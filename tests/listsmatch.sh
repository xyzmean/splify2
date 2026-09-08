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
# НЕСКОЛЬКО -e В ОДНОМ ВЫЗОВЕ, как это делает настоящий jsonfilter. Прежняя заглушка
# запоминала только последнее выражение, и вызов `-e prefixes_files -e domains_files`
# (именно так спрашивает fetch_missing_lists) отдавал одни доменные списки. Из-за этого
# стенд не видел половину работы: адресные файлы спеки в цикл доскачивания не попадали
# вовсе, и проверка на них была бы зелена при любом поведении кода.
file=""
exprs=""
while [ $# -gt 0 ]; do
    case "$1" in
        -i) file="$2"; shift 2 ;;
        # Выражения СКЛАДЫВАЮТСЯ в аргументы, а не в stdin: тело заглушки приходит сюда
        # heredoc-ом, то есть stdin занят, и прочитанное оттуда было бы исходником python.
        -e) exprs="$exprs $2"; shift 2 ;;
        *) shift ;;
    esac
done
# shellcheck disable=SC2086
python3 - "$file" $exprs <<'PY'
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path, encoding='utf-8'))
except Exception:
    sys.exit(1)
for expr in sys.argv[2:]:
  if expr == '@.base_url':
    print(d.get('base_url', ''))
  elif expr in ('@.categories[*].file', '@.domain_lists[*].file'):
    key = 'categories' if 'categories' in expr else 'domain_lists'
    for e in d.get(key, []):
        print(e['file'])
  elif expr.startswith('@.categories[@.format=') or expr.startswith('@.domain_lists[@.format='):
    # Записи-наборы: фильтр по format плюс имя поля. Заглушка обязана уметь ровно это
    # выражение, иначе карта манифеста собиралась бы без наборов, и стенд был бы зелен
    # при любом их поведении.
    key = 'categories' if 'categories' in expr else 'domain_lists'
    field = expr.rsplit('.', 1)[1]
    for e in d.get(key, []):
        if e.get('format') == 'srs' and field in e:
            print(e[field])
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
    *categories.json|*lists.json) cp "$SANDBOX/manifest.src" "$out" ;;
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

# Заглушка команды телеметрии: оставляет след. Нужна ровно для того, чтобы проверка «её не
# звали» была проверкой, а не совпадением: настоящей команды на машине стенда нет, и без
# заглушки скрипт молчал бы по одной лишь недоступности файла.
cat > "$T/bin/telemetry-stub" <<EOF
#!/bin/sh
printf 'звали: %s\n' "\$*" > "$T/telemetry-called"
EOF
chmod +x "$T/bin/telemetry-stub"

# ---- прогон ------------------------------------------------------------------
SANDBOX="$T" \
PATH="$T/bin:$PATH" \
STEER="$T/bin/steer" \
SPEC="$T/etc/spec.json" \
LISTS="$T/lists" \
MANIFEST="$T/etc/manifest.json" \
STAMP="$T/var/last-update" \
LOCK="$T/var/update.lock" \
REPORT="$T/report" \
TELEMETRY="$T/bin/telemetry-stub" \
FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    sh "$SCRIPT" > "$T/out" 2>&1

# ---- проверки ----------------------------------------------------------------
# ТЕЛЕМЕТРИЮ ОТСЮДА БОЛЬШЕ НЕ ЗОВУТ. Она уезжает раз в час и живёт своим заданием крона;
# пока вызов висел хвостом ночного обновления, в час этого задания отправок было бы две.
# Проверка по следствию: заглушка, оставляющая след, подставлена в тот самый шов (TELEMETRY),
# которым скрипт звал команду, — след не должен появиться ни разу.
check "обновление списков телеметрию не отправляет" "нет" \
      "$([ -e "$T/telemetry-called" ] && cat "$T/telemetry-called" || echo нет)"

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

# REPORT — то же, что уходит в syslog, но файлом. Через него отвечает кнопка «Обновить
# списки» в каталоге: rpcd зовёт этот же скрипт не из терминала, где его log() молчит, и
# без файла человеку осталось бы читать журнал ради ответа на нажатие кнопки.
check "отчёт файлом заполнен" \
      "yes" "$([ -s "$T/report" ] && echo yes || echo no)"

check "в отчёте те же строки, что в журнале" \
      "yes" "$(grep -q 'news.lst: обновлён' "$T/report" && echo yes || echo no)"

check "прогон без REPORT ничего лишнего не пишет" \
      "yes" "$([ ! -f "$T/lists/report" ] && echo yes || echo no)"

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
    *categories.json|*lists.json) cp "$SANDBOX/manifest.src" "$out" ;;
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

# ---- второй издатель: itdoginfo/allow-domains, наборы .srs ----------------------
#
# ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЗАЧЕМ. Списки этого издателя приезжают не текстом, а двоичным
# набором sing-box (в релизе текстовых файлов нет ни одного), и раскладывает их на наши
# два вида списка сам движок — `steer srs-read`. У управляющего слоя поэтому три новых
# обязанности, и каждая ниже названа отдельной проверкой:
#
#   1. Версия зафиксирована ТЕГОМ. Плавающий `latest` означает, что состав списков у
#      человека меняется сам собой раз в неделю, ночью, и объяснить «вчера пускало, сегодня
#      нет» нечем: сравнивать не с чем.
#   2. Домены и подсети — в РАЗНЫЕ файлы: у нас это два разных вида списка, и схлопывание
#      двух списков в один проект уже проходил (I-011).
#   3. Отказ движка с кодом 2 («понят, но не выразим») и с кодом 1 («не наш файл или
#      испорчен») — это РАЗНЫЕ беды: первая значит «такой список нам пока не подходит»,
#      вторая — «скачалось битое». Сказать человеку одно и то же в обоих случаях значит
#      обвинить сеть в том, чего она не делала.
#
# Образцы наборов НАСТОЯЩИЕ (tests/srs — копии из стенда движка), поэтому подпись формата и
# отказ discord проверяются на том, что издатель действительно публикует. Сети стенду при
# этом не нужно: движок здесь заглушка, и она отвечает по тем же правилам, что настоящая
# команда, — по СОДЕРЖИМОМУ поданного файла, а не по его имени (скачанное лежит во
# временном файле, имени сервиса в нём нет).
AD_TAG=2000-01-01_00-00
AD_TAG2=2000-02-02_11-22

mkdir -p "$T/srs"
cp "$ROOT/tests/srs/"*.srs "$ROOT/tests/srs/"*.lst "$T/srs/"
# Мусор вместо набора: подписи SRS нет, и настоящая команда отвечает на это кодом 1.
printf 'not an srs at all\n' > "$T/srs/news.srs"

# uci: хранилище файлом, только `-q get`. Прежняя заглушка отвечала отказом ВСЕГДА, и
# проверить «тег взят из uci» ею было нечем. С пустым хранилищем поведение то же, что было.
cat > "$T/bin/uci" <<'EOF'
#!/bin/sh
key=""
for a in "$@"; do key="$a"; done
[ -f "$SANDBOX/uci.store" ] || exit 1
v=""
while IFS= read -r l; do
    case "$l" in "$key="*) v="${l#*=}" ;; esac
done < "$SANDBOX/uci.store"
[ -n "$v" ] || exit 1
printf '%s\n' "$v"
EOF
: > "$T/uci.store"

# curl: отдаёт ТОЛЬКО то, что издатель действительно опубликовал по этому адресу. На всё
# прочее — отказ, и это важно: иначе обходные пути GitHub (зеркало, api, архив) «успешно»
# приносили бы мусор, и проверка «набор не скачался» проходила бы на пустоте.
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
    *categories.json|*lists.json) cp "$SANDBOX/manifest.src" "$out" ;;
    */releases/download/*/*.srs)
        tag="${url%/*}"; tag="${tag##*/}"
        svc="${url##*/}"; svc="${svc%.srs}"
        # Тег в адресе обязан быть тем, который зафиксирован: чужой релиз отдаёт 404,
        # и подменять это «отдам что попросили» значило бы не проверять фиксацию вовсе.
        [ "$tag" = "$SRS_TAG" ] || exit 1
        [ -f "$SANDBOX/srs/$svc.srs" ] || exit 1
        cp "$SANDBOX/srs/$svc.srs" "$out"
        ;;
    *rkn.lst) printf '10.0.0.0/8\n' > "$out" ;;
    *) exit 1 ;;
esac
exit 0
EOF

# steer: та же команда, что на роутере, и с тем же контрактом — коды 0/1/2, домены и
# подсети в разные файлы. Какой именно набор подан — решается сравнением с образцами, а не
# по имени файла (см. шапку раздела).
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
case "${1:-}" in
    fit) src=""; for a in "$@"; do src="$a"; done; cat "$src"; exit 0 ;;
    apply) exit 0 ;;
    srs-read) ;;
    *) exit 0 ;;
esac
f="$2"; shift 2
out=""; pfx=""; meta=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) out="$2"; shift 2 ;;
        --prefixes-out) pfx="$2"; shift 2 ;;
        --meta-out) meta="$2"; shift 2 ;;
        *) shift ;;
    esac
done
case "$(dd if="$f" bs=3 count=1 2>/dev/null)" in
    SRS) ;;
    *) echo 'steer: srs: это не набор правил sing-box (нет подписи SRS)' >&2; exit 1 ;;
esac
for s in "$SANDBOX"/srs/*.srs; do
    cmp -s "$f" "$s" || continue
    b="${s##*/}"; b="${b%.srs}"
    # discord сужен по протоколу и портам: движок отдаёт сужение ТРЕТЬИМ потоком, а без
    # `--meta-out` отвергает набор кодом 2 (steer e4fa98a) — иначе подсети Cloudflare уехали
    # бы в туннель без «только udp».
    if [ "$b" = discord ]; then
        if [ -z "$meta" ]; then
            echo 'steer: srs: набор сужен по протоколу или портам — нужен --meta-out, иначе сужение потеряется, а подсети уедут в туннель целиком' >&2
            exit 2
        fi
        printf 'proto=udp\nports=50000-65535,19000-20000\n' > "$meta"
    else
        [ -n "$meta" ] && : > "$meta"
    fi
    [ -n "$out" ] && awk 1 "$SANDBOX/srs/$b.lst" > "$out"
    if [ -n "$pfx" ]; then
        if [ -f "$SANDBOX/srs/$b-subnets.lst" ]; then awk 1 "$SANDBOX/srs/$b-subnets.lst" > "$pfx"
        else : > "$pfx"; fi
    fi
    exit 0
done
echo 'steer: srs: набор не разобрался' >&2
exit 1
EOF
chmod +x "$T/bin/uci" "$T/bin/curl" "$T/bin/steer"

# Манифест ПЕРВОГО издателя остаётся на месте: второй источник заведён РЯДОМ, а не вместо.
cat > "$T/manifest.src" <<EOF
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "rkn", "file": "rkn.lst" } ],
  "domain_lists": [ ]
}
EOF

# Спека ссылается на файлы обоих издателей. Пути второго — свой подкаталог, доменные в
# domains/: вид списка обязан читаться из пути.
cat > "$T/etc/spec.json" <<EOF
{
  "schema": 1,
  "channels": [
    { "name": "c1", "match": { "prefixes_files": ["$T/lists/itdog/telegram.lst",
                                                  "$T/lists/itdog/youtube.lst",
                                                  "$T/lists/itdog/discord.lst",
                                                  "$T/lists/rkn.lst"],
                               "domains_files":  ["$T/lists/itdog/domains/telegram.lst",
                                                  "$T/lists/itdog/domains/youtube.lst",
                                                  "$T/lists/itdog/domains/news.lst",
                                                  "$T/lists/itdog/domains/tiktok.lst"] } }
  ]
}
EOF

srs_lists_reset() {
    rm -rf "$T/lists" "$T/var/last-update" "$T/requested" "$T/etc/allow-domains.tag"
    mkdir -p "$T/lists/itdog/domains"
    printf '0.0.0.0/32\n'      > "$T/lists/itdog/telegram.lst"
    printf '10.1.0.0/16\n'     > "$T/lists/itdog/youtube.lst"
    printf '10.9.0.0/16\n'     > "$T/lists/itdog/discord.lst"
    printf '0.0.0.0/32\n'      > "$T/lists/rkn.lst"
    printf 'old.example\n'     > "$T/lists/itdog/domains/telegram.lst"
    printf 'old.example\n'     > "$T/lists/itdog/domains/youtube.lst"
    printf 'old-news.example\n'  > "$T/lists/itdog/domains/news.lst"
    printf 'old-tiktok.example\n' > "$T/lists/itdog/domains/tiktok.lst"
    : > "$T/syslog"
}

srs_run() {  # ТЕГ_КОТОРЫЙ_ОТДАЁТ_ИЗДАТЕЛЬ
    SANDBOX="$T" PATH="$T/bin:$PATH" SRS_TAG="$1" \
    STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" \
    MANIFEST="$T/etc/manifest.json" STAMP="$T/var/last-update" LOCK="$T/var/update.lock" \
    FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    AD_SH="$ROOT/files/usr/share/splify2/allow-domains.sh" \
    AD_TAG_DEFAULT="$AD_TAG" AD_BASE="https://github.com/itdoginfo/allow-domains/releases/download" \
    AD_STAMP="$T/etc/allow-domains.tag" \
    sh "$SCRIPT" > "$T/out-srs" 2>&1
}

srs_lists_reset
srs_run "$AD_TAG"
rc_srs=$?

check "набор качается по адресу с зафиксированным тегом" \
      "https://github.com/itdoginfo/allow-domains/releases/download/$AD_TAG/telegram.srs" \
      "$(grep -x ".*/$AD_TAG/telegram.srs" "$T/requested" 2>/dev/null | head -1)"

# ПЛАВАЮЩЕГО latest НЕТ У НАБОРОВ — и только у них. Сам каталог живёт по постоянному адресу
# релиза (`/releases/latest/download/lists.json`), и это не противоречие: у каталога один файл,
# который переиздаётся только при изменении содержимого, а фиксация версии живёт ВНУТРИ него —
# у каждого набора свой тег в ссылке. Требовать отсутствия слова latest во всех запросах
# значило бы запретить каталогу иметь постоянный адрес.
check "плавающего latest у наборов нет ни одного" "" \
      "$(grep '\.srs$' "$T/requested" 2>/dev/null | grep -c '/latest/' | grep -v '^0$')"

check "домены набора легли в доменный список" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"

check "подсети того же набора легли в АДРЕСНЫЙ список" "10" \
      "$(grep -c . "$T/lists/itdog/telegram.lst" 2>/dev/null)"

check "в доменном списке нет подсетей" "0" \
      "$(grep -c '/' "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"

check "в адресном списке нет доменов" "0" \
      "$(grep -c '[a-z]' "$T/lists/itdog/telegram.lst" 2>/dev/null)"

check "один набор скачан ОДИН раз, хотя нужен обоим видам" "1" \
      "$(grep -c "/telegram.srs$" "$T/requested" 2>/dev/null)"

# Сервис без подсетей. Канал на такой файл ссылаться может — значит сказать об этом надо
# каждую ночь, а не один раз: прежний файл остаётся, и молчание читалось бы как «обновлено».
check "у сервиса без подсетей адресный список не подменён" "10.1.0.0/16" \
      "$(cat "$T/lists/itdog/youtube.lst" 2>/dev/null)"
check "про отсутствующие подсети сказано вслух" "yes" \
      "$(grep -q 'в наборе youtube нет подсетей' "$T/syslog" && echo yes || echo no)"
check "доменный список того же сервиса при этом обновлён" "18" \
      "$(grep -c . "$T/lists/itdog/domains/youtube.lst" 2>/dev/null)"

# Набор с сужением по протоколу и портам (discord) больше НЕ отвергается: сужение приезжает
# третьим потоком и ложится рядом с подсетями файлом .meta — по нему интерфейс ставит каналу
# proto/ports. Прежде это был код 2 «пока не подходит», и единственный такой набор у издателя
# оставался недоступным.
check "суженный набор установлен, а не отвергнут" "104.16.0.0/12" \
      "$(sed -n 1p "$T/lists/itdog/discord.lst" 2>/dev/null)"
check "сужение лежит рядом с подсетями" "proto=udp" \
      "$(sed -n 1p "$T/lists/itdog/discord.meta" 2>/dev/null)"
check "порты — через тире, как в спеке" "ports=50000-65535,19000-20000" \
      "$(sed -n 2p "$T/lists/itdog/discord.meta" 2>/dev/null)"
check "про «не подходит» больше не говорится" "" \
      "$(grep -o 'discord.lst: такой список нам пока не подходит' "$T/syslog" 2>/dev/null | head -1)"

# Код 1 — «это не наш файл». Здесь виноват путь до издателя, а не сам список.
check "испорченный набор прежний файл не тронул" "old-news.example" \
      "$(cat "$T/lists/itdog/domains/news.lst" 2>/dev/null)"
check "про код 1 сказано «испорченный»" "yes" \
      "$(grep -q 'news.lst: скачался испорченный набор' "$T/syslog" && echo yes || echo no)"
check "код 1 «пока не подходит» НЕ назван" "" \
      "$(grep -o 'news.lst: такой список нам пока не подходит' "$T/syslog" 2>/dev/null | head -1)"

# Не отдалось вовсе — третья, отдельная беда.
check "неотдавшийся набор прежний файл не тронул" "old-tiktok.example" \
      "$(cat "$T/lists/itdog/domains/tiktok.lst" 2>/dev/null)"
check "про неотдавшийся набор сказано «не скачался»" "yes" \
      "$(grep -q 'tiktok.lst: набор tiktok.srs не скачался' "$T/syslog" && echo yes || echo no)"

# Половина каталога лучше пустого списка на пустом месте: беда с одним списком не сворачивает
# обновление целиком, и список ПЕРВОГО издателя обновляется рядом со вторым.
check "список первого издателя обновлён рядом со вторым" "10.0.0.0/8" \
      "$(cat "$T/lists/rkn.lst" 2>/dev/null)"
check "правила применены, обновление не свёрнуто целиком" "yes" \
      "$(grep -q 'правила применены' "$T/syslog" && echo yes || echo no)"
check "неудачи подняли признак неудачи прогона" "1" "$rc_srs"

# Отметка версии: по строке на ФАЙЛ. Без неё вопрос «какая у тебя версия списков» ответа не
# имеет, а ночь качала бы одни и те же байты каждый раз.
check "отметка версии записана по файлам" "yes" \
      "$(grep -q "^telegram domains $AD_TAG$" "$T/etc/allow-domains.tag" &&
         grep -q "^telegram prefixes $AD_TAG$" "$T/etc/allow-domains.tag" && echo yes || echo no)"
check "того, чего на диске нет, в отметке тоже нет" "" \
      "$(grep -o '^youtube prefixes' "$T/etc/allow-domains.tag" 2>/dev/null)"

# ---- тот же тег: в сеть не ходим ---------------------------------------------
# Тег зафиксирован, значит содержимое релиза то же. Двадцать пять файлов каждую ночь ради
# одинаковых байтов — это трата на ничего.
rm -f "$T/requested" "$T/var/last-update"
: > "$T/syslog"
srs_run "$AD_TAG"

check "на том же теге набор повторно не качается" "0" \
      "$(grep -c '/telegram.srs$' "$T/requested" 2>/dev/null)"
check "и сказано, почему не качается" "yes" \
      "$(grep -q "уже на диске" "$T/syslog" && echo yes || echo no)"
check "жалоба про отсутствующие подсети повторяется" "yes" \
      "$(grep -q 'в наборе youtube нет подсетей' "$T/syslog" && echo yes || echo no)"

# ---- тег сменили в uci: качаем заново ------------------------------------------
# Поднять версию списков может только человек — явным `uci set`. Ночь тег не двигает.
rm -f "$T/requested" "$T/var/last-update"
: > "$T/syslog"
printf 'splify2.main.allow_domains_tag=%s\n' "$AD_TAG2" > "$T/uci.store"
srs_run "$AD_TAG2"

check "тег из uci заменяет зашитый в пакет" \
      "https://github.com/itdoginfo/allow-domains/releases/download/$AD_TAG2/telegram.srs" \
      "$(grep -x ".*/$AD_TAG2/telegram.srs" "$T/requested" 2>/dev/null | head -1)"
check "смена тега перезаписала отметку версии" "yes" \
      "$(grep -q "^telegram domains $AD_TAG2$" "$T/etc/allow-domains.tag" && echo yes || echo no)"

# ---- tag=latest фиксацией не является -------------------------------------------
# Это единственное значение, которое молча отменяет воспроизводимость, и набрать его
# человек попробует первым. Берём зашитый тег и говорим об этом вслух.
rm -f "$T/requested" "$T/var/last-update"
: > "$T/syslog"
printf 'splify2.main.allow_domains_tag=latest\n' > "$T/uci.store"
srs_run "$AD_TAG"

check "tag=latest отбит, взят зашитый тег" "yes" \
      "$(grep -q "/$AD_TAG/telegram.srs$" "$T/requested" && echo yes || echo no)"
check "про отбитый latest сказано вслух" "yes" \
      "$(grep -q 'latest' "$T/syslog" && echo yes || echo no)"
: > "$T/uci.store"

# ---- зашитый в пакет тег — настоящий тег релиза, а не latest ----------------------
# Файл описания источника едет в пакете, и значение в нём — это версия списков у каждого,
# кто ничего не настраивал.
AD_SRC="$ROOT/files/usr/share/splify2/allow-domains.sh"
check "в описании источника зашит тег вида ГГГГ-ММ-ДД_ЧЧ-ММ" "yes" \
      "$(grep -qE '^AD_TAG_DEFAULT=\$\{AD_TAG_DEFAULT:-2[0-9]{3}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\}$' "$AD_SRC" &&
         echo yes || echo no)"
check "в описании источника нет ссылки на latest" "" \
      "$(grep -o 'releases/latest' "$AD_SRC" | head -1)"

# ---- список из спеки, которого на диске ещё нет ---------------------------------
#
# Так выглядит ПЕРВАЯ ночь после того, как человек включил список: в спеке он есть, на диске
# его нет, и подкаталога под него тоже нет. `mkdir -p "$LISTS"` в начале скрипта создаёт
# только корень, а списки лежат глубже — доменные в domains/, у второго издателя ещё и в
# своём. Пока подкаталог заводил кто-то другой (объект rpcd делает mkdir перед записью),
# этого не было видно; без него `mv` молча не срабатывал, файл не появлялся, а в журнал
# уходило «обновлён ( записей)» — с пустым числом вместо признака беды.
rm -rf "$T/lists" "$T/var/last-update" "$T/requested" "$T/etc/allow-domains.tag"
mkdir -p "$T/lists"
: > "$T/syslog"
srs_run "$AD_TAG"

check "список лёг, хотя подкаталога под него не было" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"
check "и адресный тоже" "10" \
      "$(grep -c . "$T/lists/itdog/telegram.lst" 2>/dev/null)"
check "«обновлён» с пустым числом записей в журнал не попал" "" \
      "$(grep -o 'обновлён ( записей)' "$T/syslog" 2>/dev/null | head -1)"

# ---- кнопка «Загрузить» в каталоге: тот же путь через объект rpcd -----------------
#
# Один издатель — один способ добычи. Вторая реализация того же скачивания в объекте
# разошлась бы с ночной на первом же изменении: этим проект уже болел (см. шапку fetch.sh).
srs_rpcd() {  # МЕТОД ВХОД   (тег издателя переопределяется через SRS_TAG_NOW)
    printf '%s\n' "$2" | env SANDBOX="$T" PATH="$T/bin:$PATH" SRS_TAG="${SRS_TAG_NOW:-$AD_TAG}" \
        JSHN_SH="$ROOT/tests/stub/jshn.sh" RPCD_LIB="$ROOT/files/usr/lib/splify2/rpcd" \
        FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
        DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
        ZP_DIR="$T/zapret" ZP_CONF="$T/etc/config-zapret" ZP_NFQWS="$T/bin/nfqws-missing" \
        ZP_INIT="$T/bin/initd-zapret" ZP_RCD="$T/rcd" DOH_CONF="$T/etc/config-doh" \
        INITD="$T/bin/initd-steer" \
        AD_SH="$ROOT/files/usr/share/splify2/allow-domains.sh" \
        AD_TAG_DEFAULT="${SRS_TAG_NOW:-$AD_TAG}" \
        AD_BASE="https://github.com/itdoginfo/allow-domains/releases/download" \
        AD_STAMP="$T/etc/allow-domains.tag" \
        STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" \
        MANIFEST="$T/etc/manifest.json" UCI_SPLIFY2="$T/etc/config-splify2" \
        sh "$ROOT/files/usr/libexec/rpcd/splify2" call "$1" 2>"$T/rpcd-err"
}

srs_lists_reset
rm -f "$T/requested"
out="$(srs_rpcd list_fetch '{"id":"itdog:telegram","kind":"domains"}')"

check "list_fetch у второго издателя отвечает успехом" "yes" \
      "$(printf '%s' "$out" | grep -q '"ok": *true' && echo yes || echo no)"
check "list_fetch положил доменный список" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"
check "list_fetch положил и адресный — набор один, качать его дважды незачем" "10" \
      "$(grep -c . "$T/lists/itdog/telegram.lst" 2>/dev/null)"
check "list_fetch вернул путь запрошенного вида" "yes" \
      "$(printf '%s' "$out" | grep -q "$T/lists/itdog/domains/telegram.lst" && echo yes || echo no)"

out="$(srs_rpcd list_fetch '{"id":"itdog:youtube","kind":"prefixes"}')"
check "list_fetch про отсутствующий вид отвечает внятно" "yes" \
      "$(printf '%s' "$out" | grep -q 'подсет' && echo yes || echo no)"

out="$(srs_rpcd list_fetch '{"id":"itdog:discord","kind":"prefixes"}')"
check "list_fetch отдаёт сужение подсетей вместе со списком" "yes" \
      "$(printf '%s' "$out" | tr -d ' \n\t' | grep -q '"narrow":{"proto":"udp","ports":\["50000-65535","19000-20000"\]}' && echo yes || echo no)"
out="$(srs_rpcd allow_domains '{}')"
check "каталог второго издателя называет сужение у скачанного discord" "yes" \
      "$(printf '%s' "$out" | tr -d ' \n\t' | grep -q '"id":"discord"[^}]*"narrow":{"proto":"udp"' && echo yes || echo no)"

out="$(srs_rpcd list_fetch '{"id":"itdog:nosuchservice","kind":"domains"}')"
check "list_fetch про неизвестный сервис не врёт, что скачивание не вышло" "yes" \
      "$(printf '%s' "$out" | grep -q 'нет списка nosuchservice' && echo yes || echo no)"

out="$(srs_rpcd list_fetch '{"id":"itdog:../../etc/passwd","kind":"domains"}')"
check "list_fetch отвергает выход за каталог списков" "yes" \
      "$(printf '%s' "$out" | grep -q '"ok": *false' && echo yes || echo no)"
check "и файла за каталогом не появилось" "yes" \
      "$([ ! -e "$T/etc/passwd" ] && echo yes || echo no)"

# ---- недостающий список второго издателя доскачивается ПО ТРЕБОВАНИЮ ------------------
#
# ЗАЧЕМ ЭТА ПРОВЕРКА. Движок умирает на отсутствующем файле списка, поэтому объект rpcd
# доскачивает недостающее перед каждой проверкой спеки (см. fetch_missing_lists). Знание «где
# живёт второй издатель» в эту функцию не завозили, и потому путь `itdog/telegram.lst` уезжал
# ПЕРВОМУ издателю: у него такого файла нет, спека применялась, а канал стоял пустым до
# первого срабатывания ночного расписания — то есть до суток. Молча.
#
# Проверяется по СЛЕДСТВИЮ, а не по тексту функции: появился ли файл и по какому адресу за
# ним ходили. Адрес здесь и есть суть находки.
srs_lists_reset
rm -f "$T/requested"
# Спека ссылается на набор второго издателя, которого на диске нет.
rm -f "$T/lists/itdog/domains/telegram.lst" "$T/lists/itdog/telegram.lst"
out="$(srs_rpcd apply '{}')"

check "недостающий набор второго издателя доскачался" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"
check "и второй вид того же набора тоже" "10" \
      "$(grep -c . "$T/lists/itdog/telegram.lst" 2>/dev/null)"
# Оба вида отсутствовали, а набор один — значит скачан он обязан быть РАЗ. Второй круг цикла
# берёт уже разобранное из памяти прогона (ad_get).
check "набор скачан один раз на оба недостающих вида" "1" \
      "$(grep -c "/$AD_TAG/telegram.srs" "$T/requested" 2>/dev/null || true)"
# И разбор за собой убран. Проверка отдельная, потому что цена у неё своя: /tmp на роутере —
# tmpfs, то есть ОПЕРАТИВНАЯ память, и оставленный разбор двадцати пяти наборов её и занимает.
# Мусор в /tmp сам себя не показывает: он не ломает ничего до того дня, когда памяти не хватило.
check "разбор набора после вызова не остался" "0" \
      "$(ls -d /tmp/splify2-srs.* 2>/dev/null | grep -c . || true)"
# ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА: за ним ходили к ЕГО издателю, а не к нашему манифесту. Без
# развилки запрос уходил на base_url первого издателя с путём itdog/domains/telegram.lst.
check "ходили к релизу второго издателя, а не к манифесту первого" "yes" \
      "$(grep -q "/releases/download/$AD_TAG/telegram.srs" "$T/requested" && echo yes || echo no)"
# Число берётся `grep -c ... || true`, а не `|| echo 0`: у grep без совпадений код 1, и
# подстановка «или ноль» дописала бы ВТОРОЙ нуль к уже напечатанному — сравнение получало
# «0\n0». Стенд ловил на этом сам себя.
check "к первому издателю за этим файлом не ходили вовсе" "0" \
      "$(grep -c 'itdog/domains/telegram.lst' "$T/requested" 2>/dev/null || true)"
# Отметка тега ставится и здесь: иначе ночное обновление скачало бы тот же зафиксированный
# релиз ещё раз, потому что «чем набит файл» осталось бы неизвестным.
check "отметка тега поставлена — ночь не будет качать то же ещё раз" "yes" \
      "$(grep -q "$AD_TAG" "$T/etc/allow-domains.tag" 2>/dev/null && echo yes || echo no)"
# ОТСУТСТВИЕ МАНИФЕСТА БОЛЬШЕ НЕ ПРЕКРАЩАЕТ РАБОТУ ЦЕЛИКОМ, и это вторая половина находки:
# прежде функция выходила на первой же строке, если манифеста нет, — и вместе с первым
# издателем молча выпадал второй, которому манифест не нужен вовсе. Состояние настоящее: на
# чистом роутере манифест появляется только после первого обращения к списку.
mv "$T/etc/manifest.json" "$T/etc/manifest.away"
rm -f "$T/lists/rkn.lst" "$T/lists/itdog/domains/telegram.lst" "$T/requested"
out="$(srs_rpcd apply '{}')"
check "без манифеста набор ВТОРОГО издателя всё равно доскачался" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"
# КАТАЛОГ БЕРЁТСЯ САМ, если его нет на диске: это законное состояние (свежий роутер, смена
# источника), и «манифест не загружен» на нём означало, что канал не поднимется из-за файла,
# который мы умеем достать.
check "каталога не было — он скачался, и список первого издателя приехал" "yes" \
      "$([ -s "$T/lists/rkn.lst" ] && echo yes || echo no)"

# А вот когда каталог скачать НЕЧЕМ, молчать нельзя: список первого издателя не приедет, и
# сказать об этом надо. Издатель здесь недоступен целиком — заглушка curl не находит образец.
mv "$T/manifest.src" "$T/manifest.src.away"
rm -f "$T/etc/manifest.json" "$T/lists/rkn.lst" "$T/requested"
out="$(srs_rpcd apply '{}')"
check "каталог недоступен — про список первого сказано вслух" "yes" \
      "$(printf '%s' "$out" | grep -q 'манифест не загружен' && echo yes || echo no)"
mv "$T/manifest.src.away" "$T/manifest.src"
mv "$T/etc/manifest.away" "$T/etc/manifest.json"

# СМЕНА ТЕГА ОБЯЗАНА ПРИВЕСТИ К НОВОЙ ЗАГРУЗКЕ, и это единственная проверка, которая ловит
# разбор, оставленный в общем /tmp. `ad_get` помнит уже разобранное по имени файла, а не по
# тегу: внутри одного прогона это верно и экономит загрузку второму виду того же сервиса, но
# разбор, переживший вызов, отдал бы новому тегу СТАРОЕ содержимое — файл на месте, значит
# качать нечего. Человек получил бы список прежней версии и ни разу об этом не услышал.
#
# Ровно на этом стенд однажды позеленел по неверной причине: набор не качался вовсе, а брался
# из разбора предыдущего раздела. Поэтому проверка стоит на ДВУХ прогонах с разными тегами.
rm -f "$T/lists/itdog/domains/telegram.lst" "$T/requested"
SRS_TAG_NOW="$AD_TAG2" out="$(SRS_TAG_NOW="$AD_TAG2" srs_rpcd apply '{}')"
check "после смены тега набор скачан заново, а не взят из прежнего разбора" "yes" \
      "$(grep -q "/$AD_TAG2/telegram.srs" "$T/requested" && echo yes || echo no)"
check "и файл на месте" "20" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst" 2>/dev/null)"
check "отметка обновилась на новый тег" "yes" \
      "$(grep -q "$AD_TAG2" "$T/etc/allow-domains.tag" 2>/dev/null && echo yes || echo no)"

# Списки ПЕРВОГО издателя этой развилкой не затронуты: путь без его подкаталога идёт прежней
# дорогой. Проверка нужна затем, что развилка стоит в общем цикле.
cp "$T/manifest.src" "$T/etc/manifest.json"
rm -f "$T/lists/rkn.lst" "$T/requested"
out="$(srs_rpcd apply '{}')"
check "список первого издателя по-прежнему качается через манифест" "yes" \
      "$(grep -q 'rkn.lst' "$T/requested" && echo yes || echo no)"
check "и он лёг на место" "yes" \
      "$([ -s "$T/lists/rkn.lst" ] && echo yes || echo no)"


# ---- каталог второго издателя: метод allow_domains -------------------------------
#
# ЗАЧЕМ ЭТОТ РАЗДЕЛ. Двадцать пять списков лежали на роутере и включить их было неоткуда:
# метода, который отдал бы каталог второго издателя, не существовало вовсе. Раздел сторожит
# четыре обещания этого метода, и каждое из них однажды нарушалось где-то рядом:
#
#   1. Каталог — ТА ЖЕ таблица, что читает скачивание. Переписанный в стенд список
#      сервисов зеленел бы на разошедшейся копии, поэтому ожидаемое берётся из САМОГО
#      файла описания источника.
#   2. `have` отвечает на вопрос «что скачано и какой версии», и отвечает ТОЛЬКО про то,
#      что лежит на диске. Ноль строк — законное состояние скачанного пустого списка, и
#      подменять им «файла нет» значит соврать интерфейсу ровно там, где он решает, рисовать
#      кнопку «Загрузить» или «Обновить».
#   3. Жалоба на негодную настройку тега ДОЕЗЖАЕТ. Разбор и печать в описании источника
#      разведены именно затем, чтобы предупреждение не съела подоболочка (`$( )`), и метод
#      обязан звать ad_tag_resolve в своей.
#   4. Метод НЕ ХОДИТ В СЕТЬ. Его зовёт опрос страницы, а поход в сеть на опросе — это
#      полминуты ожидания у того, у кого GitHub закрыт. Проверяется по следствию: curl и
#      wget подменяются падающими заглушками, и ответ обязан остаться верным.

# Сравнение ответа с таблицей. Ожидаемое — из файла описания источника, а не из копии в
# стенде: копия расходится с таблицей на первом же добавленном сервисе, и стенд после этого
# зелен по неверной причине.
ad_cat() {  # ОПЕРАЦИЯ   (ответ метода — в $T/cat.json)
    python3 - "$1" "$T/cat.json" "$ROOT/files/usr/share/splify2/allow-domains.sh" <<'PY'
import json, re, sys
op, catf, srcf = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cat = json.load(open(catf, encoding='utf-8'))
except Exception as e:
    print('НЕ JSON: %s' % e); sys.exit(0)
tbl = []
for line in open(srcf, encoding='utf-8'):
    m = re.match(r'^([a-z0-9_]+)\|([a-z,]+)\|(.+)$', line.rstrip('\n'))
    if m:
        tbl.append((m.group(1), m.group(2).split(','), m.group(3)))
svc = cat.get('services', [])
by = {s.get('id'): s for s in svc}
if   op == 'count':    print(len(svc))
elif op == 'tblcount': print(len(tbl))
elif op == 'ids':      print(' '.join(sorted(by)))
elif op == 'tblids':   print(' '.join(sorted(t[0] for t in tbl)))
elif op == 'kindsdiff': print(' '.join(t[0] for t in tbl if by.get(t[0], {}).get('kinds') != t[1]))
elif op == 'namesdiff': print(' '.join(t[0] for t in tbl if by.get(t[0], {}).get('name')  != t[2]))
elif op.startswith('top:'):
    v = cat.get(op[4:], '<нет ключа>')
    print(v if not isinstance(v, bool) else ('true' if v else 'false'))
elif op.startswith('haskey:'):     # есть ли у сервиса ключ have ВООБЩЕ
    print('yes' if 'have' in by.get(op[7:], {}) else 'no')
elif op.startswith('hv:'):         # hv:СЕРВИС:ВИД:ПОЛЕ
    _, s, k, f = op.split(':')
    print(by.get(s, {}).get('have', {}).get(k, {}).get(f, '<нет>'))
elif op.startswith('hvkinds:'):    # какие виды названы в have
    print(' '.join(sorted(by.get(op[8:], {}).get('have', {}))))
PY
}

ad_catalog() {  # снять каталог в $T/cat.json
    srs_rpcd allow_domains '{}' > "$T/cat.json"
}

# Раздел выше оставил в оболочке SRS_TAG_NOW=AD_TAG2 (присваивание перед присваиванием, а не
# перед командой, живёт до конца скрипта). Здесь тег обязан быть предсказуем: половина
# проверок сравнивает ответ метода именно с зашитым умолчанием.
SRS_TAG_NOW=""

# Диск чистый: ни одного списка второго издателя и ни одной отметки. Так выглядит роутер,
# на котором каталог открывают впервые.
srs_lists_reset
rm -rf "$T/lists"; mkdir -p "$T/lists"
rm -f "$T/etc/allow-domains.tag" "$T/requested"
: > "$T/uci.store"

ad_catalog
check "allow_domains отвечает успехом" "true" "$(ad_cat top:ok)"
check "каталог отдаёт СТОЛЬКО сервисов, сколько их в таблице" "$(ad_cat tblcount)" "$(ad_cat count)"
check "и ровно те же имена, что в таблице" "$(ad_cat tblids)" "$(ad_cat ids)"
check "виды у каждого сервиса — те же, что в таблице" "" "$(ad_cat kindsdiff)"
check "названия у каждого сервиса — те же, что в таблице" "" "$(ad_cat namesdiff)"
check "приставка id названа именем источника" "itdog" "$(ad_cat top:id)"
check "репозиторий издателя назван" "itdoginfo/allow-domains" "$(ad_cat top:repo)"
check "ссылка ведёт на релизы, а не на ветку" "yes" \
      "$(ad_cat top:base_url | grep -q '/releases/download$' && echo yes || echo no)"
check "тег — зашитый в пакет, пока uci молчит" "$AD_TAG" "$(ad_cat top:tag)"
check "зашитый тег отдаётся отдельным полем" "$AD_TAG" "$(ad_cat top:tag_default)"
check "жалобы на настройку нет, когда с ней всё в порядке" "" "$(ad_cat top:tag_warn)"
check "на чистом диске ни у кого нет ключа have" "no" "$(ad_cat haskey:telegram)"

# ---- have появляется ровно у того, что ЛЕЖИТ на диске ----------------------------
#
# Файлы кладёт настоящее скачивание (list_fetch), а не стенд своей рукой: `have` обязан
# описывать то, что создаёт продукт, и путь у обеих половин обязан быть один. Разложи стенд
# файлы сам — он зеленел бы и на методе, который смотрит не туда.
rm -f "$T/requested"
out="$(srs_rpcd list_fetch '{"id":"itdog:telegram","kind":"domains"}')"
ad_catalog

check "у скачанного сервиса have есть" "yes" "$(ad_cat haskey:telegram)"
check "и в нём оба вида — набор один, кладутся оба" "domains prefixes" "$(ad_cat hvkinds:telegram)"
check "тег в have — тот, что записан в отметке" \
      "$(awk '$1=="telegram" && $2=="domains" {print $3}' "$T/etc/allow-domains.tag")" \
      "$(ad_cat hv:telegram:domains:tag)"
check "число строк в have — то, что лежит на диске" \
      "$(grep -c . "$T/lists/itdog/domains/telegram.lst")" "$(ad_cat hv:telegram:domains:lines)"
check "и у второго вида того же набора тоже" \
      "$(grep -c . "$T/lists/itdog/telegram.lst")" "$(ad_cat hv:telegram:prefixes:lines)"
check "у сервиса без файла ключа have НЕТ ВОВСЕ" "no" "$(ad_cat haskey:anime)"
check "и у соседа по таблице тоже" "no" "$(ad_cat haskey:youtube)"

# ПУСТОЙ СКАЧАННЫЙ СПИСОК — ЭТО НЕ «ФАЙЛА НЕТ». Ноль строк законен (у сервиса может не
# оказаться ни одной записи нужного вида), и подмена его отсутствием ключа заставила бы
# интерфейс предлагать «Загрузить» то, что уже загружено.
: > "$T/lists/itdog/domains/anime.lst"
ad_catalog
check "пустой скачанный список назван в have, а не пропущен" "yes" "$(ad_cat haskey:anime)"
check "и у него честный ноль строк" "0" "$(ad_cat hv:anime:domains:lines)"
check "и только тот вид, который лежит" "domains" "$(ad_cat hvkinds:anime)"

# Файл без отметки — законное состояние: так выглядит список, положенный руками или
# вернувшийся из архива настроек. Он ЕСТЬ на диске, значит have про него быть обязан, а
# версия у него неизвестна — и врать про неё нельзя.
check "у файла без отметки версия пуста, но сам он в have есть" "" "$(ad_cat hv:anime:domains:tag)"
rm -f "$T/lists/itdog/domains/anime.lst"

# ---- негодный тег в uci: жалоба доезжает, а тег остаётся зашитым --------------------
#
# Предупреждение, съеденное подоболочкой, — ровно та беда, ради которой разбор и печать
# тега в описании источника разведены. Проверяется по СЛЕДСТВИЮ: в ответе жалоба непуста,
# а тег — умолчание, а не мусор из uci.
printf 'splify2.main.allow_domains_tag=%s\n' 'not a tag/../../x' > "$T/uci.store"
ad_catalog
check "негодный тег из uci даёт непустую жалобу" "yes" \
      "$(ad_cat top:tag_warn | grep -q . && echo yes || echo no)"
check "и жалоба называет то, что человек набрал" "yes" \
      "$(ad_cat top:tag_warn | grep -q 'not a tag' && echo yes || echo no)"
check "а качать будем по ЗАШИТОМУ тегу, а не по мусору" "$AD_TAG" "$(ad_cat top:tag)"

printf 'splify2.main.allow_domains_tag=latest\n' > "$T/uci.store"
ad_catalog
check "tag=latest отбит и назван вслух" "yes" \
      "$(ad_cat top:tag_warn | grep -q 'latest' && echo yes || echo no)"
check "и тег остался зашитым" "$AD_TAG" "$(ad_cat top:tag)"

# Годный тег из uci метод обязан ПОКАЗАТЬ: иначе человек, поднявший версию руками, видел бы
# в каталоге не ту, по которой качается.
printf 'splify2.main.allow_domains_tag=%s\n' "$AD_TAG2" > "$T/uci.store"
ad_catalog
check "годный тег из uci доезжает до каталога" "$AD_TAG2" "$(ad_cat top:tag)"
check "и жалобы при нём нет" "" "$(ad_cat top:tag_warn)"
check "а зашитый рядом виден по-прежнему" "$AD_TAG" "$(ad_cat top:tag_default)"
: > "$T/uci.store"

# ---- метод НЕ ХОДИТ В СЕТЬ -------------------------------------------------------
#
# Его зовёт опрос страницы. Поход в сеть на опросе — это то, чего в продукте избегают везде:
# у аудитории, которой этот издатель и нужен, GitHub закрыт, и каждый такой поход стоит
# полминуты ожидания. Проверяется по следствию: заглушки скачивания ПАДАЮТ и протоколируют
# попытку, а ответ обязан остаться тем же самым.
cp "$T/bin/curl" "$T/bin/curl.keep"
[ -f "$T/bin/wget" ] && cp "$T/bin/wget" "$T/bin/wget.keep"
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$SANDBOX/netcalls"
exit 7
EOF
cp "$T/bin/curl" "$T/bin/wget"
chmod +x "$T/bin/curl" "$T/bin/wget"
rm -f "$T/netcalls"
ad_catalog
check "с падающим скачиванием каталог всё равно верен" "$(ad_cat tblcount)" "$(ad_cat count)"
check "и по-прежнему успешен" "true" "$(ad_cat top:ok)"
check "и have на месте — он про диск, а не про сеть" "yes" "$(ad_cat haskey:telegram)"
check "в сеть не ходили ни разу" "no" "$([ -f "$T/netcalls" ] && echo yes || echo no)"
mv "$T/bin/curl.keep" "$T/bin/curl"
if [ -f "$T/bin/wget.keep" ]; then mv "$T/bin/wget.keep" "$T/bin/wget"; else rm -f "$T/bin/wget"; fi

# ---- метод объявлен и разрешён ---------------------------------------------------
# Метод, которого нет в ACL, работает из ssh и НЕ работает из браузера: страница получает
# отказ доступа и показывает «нет данных». Барьер сборки требует того же, но стенд быстрее.
check "allow_domains объявлен в перечне методов объекта" "yes" \
      "$(JSHN_SH="$ROOT/tests/stub/jshn.sh" sh "$ROOT/files/usr/libexec/rpcd/splify2" list 2>/dev/null |
         grep -q '"allow_domains"' && echo yes || echo no)"
check "allow_domains разрешён в ACL на чтение" "yes" \
      "$(python3 -c '
import json,sys
a=json.load(open(sys.argv[1],encoding="utf-8"))["luci-app-splify2"]
print("yes" if "allow_domains" in a["read"]["ubus"]["splify2"] else "no")' \
        "$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json")"

# ---- удаление списка второго издателя ---------------------------------------------
#
# ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ ДЫРЫ. Приставку `itdog:` выучил один потребитель — скачивание, — а
# list_remove разбирал id по прежнему правилу и искал его в манифесте ПЕРВОГО издателя. На
# `itdog:telegram` он честно отвечал «такого нет в манифесте», и список, который можно было
# скачать, нельзя было убрать НИКОГДА. Тот же класс, что R-106.
#
# Проверяется по СЛЕДСТВИЮ: исчезает ли файл, который создало скачивание. «Метод вернул ok»
# здесь ничего не значит — ровно так выглядел бы и метод, стирающий не тот путь.
srs_lists_reset
rm -rf "$T/lists"; mkdir -p "$T/lists"
rm -f "$T/etc/allow-domains.tag" "$T/requested"
# Спека на время удаления не должна ссылаться на удаляемое — иначе сработает (законный)
# отказ «список используется каналом», и проверялся бы он, а не удаление.
cp "$T/etc/spec.json" "$T/etc/spec.keep"
printf '{"schema":1,"channels":[]}\n' > "$T/etc/spec.json"
out="$(srs_rpcd list_fetch '{"id":"itdog:telegram","kind":"domains"}')"
check "перед удалением файл на месте" "yes" \
      "$([ -s "$T/lists/itdog/domains/telegram.lst" ] && echo yes || echo no)"

out="$(srs_rpcd list_remove '{"id":"itdog:telegram","kind":"domains"}')"
check "list_remove у второго издателя отвечает успехом" "yes" \
      "$(printf '%s' "$out" | grep -q '"ok": *true' && echo yes || echo no)"
check "и файл, созданный скачиванием, исчез" "no" \
      "$([ -e "$T/lists/itdog/domains/telegram.lst" ] && echo yes || echo no)"
check "а второй вид того же набора не тронут — его не просили" "yes" \
      "$([ -s "$T/lists/itdog/telegram.lst" ] && echo yes || echo no)"
# ОТМЕТКА ВЕРСИИ УХОДИТ ВМЕСТЕ С ФАЙЛОМ. Отметка говорит «лежащий файл набит этим тегом»;
# пережившая свой файл, она заявляет о том, чего нет, — и каталог показал бы версию у
# списка, которого на роутере не осталось.
check "отметка версии удалённого вида снята" "" \
      "$(awk '$1=="telegram" && $2=="domains" {print $3}' "$T/etc/allow-domains.tag" 2>/dev/null)"
check "а отметка оставшегося вида цела" "yes" \
      "$(awk '$1=="telegram" && $2=="prefixes" {print $3}' "$T/etc/allow-domains.tag" | grep -q . &&
         echo yes || echo no)"
ad_catalog
check "и каталог про удалённый вид больше не говорит" "prefixes" "$(ad_cat hvkinds:telegram)"

# Вид не указан, а на диске лежит ровно один — берётся он. Это тот же случай, что у своих
# списков: имя внутри сервиса уникально по виду.
out="$(srs_rpcd list_remove '{"id":"itdog:telegram"}')"
check "без вида удаляется единственный лежащий" "no" \
      "$([ -e "$T/lists/itdog/telegram.lst" ] && echo yes || echo no)"

# Оба вида на диске, а вид не назван — удалять наугад нельзя: у второго издателя оба вида
# кладутся ОДНИМ скачиванием, то есть это обычное состояние, а не редкость.
out="$(srs_rpcd list_fetch '{"id":"itdog:telegram","kind":"domains"}')"
out="$(srs_rpcd list_remove '{"id":"itdog:telegram"}')"
check "при двух лежащих видах без вида не удаляется ничего" "yes" \
      "$([ -s "$T/lists/itdog/domains/telegram.lst" ] && [ -s "$T/lists/itdog/telegram.lst" ] &&
         echo yes || echo no)"
check "и сказано, чего не хватает" "yes" \
      "$(printf '%s' "$out" | grep -q 'вид' && echo yes || echo no)"

# Список, на который ссылается канал, не удаляется: движок читает список при сборке правил и
# падает на отсутствующем. Проверка про СПЕКУ, а не про издателя, и второму издателю нужна
# ровно так же, как первому.
cp "$T/etc/spec.keep" "$T/etc/spec.json"
out="$(srs_rpcd list_remove '{"id":"itdog:telegram","kind":"domains"}')"
check "используемый каналом список второго издателя не удаляется" "yes" \
      "$([ -s "$T/lists/itdog/domains/telegram.lst" ] && echo yes || echo no)"
check "и сказано, почему" "yes" \
      "$(printf '%s' "$out" | grep -q 'используется каналом' && echo yes || echo no)"
check "и отметка версии при отказе цела" "yes" \
      "$(awk '$1=="telegram" && $2=="domains" {print $3}' "$T/etc/allow-domains.tag" | grep -q . &&
         echo yes || echo no)"

out="$(srs_rpcd list_remove '{"id":"itdog:nosuchservice","kind":"domains"}')"
check "неизвестный сервис не выдаётся за манифест первого издателя" "yes" \
      "$(printf '%s' "$out" | grep -q 'манифест' && echo no || echo yes)"
out="$(srs_rpcd list_remove '{"id":"itdog:../../etc/passwd","kind":"domains"}')"
check "list_remove отвергает выход за каталог списков" "yes" \
      "$(printf '%s' "$out" | grep -q '"ok": *false' && echo yes || echo no)"

# ---- НАБОР, НАЗВАННЫЙ КАТАЛОГОМ: format=srs и своя ссылка в манифесте -------------------
#
# ИМЯ ПОЛОВИНЫ — ОТ НАБОРА (`telegram.srs.lst`), и это видно в путях ниже: качается `.srs`, а
# на диск ложится текстовый список, потому что движок держит в спеке именно списки. Точка в
# имени заодно разводит эти файлы со вторым издателем: его разбор путей (ad_service_of) имён
# с точкой не принимает, поэтому свой `itdog/x.lst` он с чужим `itdog/x.srs.lst` не спутает.
#
# ЧТО ЗДЕСЬ СТОРОЖИТСЯ. Каталог списков (lists.json репозитория splify2-lists) описывает не
# только свои плоские файлы, но и чужие наборы: у записи есть `url` и `format: "srs"`. Разница
# со вторым издателем не в механике — разбор тот же самый, — а в том, КТО называет ссылку:
# там таблица зашита в пакет, здесь её называет каталог. Ради этого каталог и заводился:
# добавить сервис можно правкой каталога, а не новой сборкой splify2.
#
# Проверяется ночное обновление: оно ходит по файлам СПЕКИ, и набор должен разложиться на две
# половины по путям, которые назвал каталог, — ровно как у зашитого издателя.
rm -rf "$T/lists" "$T/var/last-update" "$T/requested" "$T/etc/allow-domains.tag"
mkdir -p "$T/lists/catalog/domains"
printf '0.0.0.0/32\n'  > "$T/lists/catalog/telegram.srs.lst"
printf 'old.example\n' > "$T/lists/catalog/domains/telegram.srs.lst"
: > "$T/syslog"

cat > "$T/manifest.src" <<EOF
{
  "base_url": "https://example.invalid/lists",
  "categories": [
    { "id": "src:telegram", "file": "catalog/telegram.srs.lst", "format": "srs",
      "url": "https://github.com/itdoginfo/allow-domains/releases/download/$AD_TAG/telegram.srs" }
  ],
  "domain_lists": [
    { "id": "svc_src_telegram", "kind": "domains", "file": "catalog/domains/telegram.srs.lst",
      "format": "srs", "same_as_ip": ["src:telegram"],
      "url": "https://github.com/itdoginfo/allow-domains/releases/download/$AD_TAG/telegram.srs" }
  ]
}
EOF
cat > "$T/etc/spec.json" <<EOF
{
  "schema": 1,
  "channels": [
    { "name": "c1", "match": { "prefixes_files": ["$T/lists/catalog/telegram.srs.lst"],
                               "domains_files":  ["$T/lists/catalog/domains/telegram.srs.lst"] } }
  ]
}
EOF
srs_run "$AD_TAG"
check "набор каталога скачан по СВОЕЙ ссылке" "1" \
      "$(grep -c "/$AD_TAG/telegram.srs$" "$T/requested" 2>/dev/null)"
check "и скачан один раз на обе половины" "1" \
      "$(grep -c "/telegram.srs$" "$T/requested" 2>/dev/null)"
check "домены легли по пути, который назвал каталог" "20" \
      "$(grep -c . "$T/lists/catalog/domains/telegram.srs.lst" 2>/dev/null)"
check "подсети — по своему пути" "10" \
      "$(grep -c . "$T/lists/catalog/telegram.srs.lst" 2>/dev/null)"
check "и base_url для набора не при чём" "0" \
      "$(grep -c 'example.invalid/lists/catalog' "$T/requested" 2>/dev/null)"

# Спека и манифест возвращаются к прежним: разделы ниже написаны под них.
cat > "$T/manifest.src" <<EOF
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "rkn", "file": "rkn.lst" } ],
  "domain_lists": [ ]
}
EOF
cat > "$T/etc/spec.json" <<EOF
{
  "schema": 1,
  "channels": [
    { "name": "c1", "match": { "prefixes_files": ["$T/lists/rkn.lst"] } }
  ]
}
EOF

# ---- движок выключен человеком: списки обновляются, правила НЕ ставятся ----------------
#
# ЧТО ЗДЕСЬ СТОРОЖИТСЯ. Ночное обновление заканчивалось двумя действиями — `steer apply` и
# `reload_dnsd`, — и оба возвращали к жизни движок, который человек выключил кнопкой
# «Остановить всё»: apply ставил правила в ядро, а reload_dnsd при отсутствии экземпляра
# резолвера поднимал всю службу. Наутро движок работал сам, а интерфейс показывал
# «выключено» (он читает автозапуск, а тот остался снятым) — выключатель выглядел сломанным
# дважды. Обратка владельца: «если отключить splify2, спустя какое-то время он сам
# включается; причём запускается сам steer, splify2 всё ещё считает, что всё выключено».
#
# Признак выключенности — СНЯТАЯ ССЫЛКА автозапуска плюс неработающая служба: остановленная
# служба бывает случайностью, снятая ссылка ставится ровно одним человеческим действием.
rm -rf "$T/lists" "$T/var/last-update" "$T/rcd"
mkdir -p "$T/lists/domains" "$T/rcd"
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
case "${1:-}" in
    fit) src=""; for a in "$@"; do src="$a"; done; cat "$src" ;;
    apply) echo "apply" >> "$SANDBOX/applied.log"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$T/bin/steer"
cat > "$T/bin/initd-steer" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$SANDBOX/initd.log"
case "$1" in running) [ -f "$SANDBOX/steer-running" ] ;; *) : ;; esac
EOF
chmod +x "$T/bin/initd-steer"
rm -f "$T/applied.log" "$T/initd.log" "$T/steer-running"
: > "$T/syslog"

run_update() {
    SANDBOX="$T" PATH="$T/bin:$PATH" STEER="$T/bin/steer" SPEC="$T/etc/spec.json" \
        LISTS="$T/lists" MANIFEST="$T/etc/manifest.json" STAMP="$T/var/last-update" \
        LOCK="$T/var/update.lock" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        STEER_INIT="$T/bin/initd-steer" RC_D="$T/rcd" \
        sh "$SCRIPT" > "$T/out-off" 2>&1
}

run_update
check "выключенному движку правила не ставятся" "no" \
      "$([ -s "$T/applied.log" ] && echo yes || echo no)"
check "и резолвер ему не перезапускается" "no" \
      "$([ -s "$T/initd.log" ] && grep -q reload_dnsd "$T/initd.log" && echo yes || echo no)"
check "но списки при этом обновлены" "yes" \
      "$([ -s "$T/lists/rkn.lst" ] && echo yes || echo no)"
check "и сказано, почему правила не применены" "yes" \
      "$(grep -q 'движок выключен' "$T/syslog" && echo yes || echo no)"

# Автозапуск на месте — прежнее поведение целиком: правила ставятся, резолвер перечитывает.
rm -rf "$T/lists" "$T/var/last-update"
mkdir -p "$T/lists/domains"
ln -sf "$T/bin/initd-steer" "$T/rcd/S94steer"
rm -f "$T/applied.log" "$T/initd.log"
run_update
check "включённому движку правила ставятся как прежде" "yes" \
      "$([ -s "$T/applied.log" ] && echo yes || echo no)"

# Работающая служба со снятой ссылкой — человек поднял её руками, и мешать ему незачем.
rm -rf "$T/lists" "$T/var/last-update"
mkdir -p "$T/lists/domains"
rm -f "$T/rcd/S94steer" "$T/applied.log"
: > "$T/steer-running"
run_update
check "работающей службе правила ставятся, даже если ссылка снята" "yes" \
      "$([ -s "$T/applied.log" ] && echo yes || echo no)"

printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'все проверки прошли' || echo 'ЕСТЬ ПРОВАЛЫ')"
[ "$fails" -eq 0 ]
