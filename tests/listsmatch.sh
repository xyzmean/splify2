#!/bin/sh
# Стенд для splify2-update-lists: проверяется выбор URL по списку из спеки.
#
# Зачем именно так. Скрипт целиком состоит из обращений к системе — uci, jsonfilter,
# curl, steer, /etc/init.d — поэтому «вызвать функцию и посмотреть на результат» здесь
# не работает: функции не существуют отдельно от окружения. Стенд поднимает окружение
# целиком в каталоге-песочнице: подменяет внешние команды заглушками в PATH и
# переопределяет пути переменными (тот самый шов в шапке скрипта). Скрипт при этом
# запускается настоящий, целиком, как на роутере.
#
# Что проверяется. Коллизия имён: в манифесте ru-bypass-ipsets `news.lst` есть и среди
# адресных списков (`categories`), и среди доменных (`domain_lists`, файл
# `domains/news.lst`). Пока карта строилась по basename, оба ключа сливались в один,
# `url_for` брал первое совпадение (адресное) — и доменный список качался по адресу
# адресного. Проверка содержимого видела CIDR вместо доменов и оставляла прежний файл:
# список не обновлялся никогда, а в журнале стояло обвинение издателя.
#
# Запуск: sh tests/listsmatch.sh (нужен python3 — только для заглушки jsonfilter).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/files/usr/sbin/splify2-update-lists"
T="$(mktemp -d /tmp/listsmatch.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM

fails=0
check() {  # ОПИСАНИЕ ОЖИДАЕМОЕ ПОЛУЧЕННОЕ
    if [ "$2" = "$3" ]; then
        printf '%-58s ok\n' "$1"
    else
        printf '%-58s ПРОВАЛ\n' "$1"
        printf '    ожидалось: %s\n    получено:  %s\n' "$2" "$3"
        fails=$((fails + 1))
    fi
}

mkdir -p "$T/bin" "$T/lists/domains" "$T/etc" "$T/var"

# ---- заглушки внешних команд -------------------------------------------------
# jsonfilter: поддерживаются ровно те выражения, которые использует скрипт.
cat > "$T/bin/jsonfilter" <<'EOF'
#!/bin/sh
file=""; expr=""
while [ $# -gt 0 ]; do
    case "$1" in
        -i) file="$2"; shift 2 ;;
        -e) expr="$2"; shift 2 ;;
        *) shift ;;
    esac
done
python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path, encoding='utf-8'))
except Exception:
    sys.exit(1)
if expr == '@.base_url':
    print(d.get('base_url', ''))
elif expr in ('@.categories[*].file', '@.domain_lists[*].file'):
    key = 'categories' if 'categories' in expr else 'domain_lists'
    for e in d.get(key, []):
        print(e['file'])
elif expr in ('@.aliases[*].from', '@.aliases[*].to'):
    field = expr.rsplit('.', 1)[1]
    for e in d.get('aliases', []):
        print(e[field])
elif expr.endswith('prefixes_files[*]') or expr.endswith('domains_files[*]'):
    field = 'prefixes_files' if 'prefixes' in expr else 'domains_files'
    for ch in d.get('channels', []):
        for f in ch.get('match', {}).get(field, []):
            print(f)
PY
EOF

# curl: пишет в файл содержимое, зависящее от URL, и протоколирует запрос. Содержимое
# намеренно РАЗНОЕ по виду: адресный список — CIDR, доменный — имена. Именно на этом
# различии и видно, за каким файлом скрипт на самом деле сходил.
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
echo "$url" >> "$SANDBOX/requested"
case "$url" in
    *categories.json) cp "$SANDBOX/manifest.src" "$out" ;;
    */domains/*)      printf 'example.org\nnews.example\n' > "$out" ;;
    *)                printf '10.0.0.0/8\n192.0.2.0/24\n' > "$out" ;;
esac
EOF

# steer: fit пропускает список как есть, apply молча соглашается.
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
cmd="${1:-}"
case "$cmd" in
    fit)
        src=""
        for a in "$@"; do src="$a"; done
        cat "$src"
        ;;
    apply) exit 0 ;;
esac
exit 0
EOF

# logger: журнал скрипта уходит в syslog, а в stdout — только при терминале
# (`[ -t 1 ]` в log()). Под стендом терминала нет, поэтому всё, что скрипт говорит
# человеку, видно ТОЛЬКО здесь. Раньше заглушка молча возвращала 0, и любая проверка
# журнала проходила на пустоте — то есть не проверяла ничего.
cat > "$T/bin/logger" <<EOF
#!/bin/sh
while [ \$# -gt 0 ]; do
    case "\$1" in
        -t) shift 2 ;;
        *) break ;;
    esac
done
echo "\$*" >> "$T/syslog"
exit 0
EOF
: > "$T/syslog"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/uci"          # manifest_url не задан — берётся дефолтный
chmod +x "$T/bin"/*

# ---- фикстуры ----------------------------------------------------------------
# Манифест с коллизией: news.lst и как адресный, и как доменный (domains/news.lst).
cat > "$T/manifest.src" <<EOF
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "news", "file": "news.lst" },
                    { "id": "rkn",  "file": "rkn.lst" } ],
  "domain_lists": [ { "id": "news", "file": "domains/news.lst" } ],
  "aliases":      [ { "from": "rkn_other.lst", "to": "rkn.lst" } ]
}
EOF

# Спека ссылается на rkn_other.lst — имя, которого у издателя больше нет. Ровно тот
# случай, ради которого заведены aliases: без них список молча замирает навсегда.
cat > "$T/etc/spec.json" <<EOF
{
  "schema": 1,
  "channels": [
    { "name": "c1", "match": { "prefixes_files": ["$T/lists/news.lst"],
                               "domains_files":  ["$T/lists/domains/news.lst"] } },
    { "name": "c2", "match": { "prefixes_files": ["$T/lists/rkn_other.lst"] } }
  ]
}
EOF

printf '0.0.0.0/32\n'  > "$T/lists/news.lst"
printf 'old.example\n' > "$T/lists/domains/news.lst"
printf '0.0.0.0/32\n'  > "$T/lists/rkn_other.lst"

# ---- прогон ------------------------------------------------------------------
SANDBOX="$T" \
PATH="$T/bin:$PATH" \
STEER="$T/bin/steer" \
SPEC="$T/etc/spec.json" \
LISTS="$T/lists" \
MANIFEST="$T/etc/manifest.json" \
STAMP="$T/var/last-update" \
LOCK="$T/var/update.lock" \
FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    sh "$SCRIPT" > "$T/out" 2>&1

# ---- проверки ----------------------------------------------------------------
dom_url="$(grep 'domains/news.lst' "$T/requested" 2>/dev/null | head -1)"
check "доменный список качается по адресу доменного (I-011)" \
      "https://example.invalid/lists/domains/news.lst" "${dom_url:-НЕ ЗАПРАШИВАЛСЯ}"

check "адресный список качается по адресу адресного" \
      "https://example.invalid/lists/news.lst" \
      "$(grep -x 'https://example.invalid/lists/news.lst' "$T/requested" 2>/dev/null | head -1)"

check "доменный файл содержит домены, а не CIDR" \
      "example.org" "$(head -1 "$T/lists/domains/news.lst")"

check "адресный файл содержит CIDR" \
      "10.0.0.0/8" "$(head -1 "$T/lists/news.lst")"

check "в журнале нет обвинения издателя в непохожем содержимом" \
      "" "$(grep -o 'не похожи на [a-z]*-записи' "$T/syslog" 2>/dev/null | head -1)"

# ---- переименование списка у издателя ----------------------------------------
# Издатель схлопнул семнадцать списков в два. Настроенная спека ссылается на старое имя;
# без разрешения алиасов скрипт написал бы «нет в манифесте, пропущен», и список остался
# бы лежать прежней копией НАВСЕГДА, без признака ошибки.
check "переименованный список скачан по новому адресу" \
      "https://example.invalid/lists/rkn.lst" \
      "$(grep -x 'https://example.invalid/lists/rkn.lst' "$T/requested" 2>/dev/null | head -1)"

check "содержимое легло по прежнему пути — спека продолжает работать" \
      "10.0.0.0/8" "$(head -1 "$T/lists/rkn_other.lst" 2>/dev/null)"

check "переименование названо в журнале вслух" \
      "yes" "$(grep -q 'переименовал в rkn.lst' "$T/syslog" && echo yes || echo no)"

check "пропуска по причине «нет в манифесте» не было" \
      "" "$(grep -o 'rkn_other.lst: нет в манифесте' "$T/syslog" 2>/dev/null | head -1)"

# ---- откат возвращает и ДОМЕННЫЕ списки тоже -----------------------------------
#
# Копии кладутся рядом с файлом, а доменные списки лежат в подкаталоге domains/ — глоб
# "$LISTS"/*.prev туда не заходит. Откат поэтому возвращал только адресные: повторный
# apply падал на том же доменном файле, и в журнал уходило «ОТКАТ НЕ ПОМОГ», при
# полностью исправном механизме отката. Заодно доменные .prev не удалялись никогда и
# занимали на overlay двойной объём.
#
# Прогон второй, отдельный: движок теперь отвергает применение, то есть срабатывает
# ровно ветка отката.
rm -rf "$T/lists" "$T/var/last-update"
mkdir -p "$T/lists/domains"
printf 'prev-address.example/32\n' > "$T/lists/news.lst"
printf 'prev-domain.example\n'     > "$T/lists/domains/news.lst"
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
case "${1:-}" in
    fit) src=""; for a in "$@"; do src="$a"; done; cat "$src" ;;
    apply) exit 1 ;;          # движок отвергает — включается откат
esac
exit 0
EOF
chmod +x "$T/bin/steer"

SANDBOX="$T" PATH="$T/bin:$PATH" STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" MANIFEST="$T/etc/manifest.json" STAMP="$T/var/last-update" LOCK="$T/var/update.lock" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh"     sh "$SCRIPT" > "$T/out2" 2>&1

check "откат вернул адресный список" "prev-address.example/32" \
      "$(cat "$T/lists/news.lst" 2>/dev/null)"
check "откат вернул и ДОМЕННЫЙ список" "prev-domain.example" \
      "$(cat "$T/lists/domains/news.lst" 2>/dev/null)"
check "копий .prev после отката не осталось" "" \
      "$(find "$T/lists" -name '*.prev' 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"

# ---- просадка объёма: кратно поредевший список не применяется (R-085, I-118) ----
#
# Проверка формы («строки похожи на записи») пропускает файл, в котором записи выглядят
# правильно, но их кратно меньше прежних. Ровно так выглядела беда I-118: одиннадцать
# снапшотов из четырнадцати вышли с четвертью потерянного покрытия (geoblock.lst — 77
# префиксов против 420), и по самим файлам это не видно — они правильные, просто
# короткие. Роутер их принимал и применял: собственного рубежа у него не было вовсе,
# всё держалось на том, что гейты генератора беду не пропустят.
#
# Прогон третий, со своим манифестом и своей спекой: здесь важны РАЗМЕРЫ файлов, а не
# коллизия имён, поэтому имена списков нарочно разные.
rm -rf "$T/lists" "$T/var/last-update" "$T/requested"
mkdir -p "$T/lists/domains" "$T/serve"

cat > "$T/manifest.src" <<EOF
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "big",   "file": "big.lst" },
                    { "id": "mild",  "file": "mild.lst" },
                    { "id": "small", "file": "small.lst" } ],
  "domain_lists": [ { "id": "dom",   "file": "domains/dom.lst" } ]
}
EOF

cat > "$T/etc/spec.json" <<EOF
{
  "schema": 1,
  "channels": [
    { "name": "c1", "match": { "prefixes_files": ["$T/lists/big.lst",
                                                  "$T/lists/mild.lst",
                                                  "$T/lists/small.lst"],
                               "domains_files":  ["$T/lists/domains/dom.lst"] } }
  ]
}
EOF

# curl отдаёт заранее положенное тело по имени файла: размерами иначе не поуправлять.
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
echo "$url" >> "$SANDBOX/requested"
case "$url" in
    *categories.json) cp "$SANDBOX/manifest.src" "$out" ;;
    *) body="$SANDBOX/serve/$(basename "$url")"
       if [ -f "$body" ]; then cp "$body" "$out"; else printf '10.0.0.0/8\n' > "$out"; fi ;;
esac
EOF
# steer снова соглашается: проверяется рубеж ДО применения, а не откат после.
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
case "${1:-}" in
    fit) src=""; for a in "$@"; do src="$a"; done; cat "$src" ;;
    apply) exit 0 ;;
esac
exit 0
EOF
chmod +x "$T/bin/curl" "$T/bin/steer"

cidrs() { awk -v n="$1" 'BEGIN { for (i = 0; i < n; i++) printf "10.%d.%d.0/24\n", int(i / 256), i % 256 }'; }

cidrs 400 > "$T/lists/big.lst"      # прежний большой список
cidrs 40  > "$T/serve/big.lst"      #   пришёл в десять раз короче — это авария
cidrs 400 > "$T/lists/mild.lst"     # прежний большой список
cidrs 300 > "$T/serve/mild.lst"     #   минус четверть — законная смена состава категории
cidrs 8   > "$T/lists/small.lst"    # мелкий список
cidrs 2   > "$T/serve/small.lst"    #   кратно меньше, но на восьми записях это обычная жизнь
printf 'a.example\nb.example\n' > "$T/lists/domains/dom.lst"
printf '# всё вычистили\n'      > "$T/serve/dom.lst"   # записей не осталось вовсе

: > "$T/syslog"
SANDBOX="$T" PATH="$T/bin:$PATH" STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" MANIFEST="$T/etc/manifest.json" STAMP="$T/var/last-update" LOCK="$T/var/update.lock" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    sh "$SCRIPT" > "$T/out3" 2>&1
rc3=$?

check "кратно поредевший список не подменён" "400" \
      "$(grep -c . "$T/lists/big.lst" 2>/dev/null)"
check "в журнале названы и файл, и оба числа" "yes" \
      "$(grep -q 'big.lst: записей в скачанном 40 против 400 прежних' "$T/syslog" && echo yes || echo no)"
check "минус четверть — законное изменение, список обновлён" "300" \
      "$(grep -c . "$T/lists/mild.lst" 2>/dev/null)"
check "на мелком списке кратность ничего не значит — обновлён" "2" \
      "$(grep -c . "$T/lists/small.lst" 2>/dev/null)"
check "доменный список без записей не подменён" "2" \
      "$(grep -c . "$T/lists/domains/dom.lst" 2>/dev/null)"
check "остальные списки применены, обновление не свёрнуто целиком" "yes" \
      "$(grep -q 'правила применены' "$T/syslog" && echo yes || echo no)"
check "просадка объёма поднимает признак неудачи" "1" "$rc3"

# ---- порог снят вручную: список применяется, пустой файл всё равно нет --------------
#
# Кратная просадка бывает и законной — издатель схлопнул категорию, и роутеру об этом
# знать неоткуда. Тогда человек снимает порог (`uci set splify2.main.list_shrink_factor=0`,
# здесь — тем же швом через окружение). Файл без записей это не отменяет: после такой
# подмены канал не совпадёт ни с чем.
rm -f "$T/var/last-update"
cidrs 400 > "$T/lists/big.lst"
printf 'a.example\nb.example\n' > "$T/lists/domains/dom.lst"
: > "$T/syslog"
SANDBOX="$T" PATH="$T/bin:$PATH" STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" MANIFEST="$T/etc/manifest.json" STAMP="$T/var/last-update" LOCK="$T/var/update.lock" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    SHRINK_FACTOR=0 sh "$SCRIPT" > "$T/out4" 2>&1

check "порог снят — кратно поредевший список применён" "40" \
      "$(grep -c . "$T/lists/big.lst" 2>/dev/null)"
check "порог снят, но файл без записей всё равно не применён" "2" \
      "$(grep -c . "$T/lists/domains/dom.lst" 2>/dev/null)"

printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'все проверки прошли' || echo 'ЕСТЬ ПРОВАЛЫ')"
[ "$fails" -eq 0 ]
