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

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
