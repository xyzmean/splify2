#!/bin/sh
# Протокол xsteer для netifd: интерфейс в /etc/config/network вместо файла в /etc/steer.
#
# ЗАЧЕМ ЭТА ПРОСЛОЙКА. У движка уже есть свой способ поднять туннель: выход `kind: xsteer` в
# спеке и экземпляр procd. Он хорош там, где настройками владеет управляющий слой (splify2).
# Но на роутере, который настраивают руками через LuCI, туннель должен быть ОБЫЧНЫМ
# интерфейсом: попасть в зону firewall, получить адрес и MTU, показаться в «Состоянии» и
# перезапускаться вместе с сетью. Всё это умеет netifd, и повторять это внутри движка значило
# бы написать вторую систему управления интерфейсами.
#
# ЧТО ЗДЕСЬ ПРОИСХОДИТ, И ЧЕГО НЕ ПРОИСХОДИТ. Скрипт создаёт устройство TUN САМ (`ip tuntap
# add`) и отдаёт его netifd, а адрес, MTU и зону ставит netifd. Движок в этом режиме
# устройство только ОТКРЫВАЕТ (`steer xsteer --device`) и не трогает его настройки: две
# стороны, настраивающие одно устройство, — это гонка, в которой заметно будет только «MTU
# иногда не тот».
#
# ПОЧЕМУ УСТРОЙСТВО СОЗДАЁТ СКРИПТ, А НЕ ДЕМОН. netifd обязан увидеть устройство сразу, иначе
# зона firewall и адрес поставить некуда, а ждать асинхронного демона он не умеет. Создать
# tuntap стоит один вызов; демон, открывая существующее устройство, получает то же самое.
#
# КЛЮЧИ В UCI, А ФАЙЛ — В tmpfs. Движок читает конфигурацию в стиле wg, поэтому скрипт
# собирает её из UCI в /var/run с правами 0600. На диск она не попадает: в UCI ключ уже есть,
# а вторая копия на флеше — это второе место, откуда его можно прочитать.
[ -n "$INCLUDE_ONLY" ] || {
	. /lib/functions.sh
	. ../netifd-proto.sh
	init_proto "$@"
}

XSTEER_RUN=/var/run/xsteer

proto_xsteer_init_config() {
	available=1
	no_device=1
	proto_config_add_string private_key
	proto_config_add_string sni
	proto_config_add_int mtu
	proto_config_add_array 'addresses:list(cidr4)'
	# Имя устройства можно задать явно; иначе берётся имя интерфейса с приставкой.
	proto_config_add_string device_name
	# Транспорт. Умолчание — поддельный TCP; режим потока нужен там, где он невозможен
	# (провайдер режет сырые сокеты, нет прав на nft) или где хаб слушает только его.
	proto_config_add_boolean stream
	proto_config_add_int stream_port
}

# Одна секция пира в файл. Пиры живут в секциях `config xsteer_<интерфейс>` — то же
# соглашение, что у wireguard (`config wireguard_<интерфейс>`), чтобы человек, знающий одно,
# не изучал второе.
xsteer_peer() {
	local cfg="$1"
	local public_key allowed_ips endpoint_host endpoint_port persistent_keepalive disabled
	config_get_bool disabled "$cfg" disabled 0
	[ "$disabled" = 1 ] && return 0
	config_get public_key "$cfg" public_key
	config_get endpoint_host "$cfg" endpoint_host
	config_get endpoint_port "$cfg" endpoint_port
	config_get persistent_keepalive "$cfg" persistent_keepalive
	config_get allowed_ips "$cfg" allowed_ips

	[ -n "$public_key" ] || { echo "xsteer: пир $cfg без public_key — пропускаю" >&2; return 0; }

	echo "" >> "$XSTEER_CONF"
	echo "[Peer]" >> "$XSTEER_CONF"
	echo "PublicKey = $public_key" >> "$XSTEER_CONF"
	# Список превращается в строку через запятую — ровно то, что ждёт разбор движка.
	local ips=""
	local ip
	for ip in $allowed_ips; do
		[ -n "$ips" ] && ips="$ips, "
		ips="$ips$ip"
	done
	[ -n "$ips" ] && echo "AllowedIPs = $ips" >> "$XSTEER_CONF"
	[ -n "$endpoint_host" ] && [ -n "$endpoint_port" ] && \
		echo "Endpoint = $endpoint_host:$endpoint_port" >> "$XSTEER_CONF"
	[ -n "$persistent_keepalive" ] && \
		echo "PersistentKeepalive = $persistent_keepalive" >> "$XSTEER_CONF"
}

proto_xsteer_setup() {
	local config="$1"
	local private_key sni mtu device_name stream stream_port
	local addresses

	json_get_vars private_key sni mtu device_name stream stream_port
	json_get_values addresses addresses

	[ -n "$private_key" ] || {
		# Отказ НАЗЫВАЕТ причину и не повторяется впустую: без ключа туннель не поднимется
		# никогда, и крутить попытки раз в пять секунд значит только засорять журнал.
		proto_notify_error "$config" NO_PRIVATE_KEY
		proto_block_restart "$config"
		return 1
	}

	local dev="${device_name:-xs-$config}"
	# MTU задавать НЕ НУЖНО: движок согласует его сам — берёт минимум из пределов сторон и
	# проверяет настоящий путь пробами (см. src/ext/xswire.h). Поэтому устройство создаётся с
	# безопасным низом, а движок поднимет его до подтверждённого значения. В режиме потока
	# вторая ступень не нужна вовсе (сегментацией распоряжается ядро), и значение ставится
	# сразу после рукопожатия — низ в этом случае живёт доли секунды.
	#
	# Если человек всё же задал MTU в настройках, это ПРЕДЕЛ: согласование не поднимет выше.
	# Нужно там, где путь заведомо уже, чем удаётся выяснить пробой (например, дальше стоит
	# ещё один туннель, который режет молча).
	local start_mtu=1200
	[ -n "$mtu" ] && start_mtu="$mtu"
	mkdir -p "$XSTEER_RUN"
	chmod 0700 "$XSTEER_RUN"
	XSTEER_CONF="$XSTEER_RUN/$config.conf"
	# umask ДО создания файла: приватный ключ не должен даже на мгновение оказаться
	# доступным всем. Перенаправление создаёт файл по текущей umask, а не по chmod после.
	( umask 077; : > "$XSTEER_CONF" )

	{
		echo "[Interface]"
		echo "PrivateKey = $private_key"
		# Адрес нужен и движку: из него он знает, чей это туннель внутри звезды. netifd
		# поставит его же на устройство — значения обязаны совпадать, поэтому берутся из
		# одного места.
		local first=""
		local a
		for a in $addresses; do
			[ -n "$first" ] || first="$a"
		done
		[ -n "$first" ] && echo "Address = $first"
		[ -n "$sni" ] && echo "SNI = $sni"
		# В конфигурацию MTU попадает только если человек задал его явно: пустое значение
		# означает «согласуй сам», а не «поставь умолчание».
		[ -n "$mtu" ] && echo "MTU = $mtu"
	} >> "$XSTEER_CONF"

	config_load network
	config_foreach xsteer_peer "xsteer_$config"

	# Проверяем конфигурацию ДО создания устройства: движок скажет о неверном ключе или
	# пересечении префиксов внятной строкой, и лучше получить её здесь, чем увидеть интерфейс,
	# который «поднялся и молчит».
	if ! /usr/sbin/steer xsteer-check --config "$XSTEER_CONF" 2>/tmp/xsteer-$config.err; then
		echo "xsteer: $(cat /tmp/xsteer-$config.err)" >&2
		proto_notify_error "$config" INVALID_CONFIG
		proto_block_restart "$config"
		rm -f "$XSTEER_CONF"
		return 1
	fi

	# Устройство: создаём, если его ещё нет. Повторный подъём интерфейса не должен падать на
	# «File exists» — netifd делает setup после teardown не всегда.
	# multi_queue ОБЯЗАТЕЛЕН: движок открывает по очереди на ядро и на этом строит
	# многопоточность (см. src/ext/xsclient.c). Устройство без него отдаст одну очередь, все
	# потоки будут читать её же, и второе ядро останется без работы — молча, потому что
	# туннель при этом полностью работоспособен.
	ip link show dev "$dev" >/dev/null 2>&1 || \
		ip tuntap add dev "$dev" mode tun multi_queue
	ip link set dev "$dev" mtu "$start_mtu" up

	# Режим потока передаётся КЛЮЧОМ, а не через файл конфигурации: транспорт — свойство
	# запуска, а не звезды, и в файле, который носят между роутером и десктопом, ему места нет
	# (там он на каждой стороне свой). Порт без режима смысла не имеет и не передаётся.
	local xs_args=""
	[ "$stream" = 1 ] && xs_args="--stream"
	[ "$stream" = 1 ] && [ -n "$stream_port" ] && xs_args="$xs_args --stream-port $stream_port"

	# shellcheck disable=SC2086
	proto_run_command "$config" /usr/sbin/steer xsteer \
		--config "$XSTEER_CONF" --device "$dev" $xs_args

	proto_init_update "$dev" 1
	local a
	for a in $addresses; do
		case "$a" in
			*:*) : ;;                       # IPv6 движок не несёт, см. docs/xsteer.md
			*/*) proto_add_ipv4_address "${a%%/*}" "${a##*/}" ;;
			*)   proto_add_ipv4_address "$a" 32 ;;
		esac
	done
	proto_send_update "$config"
}

proto_xsteer_teardown() {
	local config="$1"
	local device_name
	json_get_vars device_name
	local dev="${device_name:-xs-$config}"
	proto_kill_command "$config"
	# Устройство и файл убираем ЗА СОБОЙ: оставленный tun с адресом выглядит как работающий
	# интерфейс, а оставленный файл — это приватный ключ в tmpfs после того, как туннель
	# выключили.
	ip link del dev "$dev" 2>/dev/null
	rm -f "$XSTEER_RUN/$config.conf"
}

[ -n "$INCLUDE_ONLY" ] || add_protocol xsteer
