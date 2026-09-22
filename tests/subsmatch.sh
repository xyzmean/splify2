#!/bin/sh
# Стенд автообновления подписок: splify2-update-subs.
#
# ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Скрипт сам ничего не качает — он смотрит по часам, кому пора, и зовёт
# метод объекта rpcd. Значит проверять надо ровно одно: КОГО он позвал и кого не тронул.
# Поэтому ubus здесь заглушка, которая протоколирует вызовы, а перечень подписок ей задаётся
# снаружи файлом.
#
# Почему это отдельный стенд, а не часть rpcdmatch.sh: там проверяется объект rpcd, а здесь
# задание крона, и общего у них — только имена методов.
#
# Запуск: sh tests/subsmatch.sh (нужен python3).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/files/usr/sbin/splify2-update-subs"
T="$(mktemp -d /tmp/subsmatch.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/bin"

fails=0
check() {  # ОПИСАНИЕ ОЖИДАЕМОЕ ПОЛУЧЕННОЕ
    if [ "$2" = "$3" ]; then
        printf '%-64s ok\n' "$1"
    else
        printf '%-64s ПРОВАЛ\n' "$1"
        printf '    ожидалось: %s\n    получено:  %s\n' "$2" "$3"
        fails=$((fails + 1))
    fi
}

cat > "$T/bin/jsonfilter" <<'EOF'
#!/bin/sh
file=""; str=""; exprs=""
while [ $# -gt 0 ]; do
    case "$1" in
        -i) file="$2"; shift 2 ;;
        -s) str="$2"; shift 2 ;;
        -e) exprs="$exprs$2
"; shift 2 ;;
        *) shift ;;
    esac
done
# Без -i и -s настоящий jsonfilter читает ПОТОК — так его и зовут в скрипте
# (`steer status | jsonfilter -e ...`). Поток вычитывается здесь, потому что дальше
# стандартный ввод занят программой python.
if [ -z "$file" ] && [ -z "$str" ]; then str="$(cat)"; fi
# Выражения уезжают переменной окружения, а не потоком: программу python читает как раз
# со стандартного ввода (`python3 -` плюс heredoc), и труба до неё не доходит.
EXPRS="$exprs" python3 - "$file" "$str" <<'PY'
import json, os, re, sys
path, raw = sys.argv[1], sys.argv[2]
try:
    d = json.loads(raw) if raw else json.load(open(path, encoding='utf-8'))
except Exception:
    sys.exit(1)

def render(v):
    if isinstance(v, bool):          return 'true' if v else 'false'
    if isinstance(v, (dict, list)):  return json.dumps(v, ensure_ascii=False)
    return str(v)

def walk(cur, parts):
    if not parts:
        if cur is not None:
            yield cur
        return
    p, rest = parts[0], parts[1:]
    if p == '*':
        items = cur if isinstance(cur, list) else list(cur.values()) if isinstance(cur, dict) else []
        for it in items:
            yield from walk(it, rest)
    elif isinstance(cur, list) and p.isdigit():
        i = int(p)
        if 0 <= i < len(cur):
            yield from walk(cur[i], rest)
    elif isinstance(cur, dict) and p in cur:
        yield from walk(cur[p], rest)

for expr in os.environ.get('EXPRS', '').splitlines():
    if not expr:
        continue
    m = re.match(r"@\.(categories|domain_lists)\[@\.id='([^']*)'\]\.([a-z_]+)$", expr)
    if m:
        for e in d.get(m.group(1), []):
            if e.get('id') == m.group(2) and m.group(3) in e:
                print(e[m.group(3)])
        continue
    # Поле записи, найденной ПО ПУТИ СПИСКА: так доскачивание спрашивает ссылку набора —
    # ему известен путь из спеки, а не идентификатор.
    m = re.match(r"@\.(categories|domain_lists)\[@\.file='([^']*)'\]\.([a-z_]+)$", expr)
    if m:
        for e in d.get(m.group(1), []):
            if e.get('file') == m.group(2) and m.group(3) in e:
                print(e[m.group(3)])
        continue
    # Общий обход: точки — шаги пути, [*] — «все элементы массива или все значения
    # объекта». Ровно тот набор выражений, который встречается в скрипте.
    # Числовой индекс массива (`@[0].tag_name`) — им читается список релизов GitHub.
    # Приводится к обычному шагу пути: скобки становятся точками, а walk() ниже понимает
    # цифровой шаг как индекс в списке.
    # Грамматика настоящего jsonfilter: голый шаг пути — LABEL [a-zA-Z_][a-zA-Z0-9_]*; имя с
    # дефисом или точкой годится только в скобках `['имя']`. Заглушка этому раньше не
    # следовала и делила путь по точкам как угодно — из-за чего стенд не видел, что имя
    # выхода `de-1` ломает каждый запрос по нему (I-284).
    norm = expr.replace('@.', '', 1).replace('[*]', '.*')
    norm = re.sub(r"\[(['\"])([^'\"]*)\1\]", lambda m: '.\x00' + m.group(2), norm)
    norm = norm.replace('[', '.').replace(']', '')
    parts = [x for x in norm.split('.') if x and x != '@']
    bad = False
    clean = []
    for x in parts:
        if x.startswith('\x00'):
            clean.append(x[1:])
        elif x == '*' or x.isdigit() or re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', x):
            clean.append(x)
        else:
            bad = True
    if bad:
        sys.stderr.write('Syntax error\n')
        sys.exit(1)
    for v in walk(d, clean):
        print(render(v))
PY
EOF
chmod +x "$T/bin/jsonfilter"

# ubus: перечень подписок берётся из файла (его пишет каждая проверка), обновление
# протоколируется. Отказ объекта задаётся UBUS_LIST_RC, отказ обновления — UBUS_REFRESH_RC.
cat > "$T/bin/ubus" <<'EOF'
#!/bin/sh
# call splify2 <метод> [json]
case "$3" in
    sub_list)
        [ "${UBUS_LIST_RC:-0}" = 0 ] || exit "$UBUS_LIST_RC"
        cat "$SANDBOX/sub_list.json"
        ;;
    sub_refresh)
        printf '%s\n' "$4" >> "$SANDBOX/refresh.log"
        [ "${UBUS_REFRESH_RC:-0}" = 0 ] || { printf 'отказ\n'; exit "$UBUS_REFRESH_RC"; }
        printf '{"ok":true,"changed":%s,"usable":3}\n' "${UBUS_CHANGED:-false}"
        ;;
    *) exit 1 ;;
esac
exit 0
EOF
chmod +x "$T/bin/ubus"

# logger: на машине разработчика он есть не всегда, а вывод стенду мешает.
cat > "$T/bin/logger" <<'EOF'
#!/bin/sh
shift 2 2>/dev/null || true
printf '%s\n' "$*" >> "$SANDBOX/log.txt"
EOF
chmod +x "$T/bin/logger"

run() {  # запускает скрипт в песочнице
    : > "$T/refresh.log"
    : > "$T/log.txt"
    env SANDBOX="$T" PATH="$T/bin:$PATH" LOCK="$T/lock" \
        UBUS_LIST_RC="${UBUS_LIST_RC:-0}" UBUS_REFRESH_RC="${UBUS_REFRESH_RC:-0}" \
        UBUS_CHANGED="${UBUS_CHANGED:-false}" \
        sh "$SCRIPT" >/dev/null 2>&1
}

# Перечень подписок: имя и признак «пора обновлять», который считает сам объект rpcd. Здесь
# он задаётся прямо — стенд проверяет задание крона, а не часы объекта: их проверяет
# rpcdmatch.sh, где живёт sub_auto_due.
subs() {  # subs '<json массива subs>'
    printf '{"subs":%s}\n' "$1" > "$T/sub_list.json"
}

echo "== автообновление подписок =="

# 1. Без интервала не ходим никуда. Это главное свойство: подписка, которую человек не просил
#    обновлять, не должна стучаться к панели вообще никогда.
subs '[{"name":"a","auto":0,"due":false}]'
run
check "интервал не задан — не обновляем" "" "$(cat "$T/refresh.log")"

# 2. Срок не вышел — тоже не ходим.
subs '[{"name":"a","auto":60,"due":false}]'
run
check "срок не вышел — не обновляем" "" "$(cat "$T/refresh.log")"

# 3. Срок вышел — обновляем, и только эту.
subs '[{"name":"a","auto":60,"due":true},{"name":"b","auto":0,"due":false},{"name":"c","auto":600,"due":false}]'
run
check "срок вышел — обновляем именно её" '{"name":"a"}' "$(cat "$T/refresh.log")"

# 4. Подписка, которую ещё ни разу не обновляли: отметки у неё нет вовсе, и поля auto_at в
#    перечне тоже. Строка обязана быть разобрана и без него — иначе такая подписка не
#    обновилась бы никогда.
subs '[{"name":"new","auto":30,"due":true}]'
run
check "подписки без отметки времени не теряются" '{"name":"new"}' "$(cat "$T/refresh.log")"

# 5. Объект rpcd не отвечает — прогон молча заканчивается, а не сыплет отказами в журнал и не
#    зовёт обновление вслепую.
subs '[{"name":"a","auto":30,"due":true}]'
UBUS_LIST_RC=1 run
check "объект не отвечает — никого не зовём" "" "$(cat "$T/refresh.log")"
UBUS_LIST_RC=0

# 6. Панель молчит: отказ одной подписки не мешает остальным. Проверяется на двух — обе
#    просрочены, обе обязаны быть опрошены.
subs '[{"name":"a","auto":30,"due":true},{"name":"b","auto":30,"due":true}]'
UBUS_REFRESH_RC=1 run
check "отказ одной не отменяет остальных" '{"name":"a"} {"name":"b"}' "$(tr '\n' ' ' < "$T/refresh.log" | sed 's/ $//')"
check "и о неудаче сказано в журнале" "yes" \
      "$(grep -q 'не обновилась' "$T/log.txt" && echo yes || echo no)"
UBUS_REFRESH_RC=0

# 7. Изменившиеся узлы названы словами: по этой строке человек в журнале понимает, почему
#    туннель перечитал настройку.
subs '[{"name":"a","auto":30,"due":true}]'
UBUS_CHANGED=true run
check "смена узлов названа в журнале" "yes" \
      "$(grep -q 'узлы изменились' "$T/log.txt" && echo yes || echo no)"
UBUS_CHANGED=false run
check "и неизменность тоже" "yes" \
      "$(grep -q 'узлы прежние' "$T/log.txt" && echo yes || echo no)"

echo
if [ "$fails" -gt 0 ]; then echo "ЕСТЬ ПРОВАЛЫ: $fails"; exit 1; fi
echo "автообновление подписок работает"
