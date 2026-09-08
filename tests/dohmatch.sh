#!/bin/sh
# DNS over HTTPS: каталог резолверов, запись настройки и главная тонкость — force_dns.
#
# ЗАЧЕМ СТЕНД. Здесь два места, где ошибка молчит.
#
# Первое — определение выбранного резолвера. Оно идёт по НАБОРУ ссылок в конфигурации, а не по
# своей записи «что мы выбрали»: своя запись разошлась бы с настоящей настройкой ровно тогда,
# когда её поменяли не нами (руками, менеджером, страницей luci-app-https-dns-proxy). Сравнение
# по одной ссылке вместо набора сделало бы «Cloudflare» и «по умолчанию» неразличимыми — у
# второго ссылок две, и первая из них та же.
#
# Второе — force_dns. Ключ заворачивает весь DNS сети на роутер, и ровно то же делает
# перенаправление движка. Два правила в одной точке разрешаются порядком регистрации служб, а
# не замыслом: проигравший резолвер молча остаётся без запросов, и правила по доменам
# перестают действовать при полностью исправном виде настройки.
set -u
cd "$(dirname "$0")/.." || exit 2
LIB=files/usr/lib/splify2/doh.sh
LIST=files/usr/share/splify2/doh-providers.conf
[ -s "$LIB" ] || { echo "нет $LIB"; exit 2; }
[ -s "$LIST" ] || { echo "нет $LIST"; exit 2; }

pass=0 fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  вышло:     %s\n' "$1" "$2" "$3"
    fi
}

# Заглушка движка: отвечает на needs-dnsd кодом возврата, как настоящий.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/steer" <<'STUB'
#!/bin/sh
[ "$1" = needs-dnsd ] || exit 1
exit "$(cat "$SANDBOX/needs-dnsd" 2>/dev/null || echo 1)"
STUB
chmod +x "$tmp/bin/steer"
SANDBOX="$tmp"; export SANDBOX

DOH_CONF="$tmp/https-dns-proxy"
DOH_INIT="$tmp/bin/initd"
DOH_LIST="$LIST"
DOH_STEER="$tmp/bin/steer"
DOH_SPEC="$tmp/spec.json"
# Заглушка uci: настоящего libuci на машине разработчика нет, а признак «ведём ли DoH мы» и
# список резолверов dnsmasq живут именно в uci. Без заглушки эти ветки не исполнялись бы, и
# стенд был бы зелёным при любом их поведении.
DOH_UCI="$(pwd)/tests/stub/uci"
UCI_STUB_DB="$tmp/uci.db"; export UCI_STUB_DB
# Init-скрипт службы: записывает, что ему велели, — стенд проверяет, что `disable` больше не
# зовётся ни разу. Именно он и отбирал у человека управление собственной службой.
cat > "$DOH_INIT" <<'INITD'
#!/bin/sh
printf '%s\n' "$1" >> "$SANDBOX/initd.log"
case "$1" in
    running) [ -f "$SANDBOX/running" ] ;;
    start)   : > "$SANDBOX/running" ;;
    stop)    rm -f "$SANDBOX/running" ;;
    *)       : ;;
esac
INITD
chmod +x "$DOH_INIT"
# dnsmasq перезапускается по абсолютному пути — на машине разработчика его нет, и это не беда:
# отказ команды в подоболочке ничего не решает, а проверяем мы не его.
. "$LIB"

# ---- каталог -----------------------------------------------------------------
check "каталог читается" "1" "$([ "$(doh_items | grep -c .)" -gt 5 ] && echo 1 || echo 0)"
check "первым пунктом — по умолчанию" "default" "$(doh_items | head -1 | cut -d'|' -f1)"
check "у пункта по умолчанию два резолвера" "2" \
    "$(doh_providers | awk -F'|' '$1 == "default"' | grep -c .)"
check "есть — есть" "0" "$(doh_has comss; echo $?)"
check "нет — нет" "1" "$(doh_has нету; echo $?)"
# У каждой строки каталога обязаны быть все четыре поля: пропущенное поле сдвигает ссылку в
# bootstrap, и https-dns-proxy получает адрес там, где ждёт URL.
check "у всех строк четыре поля" "0" \
    "$(doh_providers | awk -F'|' 'NF != 4' | grep -c .)"
# Ссылка обязана быть ссылкой: опечатка здесь означает резолвер, который не поднимется, а
# пункт в списке при этом есть.
check "все ссылки — https" "0" \
    "$(doh_providers | cut -d'|' -f3 | grep -vc '^https://')"

# ---- запись настройки --------------------------------------------------------
echo 1 > "$tmp/needs-dnsd"   # доменных каналов нет
doh_write cloudflare
check "настройка записана" "0" "$?"
check "выбранный резолвер читается обратно" "cloudflare" "$(doh_active)"
check "порт задан явно" "1" "$(grep -c "option listen_port '5053'" "$DOH_CONF")"
check "bootstrap записан" "1" "$(grep -c "option bootstrap_dns '1.1.1.1" "$DOH_CONF")"
# force_dns ВСЕГДА 0, и это уже не «как у менеджера, если доменных каналов нет».
#
# Решение владельца (запуск 65): резолвер держим постоянно, значит перенаправление порта 53
# наше постоянно, значит заворачивать DNS прокси нельзя никогда — два перенаправления в
# одной точке nat prerouting дают гонку, и проигравший молчит.
#
# Проверяется на спеке БЕЗ доменных каналов нарочно: именно этот случай раньше давал 1, и
# именно он мог перевернуться ночным обновлением списков, когда доменность стала зависеть от
# содержимого файла, а не от спеки.
check "force_dns выключен даже без доменных каналов" "1" \
    "$(grep -c "option force_dns '0'" "$DOH_CONF")"
check "и единицы в ключе нет вовсе" "0" "$(grep -c "option force_dns '1'" "$DOH_CONF")"

doh_write default
check "пункт с двумя резолверами записан" "2" "$(grep -c 'resolver_url' "$DOH_CONF")"
check "порты раздаются подряд" "1" "$(grep -c "option listen_port '5054'" "$DOH_CONF")"
check "и он же читается обратно" "default" "$(doh_active)"
# Главное про определение выбранного: у «default» и «cloudflare» первая ссылка одна и та же,
# и сравнение по одной ссылке спутало бы их.
check "две ссылки не читаются как cloudflare" "1" \
    "$([ "$(doh_active)" != cloudflare ] && echo 1 || echo 0)"

echo 0 > "$tmp/needs-dnsd"   # доменные каналы есть
doh_write comss
check "с доменными каналами force_dns = 0" "1" "$(grep -c "option force_dns '0'" "$DOH_CONF")"
check "и это видно снаружи" "0" "$(doh_force_dns)"

# У резолвера без bootstrap ключа быть не должно вовсе: пустое значение
# https-dns-proxy читает как «разрешать имя резолвера нечем».
doh_write xbox
check "без bootstrap ключа нет" "0" "$(grep -c 'bootstrap_dns' "$DOH_CONF")"

doh_write 'нет такого'
check "неизвестный резолвер — отказ" "1" "$?"
check "и настройка не тронута" "xbox" "$(doh_active)"

# ---- чужая ссылка ------------------------------------------------------------
# Человек вписал свою руками или взял из версии менеджера новее нашей. Это законное
# состояние, и активным пунктом каталога оно НЕ является — интерфейс обязан показать ссылку.
printf "config https-dns-proxy\n\toption resolver_url 'https://dns.example/dns-query'\n" > "$DOH_CONF"
check "чужая ссылка не выдаётся за пункт каталога" "1" "$(doh_active >/dev/null; echo $?)"
check "но сама ссылка отдаётся" "https://dns.example/dns-query" "$(doh_urls)"

# ---- копия чужой настройки ----------------------------------------------------
# ГЛАВНОЕ, ЧТО СТОРОЖИТ ЭТОТ РАЗДЕЛ. Файл /etc/config/https-dns-proxy принадлежит чужому
# пакету, и человек мог вписать в него свой резолвер руками. Наша запись переписывает файл
# целиком, поэтому перед первой записью с него снимается копия — и она обязана уцелеть при
# любом порядке вызовов. Опасен здесь не отказ, а успех: переснятая копия выглядит как копия,
# но содержит уже НАШУ настройку, и оригинал после этого не вернуть ничем.
alien_write() {
    cat > "$DOH_CONF" <<'ALIEN'
config main 'config'
	option force_dns '1'
	option dnsmasq_config_update '*'

config https-dns-proxy
	option resolver_url 'https://dns.example/dns-query'
	option listen_port '5053'
# свой резолвер, вписан руками: don't touch
ALIEN
}
# Сравнение — с оригиналом БЕЗ пустых строк: пустая строка в uci-файле только оформление, и в
# копию она не берётся нарочно (см. doh_backup_save).
alien_diff() { grep -v '^[[:space:]]*$' "$tmp/alien" | diff - "$DOH_CONF"; }

alien_write
cp "$DOH_CONF" "$tmp/alien"
doh_write cloudflare
check "наш резолвер записан поверх чужого" "cloudflare" "$(doh_active)"
check "чужая ссылка больше не действует" "0" "$(doh_urls | grep -c 'dns.example')"
check "копия чужой настройки снята" "saved" "$(doh_backup_state)"
check "в копии лежит чужая ссылка" "1" \
    "$(doh_backup_lines | grep -c "resolver_url 'https://dns.example/dns-query'")"
# Комментарии и апострофы — не мелочь: в чужом файле руками пишут именно их, а копия хранится
# в uci-значениях, где апостроф — разделитель.
check "комментарий с апострофом уцелел" "1" "$(doh_backup_lines | grep -c "don't touch")"

# Вторая запись копию НЕ переснимает — то самое падение между копией и восстановлением.
doh_write default
check "копия не переснимается второй записью" "1" "$(doh_backup_lines | grep -c 'dns.example')"
check "нашей настройки в копии нет" "0" "$(doh_backup_lines | grep -c 'heartbeat')"
check "и выбранный резолвер читается по-прежнему" "default" "$(doh_active)"

doh_restore
check "восстановление отдало чужой файл как был" "" "$(alien_diff)"
check "копии после восстановления нет" "" "$(doh_backup_state)"
# Второе восстановление обязано быть ничем: файл уже чужой, и «вернуть оригинал» повторно
# означало бы затереть его тем, чего в копии больше нет.
doh_restore
check "повторное восстановление ничего не портит" "" "$(alien_diff)"

# Конфига до нас не было вовсе — это тоже состояние, и восстановить его значит удалить наш.
rm -f "$DOH_CONF"
doh_write cloudflare
check "конфига не было — так и записано" "none" "$(doh_backup_state)"
doh_write comss
check "и это состояние переносится дальше" "none" "$(doh_backup_state)"
doh_restore
check "восстановление пустоты — наш файл удаляется" "1" \
    "$([ -e "$DOH_CONF" ] && echo 0 || echo 1)"

# Первая наша запись в этот файл — не обязательно doh_write: force_dns правится и из apply, и
# из установки пакета, то есть задолго до того, как человек выберет резолвер на вкладке.
alien_write
doh_backup_save
check "копия снимается и до выбора резолвера" "saved" "$(doh_backup_state)"
check "чужая настройка при этом на месте" "1" "$(doh_urls | grep -c 'dns.example')"
doh_write xbox
check "снятая раньше копия записью не переснимается" "1" "$(doh_backup_lines | grep -c 'dns.example')"

# Файл, которого мы не касались, восстановлению не подлежит: копии нет — значит и оригинал
# никто не забирал, а удалить его здесь значило бы снести чужую настройку под видом отката.
alien_write
doh_restore
check "чужой файл без копии не удаляется" "1" "$([ -s "$DOH_CONF" ] && echo 1 || echo 0)"
check "и остаётся дословно как был" "" "$(diff "$tmp/alien" "$DOH_CONF")"

# ---- чьё это хозяйство: управление возвращается человеку -----------------------
#
# ГЛАВНОЕ, ЧТО СТОРОЖИТ ЭТОТ РАЗДЕЛ. Пакет https-dns-proxy не наш, и человек вправе держать
# свой DoH без нас. Прежде «Системный DNS» на вкладке делал три вещи разом: выключал службу,
# СНИМАЛ ЕЁ АВТОЗАПУСК и оставлял в чужом файле нашу настройку, которую apply продолжал
# править. Со стороны это и выглядело как перехват управления — обратка называла это прямо.
rm -f "$tmp/initd.log" "$tmp/running"
alien_write
cp "$DOH_CONF" "$tmp/alien"
doh_write cloudflare
check "запись объявляет нас хозяином настройки" "1" \
    "$("$DOH_UCI" -q get splify2.main.doh_managed)"
doh_apply
check "и служба включена нами" "1" "$(grep -c '^enable$' "$tmp/initd.log")"

doh_off
check "выключение снимает признак управления" "0" \
    "$("$DOH_UCI" -q get splify2.main.doh_managed)"
check "и возвращает человеку его настройку" "" "$(alien_diff)"
check "служба остановлена" "1" "$(grep -c '^stop$' "$tmp/initd.log")"
# ВОТ ЭТА СТРОКА И ЕСТЬ ПОЧИНКА. Снятый автозапуск человек на своей странице не видит и с
# нами не связывает, а «Start» там после перезагрузки ничего не меняет. Служба была включена
# ДО нас (заглушка отвечает «включена»), значит включённой и остаётся.
check "автозапуск НЕ снимается" "0" "$(grep -c '^disable$' "$tmp/initd.log")"
check "и запись о чужом состоянии убрана за собой" "" \
    "$("$DOH_UCI" -q get splify2.main.doh_prev_enabled)"

# А ЕСЛИ ДО НАС СЛУЖБА БЫЛА ВЫКЛЮЧЕНА — возвращается выключенной. Это то же правило с другой
# стороны: вернуть человеку надо ровно то, что у него было, а не то, что мы считаем верным.
# Заглушка автозапуска отвечает по файлу: так стенд различает два состояния, которых у
# настоящего init-скрипта два и есть.
cat > "$DOH_INIT" <<'INITD2'
#!/bin/sh
printf '%s\n' "$1" >> "$SANDBOX/initd.log"
case "$1" in
    running) [ -f "$SANDBOX/running" ] ;;
    start)   : > "$SANDBOX/running" ;;
    stop)    rm -f "$SANDBOX/running" ;;
    enabled) [ -f "$SANDBOX/enabled" ] ;;
    enable)  : > "$SANDBOX/enabled" ;;
    disable) rm -f "$SANDBOX/enabled" ;;
    *)       : ;;
esac
INITD2
chmod +x "$DOH_INIT"
rm -f "$tmp/initd.log" "$tmp/enabled"
alien_write
doh_write cloudflare
doh_apply
check "чужое состояние автозапуска записано" "0" \
    "$("$DOH_UCI" -q get splify2.main.doh_prev_enabled)"
check "и служба включена нами" "1" "$([ -f "$tmp/enabled" ] && echo 1 || echo 0)"
doh_off
check "выключенный до нас автозапуск возвращается выключенным" "0" \
    "$([ -f "$tmp/enabled" ] && echo 1 || echo 0)"

# Сверка force_dns — только пока ведём мы. У чужого хозяйства ключ не правится: расхождение
# показывается (doh_force_conflict) и исправляется по нажатию (doh_force_fix), а не молча.
printf "config main 'config'\n\toption force_dns '1'\n" > "$DOH_CONF"
doh_force_sync
check "чужой force_dns не переписывается" "1" \
    "$(sed -n "s/^[[:space:]]*option force_dns '\([^']*\)'.*/\1/p" "$DOH_CONF")"
check "и расхождение читается снаружи" "1" "$(doh_force_now)"
: > "$tmp/running"
check "спор с нашим резолвером виден" "0" "$(doh_force_conflict; echo $?)"
doh_force_fix
# Правка идёт через uci (чтобы не потерять чужой резолвер ради одного ключа), поэтому здесь
# спрашивается uci, а не файл: настоящий `uci commit` перепишет файл сам, заглушка — нет.
check "по нажатию ключ всё-таки исправляется" "0" \
    "$("$DOH_UCI" -q get 'https-dns-proxy.@main[0].force_dns')"
check "копия чужой настройки при этом снята" "saved" "$(doh_backup_state)"
# А как только правка доехала до файла, спор пропадает.
printf "config main 'config'\n\toption force_dns '0'\n" > "$DOH_CONF"
check "и спора больше нет" "1" "$(doh_force_conflict; echo $?)"

# Служба запускается и останавливается из нашей вкладки, не делая нас хозяином настройки:
# кнопка «Start» на чужой странице у людей не срабатывает, а спрашивают про DoH здесь.
"$DOH_UCI" -q set splify2.main.doh_managed=0
rm -f "$tmp/running"
doh_start
check "запуск из вкладки поднимает службу" "0" "$(doh_running; echo $?)"
check "и хозяином настройки нас не делает" "0" \
    "$("$DOH_UCI" -q get splify2.main.doh_managed)"
doh_stop
check "остановка из вкладки останавливает" "1" "$(doh_running; echo $?)"

# ---- системный DNS адресом ----------------------------------------------------
#
# Второй род резолвера: не ссылка, а адрес, и обслуживает его сам dnsmasq. «Не хватает опции
# вносить не формат https://…/dns-query, а просто ip» — обратка. Чужие записи того же списка
# (петля прокси, доменные заглушки canary) не наши и обязаны уцелеть.
"$DOH_UCI" -q add_list 'dhcp.@dnsmasq[0].server=127.0.0.1#5053'
"$DOH_UCI" -q add_list 'dhcp.@dnsmasq[0].server=/mask.icloud.com/'
"$DOH_UCI" -q add_list 'dhcp.@dnsmasq[0].server=9.9.9.9'
check "свой адрес виден, чужие записи — нет" "9.9.9.9" "$(doh_sys_get | tr '\n' ' ' | sed 's/ $//')"

doh_sys_set '1.1.1.1 8.8.8.8#5353'
check "адреса записаны" "1.1.1.1 8.8.8.8#5353" "$(doh_sys_get | tr '\n' ' ' | sed 's/ $//')"
check "провайдерские резолверы отключены" "1" "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].noresolv')"
check "петля прокси уцелела" "1" \
    "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].server' | tr ' ' '\n' | grep -c '127.0.0.1#5053')"
check "доменная заглушка уцелела" "1" \
    "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].server' | tr ' ' '\n' | grep -c '/mask.icloud.com/')"
check "исходный адрес лежит в копии" "9.9.9.9" \
    "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].splify2_orig_server')"

doh_sys_set 'не адрес'
check "не адрес — отказ" "1" "$?"
check "и список не тронут" "1.1.1.1 8.8.8.8#5353" "$(doh_sys_get | tr '\n' ' ' | sed 's/ $//')"

doh_sys_set ''
check "пусто — вернулось как было" "9.9.9.9" "$(doh_sys_get | tr '\n' ' ' | sed 's/ $//')"
check "и noresolv вернулся к своему отсутствию" "" \
    "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].noresolv')"
check "копии после возврата нет" "" "$("$DOH_UCI" -q get 'dhcp.@dnsmasq[0].splify2_dns_state')"

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
