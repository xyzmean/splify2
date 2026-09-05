#!/bin/sh
# Телеметрия: что уезжает и, ГЛАВНОЕ, что не уезжает.
#
# ЧЕМ ЭТОТ СТЕНД ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ. Обычная проверка спрашивает «правильно ли сделано».
# Здесь главный вопрос другой — «не уехало ли лишнее», и он устроен наоборот: не перечень
# разрешённых полей, а ЗАПРЕТ на образце, набитом настоящими по форме секретами.
#
# Перечень разрешённого не годится по трём причинам сразу: он зелен на пакете, которого нет;
# он зелен на песочнице без секретов; и он ничего не говорит о поле, которое добавят завтра.
# Запрет на образце с секретами краснеет во всех трёх случаях.
#
# КАНАРЕЙКА. Кроме поимённых запретов в КАЖДЫЙ файл, который читает сборщик, посажена одна и
# та же метка — суффиксом внутри законного значения, чтобы разборщики не сломались. Проверка
# одна: метки в пакете нет ни разу. Она кусается там, где поимённый список бессилен: добавили
# новое поле из любого из этих источников — стенд краснеет сам, без правки списка запретов.
# Рядом стоит вторая проверка: сколько файлов метку несут. Источник добавили, метку в него не
# посадили — число разошлось, и стенд об этом скажет.
#
# Запуск: sh tests/telemetrymatch.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
STEER_BIN="${STEER_BIN:-$ROOT/../steer/build/steer}"
[ -x "$STEER_BIN" ] || { echo "нет движка $STEER_BIN — соберите: make -C ../steer all"; exit 2; }

pass=0 fail=0
check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  получено:  %s\n' "$1" "$2" "$3"
    fi
}
T="$(mktemp -d /tmp/telemetrymatch.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/bin" "$T/lists/itdog" "$T/lists/custom" "$T/var" "$T/etc" "$T/zapret"

# Метка-канарейка. Ровно одна строка на весь стенд: искать в пакете придётся именно её.
CANARY=CANARY7f3a

# ---- песочница: чужие команды -----------------------------------------------------------
cat > "$T/bin/uci" <<EOF
#!/bin/sh
db="$T/uci.db"
case "\$1" in
    -q) shift ;;
esac
case "\$1" in
    get)  v="\$(sed -n "s|^\$2=||p" "\$db" 2>/dev/null | tail -n1)"
          [ -n "\$v" ] || exit 1
          printf '%s\n' "\$v" ;;
    set)  printf '%s\n' "\$2" >> "\$db" ;;
    delete) sed -i "\\|^\$2=|d" "\$db" 2>/dev/null ;;
    show) cat "\$db" 2>/dev/null | sed "s/=\\(.*\\)/='\\1'/" ;;
    commit) : ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$T/bin/uci"
uset() { printf '%s=%s\n' "$1" "$2" >> "$T/uci.db"; }
PATH="$T/bin:$PATH"

# ---- песочница: настоящие по форме СЕКРЕТЫ ----------------------------------------------
#
# Каждый несёт канарейку — и каждый лежит там, где лежит на роутере.
#
# Ссылка подписки: токен в запросе И токен в ПОДДОМЕНЕ. Второе не выдумка: у части панелей
# секретом оказывается сам хост, и «отрезали всё после хоста» там не спасает.
uset splify2.main.sub_url "https://tok${CANARY}.panel.example.org/sub?token=SECRET${CANARY}"
uset splify2.sub_work.url "https://user:pw${CANARY}@vpn-${CANARY}.example.com:8443/s/zzz"
uset splify2.main.telemetry_id "sp-00112233445566778899aabbccddeeff"
uset splify2.main.telemetry 1

# Спека: имена выходов и правил писал ЧЕЛОВЕК — в отчёт для поддержки имена правил попадать
# могут, а в телеметрию нет, и это единственное место, где два наших правила расходятся.
cat > "$T/etc/spec.json" <<EOF
{"schema":1,
 "outputs":{"vpn-${CANARY}":{"kind":"interface","device":"wan"},
            "d":{"kind":"direct"}},
 "channels":[{"name":"rule-${CANARY}","out":"vpn-${CANARY}",
   "match":{"prefixes_files":["$T/lists/rkn.lst",
                              "$T/lists/itdog/telegram.lst",
                              "$T/lists/custom/vasya-${CANARY}.lst"]}}]}
EOF
printf '203.0.113.0/24\n' > "$T/lists/rkn.lst"
printf '10.0.0.0/8\n'     > "$T/lists/itdog/telegram.lst"
printf '10.1.0.0/16\n'    > "$T/lists/custom/vasya-${CANARY}.lst"

# Файл подписки: ссылка узла, UUID, имя узла с логином владельца внутри — ровно так их пишет
# панель, и ровно поэтому имена узлов не отправляются никуда.
printf 'vless://8f14e45f-ceea-467a-9fb2-1111deadbeef@203.0.113.9:443?sni=a#Germania-login-%s\n' \
    "$CANARY" > "$T/etc/sub.txt"

# Кэш страны выхода: во ВТОРОМ поле страна, в ТРЕТЬЕМ внешний адрес. Соседние поля одного
# файла — самый вероятный способ утечки адреса, потому что читаются одной строкой.
printf '%s %s %s %s %s\n' "$(date +%s)" "DE" "203.0.113.77" "wan:3" "120" > "$T/var/geo-vpn-${CANARY}"

# Обход DPI: активная стратегия правлена руками — значит её имени в пакете быть не должно
# вовсе, вместо него слово `custom`.
printf '#v1\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#myown-%s\n--filter-tcp=443\n'\n" \
    "$CANARY" > "$T/etc/config-zapret"

# Резолвер DoH, вписанный руками: не из нашего каталога, значит его ссылка не уезжает.
printf "config https-dns-proxy\n\toption resolver_url 'https://dns-%s.example/dns-query'\n" \
    "$CANARY" > "$T/etc/config-doh"

# Модель устройства и версия системы — из файлов прошивки. МЕТКИ В НИХ НЕТ НАРОЧНО: эти два
# значения уезжают ЗАКОННО, и канарейка в них краснила бы стенд на верном поведении. Первая
# редакция стенда посадила её и сюда — и он честно покраснел на строке, которую сам же и
# обязан пропускать. Канарейка отмечает то, чего быть не должно, а не всё подряд.
# Кавычка и обратная косая в модели — не выдумка: значение читается с диска, а пишет его
# прошивка. Без экранирования пакет перестал бы быть разбираемым JSON, и приёмник отверг бы
# его целиком, не сказав почему. Стенд ловит это проверкой «разбирается как JSON» выше.
printf 'Xiaomi "AX3000T" \\ v1\n' > "$T/etc/model"
printf "DISTRIB_RELEASE='24.10.0'\nDISTRIB_DESCRIPTION='OpenWrt 24.10.0 r28427'\n" \
    > "$T/etc/openwrt_release"

# ---- СНАЧАЛА ПРОВЕРЯЕТСЯ САМА ФИКСТУРА ---------------------------------------------------
# Иначе ниже проверялась бы не защита пакета, а собственная опечатка в песочнице: запрет
# «секрета в пакете нет» зелен и тогда, когда секрета нет и в песочнице.
n_canary=0
for f in "$T/uci.db" "$T/etc/spec.json" "$T/etc/sub.txt" "$T/etc/config-zapret" \
         "$T/etc/config-doh" "$T/lists/custom/vasya-${CANARY}.lst"; do
    case "$f" in *"$CANARY"*) n_canary=$((n_canary + 1)); continue ;; esac
    grep -q "$CANARY" "$f" 2>/dev/null && n_canary=$((n_canary + 1))
done
# СЕМЬ источников. Число здесь не украшение: добавили источник, метку в него не посадили —
# оно разойдётся, и станет видно, что канарейка перестала покрывать всё, что читает сборщик.
check "фикстура: метка посажена во все шесть источников" "6" "$n_canary"
check "фикстура: имя выхода писал человек и оно с меткой" "yes" \
      "$(grep -q "vpn-$CANARY" "$T/etc/spec.json" && echo yes || echo no)"
check "фикстура: внешний адрес лежит в кэше страны" "yes" \
      "$(grep -q '203.0.113.77' "$T/var/geo-vpn-$CANARY" && echo yes || echo no)"

# ---- сборка пакета ----------------------------------------------------------------------
build() {
    PATH="$T/bin:$PATH" \
    STEER="$STEER_BIN" SPEC="$T/etc/spec.json" LISTS="$T/lists" GEO_DIR="$T/var" \
    SYSINFO_MODEL="$T/etc/model" OPENWRT_RELEASE="$T/etc/openwrt_release" \
    BUILD_ID_FILE="$T/etc/build-id" TM_BOOT_FILE="$T/var/boot" TM_EVENTS="$T/var/events" \
    RPCD_OBJ="$T/none" \
    ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
    DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
    ZP_DIR="$T/zapret" ZP_CATALOG="$T/zapret/strategies.txt" ZP_CONF="$T/etc/config-zapret" \
    ZP_NFQWS="$T/bin/nfqws-missing" ZP_INIT="$T/bin/initd-zapret" ZP_RCD="$T/rcd" \
    DOH_CONF="$T/etc/config-doh" DOH_INIT="$T/bin/initd-doh" \
    sh -c '. files/usr/lib/splify2/telemetry.sh; tm_build'
}
pkt="$(build)"
check "пакет собрался" "0" "$?"
check "и это одна строка" "1" "$(printf '%s\n' "$pkt" | grep -c .)"
check "и он разбирается как JSON" "ok" \
      "$(printf '%s' "$pkt" | python3 -c 'import json,sys; json.load(sys.stdin); print("ok")' 2>&1)"

# ---- ГЛАВНОЕ: ЗАПРЕТЫ --------------------------------------------------------------------
check "КАНАРЕЙКИ В ПАКЕТЕ НЕТ НИ РАЗУ" "0" "$(printf '%s' "$pkt" | grep -c "$CANARY" || true)"

# Запреты по ФОРМЕ, а не по имени поля: они ловят и то, чего мы не предвидели.
check "ни одной подстроки, похожей на IPv4" "0" \
      "$(printf '%s' "$pkt" | grep -Eo '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' | grep -c . || true)"
check "ни одного «://»" "0" "$(printf '%s' "$pkt" | grep -c '://' || true)"
check "ни одной ссылки vless" "0" "$(printf '%s' "$pkt" | grep -c 'vless' || true)"
check "ни одного UUID узла" "0" \
      "$(printf '%s' "$pkt" | grep -Eoc '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' || true)"
check "приватного ключа туннеля нет" "0" "$(printf '%s' "$pkt" | grep -c 'PrivateKey\|private_key' || true)"
# Длина значения: ловит «случайно вставили строку журнала, тело стратегии или what/why».
check "ни одного значения длиннее 64 байт" "0" \
      "$(printf '%s' "$pkt" | grep -Eo '"[^"]{65,}"' | grep -c . || true)"

# Поимённо — то, что уже пробовало уехать в отчёте для поддержки и было оттуда вырезано.
check "имени выхода в пакете нет" "0" "$(printf '%s' "$pkt" | grep -c 'vpn-' || true)"
check "имени правила в пакете нет" "0" "$(printf '%s' "$pkt" | grep -c 'rule-' || true)"
check "имени своего списка в пакете нет" "0" "$(printf '%s' "$pkt" | grep -c 'vasya' || true)"
check "ссылки резолвера DoH в пакете нет" "0" "$(printf '%s' "$pkt" | grep -c 'dns-query' || true)"
check "правленной руками стратегии по имени нет" "0" "$(printf '%s' "$pkt" | grep -c 'myown' || true)"
check "и вместо неё сказано «custom»" "1" "$(printf '%s' "$pkt" | grep -c '"strategy":"custom"' || true)"

# ---- и то, что уехать ДОЛЖНО -------------------------------------------------------------
# Без этих проверок все запреты выше проходили бы на пустом пакете.
j() { printf '%s' "$pkt" | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
check "идентификатор на месте" "sp-00112233445566778899aabbccddeeff" "$(j 'd["id"]')"
check "версия схемы названа" "1" "$(j 'd["v"]')"
check "модель устройства уехала целиком, с кавычками" 'Xiaomi "AX3000T" \ v1' "$(j 'd["dev"]["model"]')"
check "выходов два — по номерам, без имён" "[1, 2]" "$(j '[o["i"] for o in d["out"]]')"
check "вид выхода назван" "['interface', 'direct']" "$(j '[o["kind"] for o in d["out"]]')"
check "страна выхода из кэша уехала, а адрес из соседнего поля — нет" "DE" \
      "$(j 'd["out"][0]["cc"]')"
check "список первого издателя назван по id" "['rkn']" "$(j 'd["lists"]["cat"]')"
check "список второго издателя назван" "['telegram']" "$(j 'd["lists"]["itdog"]')"
check "свои списки — только числом" "1" "$(j 'd["lists"]["custom"]')"
check "домен панели подписки — две последние метки" "example.org" "$(j 'd["subs"][0]["host"]')"
check "и признак «меток было больше» поднят" "True" "$(j 'd["subs"][0]["deep"]')"
check "вторая подписка тоже без логина и порта" "example.com" "$(j 'd["subs"][1]["host"]')"
check "приговоры проверок — тремя списками" "['fail', 'warn', 'note']" "$(j 'list(d["diag"].keys())')"
check "счётчики событий на месте" "0" "$(j 'd["ev"]["wan_down"]')"

# ---- согласие ----------------------------------------------------------------------------
# Три состояния, и различить их обязан именно сборщик: «не спрашивали» даёт интерфейсу право
# предложить один раз, «отказался» не даёт никогда.
cons() { PATH="$T/bin:$PATH" sh -c '. files/usr/lib/splify2/telemetry.sh; tm_consent'; }
check "согласие прочитано" "on" "$(cons)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"
check "ключа нет — «не спрашивали», а не отказ" "unset" "$(cons)"
uset splify2.main.telemetry 0
check "ноль — отказ" "off" "$(cons)"

# ---- идентификатор -----------------------------------------------------------------------
# Считает его движок и считает МЕДЛЕННО, поэтому сборщик обязан брать запомненное, а не
# считать заново на каждом пакете. Проверяется по следствию: движка нет вовсе, а пакет
# собирается — значит значение взято из настройки.
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry 1
out="$(STEER="$T/нет-такого" build 2>/dev/null)"
check "с запомненным идентификатором движок не нужен" "sp-00112233445566778899aabbccddeeff" \
      "$(printf '%s' "$out" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
# И обратное: запомненного нет, движка нет — пакет НЕ собирается, а не уезжает без опознания.
sed -i '/^splify2.main.telemetry_id=/d' "$T/uci.db"
STEER="$T/нет-такого" build >/dev/null 2>&1
check "без движка и без запомненного пакет не собирается" "1" "$?"
# А с движком — считается и запоминается, чтобы второй раз не платить. Каталог устройств
# подставной: на машине стенда физического порта с постоянным MAC может не быть вовсе, и
# тогда проверка мерила бы окружение, а не код. Число проходов занижено швом — полный счёт
# это 0,6 с на x86 и секунды на роутере.
mkdir -p "$T/net/eth0"
printf '10:bb:cc:dd:ee:ff\n' > "$T/net/eth0/address"
: > "$T/net/eth0/device"
export STEER_DEVID_ITERS=1000 STEER_SYSNET="$T/net"
out="$(STEER="$STEER_BIN" build 2>/dev/null)"
check "движок посчитал идентификатор" "yes" \
      "$(case "$(printf '%s' "$out" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')" in sp-*) echo yes ;; *) echo no ;; esac)"
check "и он запомнен в настройке" "yes" \
      "$(grep -q '^splify2.main.telemetry_id=sp-' "$T/uci.db" && echo yes || echo no)"

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
