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

# Ответ собственного объекта rpcd — и печатает его НЕ движок, а jshn (`json_dump`), то есть
# С ПРОБЕЛОМ ПОСЛЕ ДВОЕТОЧИЯ и булевыми `true`/`false`, а не единицами. Форма здесь взята с
# живого роутера дословно: пока стенд подставлял вместо объекта несуществующий файл, разбор
# этого ответа не проверялся ни разу — и не совпадал ни разу, отчего пакет говорил «движка на
# роутере нет» на каждом роутере, где движок есть.
engine_says() { printf '#!/bin/sh\nprintf %%s %s\n' "$(printf '%s' "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/")" > "$T/rpcd-obj"; chmod +x "$T/rpcd-obj"; }
engine_says '{ "present": true, "vless": true, "enabled": false, "running": true, "arch": "aarch64_cortex-a53", "version": "1.3.0" }'

# ---- СНАЧАЛА ПРОВЕРЯЕТСЯ САМА ФИКСТУРА ---------------------------------------------------
# Иначе ниже проверялась бы не защита пакета, а собственная опечатка в песочнице: запрет
# «секрета в пакете нет» зелен и тогда, когда секрета нет и в песочнице.
# Файл последнего падения. Лежит в /var/run, куда пишет не только наша команда, поэтому в
# фикстуре он НАРОЧНО испорчен: и «что упало», и причина не из набора, да ещё с меткой внутри.
# Сборщик обязан не поверить ему ни в одном поле — иначе достаточно было бы одной записи в
# /var/run, чтобы увезти в панель произвольную строку.
printf 'what=steer%s\nreason=упал-совсем-%s\ncode=139\nsignal=11\nat=1750000000\n' \
    "$CANARY" "$CANARY" > "$T/var/crash"

n_canary=0
for f in "$T/uci.db" "$T/etc/spec.json" "$T/etc/sub.txt" "$T/etc/config-zapret" \
         "$T/etc/config-doh" "$T/lists/custom/vasya-${CANARY}.lst" "$T/var/crash"; do
    case "$f" in *"$CANARY"*) n_canary=$((n_canary + 1)); continue ;; esac
    grep -q "$CANARY" "$f" 2>/dev/null && n_canary=$((n_canary + 1))
done
# СЕМЬ источников. Число здесь не украшение: добавили источник, метку в него не посадили —
# оно разойдётся, и станет видно, что канарейка перестала покрывать всё, что читает сборщик.
check "фикстура: метка посажена во все семь источников" "7" "$n_canary"
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
    RPCD_OBJ="$T/rpcd-obj" TM_NET_FILE="$T/var/net" UCI_SPLIFY2="$T/etc/config-splify2" \
    TM_CRASH_FILE="$T/var/crash" \
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
# ---- ответ СОБСТВЕННОГО объекта rpcd ----
# Форма ответа тут другая, чем у движка: пробел после двоеточия и настоящие булевы значения.
# Каждая проверка ниже была бы зелена на пустом ответе — потому и стоит рядом с ними та, что
# требует НЕ absent: именно absent приходил на каждом живом роутере.
check "архитектура из ответа объекта" "aarch64_cortex-a53" "$(j 'd["dev"]["arch"]')"
check "версия движка из ответа объекта" "1.3.0" "$(j 'd["ver"]["steer"]')"
check "вид сборки движка — расширенная" "extended" "$(j 'd["ver"]["steer_kind"]')"
check "и движок назван работающим" "True" "$(j 'd["ver"]["steer_up"]')"
engine_says '{ "present": true, "vless": false, "enabled": true, "running": false, "arch": "mipsel_24kc", "version": "1.2.9" }'
pkt="$(build)"
check "базовая сборка отличается от расширенной" "base" "$(j 'd["ver"]["steer_kind"]')"
check "и остановленный движок виден" "False" "$(j 'd["ver"]["steer_up"]')"
engine_says '{ "present": false, "vless": false, "enabled": false, "running": false }'
pkt="$(build)"
check "движка нет — так и сказано" "absent" "$(j 'd["ver"]["steer_kind"]')"
check "и архитектуры тогда нет вовсе" "yes" \
      "$(printf '%s' "$pkt" | python3 -c 'import json,sys; print("yes" if "arch" not in json.load(sys.stdin)["dev"] else "нет")')"
engine_says '{ "present": true, "vless": true, "enabled": false, "running": true, "arch": "aarch64_cortex-a53", "version": "1.3.0" }'
pkt="$(build)"
check "счётчики событий на месте" "0" "$(j 'd["ev"]["wan_down"]')"

# ---- согласие ----------------------------------------------------------------------------
# ПОЛЬЗУЯСЬ splify2, ЧЕЛОВЕК СОГЛАСИЛСЯ. Отсутствие ключа теперь значит «да», а не «не
# спрашивали»: отказ — единственное явное действие, и делается он в «Настройки → О ПО».
#
# Три состояния при этом остались, и стенд проверяет их отдельно от решения. Это не
# придирчивость: ОПИСАНИЕ состояния («трогал ли человек переключатель») нужно интерфейсу,
# чтобы отличить «по умолчанию» от «включил сам», а РЕШЕНИЕ («отправлять ли») теперь одно на
# весь продукт и живёт в одной функции. Разъедься эти два ответа — и получится ровно та
# поломка, которую мы и переворачиваем: экран говорит одно, расписание делает другое.
cons() { PATH="$T/bin:$PATH" sh -c '. files/usr/lib/splify2/telemetry.sh; tm_consent'; }
allow() { PATH="$T/bin:$PATH" sh -c '. files/usr/lib/splify2/telemetry.sh; tm_allowed && echo yes || echo no'; }
check "согласие прочитано" "on" "$(cons)"
check "и отправлять разрешено" "yes" "$(allow)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"
check "ключа нет — состояние «не спрашивали»" "unset" "$(cons)"
check "НО отправлять разрешено: молчание теперь значит согласие" "yes" "$(allow)"
uset splify2.main.telemetry 0
check "ноль — отказ" "off" "$(cons)"
check "отказ — единственное состояние, где отправлять нельзя" "no" "$(allow)"
# Мусор в ключе — тоже отказ, а не согласие: значение туда мог записать не наш код, и читать
# непонятное как «да» в вопросе про отправку данных наружу нельзя.
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry "невнятно"
check "непонятное значение — отказ" "off" "$(cons)"
check "и отправлять по нему нельзя" "no" "$(allow)"

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

# ---- город и провайдер: чужой ответ ------------------------------------------------------
#
# Второй внешний вызов роутера, и здесь проверяется не «разобрали ли мы JSON», а ДВА обещания:
# адрес не попадает даже в кэш, и не подошедшего поля в пакете нет вовсе — ни пустой строкой,
# ни нулём. Ответ сервиса подставной, и в нём нарочно лежит настоящий по форме адрес.
cat > "$T/bin/curl" <<EOF
#!/bin/sh
# Заглушка curl. Два разных вызова, и различает она их так же, как различил бы человек: у
# отправки есть --data-binary, у запроса города — нет. Аргументы обоих пишутся на диск: стенду
# важно не только что отправлено, но и ЧЕМ — заголовок с ключом однажды уезжал пустым.
_send=0
for a in "\$@"; do case "\$a" in --data-binary) _send=1 ;; esac; done
if [ "\$_send" = 1 ]; then
    printf '%s\n' "\$@" > "$T/curl.argv"
    _prev=
    for a in "\$@"; do
        [ "\$_prev" = --data-binary ] && cp "\${a#@}" "$T/curl.body" 2>/dev/null
        _prev="\$a"
    done
    printf '%s' "\$(cat "$T/curl.code" 2>/dev/null || echo 200)"
    exit 0
fi
printf '%s\n' "\$@" > "$T/curl.geo.argv"
cat "$T/geo-answer" 2>/dev/null
EOF
chmod +x "$T/bin/curl"

# Заглушка date. Настоящее время подменяется ТОЛЬКО когда стенд просит (TM_TEST_NOW) и только
# для `+%s`: нужна она одной проверке — «окно скользящее, а не календарные сутки», — и без
# управляемого «сейчас» эта проверка зависела бы от того, в какой час запущен стенд.
cat > "$T/bin/date" <<'EOF'
#!/bin/sh
if [ -n "${TM_TEST_NOW:-}" ] && [ "${1:-}" = "+%s" ]; then printf '%s\n' "$TM_TEST_NOW"; exit 0; fi
for _d in /bin/date /usr/bin/date; do [ -x "$_d" ] && exec "$_d" "$@"; done
exit 1
EOF
chmod +x "$T/bin/date"

geo_answer() { printf '%s' "$1" > "$T/geo-answer"; }
refresh() {  # -> код возврата tm_net_refresh
    PATH="$T/bin:$PATH" TM_NET_FILE="$T/var/net" UCI_SPLIFY2="$T/etc/config-splify2" \
    TM_CURL="$T/bin/curl" \
        sh -c '. files/usr/lib/splify2/telemetry.sh; tm_net_refresh'
}

# Ответ ровно той формы, что отдаёт ipinfo.io: адрес ПЕРВЫМ полем, номер сети ведущим в org.
geo_answer '{"ip":"198.51.100.23","city":"Moscow","region":"Moscow","country":"RU",
"loc":"55.75,37.61","org":"AS12345 Rostelecom '"$CANARY"'","postal":"101000"}'
check "фикстура: в ответе сервиса есть адрес" "1" \
      "$(grep -c '198.51.100.23' "$T/geo-answer" || true)"
refresh
check "город и провайдер разрешились" "0" "$?"
check "В КЭШЕ НЕТ АДРЕСА" "0" \
      "$(grep -Eo '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "$T/var/net" | grep -c . || true)"
check "и названия провайдера тоже нет — только номер" "0" \
      "$(grep -c "$CANARY" "$T/var/net" || true)"
check "страна из ответа" "RU"    "$(sed -n 's/^cc=//p' "$T/var/net")"
check "номер сети из ведущего AS" "12345" "$(sed -n 's/^asn=//p' "$T/var/net")"
check "город из ответа" "Moscow" "$(sed -n 's/^city=//p' "$T/var/net")"
# Адрес сервиса берётся из настройки, а не зашит: у части людей ipinfo.io закрыт.
uset splify2.main.geo_city_url "https://свой-сервис.example/j"
refresh >/dev/null 2>&1
check "адрес сервиса берётся из настройки" "1" \
      "$(grep -c 'свой-сервис.example' "$T/curl.geo.argv" || true)"
sed -i '/^splify2.main.geo_city_url=/d' "$T/uci.db"

pkt="$(build)"
check "город уехал в пакете" "Moscow" "$(j 'd["geo"]["city"]')"
check "номер сети уехал числом" "12345" "$(j 'd["geo"]["asn"]')"
check "страна уехала" "RU" "$(j 'd["geo"]["cc"]')"
# КОГДА измерено — иначе панель не отличит переезд от недельного кэша.
check "время измерения уехало и совпадает с кэшем" "$(sed -n 's/^at=//p' "$T/var/net")" \
      "$(j 'd["geo"]["at"]')"
check "и адреса в пакете по-прежнему нет" "0" \
      "$(printf '%s' "$pkt" | grep -Eo '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' | grep -c . || true)"

# ---- и то, что НЕ ДОЛЖНО пройти ----------------------------------------------------------
# Каждый случай проверяется по одному следствию: поля НЕТ ВОВСЕ. Пустая строка или ноль здесь
# были бы хуже отсутствия — они неотличимы от измеренного значения.
nofield() {  # ПОЛЕ -> yes, если поля нет в пакете
    printf '%s' "$pkt" | python3 -c "import json,sys
d=json.load(sys.stdin)
print('yes' if '$1' not in d.get('geo',{}) else d['net']['$1'])" 2>/dev/null
}
# Имя ЛАТИНИЦЕЙ и ровно 41 байт: возьми его кириллицей — и проверку длины подменила бы
# проверка на алфавит, а мутация «длина города не ограничена» прошла бы мимо стенда. Так она
# и прошла в первой редакции этого стенда.
geo_answer '{"ip":"198.51.100.23","city":"Llanfairpwllgwyngyll Upon Thames West","country":"RU","org":"AS12345 X"}'
refresh >/dev/null 2>&1; pkt="$(build)"
check "город длиннее 32 байт не уезжает вовсе" "yes" "$(nofield city)"
check "а страна из того же ответа уехала" "RU" "$(j 'd["geo"]["cc"]')"
geo_answer '{"city":"Москва","country":"RU","org":"AS12345 X"}'
refresh >/dev/null 2>&1; pkt="$(build)"
check "город не латиницей не уезжает" "yes" "$(nofield city)"
geo_answer '{"city":"Perm<script>","country":"RU","org":"AS12345 X"}'
refresh >/dev/null 2>&1; pkt="$(build)"
check "город с чем угодно внутри не уезжает" "yes" "$(nofield city)"
geo_answer '{"city":"Perm","country":"Russia","org":"AS12345 X"}'
refresh >/dev/null 2>&1; pkt="$(build)"
check "страна не в две буквы не уезжает" "yes" "$(nofield cc)"
geo_answer '{"city":"Perm","country":"RU","org":"Rostelecom Ltd"}'
refresh >/dev/null 2>&1; pkt="$(build)"
check "org без ведущего AS не даёт номера сети" "yes" "$(nofield asn)"
# Два килобайта — граница на ВХОДЕ. Ответ, у которого поля лежат за ней, не разбирается вовсе:
# иначе чужой сервис решал бы, сколько памяти занять на роутере с 64 МБ.
rm -f "$T/var/net"
{ printf '{"pad":"'; i=0; while [ "$i" -lt 300 ]; do printf 'xxxxxxxxxx'; i=$((i+1)); done
  printf '","city":"Perm","country":"RU","org":"AS12345 X"}'; } > "$T/geo-answer"
refresh >/dev/null 2>&1
check "ответ длиннее двух килобайт не разбирается" "1" "$?"
check "и кэш от него не появился" "no" "$([ -s "$T/var/net" ] && echo yes || echo no)"
# Кэш лежит в /tmp, куда пишет не только эта функция. Проверка повторяется НА ЧТЕНИИ — иначе
# дописанная кем угодно строка уехала бы в пакет как измеренное значение.
printf 'at=%s\ncc=RU\ncity=Perm 198.51.100.9\nasn=12345\n' "$(date +%s)" > "$T/var/net"
pkt="$(build)"
check "подделанный кэш не проходит проверку на чтении" "yes" "$(nofield city)"
check "а годные поля из него берутся" "12345" "$(j 'd["geo"]["asn"]')"
printf 'at=1\ncc=RU\ncity=Perm\nasn=12345\n' > "$T/var/net"
pkt="$(build)"
check "протухший кэш не уезжает вовсе" "0" \
      "$(printf '%s' "$pkt" | grep -c '"geo"' || true)"
# Нет curl — нет и полей: молчание здесь честнее выдумки.
rm -f "$T/var/net"
geo_answer '{"city":"Perm","country":"RU","org":"AS12345 X"}'
mv "$T/bin/curl" "$T/curl.hidden"
refresh >/dev/null 2>&1
check "без curl город не спрашивается" "1" "$?"
mv "$T/curl.hidden" "$T/bin/curl"
refresh >/dev/null 2>&1

# ---- САМА ОТПРАВКА -----------------------------------------------------------------------
#
# Проверяется по СЛЕДСТВИЮ: что заглушка curl увидела в аргументах и в теле запроса и что
# команда записала в настройку. Ни одна проверка ниже не смотрит на текст сообщений.
uset splify2.main.telemetry_url "https://panel.example/ingest"
# Ключ С ПРОБЕЛОМ нарочно: без пробела разбиение на слова стенду не видно вовсе, и проверка
# «заголовок приехал одним аргументом» была бы зелена при любой форме подстановки.
uset splify2.main.telemetry_key "K3Y SECRET"
: > "$T/curl.code"
send() {  # АРГУМЕНТЫ команды отправки
    rm -f "$T/curl.argv" "$T/curl.body"
    PATH="$T/bin:$PATH" \
    TELEMETRY_SH="$ROOT/files/usr/lib/splify2/telemetry.sh" \
    STEER="$STEER_BIN" SPEC="$T/etc/spec.json" LISTS="$T/lists" GEO_DIR="$T/var" \
    SYSINFO_MODEL="$T/etc/model" OPENWRT_RELEASE="$T/etc/openwrt_release" \
    BUILD_ID_FILE="$T/etc/build-id" TM_BOOT_FILE="$T/var/boot" TM_EVENTS="$T/var/events" \
    RPCD_OBJ="$T/rpcd-obj" TM_NET_FILE="$T/var/net" UCI_SPLIFY2="$T/etc/config-splify2" \
    TM_CRASH_FILE="$T/var/crash" TM_NOW_STAMP="$T/var/now-stamp" \
    TM_UPTIME="${TM_UPTIME_FIXTURE:-/proc/uptime}" \
    TM_CURL="$T/bin/curl" \
    ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
    DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
    ZP_DIR="$T/zapret" ZP_CATALOG="$T/zapret/strategies.txt" ZP_CONF="$T/etc/config-zapret" \
    ZP_NFQWS="$T/bin/nfqws-missing" ZP_INIT="$T/bin/initd-zapret" ZP_RCD="$T/rcd" \
    DOH_CONF="$T/etc/config-doh" DOH_INIT="$T/bin/initd-doh" \
    sh files/usr/sbin/splify2-telemetry "$@"
}
ukey() { sed -n "s|^splify2.main.$1=||p" "$T/uci.db" | tail -n1; }

check "команда исполняемая" "yes" \
      "$([ -x files/usr/sbin/splify2-telemetry ] && echo yes || echo no)"

# БЕЗ --send НИЧЕГО НЕ УЕЗЖАЕТ. То же правило, что у splify2-purge: действие, уводящее данные
# с роутера, надо назвать вслух.
rm -f "$T/curl.geo.argv"
out="$(send 2>/dev/null)"
check "без --send пакет печатается" "1" "$(printf '%s' "$out" | grep -c '"id":"sp-' || true)"
check "и curl не звался вовсе" "no" "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
# И ЗА ГОРОДОМ НАРУЖУ ТОЖЕ НЕ ХОДИЛИ. Отдельная проверка, потому что это отдельный вызов
# другого адреса: печать пакета — чтение, и обращением к третьей стороне быть не может.
check "и за городом наружу не ходили" "no" \
      "$([ -e "$T/curl.geo.argv" ] && echo yes || echo no)"

# ---- УЕЗЖАЮТ ТЕ ЖЕ БАЙТЫ, ЧТО ПОКАЗЫВАЕТ ПРЕДПРОСМОТР ----
# Сравниваются тело запроса и вывод сборщика; замаскированы только три величины, которые
# меняются между двумя вызовами по определению — время, аптайм и отсчёт событий.
mask() { sed 's/"at":[0-9]*/"at":T/; s/"uptime":[0-9]*/"uptime":T/; s/"since":[0-9]*/"since":T/'; }
send --send >/dev/null 2>&1
check "тело запроса — байты сборщика, а не своя сборка" "same" \
      "$([ "$(build | mask)" = "$(mask < "$T/curl.body")" ] && echo same || echo different)"

# КЛЮЧ ПРИЕЗЖАЕТ ОДНИМ АРГУМЕНТОМ. Подстановка `${key:+-H "…"}` разбиралась бы по пробелам, и
# заголовок уходил бы пустым, а сам ключ curl принял бы за второй адрес.
check "заголовок с ключом — один аргумент целиком" "1" \
      "$(grep -cx 'X-Splify2-Key: K3Y SECRET' "$T/curl.argv" || true)"
check "и адрес у curl ровно один" "1" \
      "$(grep -c '^https://panel.example/ingest$' "$T/curl.argv" || true)"
check "ключа отдельным словом среди аргументов нет" "0" \
      "$(grep -cx 'K3Y SECRET' "$T/curl.argv" || true)"
# Ключа нет НИГДЕ — ни в настройке, ни зашитого: тогда заголовка нет вовсе, а не пустой.
# Пустой заголовок панель прочла бы как «ключ прислали, и он неверный», ответила бы 401, а по
# 401 роутер гасит телеметрию сам себе — то есть сборка без ключа выключала бы её у всех.
sed -i '/^splify2.main.telemetry_key=/d' "$T/uci.db"
TM_KEY_DEF='' send --send >/dev/null 2>&1
check "ключа нет нигде — заголовка нет вовсе" "0" \
      "$(grep -c 'X-Splify2-Key' "$T/curl.argv" || true)"
uset splify2.main.telemetry_key "K3Y SECRET"

# ---- коды ответа ----
printf '200' > "$T/curl.code"
sed -i '/^splify2.main.telemetry_at=/d; /^splify2.main.telemetry_error=/d' "$T/uci.db"
uset splify2.main.telemetry_error "старая беда"
send --send >/dev/null 2>&1
check "200: код возврата ноль" "0" "$?"
check "200: время отправки записано" "yes" \
      "$(case "$(ukey telemetry_at)" in [0-9]*) echo yes ;; *) echo no ;; esac)"
check "200: прошлая ошибка убрана" "" "$(ukey telemetry_error)"

printf '400' > "$T/curl.code"
send --send >/dev/null 2>&1
check "400: код возврата единица" "1" "$?"
check "400: причина сохранена для интерфейса" "1" \
      "$(ukey telemetry_error | grep -c '400' || true)"
check "400: НО телеметрия не погашена" "1" "$(ukey telemetry)"

# 401 — ЕДИНСТВЕННЫЙ КОД, ПО КОТОРОМУ РОУТЕР ГАСИТ ОТПРАВКУ САМ. Иначе неисправный ключ
# превращается в ежедневный стук в чужую дверь.
printf '401' > "$T/curl.code"
send --send >/dev/null 2>&1
check "401: код возврата единица" "1" "$?"
check "401: ТЕЛЕМЕТРИЯ ПОГАШЕНА" "0" "$(ukey telemetry)"
check "401: и сказано почему" "1" "$(ukey telemetry_error | grep -c '401' || true)"
check "401: после этого расписание молчит" "no" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry 1
sed -i '/^splify2.main.telemetry_error=/d' "$T/uci.db"

# 429 — панель просит подождать. Это не поломка: код возврата ноль и в настройку ничего.
printf '429' > "$T/curl.code"
send --send >/dev/null 2>&1
check "429: код возврата ноль" "0" "$?"
check "429: в настройку ничего не записано" "" "$(ukey telemetry_error)"
check "429: телеметрия не погашена" "1" "$(ukey telemetry)"

# 000 — НЕ КОД ОТВЕТА, а «ответа не было вовсе»: так curl печатает отказ в соединении и
# истёкшее время. Пока разбор ждал здесь пустую строку, недоступная панель записывала в
# настройку «панель ответила 000», и интерфейс показывал это человеку как ответ панели.
printf '000' > "$T/curl.code"
send --send >/dev/null 2>&1
check "000: код возврата ноль — просто пропущен час" "0" "$?"
check "000: и это НЕ записано как ответ панели" "" "$(ukey telemetry_error)"
printf '503' > "$T/curl.code"
send --send >/dev/null 2>&1
check "503: ответ панели записан как есть" "1" \
      "$(ukey telemetry_error | grep -c '503' || true)"
printf '200' > "$T/curl.code"
sed -i '/^splify2.main.telemetry_error=/d' "$T/uci.db"

# ---- цена часа ---------------------------------------------------------------------------
#
# Пакет уезжает РАЗ В ЧАС, то есть двадцать четыре раза в сутки вместо одного. Значит всё
# дорогое обязано считаться ОДИН раз, а не на каждом такте, и проверяется это по следствию:
# дорогая вещь просто убирается с дороги, а отправка обязана всё равно состояться.
printf '200' > "$T/curl.code"
# ИДЕНТИФИКАТОР — 600 000 проходов PBKDF2, 3,24 с на AX3000T. Он уже запомнен в настройке
# выше, поэтому движок здесь не нужен вовсе; пересчитывайся он на каждой отправке — роутер
# платил бы эти секунды каждый час, и заметно это стало бы не у нас, а у человека.
_bin="$STEER_BIN"; STEER_BIN="$T/нет-такого"
send --send >/dev/null 2>&1
check "отправка без движка уходит: идентификатор взят из настройки" "0" "$?"
check "и в теле запроса он есть" "1" "$(grep -c '"id":"sp-' "$T/curl.body" || true)"
send --send >/dev/null 2>&1
check "и вторая отправка подряд — тоже, движок не понадобился" "0" "$?"
STEER_BIN="$_bin"

# ГОРОД И ПРОВАЙДЕР — обращение к ТРЕТЬЕЙ СТОРОНЕ. На часовом такте это разница между одним
# запросом в неделю и ста шестьюдесятью восемью: кэш обязан работать кэшем, а не подписью
# под словом «кэш». Проверяется тем же способом — звался ли curl за городом.
geo_answer '{"city":"Moscow","country":"RU","org":"AS12345 Rostelecom"}'
refresh
rm -f "$T/curl.geo.argv"
send --send >/dev/null 2>&1
check "при свежем кэше за городом наружу не ходили" "no" \
      "$([ -e "$T/curl.geo.argv" ] && echo yes || echo no)"
check "а сам пакет при этом уехал" "yes" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и город в нём из кэша, а не пустой" "1" \
      "$(grep -c '"city":"Moscow"' "$T/curl.body" || true)"
# А протухший кэш обновляется: переезд и смена провайдера иначе остались бы незамеченными
# навсегда — файл лежит в /tmp, но роутер может не выключаться месяцами.
sed -i 's/^at=.*/at=1/' "$T/var/net"
rm -f "$T/curl.geo.argv"
send --send >/dev/null 2>&1
check "протухший кэш освежается" "yes" \
      "$([ -e "$T/curl.geo.argv" ] && echo yes || echo no)"

# ---- падение: уезжает сразу, но не потопом ------------------------------------------------
#
# «При падении отправляем сразу, крашлоги летят моментально» — решение владельца. Текста
# журнала при этом в пакете нет и быть не может (он обрушил бы все запреты выше сразу), едет
# СТРУКТУРНЫЙ факт: что упало, причина из закрытого набора, код, сигнал, счётчик с загрузки.
printf '200' > "$T/curl.code"
rm -f "$T/var/crash" "$T/var/now-stamp" "$T/var/events" "$T/var/events".* 2>/dev/null
rm -rf "$T/var/events.c" 2>/dev/null

# ПРИЧИНА ТОЛЬКО ИЗ НАБОРА. Свободная строка — готовый способ увезти в панель что угодно:
# команду зовёт скрипт с правами root, и «причина» уехала бы дословно.
send --now 'сегфолт; ну ты понял' >/dev/null 2>&1
check "причина не из набора: код возврата два" "2" "$?"
check "и наружу при этом не ходили" "no" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и файла падения не появилось" "no" \
      "$([ -e "$T/var/crash" ] && echo yes || echo no)"
send --now steer_down --what 'сам-придумал' >/dev/null 2>&1
check "«что упало» не из набора: код возврата два" "2" "$?"
# И ОТДЕЛЬНО — С ЗАКОННЫМ `--what`. Без этой проверки набор причин можно было открыть
# настежь, и стенд остался бы зелёным: он спотыкался бы о «что упало», выведенное из
# неизвестной причины пустым, а не о саму причину. Именно так эта дыра и нашлась — мутацией.
send --now 'строка журнала: /etc/steer/spec.json не читается' --what steer >/dev/null 2>&1
check "свободная причина при законном «что упало»: код возврата два" "2" "$?"
check "и наружу по ней не ходили" "no" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и в файл падения она не попала" "no" \
      "$([ -e "$T/var/crash" ] && echo yes || echo no)"

# ЗАКОННОЕ ПАДЕНИЕ УЕЗЖАЕТ НЕМЕДЛЕННО.
send --now steer_down --code 139 --signal 11 >/dev/null 2>&1
check "падение отправлено" "0" "$?"
check "и curl звался" "yes" "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
pkt="$(cat "$T/curl.body" 2>/dev/null)"
check "в пакете сказано, что упало" "steer" "$(j 'd["crash"]["what"]')"
check "и почему — словом из набора" "steer_down" "$(j 'd["crash"]["reason"]')"
check "и код возврата числом" "139" "$(j 'd["crash"]["code"]')"
check "и сигнал числом" "11" "$(j 'd["crash"]["signal"]')"
check "и счётчик с загрузки" "1" "$(j 'd["crash"]["count"]')"
check "и время падения" "yes" "$(j '"yes" if d["crash"]["at"] > 1700000000 else "нет"')"
# ЗАПРЕТЫ ДЕЙСТВУЮТ И НА ПАКЕТЕ С ПАДЕНИЕМ. Это и есть то место, где соблазн приложить
# «крашлог» сильнее всего: одна строка журнала — это пути, имена узлов и ссылка подписки с
# токеном в одном куске текста, и она обрушила бы все три запрета разом.
check "падение не принесло ни одного «://»" "0" "$(printf '%s' "$pkt" | grep -c '://' || true)"
check "падение не принесло ни одного IPv4" "0" \
      "$(printf '%s' "$pkt" | grep -Eo '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' | grep -c . || true)"
check "падение не принесло значений длиннее 64 байт" "0" \
      "$(printf '%s' "$pkt" | grep -Eo '"[^"]{65,}"' | grep -c . || true)"
check "и канарейки в нём нет" "0" "$(printf '%s' "$pkt" | grep -c "$CANARY" || true)"

# ОГРАНИЧИТЕЛЬ ПОТОПА. Флапающий WAN даёт десятки событий в минуту; без предела каждое стало
# бы запросом наружу. Двадцать событий подряд — одна отправка, и это проверяется счётом
# вызовов curl, а не словами.
_sends=0
_n=0
while [ "$_n" -lt 20 ]; do
    _n=$((_n + 1))
    send --now wan_flap >/dev/null 2>&1
    [ -e "$T/curl.argv" ] && _sends=$((_sends + 1))
done
check "двадцать падений подряд — ни одной лишней отправки" "0" "$_sends"
# НО СЧЁТЧИК ЧЕСТНЫЙ. Погашенное событие обязано остаться посчитанным: иначе «сыпется сорок
# раз» стало бы неотличимо от «дёрнулось однажды» — а различать эти два случая и есть смысл
# затеи.
send --scheduled >/dev/null 2>&1
pkt="$(cat "$T/curl.body" 2>/dev/null)"
check "плановая отправка ограничителем НЕ гасится" "yes" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и в ней все двадцать погашенных падений посчитаны" "20" "$(j 'd["crash"]["count"]')"
check "и последнее падение названо верно" "wan_flap" "$(j 'd["crash"]["reason"]')"
check "счётчик падений лежит там же, где счётчики отвалов" "20" \
      "$(sed -n 's/^crash_wan=\([0-9]*\)$/\1/p' "$T/var/events" | tail -n1)"

# СУТОЧНЫЙ ПОТОЛОК — ВТОРОЙ ОГРАНИЧИТЕЛЬ, И ОН НЕ ЛИШНИЙ. Промежуток ограничивает частоту, а
# не количество: пять минут между отправками — это до 288 пакетов в сутки, а панель принимает
# от одного идентификатора 48 за скользящие сутки и дальше отвечает 429. По 429 команда
# пропускает такт целиком, то есть, исчерпав предел падениями, роутер перестал бы присылать и
# ПЛАНОВЫЕ пакеты — ровно тот роутер, у которого что-то сломалось, пропал бы из виду.
#
# Поэтому здесь семнадцать событий, разнесённых во времени так, чтобы промежуток не мешал:
# история отодвигается назад на семь минут перед каждым. Уехать обязаны ровно двенадцать.
rm -f "$T/var/now-stamp"
_sends=0
_n=0
while [ "$_n" -lt 17 ]; do
    _n=$((_n + 1))
    if [ -s "$T/var/now-stamp" ]; then
        awk '{print $1 - 420}' "$T/var/now-stamp" > "$T/var/now-stamp.n" &&
            mv "$T/var/now-stamp.n" "$T/var/now-stamp"
    fi
    send --now wan_flap >/dev/null 2>&1
    [ -e "$T/curl.argv" ] && _sends=$((_sends + 1))
done
check "суточный потолок внеплановых — двенадцать" "12" "$_sends"
# И ПЛАНОВАЯ ОТПРАВКА ИМ НЕ ГАСИТСЯ — даже когда он исчерпан. Иначе ограничитель, заведённый
# против 429, сам делал бы ровно то, чем этот 429 плох.
send --scheduled >/dev/null 2>&1
check "исчерпанный потолок плановую отправку не трогает" "yes" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
# ОКНО СКОЛЬЗЯЩЕЕ, А НЕ КАЛЕНДАРНЫЕ СУТКИ. Разницу видно только на границе суток, поэтому
# «сейчас» здесь подменяется: ровно 01:00 UTC, а двенадцать отметок лежат двумя часами раньше,
# то есть во ВЧЕРАШНЕМ дне и внутри скользящих суток. Календарный сброс отпустил бы отправку —
# и роутер сложил бы двадцать четыре внеплановых пакета в одни сутки счёта панели.
TM_TEST_NOW=$(( 1893456000 + 3600 ))
export TM_TEST_NOW
rm -f "$T/var/now-stamp"
_n=12
while [ "$_n" -gt 0 ]; do
    printf '%s\n' "$(( TM_TEST_NOW - 7200 - _n ))" >> "$T/var/now-stamp"
    _n=$((_n - 1))
done
send --now wan_flap >/dev/null 2>&1
check "вчерашние по календарю отметки окно всё ещё занимают" "no" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
unset TM_TEST_NOW

# И ОБРАТНОЕ: отметки старше суток перестают занимать место — иначе потолок, набранный
# однажды, остался бы набранным навсегда.
rm -f "$T/var/now-stamp"
_n=12
while [ "$_n" -gt 0 ]; do
    printf '%s\n' "$(( $(date +%s) - 86500 - _n ))" >> "$T/var/now-stamp"
    _n=$((_n - 1))
done
send --now wan_flap >/dev/null 2>&1
check "отметки старше суток окно освобождают" "yes" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и в файле остаётся только свежая отметка" "1" "$(grep -c . "$T/var/now-stamp")"

# ПЕРВЫЕ ДВЕ МИНУТЫ ПОСЛЕ ЗАГРУЗКИ ВНЕПЛАНОВЫХ ОТПРАВОК НЕТ. Отметки лежат в /var/run, то
# есть перезагрузка обнуляет оба ограничителя, — и роутер в петле перезапусков обходил бы их
# по разу за цикл. Проверяется подставным /proc/uptime.
printf '31.41 12.00\n' > "$T/var/uptime-young"
rm -f "$T/var/now-stamp"
TM_UPTIME_FIXTURE="$T/var/uptime-young" send --now steer_down >/dev/null 2>&1
check "сразу после загрузки внеплановой отправки нет" "no" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
check "но падение всё равно записано" "yes" \
      "$([ -s "$T/var/crash" ] && echo yes || echo no)"
check "и отметка на него не потрачена" "no" \
      "$([ -e "$T/var/now-stamp" ] && echo yes || echo no)"

# А ПОСЛЕ ВЫДЕРЖКИ внеплановая отправка снова уходит: ограничитель гасит повторы, а не
# следующее падение через час.
printf '%s\n' "$(( $(date +%s) - 600 ))" > "$T/var/now-stamp"
send --now zapret_down >/dev/null 2>&1
check "после выдержки внеплановая отправка снова уходит" "yes" \
      "$([ -e "$T/curl.argv" ] && echo yes || echo no)"
pkt="$(cat "$T/curl.body" 2>/dev/null)"
check "и «что упало» выведено из причины" "zapret" "$(j 'd["crash"]["what"]')"
rm -f "$T/var/crash" "$T/var/now-stamp"

# ---- согласие решает, уедет ли что-нибудь ----
#
# ПЕРЕВЁРНУТОЕ ПРАВИЛО, и проверяется оно по СЛЕДСТВИЮ — звался ли curl, — а не по тексту
# сообщений. Разница здесь не стилистическая: сообщение «телеметрия выключена» легко остаётся
# на месте при перевёрнутом решении, и стенд, читающий сообщения, остался бы зелёным ровно в
# том случае, ради которого он написан.
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"
check "расписание при отсутствии ключа ОТПРАВЛЯЕТ" "yes" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и код возврата ноль" "0" "$(send --scheduled >/dev/null 2>&1; echo $?)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry 1
check "расписание при явном согласии отправляет" "yes" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry 0
check "расписание при отказе молчит" "no" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и код возврата ноль — это не поломка" "0" "$(send --scheduled >/dev/null 2>&1; echo $?)"
send --send >/dev/null 2>&1
check "и руками при отказе — отказ, а не отправка" "1" "$?"
# ОТКАЗ ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК КОМАНДЫ. Проверка не лишняя: единственный путь, на котором
# команда сама пишет в ключ согласия, — это 401 от панели, и ошибиться там знаком (записать
# «1» вместо «0» или стереть ключ) значит вернуть отказавшемуся отправку молча. Поэтому
# сначала три вызова подряд, а потом — что в настройке лежит именно ноль, а не пусто.
check "второй вызов подряд тоже молчит" "no" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
check "и третий" "no" \
      "$(send --scheduled >/dev/null 2>&1; [ -e "$T/curl.argv" ] && echo yes || echo no)"
check "ноль в настройке остался нулём, а не стёрся" "0" "$(ukey telemetry)"
sed -i '/^splify2.main.telemetry=/d' "$T/uci.db"; uset splify2.main.telemetry 1

# ---- отправлять нечем ----
# У busybox uclient-fetch нет ни отправки тела, ни кода ответа. Роутер без curl — законное
# состояние, но молчание в нём читалось бы как «отправляется».
mv "$T/bin/curl" "$T/curl.hidden"
send --send >/dev/null 2>&1
check "без curl отправка — честный отказ" "1" "$?"
mv "$T/curl.hidden" "$T/bin/curl"
# ---- адрес панели и ключ: умолчание зашито, настройка ПЕРЕОПРЕДЕЛЯЕТ ----
#
# Зашитое умолчание — это то, с чем пакет уезжает людям, и оно обязано работать на роутере,
# где ключей настройки нет вовсе: `uci-defaults` отрабатывает один раз при установке, а
# восстановление из архива и правка руками его не повторяют. Проверяется по следствию: что
# именно увидел curl в аргументах.
sed -i '/^splify2.main.telemetry_url=/d; /^splify2.main.telemetry_key=/d' "$T/uci.db"
send --send >/dev/null 2>&1
check "без ключей настройки отправка всё равно уходит" "0" "$?"
check "и уходит по ЗАШИТОМУ адресу панели" "1" \
      "$(grep -cx 'https://splify2-telemetry-panel.vercel.app/api/ingest' "$T/curl.argv" || true)"
check "и с ЗАШИТЫМ ключом записи" "1" \
      "$(grep -cx 'X-Splify2-Key: 3056a9de05e4085a4f57b0410fc45cb0' "$T/curl.argv" || true)"
# Своя панель поднимается одной строкой в настройке и без правки пакета.
uset splify2.main.telemetry_url "https://panel.example/ingest"
uset splify2.main.telemetry_key "K3Y SECRET"
send --send >/dev/null 2>&1
check "настройка переопределяет зашитый адрес" "1" \
      "$(grep -cx 'https://panel.example/ingest' "$T/curl.argv" || true)"
check "и зашитого адреса среди аргументов тогда нет" "0" \
      "$(grep -c 'vercel.app' "$T/curl.argv" || true)"
check "настройка переопределяет и ключ" "1" \
      "$(grep -cx 'X-Splify2-Key: K3Y SECRET' "$T/curl.argv" || true)"

# Пакет с настройками роутера не остаётся лежать в /tmp.
send --send >/dev/null 2>&1
check "временный файл с пакетом убран" "0" \
      "$(ls /tmp/splify2-telemetry.* 2>/dev/null | grep -c . || true)"

# ---- расхождение стратегии с каталогом: поле считалось БЕЗ имени стратегии ---------------
#
# `zp_drifted_global` принимает ИМЯ стратегии первым аргументом и первой же строкой выходит,
# если его нет. Здесь её звали вовсе без аргументов — вызов выглядел настоящим (знакомое имя,
# глушилка вывода, `&& echo 1 || echo 0`), а отвечал «не разошлась» ВСЕГДА. Тот же класс, что
# I-156, и та же цена: панель по построению не могла увидеть ни одного роутера с расхождением,
# а «расхождений нет ни у кого» неотличимо от «мы этого не измеряем».
#
# На самом роутере признак при этом считался верно — вкладка обхода и отчёт для поддержки
# зовут ту же функцию с именем, — поэтому увидеть ошибку можно было только со стороны панели.
printf '#v1\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" \
    > "$T/etc/config-zapret"
pkt="$(build 2>/dev/null)"
check "стратегия из каталога уезжает по имени" "v1" "$(j 'd["zapret"]["strategy"]')"
check "совпавшая с каталогом расхождением не считается" "False" "$(j 'd["zapret"]["drifted"]')"

# Каталог обновился, применённое осталось прежним — это и есть то состояние, ради которого
# поле заведено, и именно оно не уезжало.
printf '#v1\n--filter-tcp=443\n--dpi-desync=fake\n' > "$T/zapret/strategies.txt"
pkt="$(build 2>/dev/null)"
check "изменившаяся в каталоге уезжает расхождением" "True" "$(j 'd["zapret"]["drifted"]')"

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
