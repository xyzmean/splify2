#!/bin/sh
# Стенд фоновой проверки стратегий обхода DPI (usr/sbin/splify2-zapret-test).
#
# ЗАЧЕМ. До этого стенда у проверки не было ни одного: она нуждается в nft, nfqws и сети, и
# проверялась только живым прогоном на роутере — то есть раз в несколько недель и глазами.
# Так в ней прожили три ошибки, которые видно только по результату: остановленная проверка не
# оставляла ничего, одиночной проверки не было, а «какие сайты открылись» знала только она сама.
# Здесь всё внешнее подменено заглушками в PATH: nft молча соглашается, nfqws спит, curl
# отвечает «открылось» тем сайтам, что названы в CURL_OK. Стратегии и цели настоящие — из
# каталога стенда и из снимка dpi-checkers, который едет в пакете.
#
# Что сторожится:
#   1. Наборов целей два, по семействам: Flowseal и v — общий (сайты менеджера + dpi-checkers),
#      Yv — домены YouTube; у каждого свой контрольный проход.
#   2. Результат каждой стратегии несёт свой набор, число целей и ПЕРЕЧЕНЬ открывшихся.
#   3. Одиночная проверка (one:имя) обновляет одну строку и не трогает остальные.
#   4. Остановка на середине оставляет сделанное и убирает за собой.
set -u
cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
SCRIPT=files/usr/sbin/splify2-zapret-test
[ -s "$SCRIPT" ] || { echo "нет $SCRIPT"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "нужен python3"; exit 2; }

pass=0 fail=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  вышло:     %s\n' "$1" "$2" "$3"
    fi
}

jq() {  # ФАЙЛ ВЫРАЖЕНИЕ_PYTHON — значение из JSON одной строкой
    python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
v=eval(sys.argv[2])
print(",".join(v) if isinstance(v,list) else v)' "$1" "$2" 2>/dev/null
}

# ---- заглушки --------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/zapret" "$T/run"
# nft: соглашается со всем; `-f -` читает правила со стандартного ввода — их надо съесть.
cat > "$T/bin/nft" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/nft.log"
[ "$1" = "-f" ] && cat >> "$SANDBOX/nft-rules.log"
exit 0
EOF
# curl: последний аргумент — ссылка; «открылось», если её хост назван в CURL_OK.
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
for u; do :; done
h="${u#*://}"; h="${h%%/*}"
for ok in $CURL_OK; do [ "$h" = "$ok" ] && exit 0; done
exit 28
EOF
cat > "$T/bin/logger" <<'EOF'
#!/bin/sh
exit 0
EOF
# nfqws: --dry-run одобряет ключи, иначе сидит на «очереди», пока не убьют.
cat > "$T/bin/nfqws" <<'EOF'
#!/bin/sh
case "$*" in *--dry-run*) exit 0 ;; esac
echo "$$" >> "$SANDBOX/nfqws.pids"
sleep 60
EOF
chmod +x "$T"/bin/*

printf '#general (ALT)\n--filter-tcp=443\n--dpi-desync=fake\n\n#v1\n--filter-tcp=443\n--dpi-desync=multisplit\n\n#Yv01\n--filter-tcp=443\n--hostlist=/x\n' \
    > "$T/zapret/strategies.txt"

# Запуск ФОНОМ — тем же окружением, но не через функцию: `run … &` дал бы pid подоболочки,
# а не самого скрипта, и TERM в неё скрипта бы не достиг (стенд это и поймал).
runbg() {
    env SANDBOX="$T" PATH="$T/bin:$PATH" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" FETCH_SH=/dev/null \
        ZP_DIR="$T/zapret" ZP_CATALOG="$T/zapret/strategies.txt" \
        ZP_RESULTS="$T/zapret/results.json" ZP_RESULTS_DIR="$T/zapret/results.d" \
        ZP_PROGRESS="$T/run/progress" ZP_PIDFILE="$T/run/pid" \
        ZP_NFQWS="$T/bin/nfqws" ZT_DPI_SNAPSHOT="$ROOT/files/usr/share/splify2/dpi-suite.json" \
        ZT_CURL="$T/bin/curl" ZT_QUEUE=8399 ZT_TABLE=splify2_ztest_stand \
        CURL_OK="${CURL_OK:-}" \
        sh "$SCRIPT" "$@" >/dev/null 2>&1 &
    bg=$!
}

run() {  # ключи скрипта
    env SANDBOX="$T" PATH="$T/bin:$PATH" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" FETCH_SH=/dev/null \
        ZP_DIR="$T/zapret" ZP_CATALOG="$T/zapret/strategies.txt" \
        ZP_RESULTS="$T/zapret/results.json" ZP_RESULTS_DIR="$T/zapret/results.d" \
        ZP_PROGRESS="$T/run/progress" ZP_PIDFILE="$T/run/pid" \
        ZP_NFQWS="$T/bin/nfqws" ZT_DPI_SNAPSHOT="$ROOT/files/usr/share/splify2/dpi-suite.json" \
        ZT_CURL="$T/bin/curl" ZT_QUEUE=8399 ZT_TABLE=splify2_ztest_stand \
        CURL_OK="${CURL_OK:-}" \
        sh "$SCRIPT" "$@"
}

# ---- полный прогон ------------------------------------------------------------------------
: > "$T/nft.log"
CURL_OK="rutracker.org discord.com youtube.com i.ytimg.com" run --scope all >/dev/null 2>&1
check "прогон завершился" "0" "$?"
R="$T/zapret/results.json"
check "сводка написана и разбирается" "yes" "$(python3 -c "import json;json.load(open('$R'))" 2>/dev/null && echo yes || echo no)"
check "три стратегии в сводке" "3" "$(jq "$R" 'str(len(d["results"]))')"
check "набор общий: сайты менеджера плюс снимок dpi-checkers" "59" "$(jq "$R" 'str(d["sets"]["general"]["total"])')"
check "набор YouTube: домены менеджера" "37" "$(jq "$R" 'str(d["sets"]["youtube"]["total"])')"
check "контроль общего набора: открылось без обхода то, что открылось" "rutracker.org,discord.com" "$(jq "$R" 'd["sets"]["general"]["opened"]')"
check "контроль YouTube — свой" "2" "$(jq "$R" 'str(d["sets"]["youtube"]["baseline"])')"
check "верхние числа — про общий набор" "59/2" "$(jq "$R" 'str(d["targets"])+"/"+str(d["baseline"])')"
check "Yv мерится набором YouTube" "youtube" "$(jq "$R" '[r for r in d["results"] if r["name"]=="Yv01"][0]["set"]')"
check "и его число целей — целей YouTube" "37" "$(jq "$R" 'str([r for r in d["results"] if r["name"]=="Yv01"][0]["total"])')"
check "v мерится общим набором" "general" "$(jq "$R" '[r for r in d["results"] if r["name"]=="v1"][0]["set"]')"
check "у стратегии названы открывшиеся цели" "rutracker.org,discord.com" "$(jq "$R" '[r for r in d["results"] if r["name"]=="v1"][0]["opened"]')"
check "порядок открывшихся — как у целей, а не как ответили" "youtube.com,i.ytimg.com" \
      "$(jq "$R" '[r for r in d["results"] if r["name"]=="Yv01"][0]["opened"]')"
check "таблица изоляции снята в конце" "yes" "$(grep -q 'delete table inet splify2_ztest_stand' "$T/nft.log" && echo yes || echo no)"
# Порождённые обработчиком пакеты снимаются с учёта conntrack своей цепочкой, а не цепочкой
# службы zapret: без неё при выключенном общем обходе каждая стратегия мерилась как «без обхода».
check "у таблицы изоляции своя predefrag до conntrack" "yes" \
      "$(grep -q 'hook output priority -401' "$T/nft-rules.log" && echo yes || echo no)"
check "четыре правила notrack, как у zapret" "4" "$(grep -c ' notrack comment' "$T/nft-rules.log")"
check "обработчики не остались" "0" "$(for p in $(cat "$T/nfqws.pids" 2>/dev/null); do kill -0 "$p" 2>/dev/null && echo x; done | grep -c x)"
check "файл хода — done" "state=done" "$(head -1 "$T/run/progress")"

# ---- одиночная проверка -------------------------------------------------------------------
CURL_OK="rutracker.org discord.com x.com openwrt.org" run --scope one:v1 >/dev/null 2>&1
check "одиночный прогон завершился" "0" "$?"
check "строк в сводке по-прежнему три" "3" "$(jq "$R" 'str(len(d["results"]))')"
check "v1 обновлена" "4" "$(jq "$R" 'str([r for r in d["results"] if r["name"]=="v1"][0]["ok"])')"
check "general (ALT) осталась прежней" "2" "$(jq "$R" 'str([r for r in d["results"] if r["name"]=="general (ALT)"][0]["ok"])')"
check "набор YouTube не пересчитывался" "2" "$(jq "$R" 'str(d["sets"]["youtube"]["baseline"])')"
check "сводка отсортирована по доле" "v1" "$(jq "$R" 'd["results"][0]["name"]')"

# Неизвестная стратегия — отказ с записью в файл хода, а не молчаливый ноль.
run --scope "one:нет такой" >/dev/null 2>&1
check "чужое имя — отказ" "2" "$?"
check "и причина в файле хода" "yes" "$(grep -q 'state=error' "$T/run/progress" && echo yes || echo no)"

# ---- остановка на середине ----------------------------------------------------------------
: > "$T/nft.log"; : > "$T/nfqws.pids"
rm -rf "$T/zapret/results.d" "$R"
CURL_OK="rutracker.org" runbg --scope all
# Ждём, пока первая стратегия будет записана, и обрываем — как делает zapret_test_stop.
i=0
while [ $i -lt 100 ] && [ "$(ls "$T/zapret/results.d" 2>/dev/null | grep -vc '^_')" -lt 1 ]; do
    sleep 0.1; i=$((i + 1))
done
kill -TERM "$bg" 2>/dev/null
wait "$bg" 2>/dev/null
sleep 0.3
check "остановленная проверка оставила сделанное" "yes" \
      "$([ -s "$R" ] && [ "$(jq "$R" 'str(len(d["results"]))')" -ge 1 ] && echo yes || echo no)"
check "и сняла таблицу изоляции" "yes" "$(grep -q 'delete table inet splify2_ztest_stand' "$T/nft.log" && echo yes || echo no)"
check "и убила обработчик" "0" "$(for p in $(cat "$T/nfqws.pids" 2>/dev/null); do kill -0 "$p" 2>/dev/null && echo x; done | grep -c x)"
for p in $(cat "$T/nfqws.pids" 2>/dev/null); do kill "$p" 2>/dev/null; done

printf '\n%s проверок, %s провалов\n' "$((pass + fail))" "$fail"
[ "$fail" = 0 ]
