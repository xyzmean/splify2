# Минимальная замена /usr/share/libubox/jshn.sh для стендов.
#
# Зачем. Скрипт rpcd целиком построен на jshn: 14 разных функций, 200 с лишним вызовов.
# libubox на машине разработчика нет и не будет — это часть OpenWrt, — а без неё скрипт
# не доживает до первой строки логики. Подменить путь у `.` нечем, поэтому в скрипте
# заведён шов JSHN_SH, а здесь лежит то, что он подставляет.
#
# Поверхность ровно та, которую использует скрипт, и ни функцией больше:
#   запись — json_init, json_add_string/int/boolean, json_add_object/close_object,
#            json_add_array/close_array, json_dump
#   чтение — json_load, json_get_var, json_select, json_get_keys
#
# Разделение труда. Запись — чистый POSIX-shell: собирается текст, и это ровно то, что
# делает оригинал. Чтение — python3, потому что разбор JSON в shell был бы третьей
# реализацией разбора в проекте и первой, которой никто не верит. От python3 стенды уже
# зависят: на нём написана заглушка jsonfilter в listsmatch.sh.
#
# Чего здесь СОЗНАТЕЛЬНО нет по сравнению с оригиналом:
#   - экранируются только \ " перевод строки и табуляция. Прочие управляющие символы
#     ушли бы в вывод как есть и дали бы невалидный JSON — в фикстурах стенда их нет,
#     а если появятся, проверка вывода упадёт, а не соврёт;
#   - нет namespace'ов (json_set_namespace) и нет json_add_double — скрипт их не зовёт;
#   - json_get_var на объекте отдаёт его JSON-текстом, а не «первый попавшийся скаляр».
#
# Требования: python3 и GNU sed.

_J_NL='
'
_J_TAB="$(printf '\t')"

# ---- запись -----------------------------------------------------------------
# _J_OUT — тело корневого объекта без внешних скобок.
# _J_FIRST — стек флагов «следующий элемент первый в своём контейнере», вершина слева.
#            Он и решает, ставить ли запятую; глубина при этом нигде не считается.

json_init() { _J_OUT=''; _J_FIRST='1'; }

_j_esc() {
    case "$1" in
        *'\'*|*'"'*|*"$_J_NL"*|*"$_J_TAB"*)
            # Склейка строк — ПЕРВОЙ. Пока её не было, `s/\\/\\\\/g` успевал отработать
            # только по первой строке: цикл `:a N $!ba` возвращается к метке, то есть
            # ниже подстановок, и второй строке они уже не достаются.
            #
            # Дальше порядок тоже не произволен: обратный слэш удваивается раньше, чем
            # появляются \n и \t, иначе удвоился бы и он.
            printf '%s' "$1" | sed -e ':a' -e 'N' -e '$!ba' \
                                   -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
                                   -e "s/$_J_TAB/\\\\t/g" -e 's/\n/\\n/g'
            ;;
        *) printf '%s' "$1" ;;
    esac
}

# Запятая перед элементом и, если ключ задан, сам ключ. Пустой ключ — элемент массива:
# так его добавляет и оригинал (json_add_string "" значение).
_j_open() {  # КЛЮЧ
    case "$_J_FIRST" in
        1*) _J_FIRST="0${_J_FIRST#?}" ;;
        *)  _J_OUT="$_J_OUT," ;;
    esac
    [ -n "$1" ] && _J_OUT="$_J_OUT\"$(_j_esc "$1")\":"
    return 0
}

json_add_string()  { _j_open "$1"; _J_OUT="$_J_OUT\"$(_j_esc "$2")\""; }
json_add_int()     { _j_open "$1"; _J_OUT="$_J_OUT$((${2:-0}))"; }
# jshn печатает булево числом, и интерфейс читает его как число: 1/0, не true/false.
json_add_boolean() { _j_open "$1"; case "$2" in 1|true) _J_OUT="${_J_OUT}true" ;; *) _J_OUT="${_J_OUT}false" ;; esac; }

json_add_object()  { _j_open "$1"; _J_OUT="$_J_OUT{"; _J_FIRST="1$_J_FIRST"; }
json_close_object(){ _J_OUT="$_J_OUT}"; _J_FIRST="${_J_FIRST#?}"; }
json_add_array()   { _j_open "$1"; _J_OUT="$_J_OUT["; _J_FIRST="1$_J_FIRST"; }
json_close_array() { _J_OUT="$_J_OUT]"; _J_FIRST="${_J_FIRST#?}"; }

json_dump() { printf '{%s}\n' "$_J_OUT"; }

# ---- чтение -----------------------------------------------------------------
# _J_DOC — разбираемый документ, _J_PATH — текущая позиция в нём, ключи через перевод
# строки. Перевод строки как разделитель безопасен: ключом здесь бывает имя поля или
# имя экземпляра сервиса, и ни в одном из них его быть не может.

_j_py() {  # ОПЕРАЦИЯ [КЛЮЧ]
    printf '%s' "$_J_DOC" | python3 -c '
import json, sys

op   = sys.argv[1]
path = sys.argv[2]
key  = sys.argv[3] if len(sys.argv) > 3 else ""

try:
    cur = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

for step in path.split("\n"):
    if not step:
        continue
    if isinstance(cur, dict) and step in cur:
        cur = cur[step]
    elif isinstance(cur, list):
        try:
            cur = cur[int(step)]
        except Exception:
            sys.exit(1)
    else:
        sys.exit(1)

def render(v):
    if v is None:            return ""
    if v is True:            return "1"
    if v is False:           return "0"
    if isinstance(v, (dict, list)): return json.dumps(v, ensure_ascii=False)
    return str(v)

if op == "check":
    sys.exit(0)
if op == "keys":
    if isinstance(cur, dict):
        sys.stdout.write("\n".join(cur.keys()))
    elif isinstance(cur, list):
        sys.stdout.write("\n".join(str(i) for i in range(len(cur))))
    sys.exit(0)
if op == "has":
    ok = (isinstance(cur, dict) and key in cur) or \
         (isinstance(cur, list) and key.isdigit() and int(key) < len(cur))
    sys.exit(0 if ok else 1)
if op == "get":
    if isinstance(cur, dict) and key in cur:
        sys.stdout.write(render(cur[key]))
    elif isinstance(cur, list) and key.isdigit() and int(key) < len(cur):
        sys.stdout.write(render(cur[int(key)]))
    sys.exit(0)
sys.exit(1)
' "$1" "$_J_PATH" "${2:-}"
}

json_load() {  # ТЕКСТ
    _J_DOC="$1"
    _J_PATH=''
    _j_py check
}

# Присваивание через eval, а не через `export`: значение может содержать что угодно, и
# повторного разбора оно не переживёт. `eval "имя=\$_j_val"` подставляет имя, но не
# содержимое.
json_get_var() {  # ИМЯ_ПЕРЕМЕННОЙ КЛЮЧ
    # Заплатка X и срезание её обратно: подстановка команды съедает ЗАВЕРШАЮЩИЕ переводы
    # строки, а значение обязано приезжать байт в байт. Оригинал их не теряет (он не
    # ходит через подстановку), и без заплатки стенд зеленел бы на испорченной передаче:
    # у куска архива, пришедшего через backup_put, пропадал последний перевод строки, и
    # две строки настроек склеивались в одну.
    _j_val="$(_j_py get "$2"; printf X)"
    _j_val="${_j_val%X}"
    eval "$1=\$_j_val"
}

json_select() {  # КЛЮЧ | ..
    if [ "$1" = '..' ]; then
        _J_PATH="${_J_PATH%"$_J_NL"*}"
        return 0
    fi
    _j_py has "$1" || return 1
    _J_PATH="$_J_PATH$_J_NL$1"
}

json_get_keys() {  # ИМЯ_ПЕРЕМЕННОЙ
    _j_val="$(_j_py keys | tr '\n' ' ')"
    eval "$1=\$_j_val"
}
