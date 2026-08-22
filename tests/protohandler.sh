#!/bin/sh
# Стенд для обработчика протокола netifd (files/lib/netifd/proto/xsteer.sh).
#
# ЗАЧЕМ. Это 193 строки, которые netifd исполняет С ПРАВАМИ ROOT на каждой настройке
# интерфейса, и до этого стенда их не проверяло ничто. Скрипт целиком состоит из обращений
# к системе (`ip`, движок, netifd-proto), поэтому годится та же схема, что у rpcdmatch.sh:
# внешние команды подменяются заглушками в PATH, функции netifd — заглушками в оболочке,
# абсолютные пути — швами в самом скрипте (`XSTEER_RUN`, `STEER_BIN`). Скрипт при этом
# настоящий, целиком: файл подключается через INCLUDE_ONLY, ровно тот шов, который в нём
# для этого и заведён.
#
# Заглушки протоколируют вызовы, и большая часть проверок — про то, ЧТО СКАЗАНО netifd, а
# не про содержимое файла: беда обработчика интерфейса выглядит как «интерфейс поднят», а
# не как «функция вернула не то».
#
# Запуск: sh tests/protohandler.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLER="$ROOT/files/lib/netifd/proto/xsteer.sh"
PAGE="$ROOT/luci/htdocs/luci-static/resources/protocol/xsteer.js"
T="$(mktemp -d /tmp/protohandler.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM

fails=0
check() {  # ОПИСАНИЕ ОЖИДАЕМОЕ ПОЛУЧЕННОЕ
    if [ "$2" = "$3" ]; then
        printf '%-70s ok\n' "$1"
    else
        printf '%-70s ПРОВАЛ\n' "$1"
        printf '    ожидалось: %s\n    получено:  %s\n' "$2" "$3"
        fails=$((fails + 1))
    fi
}

mkdir -p "$T/bin"

# ---- заглушки внешних команд ------------------------------------------------
# ip: протоколирует каждый вызов и держит СПИСОК существующих устройств в файле, чтобы
# `ip link show` отвечал так же, как на живой системе. Отказ задаётся снаружи: IP_ADD_RC
# воспроизводит «устройство не создалось» (имя занято, нет kmod-tun) без ядра.
cat > "$T/bin/ip" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/ip.log"
case "$1 $2" in
    "link show")
        grep -qx "$4" "$SANDBOX/devices" 2>/dev/null && exit 0
        echo "Device \"$4\" does not exist." >&2
        exit 1
        ;;
    "tuntap add")
        if [ "${IP_ADD_RC:-0}" != 0 ]; then
            echo "Error: argument \"$4\" is wrong: \"dev\" not a valid ifname" >&2
            exit "$IP_ADD_RC"
        fi
        echo "$4" >> "$SANDBOX/devices"
        ;;
    "link set")
        grep -qx "$4" "$SANDBOX/devices" 2>/dev/null || {
            echo "Cannot find device \"$4\"" >&2; exit 1; }
        ;;
    "link del")
        grep -vx "$4" "$SANDBOX/devices" > "$SANDBOX/devices.new" 2>/dev/null || :
        mv "$SANDBOX/devices.new" "$SANDBOX/devices" 2>/dev/null || :
        ;;
esac
exit 0
EOF

# steer: только xsteer-check. Вердикт задаётся снаружи (STEER_CHECK_RC), текст отказа —
# STEER_CHECK_ERR: стенду нужно оба пути, а не только зелёный.
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/steer.log"
[ "$1" = "xsteer-check" ] || exit 0
if [ "${STEER_CHECK_RC:-0}" != 0 ]; then
    echo "${STEER_CHECK_ERR:-конфигурация отвергнута}" >&2
    exit "$STEER_CHECK_RC"
fi
exit 0
EOF
chmod +x "$T/bin/ip" "$T/bin/steer"

# ---- обвязка netifd ---------------------------------------------------------
# Функции netifd-proto.sh и /lib/functions.sh, которые обработчик зовёт. Каждая
# протоколирует вызов: проверяется именно ПОСЛЕДОВАТЕЛЬНОСТЬ сказанного netifd.
cat > "$T/netifd.sh" <<'EOF'
proto_notify_error()    { echo "notify_error $2" >> "$SANDBOX/netifd.log"; }
proto_block_restart()   { echo "block_restart" >> "$SANDBOX/netifd.log"; }
proto_run_command()     { shift; echo "run_command $*" >> "$SANDBOX/netifd.log"; }
proto_kill_command()    { echo "kill_command" >> "$SANDBOX/netifd.log"; }
proto_init_update()     { echo "init_update $1 $2" >> "$SANDBOX/netifd.log"; }
proto_add_ipv4_address(){ echo "add_ipv4 $1/$2" >> "$SANDBOX/netifd.log"; }
proto_send_update()     { echo "send_update" >> "$SANDBOX/netifd.log"; }
proto_config_add_string() { :; }
proto_config_add_int()    { :; }
proto_config_add_array()  { :; }
proto_config_add_boolean(){ :; }
add_protocol()            { :; }

# json_get_vars/json_get_values: netifd отдаёт настройки интерфейса через них. Здесь
# значения приходят переменными окружения OPT_<имя>, чтобы случай задавался одной строкой.
json_get_vars() {
    for v in "$@"; do
        eval "$v=\"\${OPT_$v:-}\""
    done
}
json_get_values() { eval "$1=\"\${OPT_$2:-}\""; }

# uci: пиры читаются config_load/config_foreach. Секции задаются переменной PEERS
# (по строке на пира: "имя public_key endpoint_host endpoint_port allowed_ips").
config_load()    { :; }
config_foreach() {
    local fn="$1"
    [ -n "${PEERS:-}" ] || return 0
    echo "$PEERS" | while read -r name pk host port ips; do
        [ -n "$name" ] || continue
        PEER_NAME="$name" PEER_PK="$pk" PEER_HOST="$host" \
            PEER_PORT="$port" PEER_IPS="$ips" "$fn" "$name"
    done
}
config_get() {
    case "$3" in
        public_key)  eval "$1=\"\$PEER_PK\"" ;;
        endpoint_host) eval "$1=\"\$PEER_HOST\"" ;;
        endpoint_port) eval "$1=\"\$PEER_PORT\"" ;;
        allowed_ips) eval "$1=\"\$PEER_IPS\"" ;;
        *) eval "$1=" ;;
    esac
}
config_get_bool() { eval "$1=0"; }
EOF

# ---- один прогон обработчика ------------------------------------------------
# Каждый случай — своя песочница: обработчик пишет файлы и держит список устройств, и
# перенос состояния между случаями сделал бы порядок проверок значимым.
run_setup() {  # ИНТЕРФЕЙС [ФУНКЦИЯ=proto_xsteer_setup]
    local iface="$1" fn="${2:-proto_xsteer_setup}"
    SANDBOX="$T/case"
    rm -rf "$SANDBOX"; mkdir -p "$SANDBOX/run"
    : > "$SANDBOX/devices"
    export SANDBOX
    PATH="$T/bin:$PATH" XSTEER_RUN="$SANDBOX/run" STEER_BIN="$T/bin/steer" \
    INCLUDE_ONLY=1 sh -c '
        . "$1"          # обвязка netifd
        . "$2"          # настоящий обработчик
        '"$fn"' "$3"
        echo "rc=$?" >> "$SANDBOX/netifd.log"
    ' _ "$T/netifd.sh" "$HANDLER" "$iface" >"$SANDBOX/out" 2>"$SANDBOX/err"
    NETIFD="$(cat "$SANDBOX/netifd.log" 2>/dev/null | tr '\n' ';')"
    IPLOG="$(cat "$SANDBOX/ip.log" 2>/dev/null | tr '\n' ';')"
    ERR="$(cat "$SANDBOX/err" 2>/dev/null)"
}

KEY='8BT4UvilnYyF0j+Gt5uy/oMUqH9NYOg3TrKQ/NS59lw='

# ── 1. Обычный подъём: устройство создано с multi_queue, движок запущен, адрес отдан ──
OPT_private_key="$KEY" OPT_addresses="10.77.0.2/24" OPT_sni="www.microsoft.com" \
    run_setup wg0
check "обычный подъём: rc=0" \
    "0" "$(printf '%s' "$NETIFD" | sed -n 's/.*rc=\([0-9]*\).*/\1/p')"
check "обычный подъём: устройство создано с multi_queue" \
    "yes" "$(echo "$IPLOG" | grep -q 'tuntap add dev xs-wg0 mode tun multi_queue' && echo yes || echo no)"
check "обычный подъём: движку передано то же имя устройства" \
    "yes" "$(echo "$NETIFD" | grep -q -- '--device xs-wg0' && echo yes || echo no)"
check "обычный подъём: адрес отдан netifd" \
    "yes" "$(echo "$NETIFD" | grep -q 'add_ipv4 10.77.0.2/24' && echo yes || echo no)"
check "обычный подъём: интерфейс объявлен поднятым" \
    "yes" "$(echo "$NETIFD" | grep -q 'send_update' && echo yes || echo no)"
check "обычный подъём: приватный ключ в файле с правами 0600" \
    "600" "$(stat -c '%a' "$T/case/run/wg0.conf" 2>/dev/null)"
check "обычный подъём: приватного ключа нет в журнале вызовов" \
    "no" "$(printf '%s%s' "$NETIFD" "$IPLOG" | grep -qF "$KEY" && echo yes || echo no)"

# ── 2. Нет ключа: отказ назван, интерфейс НЕ объявлен поднятым ──
OPT_addresses="10.77.0.2/24" run_setup wg0
check "без ключа: назван NO_PRIVATE_KEY" \
    "yes" "$(echo "$NETIFD" | grep -q 'notify_error NO_PRIVATE_KEY' && echo yes || echo no)"
check "без ключа: интерфейс не объявлен поднятым" \
    "no" "$(echo "$NETIFD" | grep -q 'send_update' && echo yes || echo no)"

# ── 3. Движок отверг конфигурацию: файл с ключом убран, повтор заблокирован ──
OPT_private_key="$KEY" STEER_CHECK_RC=1 STEER_CHECK_ERR="ключ не base64" run_setup wg0
check "отказ движка: назван INVALID_CONFIG" \
    "yes" "$(echo "$NETIFD" | grep -q 'notify_error INVALID_CONFIG' && echo yes || echo no)"
check "отказ движка: причина движка попала в stderr" \
    "yes" "$(printf '%s' "$ERR" | grep -q 'ключ не base64' && echo yes || echo no)"
check "отказ движка: файл с приватным ключом убран" \
    "no" "$([ -f "$T/case/run/wg0.conf" ] && echo yes || echo no)"
check "отказ движка: интерфейс не объявлен поднятым" \
    "no" "$(echo "$NETIFD" | grep -q 'send_update' && echo yes || echo no)"

# ── 4. Имя устройства не влезает в IFNAMSIZ ──
# `ip tuntap add` откажет (15 значащих символов), а движок создаст устройство с ДРУГИМ
# именем: он копирует имя через snprintf(ifr.ifr_name, IFNAMSIZ, ...) и срезает лишнее
# (steer/src/ext/tun.c, queue_open — измерено). Тогда туннель поднимается и работает, а
# адрес и зона netifd уезжают на имя, которого не существует.
OPT_private_key="$KEY" OPT_addresses="10.77.0.2/24" IP_ADD_RC=255 run_setup xsteer_tunnel
check "длинное имя: xs-xsteer_tunnel это 16 символов" \
    "16" "$(printf '%s' "xs-xsteer_tunnel" | wc -c | tr -d ' ')"
check "длинное имя: интерфейс НЕ объявлен поднятым" \
    "no" "$(echo "$NETIFD" | grep -q 'send_update' && echo yes || echo no)"
check "длинное имя: движок не запущен на имени, которого не будет" \
    "no" "$(echo "$NETIFD" | grep -q 'run_command' && echo yes || echo no)"
check "длинное имя: причина названа в stderr" \
    "yes" "$(printf '%s' "$ERR" | grep -qi 'ifnamsiz\|15\|длин' && echo yes || echo no)"
check "длинное имя: отказ доложен netifd" \
    "yes" "$(echo "$NETIFD" | grep -q 'notify_error' && echo yes || echo no)"

# ── 5. Устройство не создалось по другой причине (нет kmod-tun) ──
OPT_private_key="$KEY" OPT_addresses="10.77.0.2/24" IP_ADD_RC=1 run_setup wg0
check "устройство не создалось: интерфейс НЕ объявлен поднятым" \
    "no" "$(echo "$NETIFD" | grep -q 'send_update' && echo yes || echo no)"
check "устройство не создалось: отказ доложен netifd" \
    "yes" "$(echo "$NETIFD" | grep -q 'notify_error' && echo yes || echo no)"

# ── 6. Снятие: устройство и файл с ключом убраны за собой ──
OPT_private_key="$KEY" OPT_addresses="10.77.0.2/24" run_setup wg0
cp "$T/case/run/wg0.conf" "$T/case/kept.conf" 2>/dev/null || :
SANDBOX="$T/case" PATH="$T/bin:$PATH" XSTEER_RUN="$T/case/run" STEER_BIN="$T/bin/steer" \
    INCLUDE_ONLY=1 sh -c '
        . "$1"; . "$2"; proto_xsteer_teardown "$3"
    ' _ "$T/netifd.sh" "$HANDLER" wg0 >/dev/null 2>&1
check "снятие: устройство удалено" \
    "yes" "$(grep -q 'link del dev xs-wg0' "$T/case/ip.log" && echo yes || echo no)"
check "снятие: файл с приватным ключом удалён" \
    "no" "$([ -f "$T/case/run/wg0.conf" ] && echo yes || echo no)"

# ── 7. Пир: секция превращается в [Peer] с запятыми в AllowedIPs ──
OPT_private_key="$KEY" OPT_addresses="10.77.0.2/24" \
    PEERS="hub pvlciAMuJnL06ZXI5X0LgBaeA5Zty5OsqNaE7ikzaUg= 203.0.113.7 4443 10.77.0.0/24 0.0.0.0/0" \
    run_setup wg0
CONF="$(cat "$T/case/run/wg0.conf" 2>/dev/null)"
check "пир: секция [Peer] записана" \
    "yes" "$(printf '%s' "$CONF" | grep -q '^\[Peer\]' && echo yes || echo no)"
check "пир: Endpoint собран из хоста и порта" \
    "yes" "$(printf '%s' "$CONF" | grep -q '^Endpoint = 203.0.113.7:4443$' && echo yes || echo no)"
check "пир: список AllowedIPs склеен запятыми" \
    "yes" "$(printf '%s' "$CONF" | grep -q '^AllowedIPs = 10.77.0.0/24, 0.0.0.0/0$' && echo yes || echo no)"

# ── 8. Каждый код отказа обработчика назван на странице протокола ──
# Иначе LuCI покажет человеку сырой код вместо причины: коды приезжают в интерфейс через
# ubus, и переводит их только network.registerErrorCode на странице.
codes="$(grep -o 'proto_notify_error "\$config" [A-Z_]*' "$HANDLER" | awk '{print $3}' | sort -u)"
check "коды отказа: обработчик их вообще объявляет" \
    "yes" "$([ -n "$codes" ] && echo yes || echo no)"
for c in $codes; do
    check "код отказа $c назван на странице протокола" \
        "yes" "$(grep -q "registerErrorCode('$c'" "$PAGE" && echo yes || echo no)"
done

printf '\nпроверок с провалом: %s\n' "$fails"
[ "$fails" -eq 0 ]
