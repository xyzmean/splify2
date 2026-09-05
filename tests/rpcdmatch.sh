#!/bin/sh
# Стенд для ubus-объекта splify2 (files/usr/libexec/rpcd/splify2).
#
# Зачем именно так — ровно та же причина, что у listsmatch.sh: скрипт целиком состоит из
# обращений к системе (apk, wget, ubus, uci, jsonfilter, /etc/init.d), поэтому «вызвать
# функцию и посмотреть на результат» здесь не работает. Стенд поднимает окружение в
# каталоге-песочнице, подменяет внешние команды заглушками в PATH, а абсолютные пути —
# швами (JSHN_SH, INITD, OPENWRT_RELEASE и остальные). Скрипт запускается настоящий,
# целиком, как его запускает rpcd.
#
# Отличие от listsmatch.sh одно: скрипт подключает /usr/share/libubox/jshn.sh, которого
# на машине разработчика нет. Его заменяет tests/stub/jshn.sh — см. шапку того файла.
#
# Заглушки протоколируют вызовы в файлы внутри песочницы, и большая часть проверок —
# именно про ПОРЯДОК вызовов, а не про ответ: находка I-049 в том и состоит, что порядок
# apk del / apk add неверен, а ответ при этом честный.
#
# Запуск: sh tests/rpcdmatch.sh (нужен python3).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/files/usr/libexec/rpcd/splify2"
# Объект разнесён по файлам: диспетчер (SCRIPT), общие помощники и группы методов в
# usr/lib/splify2/rpcd. Проверки по ТЕКСТУ объекта смотрят во все его файлы разом.
RPCD_DIR="$ROOT/files/usr/lib/splify2/rpcd"
RPCD_ALL="$SCRIPT $RPCD_DIR/common.sh $RPCD_DIR/m-*.sh"
rpcd_src() { cat $RPCD_ALL; }  # shellcheck disable=SC2086
T="$(mktemp -d /tmp/rpcdmatch.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM

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

mkdir -p "$T/bin" "$T/lists/domains" "$T/etc" "$T/var"

# ---- заглушки внешних команд -------------------------------------------------
# apk: протоколирует каждый вызов первым словом. Поведение `add` задаётся снаружи,
# переменными APK_ADD_RC и APK_ADD_OUT, — иначе отказ установки нечем воспроизвести.
cat > "$T/bin/apk" <<'EOF'
#!/bin/sh
case "$1" in
    del) echo "del $2" >> "$SANDBOX/apk.log"; exit 0 ;;
    add)
        echo "add $*" >> "$SANDBOX/apk.log"
        [ -n "${APK_ADD_OUT:-}" ] && echo "$APK_ADD_OUT" >&2
        exit "${APK_ADD_RC:-0}"
        ;;
    list)
        echo "steer-extended-0.9.5-r1 aarch64_cortex-a53 {steer-extended}"
        echo "luci-app-splify2-0.7.6-r1 all {luci-app-splify2}"
        ;;
    --print-arch) echo "aarch64" ;;
esac
exit 0
EOF

# /etc/init.d/steer: тот же протокол, но с ПАМЯТЬЮ. enable/disable оставляют след на
# диске, а enabled его читает — иначе «после остановки автозапуск снят» проверялось бы
# против заглушки, которая всегда отвечает одно и то же, то есть ни против чего.
# ENGINE_ENABLED задаёт лишь начальное состояние.
cat > "$T/bin/initd-steer" <<'EOF'
#!/bin/sh
echo "$1" >> "$SANDBOX/initd.log"
case "$1" in
    enable)  rm -f "$SANDBOX/disabled" ;;
    disable) : > "$SANDBOX/disabled" ;;
    enabled) [ -f "$SANDBOX/disabled" ] && exit 1; exit "${ENGINE_ENABLED:-0}" ;;
    # `start` на работающем сервисе — это пересборка набора экземпляров procd. След нужен
    # заглушке движка: по нему её `status` отвечает, жив ли обработчик обхода. Без этого
    # проверить «экземпляры пересобрались» было бы нечем — заглушка всегда говорила бы «жив».
    # Когда стенд считает опросы (ZAPRET_UP_AT_CALL), «жив ли обработчик» решает счётчик в
    # заглушке движка, а не этот след: подъём в тот же миг и есть то, чего на роутере не бывает.
    # Счётчик обнуляется ЗДЕСЬ, и это делает счёт независимым от остального apply: `start`
    # стоит ровно перед ожиданием, значит после него объект опрашивает состояние только в
    # цикле ожидания, и опрос №N — это ровно N-й круг цикла.
    start)   if [ -n "${ZAPRET_UP_AT_CALL:-}" ]; then : > "$SANDBOX/steer-status.count"
             else : > "$SANDBOX/zapret-up"; fi ;;
esac
exit 0
EOF

# Обход DPI: объект проверяет только исполнимость файла (zp_installed), поэтому заглушке
# достаточно быть исполняемой. Ключи nfqws проверяет стенд zapretmatch, а не эта.
printf '#!/bin/sh\nexit 0\n' > "$T/bin/nfqws"
# Служба zapret: init-скрипт записывает команды, ссылка автозапуска — настоящая, в своём rc.d:
# по ней объект и отвечает `enabled`. Функцией, потому что раздел обхода ниже заводит
# заглушку заново.
zapret_initd_stub() {
    mkdir -p "$T/rcd-zapret"
    cat > "$T/bin/initd-zapret" <<EOF
#!/bin/sh
echo "\$1" >> "$T/initd-zapret.log"
case "\$1" in
    enable)  ln -sf "$T/bin/initd-zapret" "$T/rcd-zapret/S21zapret" ;;
    disable) rm -f "$T/rcd-zapret/S21zapret" ;;
esac
EOF
    chmod +x "$T/bin/initd-zapret"
}
zapret_initd_stub

cat > "$T/bin/initd-rpcd" <<'EOF'
#!/bin/sh
echo "$1" >> "$SANDBOX/rpcd-initd.log"
exit 0
EOF

# wget: два разных запроса — список релизов у GitHub API и сам пакет.
# В списке намеренно есть теги НЕ вида X.Y.Z: ровно их steer_install потом отвергает.
cat > "$T/bin/wget" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
    case "$1" in
        -qO-) shift ;;
        -qO)  out="$2"; shift 2 ;;
        --timeout=*) shift ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
echo "$url" >> "$SANDBOX/wget.log"
case "$url" in
    *api.github.com*)
        # Список релизов. Теперь с ЗАГОЛОВКАМИ: у выпуска есть кодовое имя («26.9 Andromeda»),
        # и приезжает оно полем `name`, а не тегом — в теге и в имени файла пакета пробелу
        # места нет. В наборе намеренно есть релиз без заголовка (null) и заголовок с
        # вертикальной чертой: обе ветки отката на число проверяются ниже.
        #
        # GH_FAIL=1 — «хост не отвечает вовсе»: так это и выглядит у человека, которому
        # закрыли api.github.com или у которого за CGNAT выбрали неавторизованный лимит
        # (splify2#5). Отличается от GH_BODY='не json' тем, что ответа нет, а не что он плох.
        [ -n "${GH_FAIL:-}" ] && exit 1
        #
        # Уезжает в ФАЙЛ, когда его просят (-qO файл), и в поток, когда просят поток: список
        # версий читается jsonfilter-ом, а тому нужен файл.
        if [ -n "${GH_BODY:-}" ]; then body="$GH_BODY"; else
            body='[{"tag_name": "v26.9", "name": "26.9 Andromeda"},{"tag_name": "v0.9.6", "name": null},{"tag_name": "v0.9.5-rc1", "name": "0.9.5 rc1"},{"tag_name": "v0.9.4", "name": "0.9.4 | старьё"},{"tag_name": "nightly", "name": "nightly"}]'
        fi
        if [ -n "$out" ]; then printf '%s\n' "$body" > "$out"; else printf '%s\n' "$body"; fi
        ;;
    *)
        [ -n "$out" ] && echo "пакет" > "$out"
        ;;
esac
exit 0
EOF

# jsonfilter: поддерживаются те выражения, которые встречаются на проверяемых путях.
# Выражений в одном вызове бывает НЕСКОЛЬКО (-e ... -e ...), и настоящий jsonfilter
# печатает совпадения по всем. Пока заглушка запоминала только последнее, проверка
# недоверенной спеки смотрела бы на одно поле из пяти — то есть была бы зелёной по
# недосмотру заглушки, а не по существу.
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
    m = re.match(r"@\.(categories|domain_lists)\[@\.id='([^']*)'\]\.file$", expr)
    if m:
        for e in d.get(m.group(1), []):
            if e.get('id') == m.group(2):
                print(e['file'])
        continue
    # Общий обход: точки — шаги пути, [*] — «все элементы массива или все значения
    # объекта». Ровно тот набор выражений, который встречается в скрипте.
    # Числовой индекс массива (`@[0].tag_name`) — им читается список релизов GitHub.
    # Приводится к обычному шагу пути: скобки становятся точками, а walk() ниже понимает
    # цифровой шаг как индекс в списке.
    norm = expr.replace('@.', '', 1).replace('[*]', '.*')
    norm = norm.replace('[', '.').replace(']', '')
    parts = [x for x in norm.split('.') if x and x != '@']
    for v in walk(d, parts):
        print(render(v))
PY
EOF

printf '#!/bin/sh\nexit 0\n' > "$T/bin/logger"
# uci: маленькое, но НАСТОЯЩЕЕ хранилище — «ключ=значение» в файле песочницы.
#
# Раньше заглушка отвечала одним `exit 1`, то есть «настройки нет никогда». Этого хватало,
# пока настройки только записывались; методу sub_quota она нужна на ЧТЕНИЕ — ссылку подписки
# он берёт из uci и ниоткуда больше, и на молчащей заглушке метод не мог ничего спросить, а
# проверка была бы зелёной при любом поведении.
cat > "$T/bin/uci" <<'EOF'
#!/bin/sh
# Заглушка uci: плоское хранилище «ключ=значение» построчно.
#
# СРАВНЕНИЕ ИДЁТ `case`, А НЕ `grep`, и это не стилистика. Настоящий uci называет безымянную
# секцию «@xsteer_home[0]» — проверено на живом роутере, — а в шаблоне grep квадратные скобки
# означают класс символов: «^network.@xsteer_home[0]=» совпадает с «network.@xsteer_home0=» и не
# совпадает с тем, что искали. Заглушка на grep поэтому «не находила» секцию, которую настоящий
# uci находит, и скрывала бы обратную ошибку — код, который ищет секцию по имени вместо типа.
# В `case` подстановка в кавычках сравнивается буквально.
S="$SANDBOX/uci.store"
[ -f "$S" ] || : > "$S"
while [ $# -gt 0 ]; do
    case "$1" in -*) shift ;; *) break ;; esac
done
case "${1:-}" in
    get)
        v=""; found=0
        while IFS= read -r line; do
            case "$line" in "${2:-}="*) v="${line#*=}"; found=1 ;; esac
        done < "$S"
        [ "$found" = 1 ] || exit 1
        printf '%s\n' "$v"
        ;;
    set)
        k="${2%%=*}"; v="${2#*=}"
        : > "$S.t"
        while IFS= read -r line; do
            case "$line" in "$k="*) continue ;; esac
            printf '%s\n' "$line" >> "$S.t"
        done < "$S"
        printf '%s=%s\n' "$k" "$v" >> "$S.t"
        mv "$S.t" "$S"
        ;;
    delete)
        # Удаление СЕКЦИИ уносит и её опции: «network.cfg1» это и строка типа, и все
        # «network.cfg1.*». Без этого удалённый пир оставлял бы за собой свои поля, и
        # следующий `show` находил бы половину секции.
        : > "$S.t"
        while IFS= read -r line; do
            case "$line" in "${2:-}="*|"${2:-}".*) continue ;; esac
            printf '%s\n' "$line" >> "$S.t"
        done < "$S"
        mv "$S.t" "$S"
        ;;
    show)
        # Формат тот же, что у настоящего uci: значение опции в кавычках, тип секции без них.
        # Разница значима — по ней метод отличает секцию от её полей.
        pfx="${2:-}"
        while IFS= read -r line; do
            k="${line%%=*}"; v="${line#*=}"
            case "$k" in "$pfx"|"$pfx".*) ;; *) continue ;; esac
            case "$k" in
                *.*.*) printf "%s='%s'\n" "$k" "$v" ;;
                *) printf '%s=%s\n' "$k" "$v" ;;
            esac
        done < "$S"
        ;;
    add)
        # Имя безымянной секции — то, что печатает настоящий uci: @<тип>[<номер>].
        i=0
        while IFS= read -r line; do
            case "$line" in "${2:-}.@${3:-}["*) i=$((i + 1)) ;; esac
        done < "$S"
        n="@${3:-}[$i]"
        printf '%s.%s=%s\n' "${2:-}" "$n" "${3:-}" >> "$S"
        printf '%s\n' "$n"
        ;;
    add_list)
        # Список хранится ОДНОЙ строкой через пробел — ровно так его отдаёт `uci get`.
        k="${2%%=*}"; v="${2#*=}"
        old=""
        while IFS= read -r line; do
            case "$line" in "$k="*) old="${line#*=}" ;; esac
        done < "$S"
        : > "$S.t"
        while IFS= read -r line; do
            case "$line" in "$k="*) continue ;; esac
            printf '%s\n' "$line" >> "$S.t"
        done < "$S"
        if [ -n "$old" ]; then printf '%s=%s %s\n' "$k" "$old" "$v" >> "$S.t"
        else printf '%s=%s\n' "$k" "$v" >> "$S.t"; fi
        mv "$S.t" "$S"
        ;;
    commit) : ;;
esac
exit 0
EOF
# ubus: код возврата прежний (на машине разработчика его нет, и скрипт обязан это
# переживать), но вызовы теперь протоколируются — сигнал экземпляру виден только так.
# nft: ничего не делает, но записывает всё, что ему дали — и аргументами, и потоком.
# Проверять фикс Zapret Manager иначе нечем: таблица собирается heredoc-ом.
# opkg: воспроизводит беду свежей прошивки — списков пакетов нет, и зависимость локального
# файла не находится. После `opkg update` установка проходит.
cat > "$T/bin/ifup" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/ifup.log"
exit 0
EOF
chmod +x "$T/bin/ifup"
cat > "$T/bin/opkg" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/opkg.log"
case "$1" in
    update) : > "$SANDBOX/opkg.lists"; exit 0 ;;
    install)
        if [ -f "$SANDBOX/opkg.lists" ]; then
            echo "Installing steer"; exit 0
        fi
        echo "Collected errors:"
        echo " * pkg_hash_check_unresolved: cannot find dependency ip-full for steer"
        exit 1
        ;;
    list-installed) exit 0 ;;
esac
exit 0
EOF

cat > "$T/bin/nft" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/nft.log"
case "$*" in *-f\ -*) cat >> "$SANDBOX/nft.log" ;; esac
exit 0
EOF

cat > "$T/bin/ubus" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/ubus.log"
exit 1
EOF
# curl: им ходит download(), то есть и списки издателя, и «свой список по ссылке».
# Протокол отдельный от wget: через wget идут пакеты и GitHub API, и смешивать их в
# одном журнале значило бы проверять «что-то скачалось» вместо «скачалось это».
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
out=""; url=""; dump=""; head=0
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        # -fsSI: запрос ОДНИХ заголовков, которым обновляется остаток трафика подписки.
        # Заголовки при этом уезжают в stdout, а не в файл -D, и тела нет вовсе — поэтому
        # ветка отдельная: без неё стенд не отличил бы «спросили заголовки» от «скачали
        # подписку заново».
        -fsSI|-I) head=1; shift ;;
        # Заголовки ЗАПРОСА протоколируются отдельным файлом: подписка уходит с
        # идентификатором устройства, и проверить это можно только так — в URL его нет.
        -H) echo "$2" >> "$SANDBOX/curl.hdrs"; shift 2 ;;
        # -D: сюда curl складывает заголовки ОТВЕТА. Стенд подставляет их через
        # CURL_RESP_HDRS — иначе сигналы панели («HWID не назван», «лимит устройств»)
        # нечем воспроизвести.
        -D) dump="$2"; shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
echo "$url" >> "$SANDBOX/curl.log"
if [ "$head" = 1 ]; then
    echo "$url" >> "$SANDBOX/curl.head.log"
    printf 'HTTP/2 200\r\n%s\r\n' "${CURL_HEAD_HDRS-${CURL_RESP_HDRS:-}}"
    exit "${CURL_HEAD_RC:-0}"
fi
[ -n "$dump" ] && printf 'HTTP/2 200\r\n%s\r\n' "${CURL_RESP_HDRS:-}" > "$dump"
if [ -n "$out" ]; then
    if [ -n "${CURL_BODY:-}" ]; then printf '%s\n' "$CURL_BODY" > "$out"
    else printf 'remote.example\n10.1.0.0/16\n' > "$out"
    fi
fi
exit "${CURL_RC:-0}"
EOF
# steer: журналирует, ЧЕМ его позвали, и умеет отказать. Нужно ровно для одной мысли —
# восстановление из архива проверяет спеку компилятором (`apply --dry-run`) и НЕ применяет
# её (`apply --spec` без dry-run). Различить это можно только по журналу вызовов.
#
# Подкоманда `outputs` отвечает ПО СПЕКЕ, а не молчанием, и это не украшение стенда:
# имена выходов скрипт узнаёт только отсюда, поэтому на молчащей заглушке любая проверка
# признака пересборки туннелей была бы зелёной при любом поведении скрипта.
cat > "$T/bin/steer" <<'EOF'
#!/bin/sh
echo "$*" >> "$SANDBOX/steer.log"
[ -n "${STEER_ERR:-}" ] && echo "$STEER_ERR" >&2
# Проверка узла: движок пишет предупреждения в stderr, а JSON — в stdout. Стенду нужно уметь
# воспроизводить обе половины сразу: именно их смешение и ломало ответ.
case "${1:-}" in
    vless-probe|vless-nodes)
        [ -n "${STEER_NOISE:-}" ] && echo "$STEER_NOISE" >&2
        [ -n "${STEER_JSON:-}" ] && printf '%s\n' "$STEER_JSON"
        exit "${STEER_RC:-0}"
        ;;
    # ПОДПИСКА. Скачивание, разбор заголовков панели, идентификатор устройства и арифметика
    # остатка трафика живут в ДВИЖКЕ (steer sub-fetch / sub-quota / sub-hwid), а не здесь: см.
    # steer/src/ext/subfetch.c и стенд steer/tests/subfetchmatch.c, где всё это и проверяется.
    #
    # Заглушке поэтому незачем повторять поведение движка — и повторять его было бы вредно:
    # проверялась бы заглушка, а не код. Она делает ровно то, что важно этому стенду:
    # протоколирует аргументы (по ним видно, ЧТО именно спросил объект rpcd), кладёт файлы туда,
    # куда просили, и отдаёт заданный ответ.
    # ССЫЛКА xs://. Заглушка НЕ разбирает формат и не должна: разбор живёт в движке и проверяется
    # его собственным стендом (steer/tests/xslinkmatch.c) плюс побайтовой сверкой с половиной на
    # Go. Здесь важно другое — что метод rpcd зовёт движок правильно (ссылка приходит стандартным
    # ВВОДОМ, а не аргументом: аргументы видны в списке процессов) и что он делает с ответом.
    xsteer-link)
        shift
        _src="${1:-}"
        if [ "$_src" = "-" ]; then
            _in="$(cat)"
            echo "stdin=$_in" >> "$SANDBOX/steer.log"
            case "${XS_LINK_RC:-0}" in
                0) printf '%s\n' "${XS_CONF_OUT:-[Interface]
PrivateKey = 6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=
Address = 10.77.0.5/24
SNI = www.microsoft.com

[Peer]
PublicKey = QYkH5bWOsEOCgIMldHPATSG7yvNyJ8st7o/HMelWKxs=
AllowedIPs = 10.77.0.0/24, 192.168.9.0/24
Endpoint = 198.51.100.9:8443
PersistentKeepalive = 25}" ;;
                *) echo "${XS_LINK_ERR:-приватный ключ в ссылке негоден}" >&2 ;;
            esac
            exit "${XS_LINK_RC:-0}"
        fi
        case "${XS_LINK_RC:-0}" in
            0) printf '%s\n' "${XS_LINK_OUT:-xs://PRIV@198.51.100.9:8443?pk=PUB&ip=10.77.0.5/24}" ;;
            *) echo "${XS_LINK_ERR:-файл не разобрался}" >&2 ;;
        esac
        exit "${XS_LINK_RC:-0}"
        ;;
    sub-hwid)
        printf '{"hwid":"%s","os":"OpenWrt 25.12.5","model":"Xiaomi AX3000T"}\n' \
               "${STEER_HWID-splify2-9c53221f0abc9c53}"
        exit 0
        ;;
    sub-fetch)
        shift
        _out=""; _info=""; _url=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --out) _out="$2"; shift 2 ;;
                --info) _info="$2"; shift 2 ;;
                *) _url="$1"; shift ;;
            esac
        done
        printf '%s %s %s\n' "$_url" "$_out" "$_info" >> "$SANDBOX/subfetch.log"
        if [ -n "${STEER_SUB_RC:-}" ] && [ "$STEER_SUB_RC" != 0 ]; then
            printf '{"ok":false,"error":"подписка не скачалась"}\n'
            exit "$STEER_SUB_RC"
        fi
        [ -n "$_out" ] && printf '%s\n' "${STEER_SUB_BODY:-vless://k@h:443#n}" > "$_out"
        if [ -n "$_info" ]; then
            if [ -n "${STEER_SUB_INFO:-}" ]; then printf '%s\n' "$STEER_SUB_INFO" > "$_info"
            else rm -f "$_info"
            fi
        fi
        if [ -n "${STEER_SUB_JSON:-}" ]; then
            printf '%s\n' "$STEER_SUB_JSON"
        else
            printf '{"ok":true,"url":"%s","usable":1,"title":"","hwid_sent":true}\n' "$_url"
        fi
        exit 0
        ;;
    sub-quota)
        shift
        _info=""; _url=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --info) _info="$2"; shift 2 ;;
                *) _url="$1"; shift ;;
            esac
        done
        printf '%s %s\n' "$_url" "$_info" >> "$SANDBOX/subquota.log"
        [ -n "${STEER_QUOTA_RC:-}" ] && [ "$STEER_QUOTA_RC" != 0 ] && exit "$STEER_QUOTA_RC"
        if [ -n "$_info" ]; then
            if [ -n "${STEER_SUB_INFO:-}" ]; then printf '%s\n' "$STEER_SUB_INFO" > "$_info"
            else rm -f "$_info"
            fi
        fi
        printf '{"ok":true,"asked":true}\n'
        exit 0
        ;;
esac
# status: собирается из спеки, чтобы у выходов была метка. Без неё фикс Zapret Manager
# нечем проверить — он берёт метку именно оттуда, а не выдумывает.
# Проверки состояния: заглушка отвечает так же, как движок, — документом с приговорами.
# Нужна для круга опроса: он спрашивает их по просьбе, и «пришло/не пришло» без ответа
# заглушки не отличить от «движок старый».
if [ "$1" = diag ]; then
    printf '{"schema":1,"checks":[{"id":"table","verdict":"ok","what":"таблица на месте","why":""}],"warn":0,"fail":0}\n'
    exit 0
fi
if [ "$1" = status ]; then
    spec=""
    while [ $# -gt 0 ]; do case "$1" in --spec) spec="$2"; shift 2 ;; *) shift ;; esac; done
    [ -s "$spec" ] && python3 - "$spec" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
outs, mark = {}, 0x00100000
for name, o in (d.get('outputs') or {}).items():
    if not isinstance(o, dict):
        continue
    if o.get('kind') == 'direct':
        outs[name] = {'kind': 'direct'}
    elif o.get('kind') == 'zapret':
        # У выхода обхода `up` означает «жив обработчик его очереди», а не «поднято
        # устройство». Заглушка не может это знать сама, поэтому читает след, который
        # оставляет заглушка init-скрипта на `start`: так моделируется procd, заводящий
        # экземпляр. Отвечать здесь всегда True значило бы проверять ветку, которая на
        # роутере никогда не выбирается.
        import os as _os
        _sb = _os.environ.get('SANDBOX', '')
        up = _os.path.exists(_os.path.join(_sb, 'zapret-up'))
        # ...либо обработчик «поднимается» на заданном по счёту опросе. Нужно ровно одному
        # стенду — тому, что проверяет ожидание в apply: там важно НЕ время, а то, на каком
        # именно опросе объект перестаёт спрашивать. Порог стенд вычисляет сам (см. «ожидание
        # обработчика обхода»), поэтому здесь только счётчик и сравнение.
        _at = _os.environ.get('ZAPRET_UP_AT_CALL', '')
        if _at:
            _cf = _os.path.join(_sb, 'steer-status.count')
            try:
                _n = int(open(_cf).read().strip() or 0)
            except Exception:
                _n = 0
            _n += 1
            open(_cf, 'w').write(str(_n))
            if _n >= int(_at):
                up = True
        outs[name] = {'kind': 'zapret', 'up': up, 'mark': f'0x{mark:08x}',
                      'queue': 8300, 'opts_file': f'/etc/steer/zapret/{name}.opts'}
        mark <<= 1
    else:
        outs[name] = {'kind': o.get('kind'), 'up': True, 'mark': f'0x{mark:08x}', 'table': 300}
        mark <<= 1
print(json.dumps({'schema': 1, 'outputs': outs, 'channels': []}, ensure_ascii=False))
PYEOF
    exit 0
fi
if [ "$1" = outputs ]; then
    spec=""; kind=""; obfs=0; devs=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --spec) spec="$2"; shift 2 ;;
            --kind) kind="$2"; shift 2 ;;
            --obfs) obfs=1; shift ;;
            --devices) devs=1; shift ;;
            *) shift ;;
        esac
    done
    [ -s "$spec" ] && KIND="$kind" OBFS="$obfs" DEVS="$devs" python3 - "$spec" <<'PYEOF'
import json, os, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
for name, o in (d.get('outputs') or {}).items():
    if not isinstance(o, dict):
        continue
    if os.environ.get('OBFS') == '1':
        if o.get('obfs'):
            print(name)
    elif not os.environ.get('KIND') or o.get('kind') == os.environ['KIND']:
        # --devices печатает УСТРОЙСТВО, а не имя выхода: у vless и xsteer оно выводится из
        # имени (не длиннее IFNAMSIZ), но может быть задано в спеке явно. Выход без
        # устройства (kind=direct) движок при этом пропускает.
        if os.environ.get('DEVS') == '1':
            dev = o.get('device') or (name[:15] if o.get('kind') != 'direct' else '')
            if dev:
                print(dev)
        else:
            print(name)
PYEOF
fi
exit "${STEER_RC:-0}"
EOF
chmod +x "$T/bin"/*

# ---- фикстуры ----------------------------------------------------------------
cat > "$T/etc/manifest.json" <<'EOF'
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "news", "file": "news.lst" } ],
  "domain_lists": [ { "id": "news", "file": "domains/news.lst" } ]
}
EOF

cat > "$T/etc/spec.json" <<EOF
{ "schema": 1,
  "channels": [ { "name": "c1", "match": { "prefixes_files": ["$T/lists/news.lst"] } } ] }
EOF

printf '10.0.0.0/8\n'  > "$T/lists/news.lst"
printf 'example.org\n' > "$T/lists/domains/news.lst"

# Поддельное /sys/class/net. Три случая нарочно: физический порт с постоянным MAC (он и
# должен победить), мост с ТЕМ ЖЕ адресом и без ссылки `device` (виртуальное — не наше) и
# физический wifi с адресом «назначен локально» (такой ядро выдумывает, после перезагрузки
# он другой).
mkdir -p "$T/sys/class/net/eth0/device" "$T/sys/class/net/br-lan" "$T/sys/class/net/wlan0/device"
printf '9C:53:22:1F:0A:BC\n' > "$T/sys/class/net/eth0/address"
printf '9c:53:22:1f:0a:bc\n' > "$T/sys/class/net/br-lan/address"
printf '0a:11:22:33:44:55\n' > "$T/sys/class/net/wlan0/address"
printf 'Xiaomi AX3000T\n'    > "$T/etc/sysinfo-model"

# Поддельное /sys/class/net для перечня СЕТЕЙ КЛИЕНТОВ (splify2#16). Набор списан с
# роутера человека из обращения: домашний мост, порт внутри этого моста, wan, туннель
# Tailscale и мост ZeroTier. Каждое устройство здесь отвечает на свой вопрос отбора.
mkdir -p "$T/sysnet/lo" "$T/sysnet/br-lan" "$T/sysnet/lan1" "$T/sysnet/wan" \
         "$T/sysnet/tailscale0" "$T/sysnet/ztrfyzwvfa" "$T/sysnet/br-guest"
ln -s ../br-lan "$T/sysnet/lan1/master"          # порт внутри моста — не своя сеть
for d in lo br-lan lan1 wan tailscale0 ztrfyzwvfa; do printf 'up\n' > "$T/sysnet/$d/operstate"; done
printf 'down\n' > "$T/sysnet/br-guest/operstate"  # гостевой мост поднимут позже

# Туннельные устройства — отдельной фикстурой (шов OUT_SYSNET): метод `devices` отвечает на
# другой вопрос, чем client_nets, и отбирает по /sys/class/net/*/type. 65534 — ARPHRD_NONE
# (wireguard, tun), у моста и порта тип другой, и в перечень они попасть не должны.
# Счётчики устройств — своя фикстура (шов SYSNET_STATS): их читают и метод dev_stats, и круг
# опроса `live`, и до сих пор они брались из настоящего /sys, то есть стендом не проверялись
# вовсе.
mkdir -p "$T/statnet/wg0/statistics" "$T/statnet/br-lan/statistics" "$T/statnet/lo/statistics"
for d in wg0 br-lan lo; do
    printf '11\n' > "$T/statnet/$d/statistics/rx_bytes"
    printf '22\n' > "$T/statnet/$d/statistics/tx_bytes"
    printf '3\n'  > "$T/statnet/$d/statistics/rx_packets"
    printf '4\n'  > "$T/statnet/$d/statistics/tx_packets"
done
printf '223000000\n' > "$T/statnet/wg0/statistics/rx_bytes"

mkdir -p "$T/outnet/wg0" "$T/outnet/br-lan" "$T/outnet/lan1"
printf '65534\n' > "$T/outnet/wg0/type";    printf 'up\n'   > "$T/outnet/wg0/operstate"
printf 'DEVTYPE=wireguard\n' > "$T/outnet/wg0/uevent"
printf '772\n'   > "$T/outnet/br-lan/type"; printf 'up\n'   > "$T/outnet/br-lan/operstate"
printf '1\n'     > "$T/outnet/lan1/type";   printf 'up\n'   > "$T/outnet/lan1/operstate"

# ip: единственная подкоманда, которая нужна перечню сетей, — адреса устройства. Форма
# строки как у настоящего `ip -4 -o addr show`, включая хвост после префикса: разбор обязан
# брать второе поле, а не всю строку. У Tailscale адрес /32 — сеть из одного адреса, и это
# не выдумка стенда, а то, из-за чего перечень обязан показывать ВЫВЕДЕННУЮ сеть.
cat > "$T/bin/ip" <<'EOF'
#!/bin/sh
# Адреса: и по одному устройству, и ВСЕ РАЗОМ. Второе — то, как настоящий `ip` отвечает на
# `ip -4 -o addr show` без имени; перечень сетей клиентов спрашивает именно так, одним
# запуском вместо запуска на устройство.
all() {
    echo "3: br-lan    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan"
    # Адрес wan подменяем из теста: бывает, что сторона провайдера сама частная (роутер за
    # роутером), и тогда «клиентом» выглядит всякий, кто пришёл оттуда.
    echo "4: wan    inet ${IP_WAN_ADDR:-46.42.17.15/22} brd 46.42.19.255 scope global wan"
    echo "9: tailscale0    inet 100.64.1.5/32 scope global tailscale0"
    echo "8: ztrfyzwvfa    inet 10.147.17.20/24 brd 10.147.17.255 scope global ztrfyzwvfa"
    echo "1: lo    inet 127.0.0.1/8 scope host lo"
}
dev=""
for a in "$@"; do dev="$a"; done
case "$1" in rule|route) exit 0 ;; esac
case "$dev" in
    show)       all ;;
    br-lan)     all | grep " br-lan " ;;
    wan)        all | grep " wan " ;;
    tailscale0) all | grep " tailscale0 " ;;
    ztrfyzwvfa) all | grep " ztrfyzwvfa " ;;
    lo)         all | grep " lo " ;;
esac
exit 0
EOF
chmod +x "$T/bin/ip"

# ---- вызов настоящего скрипта -------------------------------------------------
# Один вход на все проверки: разница между ними — только в фикстурах и переменных.
# Вызов БЕЗ завершающего перевода строки — ровно так передаёт запрос ubus.
#
# Разница не косметическая: `read` на входе без перевода строки возвращает НЕНУЛЕВОЙ код,
# уже заполнив переменную, и обработчик, написанный как `read -r input || input=''`, затирал
# прочитанное. Метод молча отвечал по первой подписке, а на экране у второй стояли чужие
# числа. Стенд всё это время передавал вход с переводом строки и потому ловушку не видел.
rpcd_raw() {  # МЕТОД JSON_ЗАПРОСА
    RPCD_NO_NEWLINE=1 rpcd "$@"
}

rpcd() {  # МЕТОД [JSON_ЗАПРОСА]  — вызов метода; для перечня методов есть rpcd_list
    if [ "${RPCD_NO_NEWLINE:-0}" = 1 ]; then printf '%s' "${2:-}"; else printf '%s\n' "${2:-}"; fi | env \
        SANDBOX="$T" \
        PATH="$T/bin:$PATH" \
        JSHN_SH="$ROOT/tests/stub/jshn.sh" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        FAST_SH="$ROOT/files/usr/lib/splify2/fast.sh" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
        DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
        RPCD_LIB="$ROOT/files/usr/lib/splify2/rpcd" \
        ZAPRET_TEST="$T/bin/zapret-test" \
        ZAPRET_AUTOSEL="$T/bin/zapret-autoselect" \
        AD_SH="${AD_SH_FIXTURE:-$ROOT/files/usr/share/splify2/allow-domains.sh}" \
        AD_STAMP="$T/etc/allow-domains.tag" AD_TMP="$T/srs-tmp" \
        AD_BASE="${AD_BASE_FIXTURE:-file://$T/adrel}" AD_TAG_DEFAULT="${AD_TAG_FIXTURE:-2026-08-31_16-18}" \
        ZA_PIDFILE="$T/zapret/autosel.pid" ZA_LOCK="$T/zapret/autosel.lock" \
        ZP_PREV="$T/zapret/previous.opts" ZP_AUTOSEL="$T/zapret/autoselect" \
        ZP_DIR="$T/zapret" ZP_CATALOG="$T/zapret/strategies.txt" \
        ZP_RESULTS="$T/zapret/results.json" ZP_RESULTS_DIR="$T/zapret/results.d" ZP_STAMP="$T/zapret/updated" \
        ZP_PROGRESS="$T/zapret/progress" ZP_PIDFILE="$T/zapret/pid" \
        ZP_OPTS_DIR="$T/etc/steer-zapret" ZP_CONF="$T/etc/config-zapret" \
        ZP_NFQWS="${ZP_NFQWS_FIXTURE:-$T/bin/nfqws-missing}" ZP_INIT="$T/bin/initd-zapret" ZP_RCD="$T/rcd-zapret" \
        DOH_CONF="$T/etc/config-doh" DOH_INIT="$T/bin/initd-doh" \
        DOH_LIST="$ROOT/files/usr/share/splify2/doh-providers.conf" \
        DOH_STEER="$T/bin/steer" DOH_SPEC="$T/etc/spec.json" \
        SYSNET_STATS="${SYSNET_STATS_FIXTURE:-$T/statnet}" \
        CONNTRACK="${CONNTRACK_FIXTURE:-$T/nf_conntrack}" \
        STEER="$T/bin/steer" \
        SPEC="$T/etc/spec.json" \
        LISTS="$T/lists" \
        SUB="$T/etc/sub.txt" \
        SUBS_DIR="$T/etc/subs" \
        MANIFEST="$T/etc/manifest.json" \
        INITD="$T/bin/initd-steer" \
        RPCD_INITD="$T/bin/initd-rpcd" \
        OPENWRT_RELEASE="${OPENWRT_RELEASE_FIXTURE:-$T/etc/openwrt_release}" \
        VLESS_DIRTY="$T/var/vless-dirty" \
        OBFS_DIRTY="$T/var/obfs-dirty" \
        HWID_SYSNET="${HWID_SYSNET_FIXTURE:-$T/sys/class/net}" \
        SYSNET="${SYSNET_FIXTURE:-$T/sysnet}" \
        OUT_SYSNET="${OUT_SYSNET_FIXTURE:-$T/outnet}" \
        UCI_SPLIFY2="${UCI_SPLIFY2_FIXTURE:-$T/etc/config/splify2}" \
        XS_STATE_DIR="$T/var/lib/steer" \
        XS_RUN="$T/var/run/xsteer" \
        SYSINFO_MODEL="$T/etc/sysinfo-model" \
        STEER_HWID="${STEER_HWID-splify2-9c53221f0abc9c53}" \
        STEER_SUB_JSON="${STEER_SUB_JSON-}" \
        STEER_SUB_INFO="${STEER_SUB_INFO-}" \
        STEER_SUB_BODY="${STEER_SUB_BODY-vless://k@h:443#n}" \
        STEER_SUB_RC="${STEER_SUB_RC:-0}" \
        STEER_QUOTA_RC="${STEER_QUOTA_RC:-0}" \
        CURL_RESP_HDRS="${CURL_RESP_HDRS:-}" \
        CURL_HEAD_HDRS="${CURL_HEAD_HDRS-}" \
        CURL_HEAD_RC="${CURL_HEAD_RC:-0}" \
        CURL_BODY="${CURL_BODY:-}" \
        CURL_RC="${CURL_RC:-0}" \
        APPLIED="$T/etc/spec.applied.json" \
        BACKUP_OUT="$T/var/backup.out" \
        BACKUP_IN="$T/var/backup.in" \
        BACKUP_MAX_BYTES="${BACKUP_MAX_BYTES:-262144}" \
        STEER_RC="${STEER_RC:-0}" \
        GH_BODY="${GH_BODY-}" \
        GH_FAIL="${GH_FAIL-}" \
        GH_CACHE="$T/var/releases.json" \
        GH_CACHE_TTL_MIN="${GH_CACHE_TTL_MIN:-0}" \
        STEER_ERR="${STEER_ERR:-}" \
        APK_ADD_RC="${APK_ADD_RC:-0}" \
        APK_ADD_OUT="${APK_ADD_OUT:-}" \
        PM_FIXTURE="${PM_FIXTURE:-}" \
        UPDATE_LISTS="${UPDATE_LISTS:-$T/bin/update-lists}" \
        ENGINE_ENABLED="${ENGINE_ENABLED:-0}" \
        sh "$SCRIPT" call "$1" 2>"$T/stderr"
}

rpcd_list() {
    env SANDBOX="$T" PATH="$T/bin:$PATH" JSHN_SH="$ROOT/tests/stub/jshn.sh" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
        DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
        sh "$SCRIPT" list 2>"$T/stderr"
}

# Булево печатается как в JSON (true/false), а не как в python (True/False): иначе
# проверка сравнивала бы ожидание с языком, на котором написана сама проверка.
# Значение uci из хранилища заглушки. Прямо файлом, а не через `$T/bin/uci`: тот работает
# только с SANDBOX в окружении, а проверкам удобнее спрашивать снаружи вызова.
uci_get() {  # КЛЮЧ
    # `case`, а не grep: в имени безымянной секции есть квадратные скобки — см. шапку заглушки uci.
    _v=""
    while IFS= read -r _l; do
        case "$_l" in "$1="*) _v="${_l#*=}" ;; esac
    done < "$T/uci.store"
    printf '%s' "$_v"
}
uci_set() {  # КЛЮЧ ЗНАЧЕНИЕ
    : > "$T/uci.store.t"
    while IFS= read -r _l; do
        case "$_l" in "$1="*) continue ;; esac
        printf '%s\n' "$_l" >> "$T/uci.store.t"
    done < "$T/uci.store" 2>/dev/null
    printf '%s=%s\n' "$1" "$2" >> "$T/uci.store.t"
    mv "$T/uci.store.t" "$T/uci.store"
}

jget() {  # ПОЛЕ < JSON
    python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: print("НЕ JSON"); raise SystemExit
v = d
for k in sys.argv[1].split("."):   # вложенное поле — через точку: game.gv
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else json.dumps(v, ensure_ascii=False) if isinstance(v,(list,dict,bool)) else v)' "$1"
}

# Вложенное поле ответа: объектами приезжают и остаток трафика подписки, и названия релизов
# («версия → название»). Сравнивать такой ответ целиком строкой значило бы привязать проверку к
# порядку ключей.
jqget() {  # ОБЪЕКТ ПОЛЕ < JSON
    python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: print("НЕ JSON"); raise SystemExit
o = d.get(sys.argv[1]) or {}
v = o.get(sys.argv[2])
print("" if v is None else json.dumps(v, ensure_ascii=False) if isinstance(v,(list,dict,bool)) else v)' "$1" "$2"
}

reset_logs() { rm -f "$T/apk.log" "$T/initd.log" "$T/wget.log" "$T/curl.log" "$T/rpcd-initd.log" "$T/disabled"; : > "$T/apk.log"; : > "$T/initd.log"; }

# Только то, что init.d МЕНЯЕТ. Запросы состояния (enabled) в протоколе тоже есть — их
# делает сам скрипт, чтобы отчитаться, — но к порядку действий они не относятся.
custom_domains_path()  { printf '%s/lists/custom/domains/%s.lst' "$T" "$1"; }
custom_prefixes_path() { printf '%s/lists/custom/%s.lst' "$T" "$1"; }

initd_actions() { grep -v '^enabled$' "$T/initd.log" | awk '{printf "%s ", $1}' | sed 's/ $//'; }

# ---- сам скрипт вообще запускается --------------------------------------------
# Первая проверка стенда — про стенд: пока она красная, все остальные бессмысленны.
out="$(rpcd_list)"
check "объект отвечает списком методов (стенд поднялся)" \
      "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys
try: print("yes" if "steer_install" in json.load(sys.stdin) else "no")
except Exception: print("не JSON")')"

# ---- I-049: установка не должна снимать работающий пакет ----------------------
# Сценарий: стоит рабочий 0.9.5-extended, ставим 0.9.6-extended, apk отказывает.
# На роутере `apk del` уже запустил pre-deinstall, а тот остановил и ОТКЛЮЧИЛ сервис
# и снёс таблицу nft. Значит роутер остаётся без маршрутизации, и перезагрузка не спасёт.
cat > "$T/etc/openwrt_release" <<'EOF'
DISTRIB_ARCH='aarch64_cortex-a53'
EOF

# Отказ НЕ по конфликту: нет зависимости. apk печатает про это тем же «unable to select
# packages», что и про конфликт, — поэтому по одному этому тексту снимать работающий
# движок нельзя, и проверка сторожит именно это различие.
reset_logs
out="$(APK_ADD_RC=1 APK_ADD_OUT='ERROR: unable to select packages: steer-extended-0.9.6-r1: required package nftables missing' \
       rpcd steer_install '{"version":"0.9.6","extended":true}')"

check "при отказе установки первым вызовом apk идёт add, а не del (I-049)" \
      "add" "$(awk 'NR==1{print $1}' "$T/apk.log")"

check "при отказе установки рабочий пакет не снят (I-049)" \
      "" "$(grep -c '^del' "$T/apk.log" | sed 's/^0$//')"

check "при отказе установки ответ отрицательный" \
      "false" "$(printf '%s' "$out" | jget ok)"

# Успешное обновление в пределах одного варианта — самый частый путь. Через удаление
# он проходить не должен вовсе: окна без маршрутизации не возникает.
reset_logs
out="$(rpcd steer_install '{"version":"0.9.6","extended":true}')"
check "обновление того же варианта не проходит через apk del (I-049)" \
      "" "$(grep -c '^del' "$T/apk.log" | sed 's/^0$//')"
check "успешная установка отчитывается положительно" \
      "true" "$(printf '%s' "$out" | jget ok)"

# Смена варианта: базовый и расширенный владеют одним /usr/sbin/steer, apk отвергает
# такое по конфликту. Вот здесь удаление законно — но только после того, как apk отказал,
# и с обязательной повторной попыткой.
reset_logs
out="$(APK_ADD_RC=1 APK_ADD_OUT='ERROR: package steer conflicts with steer-extended' \
       rpcd steer_install '{"version":"0.9.6","extended":false}')"
check "на конфликте вариантов: add, потом del, потом add ещё раз (I-049)" \
      "add del del add" "$(awk '{printf "%s ", $1}' "$T/apk.log" | sed 's/ $//')"
check "если и повторная установка не удалась, ответ говорит про снятый пакет (I-049)" \
      "yes" "$(printf '%s' "$out" | jget error | grep -qi 'снят\|удал' && echo yes || echo no)"

# ---- I-050: архитектура пакетов, а не архитектура apk -------------------------
# На роутере верный источник — DISTRIB_ARCH. Фолбэк на `apk --print-arch` отдаёт
# `aarch64`, которого нет ни в одном из двенадцати имён релиза: имя файла собирается
# неверно и скачивание молча не находит пакет.
out="$(OPENWRT_RELEASE_FIXTURE="$T/etc/nonexistent" rpcd steer_versions)"
check "без openwrt_release архитектура не выдумывается из apk (I-050)" \
      "" "$(printf '%s' "$out" | jget arch)"

out="$(rpcd steer_versions)"
check "с openwrt_release архитектура берётся из DISTRIB_ARCH" \
      "aarch64_cortex-a53" "$(printf '%s' "$out" | jget arch)"

# ---- I-052: список версий не шире, чем принимает установка --------------------
# steer_install отвергает всё, что не вида X.Y.Z. Значит тег с суффиксом, дойдя до
# выпадающего списка, будет выбран как «свежая» — и отвергнут собственным бэкендом.
out="$(rpcd steer_versions)"
check "тег с суффиксом до выпадающего списка не доходит (I-052)" \
      '["26.9", "0.9.6", "0.9.4"]' "$(printf '%s' "$out" | jget versions)"

# ---- I-042 (половина в rpcd): отказ удаления виден в ответе -------------------
# Здесь скрипт уже прав, и проверка сторожевая: интерфейс отчитывается об успехе
# независимо от ответа, и чинить надо его — но только пока ответ остаётся честным.
out="$(rpcd list_remove '{"id":"news","kind":"prefixes"}')"
check "занятый каналом список не удаляется" \
      "false" "$(printf '%s' "$out" | jget ok)"
check "причина отказа названа словами (I-042)" \
      "yes" "$(printf '%s' "$out" | jget error | grep -qi 'использ' && echo yes || echo no)"
check "файл списка на месте" "10.0.0.0/8" "$(cat "$T/lists/news.lst")"

# ---- R-017: «остановить всё» одним действием ----------------------------------
# Просьба из публичного теста дословно: «жизненно необходима кнопка Остановить, причём
# всё — и сервис, и движок». Решение владельца: stop + disable, то есть перезагрузка
# состояние не возвращает, и обратное действие тоже должно быть.
reset_logs
out="$(rpcd engine_stop)"
check "остановка действительно останавливает и отключает (R-017)" \
      "stop disable" "$(initd_actions)"
check "остановка отчитывается положительно (R-017)" \
      "true" "$(printf '%s' "$out" | jget ok)"
check "после остановки автозапуск снят (R-017)" \
      "false" "$(printf '%s' "$out" | jget enabled)"

reset_logs
out="$(rpcd engine_start)"
check "запуск включает автозапуск и поднимает сервис (R-017)" \
      "enable start" "$(initd_actions)"
check "после запуска автозапуск на месте (R-017)" \
      "true" "$(printf '%s' "$out" | jget enabled)"

# Подпись тумблера обязана читать состояние, а не помнить своё: между двумя открытиями
# страницы движок могли остановить из консоли.
out="$(ENGINE_ENABLED=0 rpcd engine)"
check "engine сообщает, включён ли автозапуск (R-017)" \
      "true" "$(printf '%s' "$out" | jget enabled)"
out="$(ENGINE_ENABLED=1 rpcd engine)"
check "engine видит снятый автозапуск (R-017)" \
      "false" "$(printf '%s' "$out" | jget enabled)"

# ---- R-042: интерфейс должен уметь обновлять сам себя --------------------------
# Движок из интерфейса ставится с первого дня, а сам интерфейс — нет: его обновляли
# только руками через ssh. Пакетов нет в feeds, поэтому «apk upgrade» их не видит, и
# другого пути, кроме как сходить в релизы самому, не существует.
reset_logs
out="$(rpcd splify2_versions)"
check "версии интерфейса берутся из релизов splify2 (R-042)" \
      "yes" "$(grep -c 'api.github.com/repos/xyzmean/splify2' "$T/wget.log" >/dev/null 2>&1 && grep -q 'xyzmean/splify2' "$T/wget.log" && echo yes || echo no)"
check "тег с суффиксом отсеивается и здесь (R-042)" \
      '["26.9", "0.9.6", "0.9.4"]' "$(printf '%s' "$out" | jget versions)"
# ---- версии формата «26.9 Andromeda» ------------------------------------------------
# Выпуск называется кодовым именем, а ставится числом, и это две разные строки: в имени файла
# пакета и в теге пробелу места нет ни у apk, ни у opkg, ни в URL. Пока бэкенд отдавал одни
# числа, список версий не сходился ни со страницей релизов, ни с тем, как о выпуске говорят.
out="$(rpcd steer_versions)"
check "версия из двух частей не отсеивается: «26.9» — не хуже «1.2.0»" "yes" \
      "$(printf '%s' "$out" | jget versions | grep -q '"26.9"' && echo yes || echo no)"
check "первой идёт самая свежая — по порядку релизов, а не по строке" "26.9" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["versions"][0])')"
check "название выпуска приезжает рядом с версией" "26.9 Andromeda" \
      "$(printf '%s' "$out" | jqget names 26.9)"
# Заголовка у релиза нет вовсе (в ответе null) — показываем число. Пустая строка на экране
# была бы версией без имени, то есть строкой, по которой нечего выбрать.
check "релиз без заголовка называется своим числом" "0.9.6" \
      "$(printf '%s' "$out" | jqget names 0.9.6)"
# Вертикальная черта — разделитель во внутренней разметке названий; заголовок с ней ломал бы
# поиск по версии. Отказываться из-за заголовка от самого релиза нельзя: ставится он по версии.
check "заголовок с вертикальной чертой откатывается на число" "0.9.4" \
      "$(printf '%s' "$out" | jqget names 0.9.4)"
check "у отсеянного тега названия нет: его нет и в версиях" "" \
      "$(printf '%s' "$out" | jqget names nightly)"

out="$(rpcd splify2_versions)"
check "интерфейс отдаёт названия тем же полем" "26.9 Andromeda" \
      "$(printf '%s' "$out" | jqget names 26.9)"

# GitHub не ответил — ни версий, ни названий, и метод обязан ОТВЕТИТЬ, а не умереть: без
# списка карточка движка показывает «Переустановить», и это верно, а не поломка.
out="$(GH_BODY='не json' rpcd steer_versions)"
check "нечитаемый ответ GitHub не роняет метод" "true;[];{}" \
      "$([ -n "$out" ] && echo true || echo false);$(printf '%s' "$out" | jget versions);$(printf '%s' "$out" | jget names)"

# Память перечня выпусков. Поход на GitHub стоит полторы секунды там, где он закрыт, и шёл при
# каждом открытии страницы; теперь ответ живёт шесть часов. Стенд в остальных проверках
# память выключает (GH_CACHE_TTL_MIN=0), потому что подменяет ответы GitHub от проверки к
# проверке; здесь включает и смотрит, что второй вызов на GitHub не ходит.
reset_logs
rm -f "$T"/var/releases.json.*.cache
GH_CACHE_TTL_MIN=360 rpcd steer_versions >/dev/null
out="$(GH_CACHE_TTL_MIN=360 rpcd steer_versions)"
check "второй вызов версий движка берёт память, а не GitHub" "1" \
      "$(grep -c 'api.github.com/repos/xyzmean/steer' "$T/wget.log")"
check "и отдаёт то же самое" "26.9 Andromeda" "$(printf '%s' "$out" | jqget names 26.9)"
rm -f "$T"/var/releases.json.*.cache

# ---- splify2#15: перечень версий переживает закрытый api.github.com ------------------
# Пакеты и списки обход получили ещё в запуске 59 (общая download() с лестницей «зеркало →
# contents API → архив → туннель»), а ПЕРЕЧЕНЬ версий остался спрошенным у одного хоста.
# Там, где api.github.com закрыт или где за CGNAT выбран его неавторизованный лимит (60
# запросов в час на адрес — так и пришла splify2#5), обе карточки показывали пустой список:
# обновиться из интерфейса нельзя, хотя сам пакет с зеркала скачался бы. Установщик этот
# путь имеет с запуска 48 (R-048, VERSION в main вторым источником) — бэкенд не имел.
reset_logs
out="$(GH_FAIL=1 CURL_BODY='1.2.9' rpcd steer_versions)"
check "api.github.com молчит — версия берётся из VERSION (splify2#15)" '["1.2.9"]' \
      "$(printf '%s' "$out" | jget versions)"
check "запасной путь идёт общей download(), а не своим wget" \
      "https://raw.githubusercontent.com/xyzmean/steer/main/VERSION" \
      "$(grep 'VERSION' "$T/curl.log" | head -1)"
check "почему список короткий — сказано словами, а не пустотой" "yes" \
      "$(printf '%s' "$out" | jget note | grep -q 'VERSION' && echo yes || echo no)"
check "единственная версия называет себя сама" "1.2.9" \
      "$(printf '%s' "$out" | jqget names 1.2.9)"

out="$(GH_FAIL=1 CURL_BODY='1.2.9' rpcd splify2_versions)"
check "интерфейс берёт свою версию тем же путём (splify2#15)" '["1.2.9"]' \
      "$(printf '%s' "$out" | jget versions)"

# VERSION содержит ТОЛЬКО цифры и точки — на это стоит барьер в build.sh. Всё остальное
# отвергается целиком: подставить мусор в имя файла пакета хуже, чем остаться без версии.
out="$(GH_FAIL=1 CURL_BODY='v1.2.9-rc1' rpcd steer_versions)"
check "VERSION не вида «цифры и точки» не берётся" "[]" \
      "$(printf '%s' "$out" | jget versions)"

# Не ответил никто. Метод обязан ОТВЕТИТЬ пустым списком: карточка на нём говорит «список
# версий не пришёл», и это правда, а падение метода выглядело бы как поломка интерфейса.
out="$(GH_FAIL=1 CURL_RC=1 rpcd steer_versions)"
check "не ответил никто — метод всё равно отвечает" "true;[]" \
      "$([ -n "$out" ] && echo true || echo false);$(printf '%s' "$out" | jget versions)"

# Обычный путь запасным не подменяется: пока API отвечает, VERSION не спрашивается вовсе.
reset_logs
out="$(rpcd steer_versions)"
check "API ответил — за VERSION никто не ходит" "" \
      "$(grep 'VERSION' "$T/curl.log" 2>/dev/null | head -1)"
check "API ответил — примечания нет" "" "$(printf '%s' "$out" | jget note)"

out="$(rpcd splify2_versions)"
check "установленная версия названа, чтобы было с чем сравнить (R-042)" \
      "0.7.6" "$(printf '%s' "$out" | jget current)"

reset_logs
out="$(rpcd splify2_install '{"version":"0.7.7"}')"
# Журнал теперь curl.log, а не wget.log: пакеты качаются общей download() (splify2#15),
# у которой есть обход закрытого githubusercontent — своим wget этот метод больше не ходит.
check "качается noarch-пакет интерфейса (R-042)" \
      "https://github.com/xyzmean/splify2/releases/download/v0.7.7/luci-app-splify2-0.7.7-1_noarch.apk" \
      "$(grep 'luci-app-splify2' "$T/curl.log" | head -1)"
check "установка интерфейса идёт тем же порядком: add первым (R-042)" \
      "add" "$(awk 'NR==1{print $1}' "$T/apk.log")"
check "после установки rpcd перезапускается, иначе новый ACL не подхватится (R-042)" \
      "yes" "$(grep -q restart "$T/rpcd-initd.log" 2>/dev/null && echo yes || echo no)"
check "установка интерфейса отчитывается положительно (R-042)" \
      "true" "$(printf '%s' "$out" | jget ok)"

reset_logs
out="$(rpcd splify2_install '{"version":"нет-такой"}')"
check "версия не вида X.Y.Z отвергается до скачивания (R-042)" \
      "false" "$(printf '%s' "$out" | jget ok)"
check "при отказе по версии ничего не качалось (R-042)" \
      "" "$(cat "$T/wget.log" "$T/curl.log" 2>/dev/null | grep -c . | sed 's/^0$//')"

# ---- R-037: свои списки доменов и адресов -------------------------------------
# Вопрос задан снаружи (splicicd#8): маршрутизировать можно только то, что опубликовал
# издатель. Движок сопоставляет исключительно по файлам, а каталог рисуется из манифеста,
# поэтому свой .lst в /etc/steer/lists был виден local_lists — и не предлагался ни одному
# правилу.
#
# Три способа ввода по решению владельца: текстом, файлом (тем же методом по частям) и
# по ссылке. Чужой текст на входе движка обязан быть проверен здесь: спека применится, а
# канал молча останется пустым, если формат не тот.
out="$(rpcd list_put '{"name":"мой","kind":"domains","text":"example.org"}')"
check "имя не из латиницы, цифр и дефиса отвергается (R-037)" \
      "false" "$(printf '%s' "$out" | jget ok)"

out="$(rpcd list_put '{"name":"../../etc/passwd","kind":"domains","text":"example.org"}')"
check "выйти из каталога списков именем нельзя (R-037)" \
      "false" "$(printf '%s' "$out" | jget ok)"

out="$(rpcd list_put '{"name":"mine","kind":"domains","text":"Example.ORG\nsub.example.net\n# коммент\n\nне домен!\n"}')"
check "доменный список принят (R-037)" "true" "$(printf '%s' "$out" | jget ok)"
check "домены приведены к нижнему регистру, мусор отброшен (R-037)" \
      "example.org sub.example.net" "$(tr '\n' ' ' < "$T/lists/custom/domains/mine.lst" | sed 's/ $//')"
check "сколько строк отброшено — сказано числом, а не молчанием (R-037)" \
      "1" "$(printf '%s' "$out" | jget dropped)"

out="$(rpcd list_put '{"name":"nets","kind":"prefixes","text":"10.0.0.0/8\n192.0.2.1\nexample.org\n"}')"
check "адресный список принят (R-037)" "true" "$(printf '%s' "$out" | jget ok)"
check "одиночный адрес дополняется до /32, домен отброшен (R-037)" \
      "10.0.0.0/8 192.0.2.1/32" "$(tr '\n' ' ' < "$T/lists/custom/nets.lst" | sed 's/ $//')"

# Дописывание по частям — то, чем загружается файл: ubus не резиновый, и большой список
# приезжает несколькими вызовами.
rpcd list_put '{"name":"mine","kind":"domains","text":"second.example\n","append":true}' >/dev/null
check "append дописывает, а не затирает (R-037)" \
      "example.org sub.example.net second.example" \
      "$(tr '\n' ' ' < "$T/lists/custom/domains/mine.lst" | sed 's/ $//')"

out="$(rpcd list_put '{"name":"mine","kind":"domains","text":"only.example\n"}')"
check "без append список заменяется целиком (R-037)" \
      "only.example" "$(tr '\n' ' ' < "$T/lists/custom/domains/mine.lst" | sed 's/ $//')"

reset_logs
out="$(rpcd list_put '{"name":"remote","kind":"domains","url":"https://example.invalid/my.lst"}')"
check "по ссылке качает роутер (R-037)" \
      "yes" "$(grep -q 'example.invalid/my.lst' "$T/curl.log" 2>/dev/null && echo yes || echo no)"
check "скачанное по ссылке проходит ту же проверку формата (R-037)" \
      "remote.example" "$(tr '\n' ' ' < "$T/lists/custom/domains/remote.lst" | sed 's/ $//')"

out="$(rpcd list_put '{"name":"empty","kind":"prefixes","text":"вообще не список\n"}')"
check "список, из которого не осталось ни строки, не создаётся (R-037)" \
      "false" "$(printf '%s' "$out" | jget ok)"
check "и файла после этого нет (R-037)" \
      "нет" "$([ -f "$T/lists/custom/empty.lst" ] && echo есть || echo нет)"

# Удалять свой список тоже надо уметь: list_remove искал файл только через манифест,
# поэтому своего в нём нет и удалить его было нечем.
out="$(rpcd list_remove '{"name":"nets"}')"
check "свой список удаляется по имени (R-037)" "true" "$(printf '%s' "$out" | jget ok)"
check "доменный и адресный с одним именем не схлопываются (R-037)" \
      "разные" "$([ "$(custom_domains_path mine)" != "$(custom_prefixes_path mine)" ] && echo разные || echo одно)"
check "файл действительно убран (R-037)" \
      "нет" "$([ -f "$T/lists/custom/nets.lst" ] && echo есть || echo нет)"

# Тот же запрет, что и для списков издателя: канал, указывающий на файл, после удаления
# не скомпилируется.
rpcd list_put '{"name":"used","kind":"prefixes","text":"10.0.0.0/8\n"}' >/dev/null
python3 - "$T/etc/spec.json" "$T/lists/custom/used.lst" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['channels'][0]['match']['prefixes_files'].append(sys.argv[2])
json.dump(d, open(sys.argv[1], 'w'))
PY
out="$(rpcd list_remove '{"name":"used"}')"
check "занятый каналом свой список не удаляется (R-037)" \
      "false" "$(printf '%s' "$out" | jget ok)"

# ---- ОТКУДА взялся свой список, и правка по этому же разделению ----------------
#
# Изменить свой список было нечем: рядом с ним стояла одна кнопка — удалить. А правят три
# способа ввода по-разному, и это не оформление: у файла меняют ФАЙЛ, у ссылки — ССЫЛКУ, у
# набранного руками — сами ЗАПИСИ. Не зная происхождения, интерфейс вынужден предлагать все
# три всем — то есть предлагать заменить файл на двадцать тысяч строк тем, что человек
# наберёт в текстовом поле.
reset_logs
rpcd list_put '{"name":"fromfile","kind":"prefixes","text":"10.9.0.0/16\n","source":"file","filename":"blocked.txt"}' >/dev/null
out="$(rpcd list_custom)"
check "происхождение «файл» запомнено вместе с именем файла" \
      "file blocked.txt" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
for l in json.load(sys.stdin)["lists"]:
    if l["name"] == "fromfile": print(l["source"], l["filename"])')"

rpcd list_put '{"name":"fromurl","kind":"domains","url":"https://example.invalid/my.lst","source":"url"}' >/dev/null
out="$(rpcd list_custom)"
check "происхождение «ссылка» запомнено вместе со ссылкой" \
      "url https://example.invalid/my.lst" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
for l in json.load(sys.stdin)["lists"]:
    if l["name"] == "fromurl": print(l["source"], l["url"])')"

# Поля `source` нет вовсе — так шлёт интерфейс постарше. Считаем по тому, что пришло: ссылка
# значит ссылку, текст значит «руками». Это ровно прежнее поведение, только теперь записанное.
rpcd list_put '{"name":"oldway","kind":"prefixes","text":"10.8.0.0/16\n"}' >/dev/null
out="$(rpcd list_custom)"
check "без поля source происхождение выводится из того, что пришло" \
      "text" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
for l in json.load(sys.stdin)["lists"]:
    if l["name"] == "oldway": print(l["source"])')"

# Запись о происхождении НЕ должна выглядеть ещё одним списком: и local_lists, и сборка архива
# обходят каталог по `*.lst`, а записи вида «source=file» санитайзер отбросил бы все до одной.
out="$(rpcd local_lists)"
check "запись о происхождении не видна как список" \
      "нет" \
      "$(printf '%s' "$out" | grep -q '\.src' && echo есть || echo нет)"

# Порции запомнились по ПЕРВОЙ, а не по последней: порции — это один и тот же файл, и запись
# при каждой означала бы, что имя файла берётся от куска, который его не несёт.
rpcd list_put '{"name":"chunked","kind":"prefixes","text":"10.1.0.0/16\n","source":"file","filename":"big.txt"}' >/dev/null
rpcd list_put '{"name":"chunked","kind":"prefixes","text":"10.2.0.0/16\n","append":true,"source":"file"}' >/dev/null
out="$(rpcd list_custom)"
check "имя файла не теряется на следующих порциях" \
      "file big.txt" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
for l in json.load(sys.stdin)["lists"]:
    if l["name"] == "chunked": print(l["source"], l["filename"])')"

# Записи обратно: редактор набранного руками обязан показать то, что лежит на роутере.
# Пустое поле вместо записей — это не «начни заново», а предложение молча потерять набранное.
out="$(rpcd list_get '{"name":"oldway","kind":"prefixes"}')"
check "записи своего списка читаются обратно" "10.8.0.0/16" \
      "$(printf '%s' "$out" | jget text | tr -d '\n')"
check "и признак конца выставлен" "true" "$(printf '%s' "$out" | jget eof)"

# Порции нарезаются по БАЙТАМ и приезжают байт в байт. Потерянный на границе перевод строки
# склеивает две записи в одну («10.0.0.0/810.1.0.0/8»), и обе исчезают из канала молча.
printf '10.0.0.0/8\n10.1.0.0/8\n10.2.0.0/8\n' > "$T/lists/custom/bytes.lst"
first="$(rpcd list_get '{"name":"bytes","kind":"prefixes","offset":0}')"
out="$( { printf '%s\n' '{"name":"bytes","kind":"prefixes","offset":0}'; } | env \
    SANDBOX="$T" PATH="$T/bin:$PATH" \
    JSHN_SH="$ROOT/tests/stub/jshn.sh" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
    FAST_SH="$ROOT/files/usr/lib/splify2/fast.sh" \
        ZAPRET_SH="$ROOT/files/usr/lib/splify2/zapret.sh" \
        DOH_SH="$ROOT/files/usr/lib/splify2/doh.sh" \
    STEER="$T/bin/steer" SPEC="$T/etc/spec.json" LISTS="$T/lists" \
    SUB="$T/etc/sub.txt" MANIFEST="$T/etc/manifest.json" RPCD_LIB="$RPCD_DIR" \
    LIST_CHUNK=11 sh "$SCRIPT" call list_get 2>/dev/null)"
check "первый кусок ровно в предел и с переводом строки на конце" "10.0.0.0/8" \
      "$(printf '%s' "$out" | jget text | tr -d '\n')"
check "и конец файла на первом куске не объявлен" "false" "$(printf '%s' "$out" | jget eof)"
check "следующее смещение — по СЧИТАННЫМ байтам" "11" "$(printf '%s' "$out" | jget next)"
check "весь файл одним куском отдаётся целиком" "3" \
      "$(printf '%s' "$first" | jget text | grep -c .)"

# Правке подлежит только СВОЙ список: список издателя приезжает по расписанию, и всякая
# правка была бы стёрта следующим обновлением молча. Читать его этим методом нельзя вовсе —
# он смотрит только в custom/.
printf '1.2.3.0/24\n' > "$T/lists/news.lst"
out="$(rpcd list_get '{"name":"news","kind":"prefixes"}')"
check "список издателя этим методом не читается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(rpcd list_get '{"name":"../../etc/passwd","kind":"prefixes"}')"
check "выйти из каталога списков именем нельзя и здесь" "false" "$(printf '%s' "$out" | jget ok)"

# Удаление списка снимает и запись о происхождении: оставленная, она переехала бы на
# СЛЕДУЮЩИЙ список того же имени и рассказала бы про него чужую правду.
rpcd list_remove '{"name":"fromfile","kind":"prefixes"}' >/dev/null
check "запись о происхождении удалена вместе со списком" "нет" \
      "$([ -f "$T/lists/custom/fromfile.lst.src" ] && echo есть || echo нет)"

# Метод, которого нет в ACL, вызвать из LuCI нельзя — метод есть, а кнопка не работает.
acl="$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json"
check "правка списков разрешена в ACL на чтение" "yes" \
      "$(python3 -c 'import json,sys
r = json.load(open(sys.argv[1]))["luci-app-splify2"]["read"]["ubus"]["splify2"]
print("yes" if "list_custom" in r and "list_get" in r else "no")' "$acl")"

# Метод, которого нет в списке методов, ubus не покажет вовсе.
out="$(rpcd_list)"
check "методы правки списков объявлены в списке" "yes" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print("yes" if "list_custom" in d and "list_get" in d else "no")')"
check "оба метода объявлены в списке (R-017)" \
      "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print("yes" if "engine_stop" in d and "engine_start" in d else "no")')"

# Метод, которого нет в ACL, вызвать из LuCI нельзя — метод есть, а кнопка не работает.
acl="$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json"
check "оба метода разрешены в ACL на запись (R-017)" \
      "yes" "$(python3 -c 'import json,sys
w = json.load(open(sys.argv[1]))["luci-app-splify2"]["write"]["ubus"]["splify2"]
print("yes" if "engine_stop" in w and "engine_start" in w else "no")' "$acl")"

# ---- путь из манифеста издателя не выходит за каталог списков -----------------
#
# Поле `file` приходит из интернета (манифест издателя, адрес которого вдобавок
# переопределяется через uci), а local_path снимала только ведущие слэши. `..` проходил
# насквозь: `file` вида `../../../etc/crontabs/root` давал запись файла ОТ ROOT куда
# угодно — крон, rc.local, сам этот скрипт, — содержимым с того же издателя. Тем же путём
# list_remove удалял любой файл.
#
# Для СВОИХ списков эта мысль додумана давно (list_put проверяет имя), для чужих не была.
cat > "$T/etc/manifest.json" <<'EOF'
{
  "base_url": "https://example.invalid/lists",
  "categories":   [ { "id": "evil", "file": "../../../trav-probe/cron.txt" },
                    { "id": "hack", "file": "a/../../b.lst" },
                    { "id": "shell", "file": "x;id>/tmp/p.lst" },
                    { "id": "news", "file": "news.lst" } ],
  "domain_lists": [ { "id": "news", "file": "domains/news.lst" } ]
}
EOF
rm -rf /tmp/trav-probe
for id in evil hack shell; do
    out="$(rpcd list_fetch "{\"id\":\"$id\",\"kind\":\"prefixes\"}")"
    check "list_fetch отвергает путь «$id» из манифеста" \
          "no" "$(printf '%s' "$out" | grep -q '"ok":true' && echo yes || echo no)"
done
check "ни один файл вне каталога списков не создан" "no" \
      "$([ -e /tmp/trav-probe ] && echo yes || echo no)"

# То же для удаления: раньше проверка «занят каналом» сравнивала уже подменённый путь.
out="$(rpcd list_remove '{"id":"evil","kind":"prefixes"}')"
check "list_remove отвергает путь с .. из манифеста" \
      "no" "$(printf '%s' "$out" | grep -q '"ok":true' && echo yes || echo no)"

# Законные пути обязаны продолжать работать — иначе заслон стоил бы больше, чем спас.
check "обычный путь манифеста по-прежнему принимается" "yes" \
      "$(rpcd list_fetch '{"id":"news","kind":"domains"}' | grep -q '"path"' && echo yes || echo no)"

# ---- предел размера не обходится дописыванием по частям ------------------------
#
# LIST_MAX_BYTES проверялся для каждого вызова отдельно, а интерфейс грузит файл кусками
# по тысяче строк с append. Число кусков не ограничено ничем, то есть предел, заведённый
# ради overlay в 6,9 МБ, обходился самым обычным способом им пользоваться.
big="$(awk 'BEGIN { while (i++ < 30000) print "10.0." int(i/256) "." (i%256) "/32" }')"
rpcd list_put "$(printf '{"name":"grow","kind":"prefixes","text":"%s"}' "$(printf '%s' "$big" | tr '\n' '@' | sed 's/@/\\n/g')")" >/dev/null
first="$(wc -c < "$T/lists/custom/grow.lst" 2>/dev/null || echo 0)"
i=0
while [ "$i" -lt 8 ]; do
    rpcd list_put "$(printf '{"name":"grow","kind":"prefixes","append":true,"text":"%s"}' "$(printf '%s' "$big" | tr '\n' '@' | sed 's/@/\\n/g')")" >/dev/null
    i=$((i + 1))
done
grown="$(wc -c < "$T/lists/custom/grow.lst" 2>/dev/null || echo 0)"
check "дописывание не переваливает за предел размера" "yes" \
      "$([ "$grown" -le 1048576 ] && echo yes || echo no)"
check "и первая порция при этом легла" "yes" \
      "$([ "$first" -gt 0 ] && echo yes || echo no)"

# ---- свой список: диапазоны октетов и длина префикса ---------------------------
# Форма проверялась, значения — нет: 10.0.0.256 и 192.168.0.0/40 проходили как верные.
# Движок их тоже пропускает, а отвергал уже nft — целиком весь ruleset одной транзакцией,
# сообщением про синтаксис nft, по которому не понять, какая строка виновата.
rpcd list_put '{"name":"ranges","kind":"prefixes","text":"10.0.0.1\n10.0.0.256\n300.1.1.1\n192.168.0.0/24\n192.168.0.0/40"}' >/dev/null
check "негодные октеты и длина префикса отброшены" "10.0.0.1/32
192.168.0.0/24" "$(cat "$T/lists/custom/ranges.lst" 2>/dev/null)"

# ---- kind объявлен в сигнатуре list_fetch --------------------------------------
# rpcd отсекает поля, которых нет в сигнатуре. Реализация kind читает, а объявлен он не
# был: доменный запрос уходил бы в фолбэк, где адресные категории проверяются первыми, и
# для id, живущего в обоих пространствах (news, hodca), скачивался бы адресный файл под
# именем доменного. Это I-011, вернувшийся с другой стороны.
check "list_fetch объявляет kind" "yes" \
      "$(rpcd_list | grep -A4 '"list_fetch"' | grep -q '"kind"' && echo yes || echo no)"

# ---- набор выходов vless изменился — экземпляры пересобираются -------------------
# Сигнал уходит экземпляру `vless_<выход>`, а у только что созданного или
# переименованного выхода экземпляра ещё нет, и сигналить некому. Для обфускации это
# давно различается (params против instances), для vless — не различалось, и новый
# туннель не поднимался до перезагрузки на конфигурации с доменными каналами.
#
# Признак читает apply, а пишет spec_set — и это ДВА РАЗНЫХ вызова, между которыми
# сохранений бывает много: автосохранение зовёт spec_set после каждой правки, а применение
# нажимают один раз. Пока признак перезаписывался, «instances» терялось первой же
# следующей правкой того же выхода (выбор узла даёт params), и apply сигналил экземпляру,
# которого нет: туннель не поднимался до перезапуска движка. Поэтому проверки ниже — про
# поведение стенда, а не про текст скрипта: два сохранения подряд, потом apply.
spec_req() {  # СПЕКА_JSON → запрос spec_set
    python3 -c 'import json,sys; print(json.dumps({"spec": sys.argv[1]}))' "$1"
}
vless_spec() {  # [НОМЕР_УЗЛА] → спека с одним выходом kind=vless
    python3 -c 'import json,sys
o = {"kind": "vless", "sub_file": sys.argv[1]}
if len(sys.argv) > 2 and sys.argv[2]:
    o["node"] = int(sys.argv[2])
print(json.dumps({"schema": 1, "outputs": {"vpn": o}, "channels": []}))' "$T/etc/sub.txt" "${1:-}"
}

rm -f "$T/var/vless-dirty" "$T/var/obfs-dirty"
printf 'vless://key@host:443#node\n' > "$T/etc/sub.txt"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
out="$(rpcd spec_set "$(spec_req "$(vless_spec)")")"
check "выход vless завёлся — признак instances" "true;instances" \
      "$(printf '%s' "$out" | jget ok);$(cat "$T/var/vless-dirty" 2>/dev/null)"
# Вторая правка ТОГО ЖЕ выхода: имя выхода не изменилось, изменился узел — сам по себе это
# случай params. Но применения между двумя сохранениями не было, значит экземпляра всё ещё
# нет, и повод пересобрать набор никуда не делся.
out="$(rpcd spec_set "$(spec_req "$(vless_spec 1)")")"
check "выбор узла у нового выхода не затирает instances" "yes" \
      "$(grep -qx instances "$T/var/vless-dirty" 2>/dev/null && echo yes || echo no)"
: > "$T/initd.log"; : > "$T/ubus.log"
out="$(rpcd apply)"
check "apply пересобирает набор экземпляров" "yes" \
      "$(grep -qx start "$T/initd.log" && echo yes || echo no)"
check "признак снят после применения" "no" \
      "$([ -f "$T/var/vless-dirty" ] && echo yes || echo no)"
# Смена узла у выхода, экземпляр которого уже есть, лечится сигналом — и `start` его не
# заменяет: командная строка экземпляра от номера узла не зависит, procd видит описание
# неизменившимся и процесс не трогает, то есть подписку заново никто не читает.
out="$(rpcd spec_set "$(spec_req "$(vless_spec 2)")")"
check "смена узла у существующего выхода — params" "params" \
      "$(cat "$T/var/vless-dirty" 2>/dev/null)"
: > "$T/initd.log"; : > "$T/ubus.log"
out="$(rpcd apply)"
check "apply сигналит экземпляру, а набор не пересобирает" "yes;no" \
      "$(grep -q 'vless_vpn' "$T/ubus.log" && echo yes || echo no);$(grep -qx start "$T/initd.log" && echo yes || echo no)"

# Новая подписка тоже перечитывается клиентом только при перезапуске, и sub_set помечал это
# ПУСТЫМ файлом. Пустой признак — не «параметры», а отсутствие слова: он затирал instances
# ровно так же, как params, а прочитать его как instances нельзя (тогда любая смена
# подписки пересобирала бы набор вместо сигнала).
rm -f "$T/var/vless-dirty"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
out="$(rpcd spec_set "$(spec_req "$(vless_spec)")")"
out="$(rpcd sub_set '{"url":"vless://key@host:443#node"}')"
check "смена подписки не затирает instances" "yes" \
      "$(grep -qx instances "$T/var/vless-dirty" 2>/dev/null && echo yes || echo no)"
check "смена подписки помечена и как params" "yes" \
      "$(grep -qx params "$T/var/vless-dirty" 2>/dev/null && echo yes || echo no)"
: > "$T/initd.log"; : > "$T/ubus.log"
out="$(rpcd apply)"
check "apply делает и то и другое: сигнал существующим, сборка набора" "yes;yes" \
      "$(grep -q 'vless_vpn' "$T/ubus.log" && echo yes || echo no);$(grep -qx start "$T/initd.log" && echo yes || echo no)"

# Обфускация: тот же признак и та же ошибка. Проверяется на той же паре сохранений —
# выход с obfs появился, затем у него сменился порт.
obfs_spec() {  # ПОРТ_LISTEN
    python3 -c 'import json,sys
print(json.dumps({"schema": 1, "outputs": {"wg": {"kind": "interface", "device": "wg0",
      "obfs": {"mode": "wg-over-tcp", "server": "203.0.113.10:4567",
               "listen": "127.0.0.1:" + sys.argv[1]}}}, "channels": []}))' "$1"
}
rm -f "$T/var/obfs-dirty" "$T/var/vless-dirty"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
out="$(rpcd spec_set "$(spec_req "$(obfs_spec 8443)")")"
check "выход с обфускацией завёлся — признак instances" "instances" \
      "$(cat "$T/var/obfs-dirty" 2>/dev/null)"
out="$(rpcd spec_set "$(spec_req "$(obfs_spec 8444)")")"
check "смена порта у нового обфускатора не затирает instances" "yes" \
      "$(grep -qx instances "$T/var/obfs-dirty" 2>/dev/null && echo yes || echo no)"
: > "$T/initd.log"
out="$(rpcd apply)"
check "apply пересобирает набор обфускаторов" "yes" \
      "$(grep -qx start "$T/initd.log" && echo yes || echo no)"

# ---- кандидат спеки готовится РЯДОМ с целевым файлом ----------------------------
# Спека — единственный файл, где лежит вся настройка, и подменяется она mv. Но mv атомарен
# только ВНУТРИ одной файловой системы: на роутере /tmp — tmpfs, а /etc — overlay, всегда
# разные, и busybox делает copy+unlink. То есть назначение открывается на запись и
# заполняется по частям: обрыв на середине (overlay на целевых устройствах 6,9 МБ)
# оставляет на месте рабочей спеки обрубок, который движок при следующей загрузке
# отвергнет, — ровно то, что --dry-run в этой же функции обещает предотвратить. Кандидат
# рядом с назначением делает mv настоящим rename: либо старый файл, либо новый.
#
# Проверяется не текст скрипта, а путь, который скрипт СВОИМИ РУКАМИ отдал движку на
# проверку: заглушка steer протоколирует свои аргументы, и `--spec` в строке dry-run — это
# и есть кандидат. Такая проверка переживает переименование переменной и не зеленеет от
# комментария о том, как правильно.
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
: > "$T/steer.log"
out="$(rpcd spec_set "$(spec_req "$(vless_spec)")")"
cand="$(awk '$1 == "apply" && $2 == "--dry-run" { print $4 }' "$T/steer.log" | tail -1)"
#
# Утверждение здесь именно «в каталоге назначения», а не «не в /tmp»: песочница стенда
# сама живёт в /tmp, и проверка на /tmp была бы красной на верном коде. Мерить нужно
# отношение кандидата к назначению — оно и решает, рождается mv из rename или из копии.
check "кандидат спеки лежит в каталоге назначения" "$T/etc" "$(dirname "$cand")"
check "имя кандидата растёт от имени спеки" "yes" \
      "$(case "$cand" in "$T/etc/spec.json".*) echo yes ;; *) echo no ;; esac)"
# Кандидат обязан исчезать в ОБОИХ исходах. Он лежит рядом с настоящей спекой, и
# оставленный после отказа он копится в /etc, а имя у него отличается от рабочего одним
# суффиксом — такой файл легко принять за настоящий.
check "после успеха кандидата не остаётся" "" \
      "$(ls "$T/etc"/spec.json.new.* 2>/dev/null)"
: > "$T/steer.log"
out="$(STEER_RC=1 STEER_ERR='bad spec' rpcd spec_set "$(spec_req "$(vless_spec 1)")")"
check "отвергнутая спека не сохраняется" "false" "$(printf '%s' "$out" | jget ok)"
check "после отказа кандидата не остаётся" "" \
      "$(ls "$T/etc"/spec.json.new.* 2>/dev/null)"

# Фикстуры возвращаются к исходным: проверки ниже писаны против них.
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
rm -f "$T/var/vless-dirty" "$T/var/obfs-dirty" "$T/etc/spec.applied.json"

# ---- файл настройки uci заводится, не убивая метод -------------------------------
# Отказ перенаправления у СПЕЦИАЛЬНОЙ встроенной команды (`: > файл`) завершает оболочку
# целиком — так требует POSIX и так делает ash. Значит там, где каталога нет или на overlay
# кончилось место, метод умирал БЕЗ ОТВЕТА: ни ok, ни ошибки, а интерфейс показывал «нет
# ответа» на пустом месте. Урок записан в запуске 46 у backup_put и там же исправлен, а
# sub_set и ui_set остались с прежней строкой — до этого стенда их ответ не проверялся вовсе,
# потому что пути /etc/config/splify2 не было шва.
# ---- порядок перенаправлений у wc (I-085) --------------------------------------
# Правило одно: `wc -c 2>/dev/null < файл`, а не `wc -c < файл 2>/dev/null`. Оболочка
# применяет перенаправления слева направо и делает это сама, до запуска команды, поэтому во
# второй форме отсутствующий файл разбирается тогда, когда stderr ещё свой.
#
# Сначала опыт, который объясняет барьер: без него это выглядело бы придиркой к порядку слов.
check "неверный порядок заставляет оболочку говорить вслух" "yes" \
      "$(sh -c 'wc -c < /nonexistent/nope 2>/dev/null' 2>&1 >/dev/null | grep -qi 'open' && echo yes || echo no)"
check "верный порядок молчит" "" \
      "$(sh -c 'wc -c 2>/dev/null < /nonexistent/nope' 2>&1 >/dev/null)"
# И барьер: в скрипте не осталось ни одного места с неверным порядком. Кавычка в шаблоне
# отсекает объяснение в комментарии, где неверная форма названа нарочно.
check "в скрипте не осталось неверного порядка" "0" \
      "$(grep -c 'wc -c < "' "$SCRIPT")"
# Значение при отсутствующем файле — нуль, а не пустая строка: пустая уезжает в json_add_int
# и делает ответ битым JSON вместо «мусора рядом с ответом».
check "размер отсутствующего файла считается нулём, а не пустотой" "0" \
      "$(sh -c 'echo "$(wc -c 2>/dev/null < /nonexistent/nope || echo 0)"')"

check "путь файла настройки — шов, а не литерал" "1" \
      "$(grep -c '^UCI_SPLIFY2=' "$SCRIPT")"
check "прямых путей /etc/config/splify2 в коде не осталось" "1" \
      "$(grep -c '/etc/config/splify2' "$SCRIPT")"
# Семь мест: sub_set, sub_put (ключи подписок), ветка настроек, ui_get|ui_set,
# fetch_mode|fetch_mode_set, zm_fix|zm_fix_set и doh_tunnel_set. Число растёт вместе с
# методами, которые пишут в uci, — и это ровно тот случай, когда барьер должен ломаться:
# новый метод обязан заводить файл той же функцией.
check "файл заводится одной функцией на все места" "7" \
      "$(rpcd_src | grep -c '^ *uci_file ||')"
check "перенаправлением файл больше не заводится" "0" \
      "$(rpcd_src | grep -c ': > "\?/etc/config')"
# И поведением: на недоступном каталоге метод обязан ОТВЕТИТЬ отказом, а не умереть.
out="$(UCI_SPLIFY2_FIXTURE=/proc/nonexistent/splify2 rpcd sub_set '{"url":"vless://k@h:443#n"}')"
check "недоступный файл настройки — отказ с причиной, а не тишина" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'кончилось место' && echo yes || echo no)"

# ---- подписку скачивает ДВИЖОК, а не этот файл -----------------------------------
#
# Скачивание, заголовки запроса с идентификатором устройства, разбор ответных заголовков,
# base64 названия, арифметика остатка трафика и повтор за другим форматом переехали в
# steer sub-fetch / sub-quota / sub-hwid. Причина — в шапке steer/src/ext/subfetch.c;
# проверяется всё это стендом steer/tests/subfetchmatch.c, где есть и поддельный curl, и
# поддельный каталог устройств.
#
# ЗДЕСЬ проверяется другая граница, и только она: что объект rpcd спрашивает движок теми
# аргументами, какими нужно, и что ответ движка доходит наверх не пересказанным. Повторять
# здесь проверки движка значило бы проверять заглушку.
rm -f "$T/subfetch.log" "$T/curl.log" "$T/etc/sub.txt"
out="$(rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "подписка скачалась" "true" "$(printf '%s' "$out" | jget ok)"
check "скачивал движок, и ему названы оба пути" \
      "https://panel.invalid/sub/abc $T/etc/sub.txt $T/etc/sub.userinfo" \
      "$(tail -1 "$T/subfetch.log")"
# Своего скачивания подписки в объекте не осталось. Проверяется отсутствием обращений curl:
# через curl здесь ходят только списки, и запрос к панели среди них был бы вторым путём
# наружу со своими заголовками — тем самым, ради устранения которого работа и переехала.
check "объект к панели сам не ходит" "no" \
      "$([ -f "$T/curl.log" ] && echo yes || echo no)"

# Идентификатор устройства тоже спрашивается у движка. Постоянство и рецептура — его забота
# (стенд subfetchmatch); здесь важно, что объект НЕ считает его сам и отдаёт как есть.
check "sub_info отдаёт идентификатор от движка" "splify2-9c53221f0abc9c53" \
      "$(rpcd sub_info | jget hwid)"
check "и sub_list тоже" "splify2-9c53221f0abc9c53" "$(rpcd sub_list | jget hwid)"
check "пустой ответ движка не превращается в выдуманный" "" \
      "$(STEER_HWID='' rpcd sub_info | jget hwid)"
# Свои реализации хеша и base64 из объекта убраны: они были там ровно потому, что на роутере
# нет ни sha256sum наверняка, ни base64 вовсе, — а у движка и то, и другое есть в C.
# Проверяется именно рецептура HWID, а не всякий хеш: отпечатки спеки (vless_fingerprint,
# obfs_fingerprint) считаются md5sum-ом законно и никуда не переезжали.
check "идентификатор устройства в объекте больше не считается" "0" \
      "$(grep -c "splify2:%s" "$SCRIPT")"
check "и base64 в awk из объекта убран" "0" \
      "$(grep -c 'b64_decode' "$SCRIPT")"

# ССЫЛКА ИЗ ОТВЕТА, А НЕ ТА, ЧТО ПРОСИЛИ. Движок мог перезапросить подписку с суффиксом
# /json — панели с привязкой к устройствам выбирают формат ответа по клиенту, — и обновлять
# в следующий раз надо по ТОЙ ссылке. Прежде это правило дублировалось в объекте строкой
# `url="${url%/}/json"`, то есть оболочка повторяла решение, которое приняла не она.
out="$(STEER_SUB_JSON='{"ok":true,"url":"https://panel.invalid/sub/abc/json","usable":9,"title":"Панель","hwid_sent":true}' \
       rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "сохранена ссылка из ответа движка" "https://panel.invalid/sub/abc/json" \
      "$(rpcd sub_info | jget url)"
check "и число пригодных узлов доехало" "9" "$(printf '%s' "$out" | jget usable)"
check "название от панели взято движком и сохранено" "Панель" \
      "$(uci_get splify2.main.sub_title)"

# Название, которое дал ЧЕЛОВЕК, ответом панели не переписывается: он его для того и вписал.
out="$(STEER_SUB_JSON='{"ok":true,"url":"https://panel.invalid/s","usable":1,"title":"Панель"}' \
       rpcd sub_set '{"url":"https://panel.invalid/s","title":"моё"}')"
check "своё название сильнее панельного" "моё" "$(uci_get splify2.main.sub_title)"

# Слово панели про устройство доходит до человека дословно. Что именно она сказала — решает
# движок по своим заголовкам; объект обязан не потерять это по дороге.
out="$(STEER_SUB_JSON='{"ok":true,"url":"https://panel.invalid/s","usable":0,"warn":"панель не увидела идентификатора устройства и отдала заглушку вместо узлов"}' \
       rpcd sub_set '{"url":"https://panel.invalid/s"}')"
check "предупреждение движка доехало до ответа" "yes" \
      "$(printf '%s' "$out" | jget warn | grep -q 'не увидела идентификатора' && echo yes || echo no)"
out="$(STEER_SUB_JSON='{"ok":true,"url":"https://panel.invalid/s","usable":1}' \
       rpcd sub_set '{"url":"https://panel.invalid/s"}')"
check "на исправном ответе предупреждения нет" "" "$(printf '%s' "$out" | jget warn)"

# ОТКАЗ ДВИЖКА — отказ метода, и настройка при этом не пишется: сохранённая ссылка на
# подписку, которая не скачалась, выглядит настроенной и молча не работает.
uci_set splify2.main.sub_url "https://panel.invalid/prev"
out="$(STEER_SUB_RC=1 rpcd sub_set '{"url":"https://panel.invalid/broken"}')"
check "отказ движка — отказ метода" "false" "$(printf '%s' "$out" | jget ok)"
check "и причина названа" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'не скачалась' && echo yes || echo no)"
check "прежняя ссылка не подменена" "https://panel.invalid/prev" \
      "$(uci_get splify2.main.sub_url)"

# Вставленные руками ссылки vless:// никуда не ходят — значит и движок для них не зовётся:
# скачивать нечего, и запуск процесса был бы работой без вопроса.
rm -f "$T/subfetch.log"
out="$(rpcd sub_set '{"url":"vless://key@host:443#node"}')"
check "для ссылок vless:// движок не зовётся" "links;no" \
      "$(printf '%s' "$out" | jget kind);$([ -f "$T/subfetch.log" ] && echo yes || echo no)"

# ---- несколько подписок ------------------------------------------------------
#
# Подписок на роутере бывает несколько: у человека две панели, и локации из обеих он
# складывает в пулы. Первая осталась на прежнем месте (/etc/steer/sub.txt) — на этот путь
# ссылаются выходы в спеках установленных роутеров.
rm -rf "$T/etc/subs"
out="$(rpcd sub_set '{"url":"https://panel.invalid/sub/second","name":"blue"}')"
check "вторая подписка легла своим файлом" "yes" \
      "$([ -s "$T/etc/subs/blue.txt" ] && echo yes || echo no)"
check "первую она не тронула" "yes" \
      "$([ -s "$T/etc/sub.txt" ] && echo yes || echo no)"
check "перечень называет обе" "blue main" \
      "$(rpcd sub_list | python3 -c 'import json,sys
print(" ".join(sorted(d["name"] for d in json.load(sys.stdin)["subs"])))')"

# ЛОВУШКА, ради которой заведён rpcd_raw: ubus передаёт запрос без завершающего перевода
# строки. Обработчик обязан прочитать имя и в этом случае — иначе он молча отвечает по
# первой подписке, и на экране у второй стоят чужие числа (поймано на роутере).
check "имя подписки читается и без перевода строки на входе" "blue" \
      "$(rpcd_raw sub_info '{"name":"blue"}' | jget name)"
check "и путь тогда её собственный" "$T/etc/subs/blue.txt" \
      "$(rpcd_raw sub_info '{"name":"blue"}' | jget path)"

# Занятую выходом не удаляем: движок читает файл узлов при подъёме, и снос под живым выходом
# оставил бы правило вести в туннель без единого узла.
cat > "$T/etc/spec.json" <<JSON
{"schema":1,"outputs":{"vl":{"name":"vl","kind":"vless","sub_file":"$T/etc/subs/blue.txt","node":-1}},"channels":[]}
JSON
out="$(rpcd sub_del '{"name":"blue"}')"
check "занятая подписка не удаляется" "false" "$(printf '%s' "$out" | jget ok)"
check "и сказано, сколькими выходами занята" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'занята выходами' && echo yes || echo no)"
printf '%s\n' '{"schema":1,"outputs":{},"channels":[]}' > "$T/etc/spec.json"
out="$(rpcd sub_del '{"name":"blue"}')"
check "свободная — удаляется вместе с файлом" "true;no" \
      "$(printf '%s' "$out" | jget ok);$([ -e "$T/etc/subs/blue.txt" ] && echo yes || echo no)"

# ---- НЕСКОЛЬКО ПОДПИСОК: каждая со своей парой файлов --------------------------
#
# Подписок на роутере бывает несколько, и главное свойство здесь — что движку называются
# пути ИМЕННО ЭТОЙ подписки. Ошибка была бы молчаливой в худшем виде: остаток второй панели,
# записанный поверх остатка первой, выглядит как правда, а узлы, скачанные в чужой файл,
# уводят трафик к другому поставщику.
rm -f "$T/subfetch.log" "$T/subquota.log"
rm -rf "$T/etc/subs"
# Первая подписка заводится ЗДЕСЬ, а не берётся из состояния предыдущих проверок: те
# оставляли её то ссылками vless://, то вовсе без ссылки, и проверка «первую не тронуло»
# смотрела бы не на то.
rpcd sub_set '{"url":"https://first.invalid/sub"}' >/dev/null
out="$(rpcd sub_set '{"url":"https://second.invalid/sub","name":"green"}')"
check "второй подписке названы её собственные пути" \
      "https://second.invalid/sub $T/etc/subs/green.txt $T/etc/subs/green.userinfo" \
      "$(tail -1 "$T/subfetch.log")"
check "и файл лёг именно туда" "yes" \
      "$([ -s "$T/etc/subs/green.txt" ] && echo yes || echo no)"
check "первую это не тронуло" "yes" \
      "$([ -s "$T/etc/sub.txt" ] && echo yes || echo no)"
# Ссылка второй подписки живёт в своей секции uci, а не поверх первой.
check "ссылка второй подписки в своей секции" "https://second.invalid/sub" \
      "$(uci_get splify2.sub_green.url)"
check "и ссылка первой на месте" "https://first.invalid/sub" \
      "$(uci_get splify2.main.sub_url)"

# Узлы подписки БЕЗ выхода: редактор выхода показывает локации подписки до того, как на неё
# заведён хоть один выход. Движку уходит путь к файлу вместо имени выхода, и путь принимается
# только свой — из перечня подписок роутера: иначе метод читал бы с диска что угодно.
: > "$T/steer.log"
out="$(STEER_JSON='{"output":"","sub_file":"x","node":-1,"chosen":[],"nodes":[]}' \
       rpcd vless_nodes "{\"sub\":\"$T/etc/subs/green.txt\"}")"
check "узлы подписки спрашиваются у движка путём к её файлу" \
      "vless-nodes $T/etc/subs/green.txt --spec $T/etc/spec.json" "$(tail -1 "$T/steer.log")"
check "и ответ движка отдан дословно" "x" "$(printf '%s' "$out" | jget sub_file)"
out="$(rpcd vless_nodes '{"sub":"/etc/passwd"}')"
check "чужой путь вместо подписки отвергается" "false" "$(printf '%s' "$out" | jget ok)"
# Остаток второй подписки спрашивается по ЕЁ файлу: общий файл означал бы, что обзор
# показывает остаток одной панели под именем другой.
out="$(rpcd sub_quota '{"name":"green"}')"
check "остаток второй подписки спрошен по её файлу" \
      "https://second.invalid/sub $T/etc/subs/green.userinfo" \
      "$(tail -1 "$T/subquota.log")"
# Имя, которого нет, в путь не превращается: оно чистится до латиницы и цифр, потому что
# становится и именем файла, и именем секции uci.
out="$(rpcd sub_set '{"url":"https://third.invalid/sub","name":"../../etc/passwd"}')"
check "имя подписки не выходит за каталог" "no" \
      "$(tail -1 "$T/subfetch.log" | grep -q '/etc/passwd' && echo yes || echo no)"

# ---- остаток трафика: файл как контракт между движком и объектом ------------------
#
# Панель говорит остаток ЗАГОЛОВКОМ ответа, и больше нигде. Спрашивает его и разбирает
# ДВИЖОК (steer sub-fetch / sub-quota), он же считает точку отсчёта периода и решает, когда
# период начался заново; всё это проверяется в steer/tests/subfetchmatch.c.
#
# Между движком и объектом остаётся ФАЙЛ — `<подписка>.userinfo`, «ключ=значение» по строке.
# Он и есть контракт: объект читает его, собирая ответы sub_info и sub_list, и не ходит за
# числами наружу. Здесь проверяется именно эта половина.
USERINFO='upload=1288490188
download=139458183168
total=214748364800
expire=1789200000
at=1789000000
at0=1788000000
used0=1073741824'
rm -f "$T/etc/sub.userinfo"
out="$(STEER_SUB_INFO="$USERINFO" rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "остаток приезжает в ответе на «Обновить»" "214748364800" \
      "$(printf '%s' "$out" | jqget quota total)"
check "разобраны обе половины расхода" "1288490188;139458183168" \
      "$(printf '%s' "$out" | jqget quota up);$(printf '%s' "$out" | jqget quota down)"
check "срок подписки разобран" "1789200000" "$(printf '%s' "$out" | jqget quota expire)"
# Точка отсчёта периода доезжает как есть: делить и предсказывать — работа интерфейса, а
# второе место, где тот же темп считается иначе, разойдётся с первым.
check "точка отсчёта периода отдана вместе с числами" "1788000000;1073741824" \
      "$(printf '%s' "$out" | jqget quota since);$(printf '%s' "$out" | jqget quota since_used)"
# Байты — СТРОКАМИ: 200 ГБ не влезают в int32 у jshn, и обрезанное число выглядело бы
# законным остатком. Проверяется именно тип, а не значение: значение сверено выше.
check "объёмы отданы строками, а не числами" "yes" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if isinstance(json.load(sys.stdin)["quota"]["total"], str) else "no")')"
check "sub_info отдаёт запомненный остаток без запроса наружу" "214748364800" \
      "$(rpcd sub_info | jqget quota total)"
rm -f "$T/subfetch.log" "$T/subquota.log"
rpcd sub_info > /dev/null
check "и правда не спрашивает движок" "no" \
      "$([ -f "$T/subfetch.log" ] || [ -f "$T/subquota.log" ] && echo yes || echo no)"
check "sub_list отдаёт тот же остаток" "214748364800" \
      "$(rpcd sub_list | python3 -c 'import json,sys
for d in json.load(sys.stdin)["subs"]:
    if d["name"] == "main": print(d["quota"]["total"])')"

# Пустое значение в файле значит «панель этого не сообщала» и НЕ равно нулю: подписка без
# ограничения объёма не должна выглядеть исчерпанной.
out="$(STEER_SUB_INFO='upload=5
download=5
total=
expire=1789200000
at=1789000000
at0=1789000000
used0=10' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "неназванный объём отдан пустой строкой, а не нулём" "" \
      "$(printf '%s' "$out" | jqget quota total)"

# Файла нет — поля `quota` нет вовсе. Пустая полоса «осталось 0 из 0» была бы выдумкой
# интерфейса, а не ответом панели.
out="$(STEER_SUB_INFO='' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "молчание панели не оставляет прежних чисел" ";" \
      "$(printf '%s' "$out" | jget quota);$(rpcd sub_info | jget quota)"

# sub_quota — обновление остатка БЕЗ подмены подписки. Метод зовут при открытии обзора, и
# подменять там узлы нельзя: движку поэтому даётся только путь остатка, а не путь подписки.
out="$(STEER_SUB_INFO="$USERINFO" rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
sub_before="$(cat "$T/etc/sub.txt")"
rm -f "$T/subfetch.log" "$T/subquota.log" "$T/var/vless-dirty"
out="$(STEER_SUB_INFO="$USERINFO" rpcd sub_quota)"
check "остаток обновлён" "true;true;139458183168" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget asked);$(printf '%s' "$out" | jqget quota down)"
check "движок спрошен про остаток, а не про подписку" "no" \
      "$([ -f "$T/subfetch.log" ] && echo yes || echo no)"
check "и путь остатка ему назван" "https://panel.invalid/sub/abc $T/etc/sub.userinfo" \
      "$(tail -1 "$T/subquota.log")"
check "файл подписки не подменён" "$sub_before" "$(cat "$T/etc/sub.txt")"
check "клиента перечитывать не просят" "no" \
      "$([ -f "$T/var/vless-dirty" ] && echo yes || echo no)"

# Движок отказал — это не отказ метода: человек ничего не сделал не так, и красная ошибка на
# исправной настройке хуже честного «панель не сообщает остаток».
out="$(STEER_QUOTA_RC=1 rpcd sub_quota)"
check "отказ движка не делает метод отказом" "true;true" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget asked)"
check "и причина названа словами" "yes" \
      "$(printf '%s' "$out" | jget why | grep -q 'не сообщила остаток' && echo yes || echo no)"

# Узлы вставлены ссылками vless:// — спрашивать некого, и движок не зовётся вовсе: у ссылки
# нет панели, а значит и заголовков.
out="$(rpcd sub_set '{"url":"vless://key@host:443#node"}')"
rm -f "$T/subquota.log"
out="$(rpcd sub_quota)"
check "для ссылок vless:// остаток не выдумывается" "true;false;no" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget asked);$([ -f "$T/subquota.log" ] && echo yes || echo no)"
check "и сказано, почему" "yes" \
      "$(printf '%s' "$out" | jget why | grep -q 'сообщает панель' && echo yes || echo no)"

# Метод обязан быть объявлен и в перечне, и в ACL — иначе rpcd его не отдаст, а сборка
# splify2 упадёт на своей же проверке.
check "sub_quota объявлен в перечне методов" "yes" \
      "$(rpcd_list | grep -q '"sub_quota"' && echo yes || echo no)"
check "sub_quota разрешён в ACL" "yes" \
      "$(grep -q '"sub_quota"' "$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json" && echo yes || echo no)"

# И обратное свойство: за СПИСКАМИ идентификатор устройства не уходит. Издателю списков
# незачем знать, какой у человека роутер, — это другой сервер и другая надобность.
rm -f "$T/curl.hdrs"
rpcd list_fetch '{"id":"news","kind":"prefixes"}' >/dev/null
check "за списками идентификатор устройства не уходит" "no" \
      "$([ -s "$T/curl.hdrs" ] && echo yes || echo no)"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
rm -f "$T/var/vless-dirty" "$T/var/obfs-dirty"

# ---- списки доскачиваются перед КАЖДОЙ проверкой спеки ----------------------------
# Движок умирает на отсутствующем файле списка, и делает это в ДВУХ местах: при
# `apply --dry-run` внутри spec_set (проверка до записи) и при настоящем apply. Пока
# доскачивание стояло только в apply, выбор нового сервиса не сохранялся вообще: автосохранение
# звало spec_set, dry-run падал с «cannot read a channel's list», правка откатывалась — и
# человек видел ошибку применения там, где ничего не применял. Проверяется поэтому не наличие
# загрузки, а её место: перед каждой проверкой.
check "доскачивание вынесено в общую функцию" "yes" \
      "$(rpcd_src | grep -q '^fetch_missing_lists()' && echo yes || echo no)"
# Мест стало три: к spec_set и apply добавилось восстановление из архива (backup_put) —
# оно тоже проверяет спеку компилятором, а на чистом роутере зеркал категорий ещё нет, и в
# архив они намеренно не едут. Проверка на число, а не на перечень имён: имена ниже.
check "функция вызывается трижды: spec_set, apply, backup_put" "3" \
      "$(rpcd_src | grep -c 'fetch_missing_lists "')"
# spec_set и apply живут в группе spec, восстановление — в группе backup.
set_line=$(grep -n 'set_warn="$(fetch_missing_lists' "$RPCD_DIR/m-spec.sh" | cut -d: -f1)
dry_line=$(grep -n 'apply --dry-run --spec "$tmp"' "$RPCD_DIR/m-spec.sh" | cut -d: -f1)
check "в spec_set загрузка идёт ДО проверки движком" "yes" \
      "$([ -n "$set_line" ] && [ -n "$dry_line" ] && [ "$set_line" -lt "$dry_line" ] && echo yes || echo no)"
# Порядок ищется ВНУТРИ ветки, а не по всему файлу: `fetch_warn=` встречается и в apply, и
# в backup_put, и общий `grep -n` отдал бы два номера строк, на которых `[` спотыкается о
# «Illegal number». Расхождение такого рода стенд однажды уже прятал.
apply_body="$(sed -n '/^    apply)/,/^        ;;/p' "$RPCD_DIR/m-spec.sh")"
apply_fetch=$(printf '%s\n' "$apply_body" | grep -n 'fetch_missing_lists' | head -1 | cut -d: -f1)
apply_run=$(printf '%s\n' "$apply_body" | grep -n 'apply --spec "$SPEC" 2>&1)"; rc=' | head -1 | cut -d: -f1)
check "в apply загрузка идёт ДО применения" "yes" \
      "$([ -n "$apply_fetch" ] && [ -n "$apply_run" ] && [ "$apply_fetch" -lt "$apply_run" ] && echo yes || echo no)"
put_body="$(sed -n '/^    backup_put)/,/^        ;;/p' "$RPCD_DIR/m-backup.sh")"
put_fetch=$(printf '%s\n' "$put_body" | grep -n 'fetch_missing_lists' | head -1 | cut -d: -f1)
put_dry=$(printf '%s\n' "$put_body" | grep -n 'apply --dry-run --spec "$D/spec"' | head -1 | cut -d: -f1)
check "в восстановлении загрузка идёт ДО проверки движком" "yes" \
      "$([ -n "$put_fetch" ] && [ -n "$put_dry" ] && [ "$put_fetch" -lt "$put_dry" ] && echo yes || echo no)"
# Сообщение об отказе обязано называть ПРИЧИНУ, а не только следствие: «cannot read a
# channel's list» отправляет искать испорченный файл, которого никогда не было.
check "при неудачной загрузке причина ставится перед ошибкой движка" "yes" \
      "$(rpcd_src | grep -q 'fail "${set_warn:+$set_warn; }' && echo yes || echo no)"

# ---- R-005: архив настроек ----------------------------------------------------
# Бекапа и переноса настроек не было вовсе, а штатный архив системы настройки splify2 не
# содержит (I-037). Проверяются обе половины: ЧТО уезжает в архив (и чего в нём быть не
# должно) и разбор ПРИСЛАННОГО файла — недоверенного ввода.
#
# Отдельный вход: собрать запрос из документа. Экранирует его python — руками собирать JSON
# с переводами строк значило бы проверять своё экранирование, а не скрипт.
backup_req() {  # < ДОКУМЕНТ на stdin
    python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read(), "append": False, "final": True}))'
}
backup_put() {  # < ДОКУМЕНТ на stdin
    rpcd backup_put "$(backup_req)"
}

# Значение поля БЕЗ добавленного перевода строки: куски архива склеиваются байт в байт, и
# лишний перевод строки на каждой границе испортил бы файл ровно так, как это незаметно.
jraw() {  # ПОЛЕ < JSON
    python3 -c 'import json,sys
d = json.load(sys.stdin)
v = d.get(sys.argv[1])
sys.stdout.write("" if v is None else v if isinstance(v, str) else str(v))' "$1"
}

# Прочитать архив целиком, склеивая куски. Число кусков пишется В ФАЙЛ, а не в переменную:
# функцию зовут через подстановку, то есть в подоболочке, откуда переменная не вернётся.
backup_doc() {
    off=0; n=0
    : > "$T/doc-all.txt"
    while [ "$n" -lt 64 ]; do
        r="$(rpcd backup_get "{\"offset\":$off}")"
        printf '%s' "$r" | jraw text >> "$T/doc-all.txt"
        n=$((n + 1))
        [ "$(printf '%s' "$r" | jget eof)" = true ] && break
        nxt="$(printf '%s' "$r" | jget next)"
        [ "$nxt" -gt "$off" ] || break
        off="$nxt"
    done
    printf '%s' "$n" > "$T/doc-parts"
    cat "$T/doc-all.txt"
}

# Фикстуры этого раздела ставятся с нуля: свои списки выше оставили после себя в том числе
# «grow» размером под мегабайт, и проверять на нём состав архива значило бы проверять
# последствия чужой проверки.
rm -rf "$T/lists/custom"
mkdir -p "$(dirname "$(custom_domains_path x)")" "$(dirname "$(custom_prefixes_path x)")"
printf '10.9.0.0/16\n' > "$(custom_prefixes_path mine-a)"
printf 'own.example\n' > "$(custom_domains_path mine-d)"
printf 'vless://k@h:443#node\n' > "$T/etc/sub.txt"
# Свой список, который заведомо не влезает в один кусок ubus: без него протокол смещений
# проверялся бы на архиве, приезжающем целиком, то есть не проверялся бы вовсе.
awk 'BEGIN { for (i = 0; i < 1200; i++) printf "host%d.example\n", i }' > "$(custom_domains_path mine-big)"
# Ключи туннелей, стратегии обхода и вторая подписка. Ровно то, чего в архиве не было и без
# чего восстановленный роутер не работает: приватный ключ пира xsteer взять больше негде
# (панель его не печатает, а сгенерировать заново — это уже другой пир), стратегия обхода
# выбрана человеком опытом, а вторая подписка живёт своим файлом со своим остатком.
#
# XSTEER_DIR экспортируется, а не стоит в общем списке швов у rpcd(): список общий для всех
# разделов стенда, а этот каталог нужен одному — архиву.
export XSTEER_DIR="$T/etc/steer-xsteer"
mkdir -p "$XSTEER_DIR" "$T/etc/steer-zapret" "$T/etc/subs"
printf '%s\n' '[Interface]' \
  'PrivateKey = 6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=' \
  'Address = 10.77.0.5/24' 'SNI = www.microsoft.com' '' '[Peer]' \
  'PublicKey = QYkH5bWOsEOCgIMldHPATSG7yvNyJ8st7o/HMelWKxs=' \
  'Endpoint = 198.51.100.9:8443' 'AllowedIPs = 10.77.0.0/24, 192.168.9.0/24' \
  > "$XSTEER_DIR/home.conf"
printf '%s\n' '#v1' '--filter-tcp=443' '--dpi-desync=fake,split2' > "$T/etc/steer-zapret/yt.opts"
printf 'vless://k2@h2:443#second\n' > "$T/etc/subs/work.txt"
uci_set splify2.sub_work subscription
uci_set splify2.sub_work.url 'https://panel.example.net/sub/2'
uci_set splify2.sub_work.kind url
# Все одиннадцать полей, а не три: перечень получается тем же способом, каким его находят в
# коде, — `grep -rhoE 'splify2\.(main|sub_[a-z_]*)\.[a-z_]+' files/`.
for _kv in 'sub_url=https://panel.example.net/sub/1' 'sub_kind=url' 'wizard=step3' \
           'sub_title=Моя панель' 'zm_fix=1' 'manifest_url=https://example.net/categories.json' \
           'fetch_via_tunnel=always' 'doh_via_tunnel=1' 'list_shrink_factor=4' \
           'zapret_source=StressOzz/Zapret-Manager' 'geo_url=https://example.net/trace'; do
    uci_set "splify2.main.${_kv%%=*}" "${_kv#*=}"
done

doc="$(backup_doc)"
check "архив приезжает несколькими кусками и склеивается" "yes" \
      "$([ "$(cat "$T/doc-parts")" -gt 1 ] && echo yes || echo no)"
check "склеенный архив не потерял ни строки на границах кусков" "1200" \
      "$(printf '%s\n' "$doc" | grep -c '^host[0-9]*\.example$')"
check "архив начинается своим заголовком с версией" "splify2-backup 2" \
      "$(printf '%s\n' "$doc" | head -1)"
check "в архиве есть спека, подписка и оба своих списка" "yes" \
      "$(printf '%s\n' "$doc" | grep -q '^\[spec\]$' &&
         printf '%s\n' "$doc" | grep -q '^\[sub\]$' &&
         printf '%s\n' "$doc" | grep -q '^\[list prefixes mine-a\]$' &&
         printf '%s\n' "$doc" | grep -q '^\[list domains mine-d\]$' && echo yes || echo no)"
# Главное свойство экспорта: 284 КБ зеркал категорий издателя в него не едут. Проверяется не
# размер, а состав — списка издателя нет ни заголовком, ни содержимым.
check "зеркал категорий издателя в архиве нет (284 КБ, I-037)" "no" \
      "$(printf '%s\n' "$doc" | grep -qE '^(\[list (prefixes|domains) news\]|10\.0\.0\.0/8|example\.org)$' && echo yes || echo no)"
check "в архиве есть и большой свой список, и оба маленьких" "yes" \
      "$(printf '%s\n' "$doc" | grep -q '^\[list domains mine-big\]$' && echo yes || echo no)"

# Приватный ключ пира — то, без чего восстановленный роутер туннель не поднимает вовсе.
# Содержимое едет ДОСЛОВНО, вместе со своими строками в квадратных скобках: файл читает
# движок и читает строго, а пересобирать его здесь значило бы завести вторую реализацию
# формата WireGuard.
check "ключи xsteer уезжают в архив дословно" "yes" \
      "$(printf '%s\n' "$doc" | grep -q '^\[xsteer home\]$' &&
         printf '%s\n' "$doc" | grep -q '^\[Interface\]$' &&
         printf '%s\n' "$doc" | grep -q '^PrivateKey = 6Gtidge6' && echo yes || echo no)"
# Отметка стратегии — первая строка файла ключей, и она комментарий (`#v1`). Разборщик архива
# комментарии выбрасывает, поэтому здесь проверяется именно она: без отметки восстановленный
# выход работает по нужным ключам, но интерфейс не знает, какая стратегия выбрана.
check "стратегия выхода обхода уезжает вместе со своей отметкой" "yes" \
      "$(printf '%s\n' "$doc" | grep -q '^\[zapret yt\]$' &&
         printf '%s\n' "$doc" | grep -qx '#v1' &&
         printf '%s\n' "$doc" | grep -qx -- '--dpi-desync=fake,split2' && echo yes || echo no)"
# Вторая подписка — это файл И ссылка на панель: без ссылки восстановленную подписку нечем
# обновить, то есть она приезжает мёртвой.
check "именованная подписка уезжает и файлом, и ссылкой" "yes" \
      "$(printf '%s\n' "$doc" | grep -q '^\[sub work\]$' &&
         printf '%s\n' "$doc" | grep -qx 'sub_work.url=https://panel.example.net/sub/2' &&
         printf '%s\n' "$doc" | grep -qx 'sub_work.kind=url' && echo yes || echo no)"
check "в архив уезжают все одиннадцать полей uci, а не три" "11" \
      "$(printf '%s\n' "$doc" | grep -cE '^(sub_url|sub_kind|wizard|sub_title|zm_fix|manifest_url|fetch_via_tunnel|doh_via_tunnel|list_shrink_factor|zapret_source|geo_url)=')"
# Шапка архива предупреждала про ссылки vless://. С приватными ключами туннелей это верно
# сильнее, и сказать об этом обязана сама шапка: файл человек уносит на флешке и в переписке.
check "шапка предупреждает и о приватных ключах" "yes" \
      "$(printf '%s\n' "$doc" | sed -n '1,10p' | grep -q 'приватные ключи' && echo yes || echo no)"

# Экспорт не отдаёт файл, который его же импорт откажется принять: иначе человек узнал бы
# об этом в тот день, когда бекап понадобился.
out="$(BACKUP_MAX_BYTES=1024 rpcd backup_get '{"offset":0}')"
check "слишком большой архив не отдаётся, а объясняется" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'не влезают в архив' && echo yes || echo no)"

# ---- разбор недоверенного файла -----------------------------------------------
# Каждая проверка ниже — про отказ, и про отказ ДО записи на диск. Импорт делает spec.json
# источником, которого не касался root (I-003), поэтому «принять, а посмотреть потом» здесь
# не годится: спека уезжает в командные строки и движка, и этого самого скрипта.
out="$(printf 'просто текст\n' | backup_put)"
check "чужой файл не принимается" "false" "$(printf '%s' "$out" | jget ok)"
check "причина отказа названа словами" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'не файл настроек' && echo yes || echo no)"

out="$(printf '%s\n' 'splify2-backup 1' '[evil]' 'x' | backup_put)"
check "непонятный раздел отвергает файл целиком" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 9' '[options]' 'sub_kind=none' | backup_put)"
check "архив чужой версии не разбирается наугад" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' 'строка вне раздела' | backup_put)"
check "строка вне раздела отвергается" "false" "$(printf '%s' "$out" | jget ok)"

# Путь за пределы каталогов настроек. Спека несёт пути к файлам списков и к файлу подписки,
# то есть присланный файл может попросить движок читать что угодно.
out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"outputs":{},"channels":[{"name":"c","out":"direct","match":{"prefixes_files":["/etc/shadow"]}}]}' |
  backup_put)"
check "список вне каталога списков отвергается" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'вне каталога' && echo yes || echo no)"

out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"outputs":{},"channels":[{"name":"c","out":"direct","match":{"domains_file":"/etc/steer/lists/../../shadow"}}]}' |
  backup_put)"
check "путь с .. отвергается и в коротком написании поля" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"outputs":{"vpn":{"kind":"vless","sub_file":"/etc/passwd"}},"channels":[]}' | backup_put)"
check "файл подписки вне каталогов настроек отвергается" "false" "$(printf '%s' "$out" | jget ok)"

# I-003: движок подставляет lan_device в popen("ip -4 -o addr show ...") без фильтрации. Пока
# спеку писал только root, это была теоретическая слабость; принятый файл делает её входом.
out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"lan_device":"br-lan; reboot","outputs":{},"channels":[]}' | backup_put)"
check "lan_device с метасимволами отвергается (I-003)" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'lan_device' && echo yes || echo no)"

# Та же слабость через МНОЖЕСТВЕННУЮ форму (splify2#16). Проверка по одному ключу
# `lan_device` мимо `lan_devices` — это дыра ровно того вида, ради которой её и писали:
# поле в спеке новое, проверка старая, и недоверенный архив снова проезжает.
out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"lan_devices":["br-lan","tailscale0; reboot"],"outputs":{},"channels":[]}' | backup_put)"
check "lan_devices с метасимволами отвергается (splify2#16)" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'lan_device' && echo yes || echo no)"

out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"lan_devices":["br-lan","tailscale0"],"outputs":{"direct":{"kind":"direct"}},"channels":[]}' | backup_put)"
check "годный перечень устройств принимается" "true" "$(printf '%s' "$out" | jget ok)"

# Имя выхода уезжает в командную строку этого же скрипта: `ubus call service signal
# {"instance":"vless_$o"}` и ensure_vless_zone.
out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"outputs":{"vpn; reboot":{"kind":"direct"}},"channels":[]}' | backup_put)"
check "имя выхода с метасимволами отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' '[spec]' \
  '{"schema":1,"outputs":{},"channels":[{"name":"a\nb","out":"direct","match":{"any":true}}]}' | backup_put)"
check "экранированный перевод строки в спеке отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' '[sub]' 'http://example.org/list' | backup_put)"
check "подписка не из vless:// и не base64 отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' '[options]' 'sub_url=https://x/$(reboot)' | backup_put)"
check "ссылка подписки с подстановкой отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 1' '[options]' 'root_password=x' | backup_put)"
check "неизвестное поле настроек отвергается" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'непонятная настройка' && echo yes || echo no)"

# Управляющий байт внутри строки: ровно то, чем можно спрятать строку от построчного
# разборщика. Собирается python-ом, потому что в тексте стенда его быть не должно.
req="$(python3 -c 'import json; print(json.dumps({"text":"splify2-backup 1\n[sub]\nvless://" + chr(1) + "\n","append":False,"final":True}))')"
out="$(rpcd backup_put "$req")"
check "двоичные данные в архиве отвергаются" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'двоичные' && echo yes || echo no)"

# Предел считается по НАКОПЛЕННОМУ, а не по куску: иначе он обходится двадцатью кусками по
# пределу каждый (ровно эта ошибка уже была в list_put). Предел на время проверки уменьшается
# швом — иначе фикстурой была бы четверть мегабайта текста.
req="$(python3 -c 'import json; print(json.dumps({"text":"splify2-backup 1\n","append":False,"final":False}))')"
out="$(BACKUP_MAX_BYTES=40 rpcd backup_put "$req")"
check "первый кусок в пределах предела принимается" "true" "$(printf '%s' "$out" | jget ok)"
# I-085, первая половина. Метод rpcd отвечает СТАНДАРТНЫМ ВЫВОДОМ, поэтому лишняя строка рядом
# с ответом — не косметика: она уезжает в журнал rpcd, а на части сборок и клиенту, который
# ждёт JSON. Накопитель на первом куске ещё не существует, и раньше именно здесь оболочка
# жаловалась вслух: `wc -c < файл 2>/dev/null` разбирает перенаправление ДО того, как stderr
# уедет в /dev/null, — значит жалобу печатает оболочка, а не `wc`.
check "отсутствующий накопитель не заставляет оболочку говорить вслух" "" \
      "$(grep -i 'cannot open\|can.t open\|No such file' "$T/stderr" 2>/dev/null | head -1)"
req="$(python3 -c 'import json; print(json.dumps({"text":"[options]\nsub_kind=none\n","append":True,"final":True}))')"
out="$(BACKUP_MAX_BYTES=40 rpcd backup_put "$req")"
check "предел считается по накопленному, а не по куску" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'больше' && echo yes || echo no)"

# ---- годный архив восстанавливается -------------------------------------------
rm -f "$T/var/backup.in" "$T/etc/spec.applied.json" "$T/var/vless-dirty"
: > "$T/steer.log"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
out="$(printf '%s\n' \
  'splify2-backup 1' \
  '# комментарий' \
  '[spec]' \
  '{"schema":1,"lan_device":"br-lan","outputs":{"direct":{"kind":"direct"}},"channels":[]}' \
  '[sub]' \
  'vless://key@host:443#node' \
  '[list domains mine-d]' \
  'Example.ORG' \
  'это не домен вовсе' \
  '[list prefixes mine-a]' \
  '10.9.0.0/16' \
  '10.9.0.256' \
  '[options]' \
  'sub_kind=links' | backup_put)"
check "годный архив принимается" "true" "$(printf '%s' "$out" | jget ok)"
check "спека из архива легла на место" "yes" \
      "$(grep -q 'br-lan' "$T/etc/spec.json" && echo yes || echo no)"
check "подписка из архива легла на место" "yes" \
      "$(grep -q '^vless://key@host:443#node$' "$T/etc/sub.txt" && echo yes || echo no)"
# Списки проходят ТЕМ ЖЕ санитайзером, что и list_put: домен приводится к нижнему регистру,
# негодные строки отбрасываются и считаются числом.
check "свой доменный список восстановлен и приведён к нижнему регистру" "example.org" \
      "$(cat "$(custom_domains_path mine-d)")"
check "негодные строки списков отброшены и сосчитаны" "2" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys; print(sum(l["dropped"] for l in json.load(sys.stdin)["lists"]))')"
# Главное свойство импорта: он НЕ применяет. Компилятор спрашивается (--dry-run), применение
# остаётся за человеком — модель проекта «сохранено ≠ применено».
check "спека проверена компилятором" "1" "$(grep -c 'apply --dry-run' "$T/steer.log")"
check "восстановление ничего не применяет" "0" "$(grep -c 'apply --spec' "$T/steer.log")"
# Без снимка применённого пилюля «Применить · N» показала бы ноль: applied_get в его
# отсутствие отдаёт саму спеку, то есть восстановленное выглядело бы применённым.
check "снимок применённого снят с ПРЕЖНЕЙ спеки" "yes" \
      "$([ -s "$T/etc/spec.applied.json" ] && ! grep -q 'br-lan' "$T/etc/spec.applied.json" && echo yes || echo no)"
# Оба повода сразу: восстановление меняет и НАБОР выходов (экземпляра для появившегося
# ещё нет — instances), и подписку у тех, что могли остаться под тем же именем (их
# экземпляр работает и обязан перечитать узлы — params).
check "туннели помечены к пересборке по обоим поводам" "yes;yes" \
      "$(grep -qx instances "$T/var/vless-dirty" && echo yes || echo no);$(grep -qx params "$T/var/vless-dirty" && echo yes || echo no)"
check "накопленный файл убран за собой" "no" \
      "$([ -f "$T/var/backup.in" ] && echo yes || echo no)"
# Заголовок у архива выше — намеренно ПРЕЖНЕЙ версии: у людей уже лежат файлы, собранные
# до появления ключей и стратегий, и обновление пакета не имеет права превратить их в
# нечитаемые. Проверка отдельной строкой, чтобы отказ читался как «сломали старые архивы»,
# а не как «сломалось восстановление вообще».
check "архив прежнего формата (1) по-прежнему принимается" "true" "$(printf '%s' "$out" | jget ok)"

# ---- формат 2: ключи туннелей, стратегии обхода и именованные подписки ------------
# Проверяется методом целиком: присланный архив → файлы на диске и поля в uci. Каталоги
# перед этим сносятся, иначе «восстановлено» было бы не отличить от «лежало и раньше».
rm -f "$T/var/backup.in"
rm -rf "$XSTEER_DIR" "$T/etc/steer-zapret" "$T/etc/subs"
: > "$T/uci.store"
: > "$T/steer.log"
out="$(printf '%s\n' \
  'splify2-backup 2' \
  '[spec]' \
  '{"schema":1,"outputs":{},"channels":[]}' \
  '[xsteer home]' \
  '[Interface]' \
  'PrivateKey = 6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=' \
  'Address = 10.77.0.5/24' \
  '' \
  '[Peer]' \
  'PublicKey = QYkH5bWOsEOCgIMldHPATSG7yvNyJ8st7o/HMelWKxs=' \
  'Endpoint = 198.51.100.9:8443' \
  '[zapret yt]' \
  '#v1' \
  '--filter-tcp=443' \
  '[sub work]' \
  'vless://k2@h2:443#second' \
  '[options]' \
  'sub_title=Моя панель' \
  'zm_fix=0' \
  'list_shrink_factor=4' \
  'geo_url=https://example.net/trace' \
  'sub_work.url=https://panel.example.net/sub/2' \
  'sub_work.kind=url' | backup_put)"
check "архив нового формата принимается" "true" "$(printf '%s' "$out" | jget ok)"
check "приватный ключ туннеля лёг на место дословно" "yes" \
      "$(grep -qx 'PrivateKey = 6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=' "$XSTEER_DIR/home.conf" &&
         grep -qx '\[Peer\]' "$XSTEER_DIR/home.conf" && echo yes || echo no)"
# Файл с приватным ключом не читается всеми: он попадает в каталог, который движок держит
# закрытым, и восстановление не имеет права раскрыть его шире, чем создало бы само.
check "восстановленный ключ закрыт от чужих глаз" "600" \
      "$(stat -c %a "$XSTEER_DIR/home.conf" 2>/dev/null)"
check "стратегия обхода лежит вместе со своей отметкой" "yes" \
      "$(head -1 "$T/etc/steer-zapret/yt.opts" | grep -qx '#v1' &&
         grep -qx -- '--filter-tcp=443' "$T/etc/steer-zapret/yt.opts" && echo yes || echo no)"
check "именованная подписка легла своим файлом" "yes" \
      "$(grep -qx 'vless://k2@h2:443#second' "$T/etc/subs/work.txt" && echo yes || echo no)"
check "ссылка именованной подписки легла в свою секцию uci" "https://panel.example.net/sub/2;url;subscription" \
      "$(uci_get splify2.sub_work.url);$(uci_get splify2.sub_work.kind);$(uci_get splify2.sub_work)"
check "остальные поля uci восстановлены, а не только три прежних" "Моя панель;0;4;https://example.net/trace" \
      "$(uci_get splify2.main.sub_title);$(uci_get splify2.main.zm_fix);$(uci_get splify2.main.list_shrink_factor);$(uci_get splify2.main.geo_url)"
check "в ответе сказано, что именно восстановлено" "1;1;1" \
      "$(printf '%s' "$out" | jget xsteer);$(printf '%s' "$out" | jget zapret);$(printf '%s' "$out" | jget subs)"

# Выход, ссылающийся на ИМЕНОВАННУЮ подписку, отвергался проверкой путей: она знала только
# /etc/steer/sub.txt и каталог списков. То есть архив роутера с двумя подписками нельзя было
# вернуть на этот же роутер — а именно за этим архив и нужен.
out="$(printf '%s\n' 'splify2-backup 2' '[spec]' \
  "{\"schema\":1,\"outputs\":{\"vpn\":{\"kind\":\"vless\",\"sub_file\":\"$T/etc/subs/work.txt\"}},\"channels\":[]}" |
  backup_put)"
check "выход на именованную подписку не считается путём наружу" "true" "$(printf '%s' "$out" | jget ok)"

# Дальше — отказы. Каталог с ключами и файл ключей nfqws попадают в руки root: первый читает
# движок, каждая строка второго становится ОТДЕЛЬНЫМ аргументом обработчика обхода. Принять
# туда что угодно из присланного файла нельзя.
out="$(printf '%s\n' 'splify2-backup 2' '[xsteer home]' '[Interface]' 'PrivateKey = k' \
  'ключ = значение; reboot' | backup_put)"
check "чужая строка в настройке туннеля отвергает файл" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'туннел' && echo yes || echo no)"

out="$(printf '%s\n' 'splify2-backup 2' '[xsteer home]' '[Interface]' 'Address = 10.77.0.5/24' | backup_put)"
check "настройка туннеля без приватного ключа отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 2' '[zapret yt]' '#v1' '/bin/sh' | backup_put)"
check "строка не из ключей nfqws отвергает стратегию" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'nfqws' && echo yes || echo no)"

out="$(printf '%s\n' 'splify2-backup 2' '[options]' 'geo_url=https://x/$(reboot)' | backup_put)"
check "подстановка в адресе измерителя отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 2' '[options]' 'zm_fix=да' | backup_put)"
check "нечисловое значение выключателя отвергается" "false" "$(printf '%s' "$out" | jget ok)"

out="$(printf '%s\n' 'splify2-backup 2' '[sub work]' 'http://example.org/list' | backup_put)"
check "именованная подписка не из vless:// отвергается" "false" "$(printf '%s' "$out" | jget ok)"

# Пустой раздел стратегии создал бы файл ключей без ключей: обработчик обхода на таком
# выходе поднимается и не обходит ничего, а канал при этом работает — то есть человек видит
# «включено» на выключенном обходе.
out="$(printf '%s\n' 'splify2-backup 2' '[zapret yt]' | backup_put)"
check "пустой раздел стратегии отвергается" "false" "$(printf '%s' "$out" | jget ok)"

# Восстановление продолжается там, где остановились: следующие проверки этого раздела ждут
# спеку и подписку на месте.
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"

# Отказ компилятора не выдаётся за успех, и в ответе сказано, что списки уже восстановлены:
# порядок записи (списки и подписка раньше спеки) продиктован тем, что движок читает их при
# dry-run, и умалчивать об этом было бы нечестно.
: > "$T/steer.log"
printf '%s\n' 'splify2-backup 1' '[spec]' '{"schema":1,"outputs":{},"channels":[]}' > "$T/doc.txt"
out="$(STEER_RC=1 STEER_ERR='cannot read a channel list' rpcd backup_put "$(backup_req < "$T/doc.txt")")"
check "отказ компилятора не выдаётся за восстановление" "false" "$(printf '%s' "$out" | jget ok)"
check "в отказе сказано, что списки и подписка уже восстановлены" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'уже восстановлены' && echo yes || echo no)"

# Архив, собранный экспортом, обязан приниматься импортом. Круг замкнут: разойдись эти два
# конца — бекап остался бы файлом, который некуда вернуть.
: > "$T/steer.log"
backup_doc > "$T/roundtrip.txt"
out="$(rpcd backup_put "$(backup_req < "$T/roundtrip.txt")")"
check "свой же архив принимается обратно (круг замкнут)" "true" "$(printf '%s' "$out" | jget ok)"

# ---- бэкенд знает оба менеджера пакетов ------------------------------------------
# Установщик ставит .ipk через opkg на OpenWrt 23.05, и бэкенд обязан уметь то же:
# иначе карточка движка показывает пустую версию, а «Установить» возвращает пустую
# ошибку (apk нет, rc 127, вывод пуст).
check "бэкенд определяет менеджер пакетов" "yes" \
      "$(grep -q 'elif command -v opkg' "$SCRIPT" && echo yes || echo no)"
check "версия пакета читается обоими способами" "yes" \
      "$(rpcd_src | grep -q 'opkg list-installed' && echo yes || echo no)"
pkg_src="$(grep -l '^pkg_install()' $RPCD_ALL | head -1)"
check "установка идёт через обёртку, а не через apk напрямую" "0" \
      "$(sed -n '/^pkg_install()/,$p' "$pkg_src" | grep -c 'apk add\|apk del')"
check "имена файлов пакетов зависят от менеджера" "yes" \
      "$(rpcd_src | grep -q 'pkg_ext)' && rpcd_src | grep -q 'pkg_noarch)' && echo yes || echo no)"

# ---- заголовки об устройстве чистит ДВИЖОК ---------------------------------------
#
# Раньше здесь стояла проверка под busybox: `tr -cd '[:print:]'` у coreutils работает, а у
# busybox НЕТ — он классов не знает и разбирает их как обычный набор символов, из-за чего
# «TP-Link Archer C6U v1» уезжал в панель строкой «inrr». Проверка на машине разработчика
# этого не видела: на GNU tr обе строки проходят целиком.
#
# Теперь чистка живёт в C (steer/src/ext/subfetch.c, hdr_clean) и проверяется в
# steer/tests/subfetchmatch.c, где этой ловушки нет по построению — байты сравниваются
# напрямую, а не через чужую реализацию `tr`. Здесь остаётся убедиться, что своей чистки в
# объекте не осталось: вторая реализация вернула бы и ловушку.
check "чистки заголовков в объекте больше нет" "0" "$(grep -c '^hdr_clean()' "$SCRIPT")"
check "и заголовков устройства объект не собирает" "0" \
      "$(grep -c 'x-device-model\|x-ver-os' "$SCRIPT")"

# ---- откуда качать списки и обновления (splify2#15) --------------------------------
# Обход по хостам самого GitHub спасает установку, но списки решает не лучшим образом:
# contents API — лишний запрос, а при исчерпанном лимите приезжает архив ветки целиком ради
# одного файла. Поэтому у человека есть выбор: ходить сразу через туннель. Здесь проверяется
# не карточка, а её опора — что выбор доезжает до uci тем значением, которое понимает
# скачивание, и что мусор отвергается ДО записи.
#
# uci на время этих проверок настоящий (файловый): общая заглушка отвечает отказом на всё, и
# на ней круг «записал — прочитал» проверить нечем.
cp "$T/bin/uci" "$T/bin/uci.stub"
cat > "$T/bin/uci" <<'STUB'
#!/bin/sh
# Ровно то, чем пользуется скрипт: get/set/delete/commit по ключу вида a.b.c.
store="$SANDBOX/uci.store"
[ -f "$store" ] || : > "$store"
q=0; [ "${1:-}" = "-q" ] && { q=1; shift; }
cmd="${1:-}"; arg="${2:-}"
case "$cmd" in
    get)
        v="$(grep "^$arg=" "$store" | tail -1)"
        [ -n "$v" ] || exit 1
        printf '%s\n' "${v#*=}"
        ;;
    set)
        key="${arg%%=*}"; val="${arg#*=}"
        [ "$key" = "$val" ] && val=""
        grep -v "^$key=" "$store" > "$store.new" 2>/dev/null || : > "$store.new"
        printf '%s=%s\n' "$key" "$val" >> "$store.new"
        mv "$store.new" "$store"
        ;;
    delete)
        grep -v "^$arg=" "$store" > "$store.new" 2>/dev/null || : > "$store.new"
        mv "$store.new" "$store"
        ;;
    commit) ;;
    *) exit 1 ;;
esac
exit 0
STUB
chmod +x "$T/bin/uci"
rm -f "$T/uci.store"

out="$(rpcd fetch_mode)"
check "по умолчанию туннель не трогается" "off" "$(printf '%s' "$out" | jget mode)"
check "имя выхода отдаётся полем, даже когда его нет" "" "$(printf '%s' "$out" | jget out)"

out="$(rpcd fetch_mode_set '{"mode":"always"}')"
check "выбор принят" "true;always" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget mode)"
check "и записан именно тем значением, которое читает скачивание" "always" \
      "$(grep '^splify2.main.fetch_via_tunnel=' "$T/uci.store" | tail -1 | cut -d= -f2)"
check "прочитан обратно" "always" "$(rpcd fetch_mode | jget mode)"

out="$(rpcd fetch_mode_set '{"mode":"через туннель"}')"
check "чужое значение отвергается" "false" "$(printf '%s' "$out" | jget ok)"
check "в отказе названы допустимые" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'always или off' && echo yes || echo no)"
check "и в uci ничего не изменилось" "always" \
      "$(grep '^splify2.main.fetch_via_tunnel=' "$T/uci.store" | tail -1 | cut -d= -f2)"

out="$(rpcd fetch_mode_set '{"mode":"off"}')"
check "выключается обратно" "off" "$(rpcd fetch_mode | jget mode)"

# Копией, а не переносом. Ниже по файлу общая заглушка восстанавливается ещё дважды
# (`cp "$T/bin/uci.stub" ...`), и перенос уносил образец — восстановление молча падало в
# запасную ветку «uci отвечает отказом на всё». Проверки, писавшие после этого в uci, шли
# против команды, которая не умеет ничего: зелёными они были не по существу.
cp "$T/bin/uci.stub" "$T/bin/uci"

# ---- фикс Zapret Manager: только сам роутер, и ничего в правилах ------------------
# Zapret Manager ставится и обновляется с GitHub, а у аудитории splify2 GitHub закрыт.
# Собственные обращения роутера уводятся в туннель сами — и ТОЛЬКО они: у устройств сети свои
# средства обхода, и уводить их трафик за них никто не просил. Отсюда метка в цепочке
# `output`: туда попадает только то, что роутер отправил сам.
#
# В 1.2.3 это было правилом в спеке, и оба свойства нарушались разом: канал касался клиентов
# и висел у человека в правилах. Стенд сторожит, чтобы так больше не было.
ZM_LIST_FIXTURE="$T/lists/zm-github.lst"
mkdir -p "$T/lists"
printf '# комментарий\n140.82.112.0/20\n185.199.108.0/22\n' > "$ZM_LIST_FIXTURE"

SPEC_ONE='{"schema":1,"outputs":{"direct":{"kind":"direct"},"vl":{"kind":"vless"}},"channels":[]}'
printf '%s' "$SPEC_ONE" > "$T/etc/spec.json"
: > "$T/nft.log"
ZM_LIST="$ZM_LIST_FIXTURE" rpcd apply >/dev/null 2>&1

check "спека не правится: правил у человека не прибавилось" "$SPEC_ONE" "$(cat "$T/etc/spec.json")"
check "метка ставится в цепочке output — сеть за роутером не затронута" "yes" \
      "$(grep -q 'hook output' "$T/nft.log" && echo yes || echo no)"
check "и только там: цепочек forward или prerouting не заводим" "" \
      "$(grep -c 'hook forward\|hook prerouting' "$T/nft.log" | sed 's/^0$//')"
check "адреса из списка попали в набор" "yes" \
      "$(grep -q '140.82.112.0/20' "$T/nft.log" && echo yes || echo no)"
check "комментарии из списка в набор не попали" "" \
      "$(grep -c 'комментарий' "$T/nft.log" | sed 's/^0$//')"
check "метка выхода взята у движка, а не выдумана" "yes" \
      "$(grep -q '0x00100000' "$T/nft.log" && echo yes || echo no)"

# Выключено человеком — таблица снимается, а не остаётся висеть.
: > "$T/nft.log"
cat > "$T/bin/uci" <<'STUB'
#!/bin/sh
key=""
for a in "$@"; do key="$a"; done
case "$key" in splify2.main.zm_fix) echo 0 ;; *) exit 1 ;; esac
STUB
chmod +x "$T/bin/uci"
ZM_LIST="$ZM_LIST_FIXTURE" rpcd apply >/dev/null 2>&1
check "выключенный фикс снимает таблицу" "yes" \
      "$(grep -q 'delete table inet splify2_zm' "$T/nft.log" && echo yes || echo no)"
check "и ничего не собирает" "" \
      "$(grep -c 'hook output' "$T/nft.log" | sed 's/^0$//')"
cp "$T/bin/uci.stub" "$T/bin/uci" 2>/dev/null || printf '#!/bin/sh\nexit 1\n' > "$T/bin/uci"
chmod +x "$T/bin/uci"

# Наследство 1.2.3: канал, дописанный прошлой версией, убирается из спеки.
SPEC_OLD='{"schema":1,"outputs":{"direct":{"kind":"direct"},"vl":{"kind":"vless"}},"channels":[{"name":"zm_github","match":{"prefixes_files":["/etc/steer/lists/zm-github.lst"]},"out":"vl"},{"name":"my","match":{"prefixes_files":["/etc/steer/lists/a.lst"]},"out":"vl"}]}'
printf '%s' "$SPEC_OLD" > "$T/etc/spec.json"
ZM_LIST="$ZM_LIST_FIXTURE" rpcd apply >/dev/null 2>&1
check "канал от 1.2.3 убран из правил" "my" \
      "$(python3 -c 'import json,sys
try: d = json.load(open(sys.argv[1]))
except Exception: print("НЕ JSON"); raise SystemExit
print(" ".join(c["name"] for c in d.get("channels", [])))' "$T/etc/spec.json")"

# ---- переключатель фикса Zapret Manager --------------------------------------------
# Умолчание — включено: фикс нужен именно тем, кто ещё ничего не настроил и до GitHub не
# дошёл. Выключенным по умолчанию он не помог бы никому — кто про него знает, тот и правило
# заведёт сам.
cp "$T/bin/uci.stub" "$T/bin/uci" 2>/dev/null || printf '#!/bin/sh\nexit 1\n' > "$T/bin/uci"
chmod +x "$T/bin/uci"
check "по умолчанию фикс включён" "true" "$(rpcd zm_fix | jget on)"
check "имя правила названо — интерфейсу есть что показать" "zm_github" "$(rpcd zm_fix | jget channel)"
out="$(rpcd zm_fix_set '{"on":"мусор"}')"
check "чужое значение отвергается" "false" "$(printf '%s' "$out" | jget ok)"
# ---- DNS over HTTPS -----------------------------------------------------------------
#
# Каталог резолверов и запись настройки проверены отдельно (tests/dohmatch.sh); здесь — то,
# что принадлежит объекту: отдаётся ли вкладке всё нужное ОДНИМ вызовом и собирается ли
# правило «через туннель».
mkdir -p "$T/etc" "$T/zapret"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/initd-doh"; chmod +x "$T/bin/initd-doh"
zapret_initd_stub
printf '#!/bin/sh\nexit 0\n' > "$T/bin/zapret-test"; chmod +x "$T/bin/zapret-test"
printf "config https-dns-proxy\n\toption resolver_url 'https://dns.comss.one/dns-query'\n" \
    > "$T/etc/config-doh"

out="$(rpcd doh_state)"
check "состояние DoH — один вызов на всё" "true" "$(printf '%s' "$out" | jget installed)"
check "выбранный резолвер узнан по ссылке" "comss" "$(printf '%s' "$out" | jget active)"
check "каталог резолверов отдан вместе с состоянием" "yes" \
      "$(printf '%s' "$out" | grep -q '"providers"' && echo yes || echo no)"
# Пункт «по умолчанию» несёт ДВЕ ссылки, и активным он считается только по обеим сразу:
# сравнение по одной сделало бы его неотличимым от «Cloudflare».
check "пункт с двумя резолверами есть в каталоге" "yes" \
      "$(printf '%s' "$out" | grep -q 'Cloudflare + Google' && echo yes || echo no)"

out="$(rpcd doh_set '{"provider":"нет такого"}')"
check "неизвестный резолвер отвергается" "false" "$(printf '%s' "$out" | jget ok)"

: > "$T/nft.log"
out="$(rpcd doh_tunnel_set '{"on":"мусор"}')"
check "чужое значение переключателя отвергается" "false" "$(printf '%s' "$out" | jget ok)"

# ---- обход DPI ------------------------------------------------------------------------
# Отсутствие пакета — не поломка, а состояние, и объект обязан отвечать им, а не отказом:
# вкладка на это состояние показывает кнопку установки.
out="$(rpcd zapret_state)"
check "обход не установлен — это ответ, а не ошибка" "false" \
      "$(printf '%s' "$out" | jget installed)"
check "и число стратегий при этом ноль" "0" "$(printf '%s' "$out" | jget strategies)"

# Архитектура пакета обхода — из того же шва, что и архитектура пакета движка
# (OPENWRT_RELEASE), а не из литерального /etc/openwrt_release. Диспетчер объявляет шов
# ровно для этого («по второму выбирается архитектура пакета»), и второй читатель, ходящий
# мимо него, означает две вещи сразу: установку обхода нечем проверить стендом, и на роутере
# два места объекта берут одно и то же число разными путями.
#
# Проверяется по СЛЕДСТВИЮ — по тому, попала ли архитектура в ссылку на релиз: имя файла в
# нём собирается из неё, и неверная архитектура выглядит как «релиза нет», то есть виной
# издателя.
rm -f "$T/curl.log" "$T/wget.log"
out="$(rpcd zapret_install)"
check "архитектура пакета обхода берётся из шва" "yes" \
      "$(cat "$T/curl.log" "$T/wget.log" 2>/dev/null | grep -q 'zapret_v.*_aarch64_cortex-a53\.zip' && echo yes || echo no)"
# И наоборот: без файла описания системы архитектура не выдумывается, а установка честно
# отказывается — тот же ответ, что у steer_versions выше (I-050).
out="$(OPENWRT_RELEASE_FIXTURE="$T/etc/nonexistent" rpcd zapret_install)"
check "без openwrt_release установка обхода не выдумывает архитектуру" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'не определилась архитектура' && echo yes || echo no)"

out="$(rpcd zapret_test_start '{"scope":"all"}')"
check "проверка без обхода не запускается" "false" "$(printf '%s' "$out" | jget ok)"

# Запрос от rpcd приходит БЕЗ перевода строки: `read` возвращает ненулевой код, уже заполнив
# переменную, и `|| input='{}'` затирал набор пустым — любая проверка шла по всем 58 (снято с
# роутера владельца). Набор обязан доехать и в такой форме.
out="$(rpcd_raw zapret_test_start '{"scope":"one:nope"}')"
check "набор без перевода строки не теряется" "yes" \
      "$(printf '%s' "$out" | grep -q 'nope' && echo yes || echo no)"
out="$(rpcd zapret_test_start '{"scope":"чужой"}')"
check "чужой набор отвергается" "false" "$(printf '%s' "$out" | jget ok)"
check "и отказ называет допустимые наборы, включая одиночный" "yes" \
      "$(printf '%s' "$out" | grep -q 'one:' && echo yes || echo no)"

# Результатов ещё нет — метод обязан отдать РАЗБИРАЕМЫЙ JSON, а не пустоту: интерфейс на
# пустом ответе показал бы «нет данных» вместо «проверка не запускалась».
out="$(rpcd zapret_results)"
check "пустые результаты — всё равно JSON" "0" "$(printf '%s' "$out" | jget at)"
check "и с пустым списком" "yes" \
      "$(printf '%s' "$out" | grep -q '"results":\[\]' && echo yes || echo no)"

# Ход проверки, когда её не было. Тот же довод: idle — это ответ.
out="$(rpcd zapret_test)"
check "ход проверки без проверки — idle" "idle" "$(printf '%s' "$out" | jget state)"
check "и процесс не считается живым" "false" "$(printf '%s' "$out" | jget running)"

# Стратегии: каталог есть, обход не установлен. Список обязан отдаваться всё равно — человек
# должен видеть, что будет доступно после установки.
mkdir -p "$T/zapret"
printf '#v1\n--filter-tcp=443\n#Yv01\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
out="$(rpcd zapret_strategies)"
check "стратегии перечисляются" "yes" \
      "$(printf '%s' "$out" | grep -q '"name":"Yv01"' && echo yes || echo no)"
check "семейство считает бэкенд, а не интерфейс" "yes" \
      "$(printf '%s' "$out" | grep -q '"family":"yv"' && echo yes || echo no)"

out="$(rpcd zapret_apply '{"name":"v1"}')"
check "применение без установленного обхода отвергается" "false" \
      "$(printf '%s' "$out" | jget ok)"

# Выключатель обхода всего роутера («как мне отключить стратегию на весь роутер?» — владелец).
# Выключается служба, стратегия остаётся отмеченной; без пакета выключать нечего.
out="$(rpcd zapret_enable '{"on":false}')"
check "выключатель без установленного обхода — отказ" "false" "$(printf '%s' "$out" | jget ok)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_enable '{"on":"мусор"}')"
check "чужое значение выключателя отвергается" "false" "$(printf '%s' "$out" | jget ok)"
"$T/bin/initd-zapret" enable
: > "$T/initd-zapret.log"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_enable '{"on":false}')"
check "выключение принято" "true" "$(printf '%s' "$out" | jget ok)"
check "и ответ говорит, что выключено" "false" "$(printf '%s' "$out" | jget enabled)"
check "служба снята с автозапуска и остановлена, в этом порядке" "disable stop" \
      "$(tr '\n' ' ' < "$T/initd-zapret.log" | sed 's/ $//')"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "состояние показывает выключенный обход" "false" "$(printf '%s' "$out" | jget enabled)"
# Применить стратегию выключенному обходу — значит включить его: иначе «Применить» отвечает
# успехом, а стратегия не действует.
printf "config zapret 'config'\n\toption NFQWS_OPT '\n--filter-tcp=443\n'\n" > "$T/etc/config-zapret"
: > "$T/initd-zapret.log"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_apply '{"name":"v1"}')"
check "стратегия выключенному обходу применяется" "true" "$(printf '%s' "$out" | jget ok)"
check "и обход при этом включается" "yes" \
      "$(grep -qx enable "$T/initd-zapret.log" && echo yes || echo no)"
: > "$T/initd-zapret.log"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_enable '{"on":true}')"
check "включение принято" "true" "$(printf '%s' "$out" | jget enabled)"
check "служба поставлена на автозапуск и запущена" "enable start" \
      "$(tr '\n' ' ' < "$T/initd-zapret.log" | sed 's/ $//')"

# Игровой фильтр (Gv): состояние в zapret_state, правка одним методом, выхода у него нет.
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "игрового блока нет — gv пуст" "" "$(printf '%s' "$out" | jget game.gv)"
check "список подделок отдаётся с признаком файла" "yes" \
      "$(printf '%s' "$out" | grep -q '"name":"stun2.bin","present":' && echo yes || echo no)"
out="$(rpcd zapret_game_set '{"gv":2}')"
check "игровой фильтр без обхода — отказ" "false" "$(printf '%s' "$out" | jget ok)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_game_set '{"gv":9}')"
check "чужой номер отвергается" "false" "$(printf '%s' "$out" | jget ok)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_game_set '{"fake":"stun2.bin"}')"
check "подделка без блока — отказ с причиной" "yes" \
      "$(printf '%s' "$out" | grep -q 'блок не стоит' && echo yes || echo no)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_game_set '{"gv":3}')"
check "Gv3 поставлен" "3" "$(printf '%s' "$out" | jget gv)"
check "в конфигурации метка Gv3" "1" "$(grep -c '^#Gv3$' "$T/etc/config-zapret")"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "состояние видит Gv3" "3" "$(printf '%s' "$out" | jget game.gv)"
check "подделка по умолчанию" "stun.bin" "$(printf '%s' "$out" | jget game.fake)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" ZP_GV_XTREME_FILE="$T/zapret/GvXtreme" rpcd zapret_game_set '{"xtreme":true}')"
check "Xtreme включён" "true" "$(printf '%s' "$out" | jget xtreme)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" ZP_GV_XTREME_FILE="$T/zapret/GvXtreme" rpcd zapret_game_set '{"gv":0}')"
check "снятие вместе с Xtreme" "" "$(printf '%s' "$out" | jget gv)"
check "и Xtreme снят" "false" "$(printf '%s' "$out" | jget xtreme)"
check "метки не осталось" "0" "$(grep -c '^#Gv' "$T/etc/config-zapret")"

# Одна стратегия целиком: её ключи, по строке на ключ, без служебного заголовка «#Имя».
# Интерфейс показывает их человеку, чтобы тот видел, ЧТО применяет.
printf '#v1\n--filter-tcp=443\n--dpi-desync=fake\n\n#Yv01\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
out="$(rpcd zapret_strategy '{"name":"v1"}')"
check "ключи стратегии отдаются списком" "yes" \
      "$(printf '%s' "$out" | grep -q '"opts":\["--filter-tcp=443","--dpi-desync=fake"\]' && echo yes || echo no)"
check "семейство стратегии названо" "v" "$(printf '%s' "$out" | jget family)"
out="$(rpcd zapret_strategy '{"name":"нет такой"}')"
check "неизвестная стратегия — отказ" "false" "$(printf '%s' "$out" | jget ok)"

# Одиночная проверка: набор «one:имя» принимается, если стратегия есть в каталоге, и
# отвергается по имени, а не как «чужой набор», если нет.
out="$(rpcd zapret_test_start '{"scope":"one:v1"}')"
check "одиночный набор доходит до проверки установки" "yes" \
      "$(printf '%s' "$out" | grep -q 'не установлен' && echo yes || echo no)"
out="$(rpcd zapret_test_start '{"scope":"one:v9"}')"
check "одиночный набор с чужим именем отвергается по имени" "yes" \
      "$(printf '%s' "$out" | grep -q 'нет такой стратегии' && echo yes || echo no)"

# ---- автоподбор стратегии ---------------------------------------------------------------
#
# Правило выбора живёт в zapret.sh и проверяется autoselmatch.sh целиком. Здесь — только
# граница «объект rpcd ↔ библиотека и команда»: ровно то место, где ломались все прежние
# находки этой вкладки (метод звал zp_drifted с /dev/null, метод отказывался применять слой).
#
# Проверяется поэтому не рейтинг, а три вещи: что ответ разбирается и при пустом состоянии,
# что запуск действительно зовёт КОМАНДУ ПОДБОРА (а не проверку) и делает это с --apply, и
# что невозможный откат отказывает громко.
printf '#!/bin/sh\necho "$@" >> "%s/autosel.log"\nexit 0\n' "$T" > "$T/bin/zapret-autoselect"
chmod +x "$T/bin/zapret-autoselect"
rm -f "$T/autosel.log" "$T/zapret/autoselect" "$T/zapret/previous.opts" "$T/uci.db"
printf '#v1\n--filter-tcp=443\n#v2\n--filter-tcp=443\n--dpi-desync=fake\n' > "$T/zapret/strategies.txt"

out="$(rpcd zapret_autoselect)"
check "автоподбор выключен по умолчанию" "false" "$(printf '%s' "$out" | jget on)"
check "и срок в днях нулевой" "0" "$(printf '%s' "$out" | jget every_days)"
check "ни разу не применяли — время ноль, а не выдумка" "0" "$(printf '%s' "$out" | jget at)"
check "откатывать нечего" "false" "$(printf '%s' "$out" | jget can_undo)"
# ОТКАЗ ТОЖЕ ОТВЕТ: без результатов проверки поле note обязано сказать, почему победителя нет.
# Пустой ответ здесь означал бы, что вкладка показывает «подбирать нечего» и там, где просто
# не запускали проверку, и там, где уже применена лучшая, — а это разные состояния.
check "и сказано, почему победителя нет" "yes" \
      "$(printf '%s' "$out" | jget note | grep -q 'проверка не проходила' && echo yes || echo no)"

# Расписание. Ноль выключает; больше 90 дней — отказ, ровно как в проверке архива, иначе
# архив умел бы то, чего не умеет интерфейс.
out="$(rpcd zapret_autoselect_set '{"days":7}')"
check "срок ставится" "7" "$(printf '%s' "$out" | jget every_days)"
out="$(rpcd zapret_autoselect)"
check "и читается обратно как включённый" "true" "$(printf '%s' "$out" | jget on)"
out="$(rpcd zapret_autoselect_set '{"days":365}')"
check "365 дней — отказ" "false" "$(printf '%s' "$out" | jget ok)"
out="$(rpcd zapret_autoselect_set '{"days":"каждый вторник"}')"
check "не число — отказ" "false" "$(printf '%s' "$out" | jget ok)"
out="$(rpcd zapret_autoselect_set '{"days":0}')"
check "ноль принимается — это «выключено»" "true" "$(printf '%s' "$out" | jget ok)"

# Запуск. Обход не установлен — отказ до всякого фона: подбирать нечего, а сказать надо.
out="$(rpcd zapret_autoselect_start '{"scope":"all"}')"
check "без обхода подбор не запускается" "false" "$(printf '%s' "$out" | jget ok)"
check "и команду не зовёт" "no" "$([ -s "$T/autosel.log" ] && echo yes || echo no)"
# Слой discord в наборах подбора отсутствует НАРОЧНО, в отличие от проверки: мерить его нечем,
# а подбор без замера — подбор наугад.
out="$(rpcd zapret_autoselect_start '{"scope":"dv"}')"
check "область dv для подбора отвергается" "false" "$(printf '%s' "$out" | jget ok)"
check "и отказ перечисляет то, что мерить есть чем" "yes" \
      "$(printf '%s' "$out" | grep -q 'all, flowseal, v или yv' && echo yes || echo no)"

out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_autoselect_start '{"scope":"v"}')"
check "с установленным обходом подбор запускается" "true" "$(printf '%s' "$out" | jget ok)"
# Ждём появления журнала: команда запускается ФОНОМ (в этом весь смысл — подбор идёт минуты,
# а у вызова ubus свой срок), поэтому файл появляется не в тот же миг. Ожидание по ФАКТУ, а
# не по времени, и с потолком — иначе стенд либо мигает, либо висит.
_w=0
while [ "$_w" -lt 40 ] && [ ! -s "$T/autosel.log" ]; do _w=$((_w + 1)); sleep 0.05; done
check "зовётся команда подбора, а не проверка" "yes" \
      "$([ -s "$T/autosel.log" ] && echo yes || echo no)"
# ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА: кнопка называется «подобрать и применить», значит --apply
# обязателен. Без него метод отвечал бы «ок», ничего не меняя, и человек считал бы, что
# стратегия подобрана.
check "и зовётся с --apply" "yes" \
      "$(grep -q -- '--apply' "$T/autosel.log" && echo yes || echo no)"
check "и с той областью, что просили" "yes" \
      "$(grep -q -- '--scope v' "$T/autosel.log" && echo yes || echo no)"

# Откат. Копии нет — отказ ГРОМКИЙ: молчаливый «ок» здесь означал бы, что человек считает,
# будто вернул как было.
out="$(rpcd zapret_autoselect_undo)"
check "откат без копии — отказ" "false" "$(printf '%s' "$out" | jget ok)"
check "и причина названа" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'откатывать нечего' && echo yes || echo no)"

# Копия есть и активная стратегия та же, что применил подбор — откат обязан пройти и вернуть
# файл байт в байт.
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/zapret/previous.opts"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v2\n--filter-tcp=443\n--dpi-desync=fake\n'\n" > "$T/etc/config-zapret"
printf 'at=%s\nby=auto\nname=v2\nok=26\ntotal=30\n' "$(date +%s)" > "$T/zapret/autoselect"
out="$(rpcd zapret_autoselect)"
check "откат доступен, когда работает применённое" "true" "$(printf '%s' "$out" | jget can_undo)"
out="$(rpcd zapret_autoselect_undo)"
check "откат прошёл" "true" "$(printf '%s' "$out" | jget ok)"
check "и вернул прежнюю стратегию" "v1" "$(printf '%s' "$out" | jget active)"
check "файл вернулся" "1" "$(grep -c '^#v1$' "$T/etc/config-zapret")"
check "и копии больше нет" "no" "$([ -e "$T/zapret/previous.opts" ] && echo yes || echo no)"

# Человек выбрал стратегию руками после подбора — откат обязан отказать, а не отменить его
# выбор: копия хранит файл целиком.
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/zapret/previous.opts"
printf 'at=%s\nby=auto\nname=v2\n' "$(date +%s)" > "$T/zapret/autoselect"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/etc/config-zapret"
out="$(rpcd zapret_autoselect)"
check "после ручного выбора откат недоступен" "false" "$(printf '%s' "$out" | jget can_undo)"
out="$(rpcd zapret_autoselect_undo)"
check "и он отказывает" "false" "$(printf '%s' "$out" | jget ok)"
check "и объясняет, что отменил бы выбор человека" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'ваш выбор' && echo yes || echo no)"

# Методы обязаны быть в перечне: метод, которого нет в list, для LuCI не существует.
# Метод, которого нет в `list`, для LuCI не существует: ubus его просто не покажет. Считаются
# ВХОЖДЕНИЯ, а не строки: перечень приезжает одним JSON.
check "автоподбор объявлен в перечне методов" "4" \
      "$(rpcd_list | grep -o '"zapret_autoselect[a-z_]*"' | sort -u | grep -c .)"

# ---- разошлась ли активная стратегия с каталогом -------------------------------------
#
# Каталог обновляется сам раз в сутки и активную стратегию НЕ подменяет (требование
# владельца) — значит расхождение с каталогом это законное состояние, и единственный способ
# о нём узнать — спросить объект. По признаку `drifted` вкладка показывает предложение
# применить стратегию заново; без него человек видит имя стратегии и не знает, что за этим
# именем в каталоге уже другие ключи.
#
# Признак проверяется здесь целиком через метод, а не через zp_drifted в zapretmatch.sh,
# потому что ломался он именно на стыке: библиотека сравнивала правильно, а объект звал её
# с /dev/null вместо применённого тела.
printf '#v1\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/etc/config-zapret"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "активная стратегия названа" "v1" "$(printf '%s' "$out" | jget active)"
check "совпавшая с каталогом не считается разошедшейся" "false" \
      "$(printf '%s' "$out" | jget drifted)"

# Каталог обновился, применённое осталось прежним — это и есть расхождение.
printf '#v1\n--filter-tcp=443\n--dpi-desync=fake\n' > "$T/zapret/strategies.txt"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "изменившаяся в каталоге считается разошедшейся" "true" \
      "$(printf '%s' "$out" | jget drifted)"

# Стратегии в каталоге нет вовсе (её переименовали у автора) — сравнивать не с чем, и
# выдавать это за расхождение нельзя: расхождение зовёт «применить заново», а применять
# нечего.
printf '#v2\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "пропавшая из каталога не выдаётся за расхождение" "false" \
      "$(printf '%s' "$out" | jget drifted)"


# ---- слой применяется как слой, а не как основная стратегия ---------------------------
#
# Значение `option NFQWS_OPT` — пачка блоков: слой YouTube, основная, подмена блока
# discord.media внутри неё, игровой в хвосте. Слои не конкурируют с основной (у них разные
# hostlist'ы), и применять их надо ВСТАВКОЙ в уже собранное значение.
#
# Проверяется здесь самое дорогое: что применение слоя НЕ подменяет основную. До запуска 65
# каталог был плоским списком, `zapret_apply {"name":"Yv01"}` уходил в zp_apply_global, тот
# срезал всё от открывающей кавычки до конца файла и писал один блок — Google начинал
# работать, а весь остальной трафик тихо оставался без обхода.
printf '#v1\n--filter-tcp=443\n--hostlist-exclude=/opt/zapret/ipset/zapret-hosts-user-exclude.txt\n\n#Yv01\n--filter-tcp=443\n--hostlist=/opt/zapret/ipset/zapret-hosts-google.txt\n--ip-id=zero\n\n#Dv2\n--filter-tcp=2053,2083,2087,2096,8443\n--hostlist-domains=discord.media\n--dpi-desync=fake,multisplit\n' \
    > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/etc/config-zapret"

out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_apply '{"name":"v1"}')"
check "основная применена" "true" "$(printf '%s' "$out" | jget ok)"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_apply '{"name":"Yv01"}')"
check "слой YouTube применён" "true" "$(printf '%s' "$out" | jget ok)"
check "и ответ называет его слоем, а не стратегией" "youtube" "$(printf '%s' "$out" | jget layer)"
# САМОЕ ГЛАВНОЕ: основная осталась на месте.
check "основная НЕ подменена слоем" "v1" "$(printf '%s' "$out" | jget active)"
check "и в конфигурации она есть" "1" "$(grep -c '^#v1$' "$T/etc/config-zapret")"
check "а слой стоит рядом" "1" "$(grep -c '^#Yv01$' "$T/etc/config-zapret")"

out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "состояние показывает слой YouTube" "01" "$(printf '%s' "$out" | jget layers.youtube)"
check "и активной по-прежнему основную" "v1" "$(printf '%s' "$out" | jget active)"

# Слой к выходу kind=zapret не применяется: у выхода своя стратегия целиком, и «слой поверх»
# там означал бы файл ключей, собранный из двух источников.
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_apply '{"name":"Yv01","out":"zt"}')"
check "слой к выходу — отказ" "false" "$(printf '%s' "$out" | jget ok)"
check "и причина названа" "yes" \
      "$(printf '%s' "$out" | grep -q 'ко всему роутеру' && echo yes || echo no)"

# Слой, которому не к чему прикрепиться, отвергается С ПРИЧИНОЙ, а не молча: у стратегии v1
# нет блока портов discord.media, подменять нечего.
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_apply '{"name":"Dv2"}')"
check "слой discord без своего блока — отказ" "false" "$(printf '%s' "$out" | jget ok)"
check "и сказано, чего не хватает" "yes" \
      "$(printf '%s' "$out" | grep -q 'discord.media' && echo yes || echo no)"

# Игровой блок дописан ПОВЕРХ стратегии соседней функцией, в каталоге его нет и быть не
# может (zp_block обрывается на следующем `#`). Без оговорки про него каждый роутер с
# игровым фильтром выглядел бы разошедшимся всегда.
printf '#v1\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n#Gv3\n--new\n--filter-udp=1024-65535\n'\n" \
    > "$T/etc/config-zapret"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "своя игровая стратегия не выдаётся за расхождение" "false" \
      "$(printf '%s' "$out" | jget drifted)"
# ...но и не закрывает глаза на настоящее расхождение: блок отрезается, остальное сверяется.
printf '#v1\n--filter-tcp=80\n' > "$T/zapret/strategies.txt"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "игровой блок не прячет расхождение в самой стратегии" "true" \
      "$(printf '%s' "$out" | jget drifted)"

# Метка `#Gv0` — не дописанный блок, а отметка встроенного игрового фильтра стратегии
# general, и стоит она ПЕРЕД её собственным хвостом. Хвост из сравнения выпадает, поэтому
# здесь совпадением считается совпадение начала.
printf '#general\n--filter-tcp=443\n--new\n--filter-tcp=2802\n--dpi-desync=multisplit\n' \
    > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#general\n--filter-tcp=443\n#Gv0\n--new\n--filter-tcp=2802\n--dpi-desync=multisplit\n'\n" \
    > "$T/etc/config-zapret"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "встроенный фильтр Flowseal не выдаётся за расхождение" "false" \
      "$(printf '%s' "$out" | jget drifted)"
printf '#general\n--filter-tcp=80\n--new\n--filter-tcp=2802\n--dpi-desync=multisplit\n' \
    > "$T/zapret/strategies.txt"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "и расхождение до метки видно" "true" "$(printf '%s' "$out" | jget drifted)"

# Каталога нет вовсе — обычное состояние свежей установки, и оно не «расхождение».
rm -f "$T/zapret/strategies.txt"
out="$(ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd zapret_state)"
check "пустой каталог не выдаётся за расхождение" "false" \
      "$(printf '%s' "$out" | jget drifted)"
printf '#v1\n--filter-tcp=443\n--dpi-desync=fake\n\n#Yv01\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"

# ---- экземпляры обработчиков пересобираются, а не ждут перезагрузки роутера -----------
#
# `steer apply` ставит правила, но экземпляров procd НЕ ЗАВОДИТ — их заводит init-скрипт,
# разбирая спеку. Значит новый выход kind=zapret после «Применить» остался бы без
# обработчика: стратегия выбрана, правило очереди стоит, разбирать пакеты некому. И при
# on_fail=drop (умолчание) трафик канала при этом СТОИТ, то есть «включил и интернет
# пропал» на полностью настроенном с виду выходе. Ровно та же беда уже была с выходами
# vless и обфускаторами (splicicd#20), и лечится тем же способом.
#
# `start`, а не `restart`: procd сверяет описанные экземпляры с запущенными и заводит
# разницу, не трогая остальные. Проверено на роутере — PIDы клиентов vless не изменились.
: > "$T/initd.log"
rm -f "$T/zapret-dirty" "$T/zapret-up"
SPEC_ZAP='{"schema":1,"outputs":{"direct":{"kind":"direct"},"zt":{"kind":"zapret"}},"channels":[]}'
printf '%s' "$SPEC_ZAP" > "$T/etc/spec.json"
out="$(ZAPRET_DIRTY="$T/zapret-dirty" ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd apply)"
check "apply пересобирает экземпляры обхода" "1" \
      "$(grep -c '^start$' "$T/initd.log")"
check "и говорит, что сделал" "yes" \
      "$(printf '%s' "$out" | jget output | grep -q 'обработчики пересобраны' && echo yes || echo no)"

# ---- ожидание обработчика обхода: приговор по СОСТОЯНИЮ, а не по счётчику --------------
#
# `apply` ждёт, пока procd поднимет экземпляр обработчика, и только потом решает, говорить ли
# «не поднялся». Ложная тревога здесь дороже пропущенной — по ней настраивают лишнее и
# перестают верить сообщениям, — и ровно ею оборачивался последний круг ожидания: цикл
# засыпал в четвёртый раз, а состояние после этого сна не спрашивал ни разу. Обработчик,
# поднявшийся на четвёртой секунде, объявлялся не поднявшимся, а сон при этом покупал ноль.
#
# Стенд считает не время, а ОПРОСЫ, и потому не зависит от скорости машины: заглушка движка
# «поднимает» обработчик на заданном по счёту опросе (ZAPRET_UP_AT_CALL), а счётчик обнуляет
# заглушка init-скрипта на `start`. `start` стоит ровно перед ожиданием, значит опрос №N —
# это N-й круг цикла, и никакие другие вызовы движка в счёт не попадают.
#
# Кругов при бюджете в четыре секунды должно быть ПЯТЬ: по разу перед каждым из четырёх снов
# и один раз после последнего. Пятый и есть смысл проверки — до правки его не было, и
# четвёртый сон покупал ровно ту ложную тревогу, ради избавления от которой ожидание заведено.
# Число 5 связано с бюджетом: поменяется бюджет — этот стенд обязан покраснеть и заставить
# пересчитать его вслух.
#
# Оба прогона стоят по четыре секунды настоящего сна — это цена проверки самого ожидания,
# и другой у неё нет.
: > "$T/initd.log"
rm -f "$T/zapret-up"
printf 'instances\n' > "$T/zapret-dirty"
printf '%s' "$SPEC_ZAP" > "$T/etc/spec.json"
: > "$T/steer-status.count"
out="$(ZAPRET_UP_AT_CALL=99999 ZAPRET_DIRTY="$T/zapret-dirty" ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd apply)"
check "обработчик не поднялся вовсе — об этом сказано" "yes" \
      "$(printf '%s' "$out" | jget output | grep -q 'обработчик обхода DPI не поднялся' && echo yes || echo no)"
check "и это не выдаётся за пересборку" "no" \
      "$(printf '%s' "$out" | jget output | grep -q 'обработчики пересобраны' && echo yes || echo no)"
check "состояние опрошено пять раз — по разу на каждый сон и один после последнего" "5" \
      "$(cat "$T/steer-status.count" 2>/dev/null || echo 0)"
# Повод не потерян: снять его на неподнявшемся обработчике значило бы, что следующий apply
# уже не станет пересобирать экземпляры, а выход так и останется без обработчика.
check "признак пересборки на неудаче не снят" "yes" \
      "$([ -f "$T/zapret-dirty" ] && echo yes || echo no)"

# Тот же прогон, но обработчик поднимается на ПЯТОМ опросе — то есть ровно на последней
# секунде ожидания, после четвёртого сна. Это единственный круг, которого объект не делал.
: > "$T/initd.log"
rm -f "$T/zapret-up"
printf 'instances\n' > "$T/zapret-dirty"
printf '%s' "$SPEC_ZAP" > "$T/etc/spec.json"
: > "$T/steer-status.count"
out="$(ZAPRET_UP_AT_CALL=5 ZAPRET_DIRTY="$T/zapret-dirty" ZP_NFQWS_FIXTURE="$T/bin/nfqws" rpcd apply)"
check "поднявшийся на последней секунде не объявляется мёртвым" "no" \
      "$(printf '%s' "$out" | jget output | grep -q 'обработчик обхода DPI не поднялся' && echo yes || echo no)"
check "и пересборка засчитана" "yes" \
      "$(printf '%s' "$out" | jget output | grep -q 'обработчики пересобраны' && echo yes || echo no)"
# Признак снимается только вместе с засчитанной пересборкой — иначе повод потерян, а
# обработчика нет.
check "признак пересборки снят" "no" \
      "$([ -f "$T/zapret-dirty" ] && echo yes || echo no)"
rm -f "$T/steer-status.count"

# Обхода нет вовсе — пересобирать нечего, но СКАЗАТЬ надо: трафик такого канала остановлен.
: > "$T/initd.log"
out="$(ZAPRET_DIRTY="$T/zapret-dirty" rpcd apply)"
check "без пакета zapret экземпляры не пересобираются" "0" \
      "$(grep -c '^start$' "$T/initd.log")"
check "но человеку сказано про пакет" "yes" \
      "$(printf '%s' "$out" | jget output | grep -q 'пакет zapret не установлен' && echo yes || echo no)"

# Выходов обхода в спеке нет — ни лишнего `start`, ни лишних слов.
: > "$T/initd.log"
printf '%s' '{"schema":1,"outputs":{"direct":{"kind":"direct"}},"channels":[]}' > "$T/etc/spec.json"
out="$(ZAPRET_DIRTY="$T/zapret-dirty" rpcd apply)"
check "без выходов обхода apply их не трогает" "0" \
      "$(grep -c '^start$' "$T/initd.log")"
check "и молчит о них" "no" \
      "$(printf '%s' "$out" | jget output | grep -q 'обход DPI' && echo yes || echo no)"

# ---- opkg: пустые списки пакетов не должны валить установку -------------------------
# С живого роутера: «cannot find dependency ip-full for steer», хотя пакет скачан и лежит
# рядом. У opkg зависимости локального файла ищутся в СПИСКАХ ПАКЕТОВ, а на свежей прошивке
# их нет — списки не переживают перезагрузку. На apk этого нет вовсе.
rm -f "$T/opkg.lists" "$T/opkg.log"
out="$(PM_FIXTURE=opkg rpcd steer_install '{"version":"1.2.4","extended":false}')"
check "после отказа по зависимости списки обновляются" "1" \
      "$(grep -c '^update' "$T/opkg.log")"
check "и установка повторяется" "2" "$(grep -c '^install' "$T/opkg.log")"
check "человеку сказано, что списки были пусты" "yes" \
      "$(printf '%s' "$out" | jget output | grep -q 'списки пакетов были пусты' && echo yes || echo no)"

# ---- кнопка «Обновить списки» в каталоге ---------------------------------------------
# Метод не делает работу сам, а зовёт splify2-update-lists — тот же, что ходит по
# расписанию. Проверяется здесь то, что ломается молча: числа в ответе считаются по
# отчёту прогона, а не выдумываются, и неудачный прогон не выдаётся за успех.
cat > "$T/bin/update-lists" <<'EOF'
#!/bin/sh
printf 'youtube.lst: обновлён (100 записей)\nrkn.lst: обновлён (3 записи)\nправила применены\n' >> "$REPORT"
exit 0
EOF
chmod +x "$T/bin/update-lists"
out="$(rpcd lists_update)"
check "прогон удался" "true" "$(printf '%s' "$out" | jget ok)"
check "обновлённые посчитаны по отчёту" "2" "$(printf '%s' "$out" | jget updated)"
check "строки прогона отданы интерфейсу" "yes"       "$(printf '%s' "$out" | jget lines | grep -q 'правила применены' && echo yes || echo no)"

cat > "$T/bin/update-lists" <<'EOF'
#!/bin/sh
printf 'rkn.lst: не скачался, оставлен прежний\n' >> "$REPORT"
exit 1
EOF
chmod +x "$T/bin/update-lists"
out="$(rpcd lists_update)"
check "неудача прогона не выдаётся за успех" "false" "$(printf '%s' "$out" | jget ok)"
check "неудавшиеся посчитаны" "1" "$(printf '%s' "$out" | jget failed)"

cat > "$T/bin/update-lists" <<'EOF'
#!/bin/sh
printf 'изменений нет\n' >> "$REPORT"
exit 0
EOF
chmod +x "$T/bin/update-lists"
out="$(rpcd lists_update)"
check "прогон без изменений — успех, а не отказ" "true" "$(printf '%s' "$out" | jget ok)"
check "и обновлённых в нём ноль" "0" "$(printf '%s' "$out" | jget updated)"

rm -f "$T/bin/update-lists"
out="$(rpcd lists_update)"
check "без обновлятора метод честно отказывается" "false" "$(printf '%s' "$out" | jget ok)"

check "метод объявлен в списке ubus" "yes"       "$(rpcd_list | grep -q lists_update && echo yes || echo no)"

# ---- splify2#16: не только устройства из br-lan --------------------------------------
# Человек держит роутер выходной точкой ещё и для хостов из Tailscale/ZeroTier и хочет
# применить к ним те же правила. В splify1 это был перечень интерфейсов через запятую в
# /etc/config; здесь у интерфейса не было даже перечня того, из чего выбирать: метод
# `devices` отбирает ТУННЕЛИ (кандидаты в выход), а сети клиентов не перечислял никто.
#
# Отбор здесь именно про «откуда приходят клиенты», и каждая проверка ниже — про одну
# ошибку, которую легко сделать именем: lo, порт внутри моста, wan.
#
# Какое устройство наружу — знает uci, а не имя. Фикстура ставится ЗДЕСЬ, а не в общей
# подготовке: проверки выбора «откуда качать» выше по файлу чистят хранилище uci за собой.
printf 'network.wan.device=wan\n' >> "$T/uci.store"
out="$(rpcd client_nets)"
names() { printf '%s' "$1" | python3 -c 'import json,sys
print(" ".join(d["name"] for d in json.load(sys.stdin)["nets"]))'; }
netof() { printf '%s' "$1" | python3 -c 'import json,sys
n=[d for d in json.load(sys.stdin)["nets"] if d["name"]==sys.argv[1]]
print(",".join(n[0].get("subnets") or []) if n else "НЕТ")' "$2"; }
flagof() { printf '%s' "$1" | python3 -c 'import json,sys
n=[d for d in json.load(sys.stdin)["nets"] if d["name"]==sys.argv[1]]
print(json.dumps(n[0].get(sys.argv[2])) if n else "НЕТ")' "$2" "$3"; }

check "сети клиентов перечислены по алфавиту, без lo и без портов моста (splify2#16)" \
      "br-guest br-lan tailscale0 wan ztrfyzwvfa" "$(names "$out")"
check "у моста названа его сеть, а не адрес роутера" "192.168.1.0/24" "$(netof "$out" br-lan)"
# Адрес /32 — норма для Tailscale, и выведенная сеть равна самому адресу. Прятать такое
# устройство нельзя (человек из обращения ходит именно через него), но и молчать о том, что
# из его адреса подсеть не выводится, тоже: соседей по Tailscale придётся дописать руками.
check "туннель с адресом /32 остаётся в перечне" "100.64.1.5/32" "$(netof "$out" tailscale0)"
check "мост ZeroTier — обычная сеть" "10.147.17.0/24" "$(netof "$out" ztrfyzwvfa)"
# wan назван, а не выкинут: выкинутое устройство человек ищет глазами и не находит, а
# помеченное он не выберет. Выбрать wan сетью клиентов — это увести в туннель всё, что
# роутер получает снаружи.
check "wan помечен, а не спрятан" "true" "$(flagof "$out" wan wan)"
check "домашний мост wan-ом не помечен" "false" "$(flagof "$out" br-lan wan)"
check "поднятое устройство названо поднятым" "true" "$(flagof "$out" br-lan up)"
check "опущенное — опущенным, но из перечня не исчезает" "false" "$(flagof "$out" br-guest up)"
# Устройства без адреса IPv4 (ещё не поднято) перечень отдаёт без подсетей, а не пропускает:
# выбрать его законно, сеть появится вместе с адресом.
check "у устройства без адреса подсетей нет" "" "$(netof "$out" br-guest)"
check "метод объявлен в списке ubus" "yes" "$(rpcd_list | grep -q client_nets && echo yes || echo no)"

# ---- I-161: смешанный пул не собрать, пока туннель выключен --------------------------
# Метод `devices` отвечает на «куда можно выпустить трафик» и отбирал кандидатов по
# /sys/class/net. Устройство выхода kind=vless/xsteer создаёт сам движок — вместе со своим
# процессом, а не с настройкой, — поэтому настроенная, но остановленная сейчас локация в
# перечень не попадала вовсе, и законную форму смешанного пула (устройство локации рядом с
# wg0) с экрана было не собрать. Вопрос здесь про НАСТРОЙКУ: выключенная сегодня локация
# завтра поднимется, и класть её в пул человек вправе сейчас.
cat > "$T/etc/spec.json" <<'EOF'
{ "schema": 1,
  "outputs": {
    "nl": { "kind": "vless", "sub_file": "/etc/steer/sub.txt" },
    "hub": { "kind": "xsteer", "device": "xs0" },
    "vpn": { "kind": "interface", "device": "wg0" },
    "direct": { "kind": "direct" }
  },
  "channels": [] }
EOF
out="$(rpcd devices)"
devs() { printf '%s' "$1" | python3 -c 'import json,sys
print(" ".join(d["name"] for d in json.load(sys.stdin)["devices"]))'; }
upof() { printf '%s' "$1" | python3 -c 'import json,sys
n=[d for d in json.load(sys.stdin)["devices"] if d["name"]==sys.argv[1]]
print(json.dumps(n[0]["up"]) if n else "НЕТ")' "$2"; }

check "устройство выключенной локации подписки предлагается (I-161)" "yes" \
      "$(case " $(devs "$out") " in *" nl "*) echo yes ;; *) echo no ;; esac)"
check "устройство выключенного хаба xsteer — тоже, и своим именем из спеки (I-161)" "yes" \
      "$(case " $(devs "$out") " in *" xs0 "*) echo yes ;; *) echo no ;; esac)"
check "выключенное не выдаётся за поднятое" "false" "$(upof "$out" nl)"
check "живой туннель остаётся первым и поднятым" "true" "$(upof "$out" wg0)"
# Мост и порт по-прежнему не кандидаты: выход в них молча ничего не маршрутизирует.
check "мост и порт в кандидаты не попадают" "wg0 nl xs0" "$(devs "$out")"
# Живое устройство не задваивается: движок называет то же имя, что уже прочитано из /sys.
cat > "$T/etc/spec.json" <<'EOF'
{ "schema": 1,
  "outputs": { "wg0": { "kind": "xsteer", "device": "wg0" } },
  "channels": [] }
EOF
check "устройство, которое уже есть, не задваивается" "wg0" "$(devs "$(rpcd devices)")"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"

# ---- перечень своих списков: три процесса на каталог, а не два на файл ---------------
# Метод был самым дорогим у объекта: `grep -c .` и `date -r` в подстановке на КАЖДЫЙ файл, а
# файлов на роутере со всем каталогом 46 — 92 запуска процессов, 1197 мс на вызов (замер на
# стенде 10.8.1.87). Платил это человек каждый раз, открывая «Настройки» или каталог.
#
# Здесь проверяется не скорость, а то, что от неё не пострадал ответ: ключ остаётся ПУТЁМ
# относительно каталога списков (по имени файла адресный список от доменного не отличить),
# счёт остаётся счётом НЕПУСТЫХ строк, а время файла не потерялось.
#
# mktime() есть у busybox awk и у gawk, но НЕ у mawk: на машине с ним время придёт нулём, и
# проверка ниже об этом честно скажет, вместо того чтобы промолчать.
mkdir -p "$T/lists/domains" "$T/lists/custom"
printf '1.2.3.0/24\n\n5.6.7.0/24\n8.9.0.0/16\n' > "$T/lists/three.lst"
printf 'example.com\n' > "$T/lists/domains/one.lst"
out="$(rpcd local_lists)"
cnt() { printf '%s' "$1" | python3 -c 'import json,sys
print(json.load(sys.stdin)["files"].get(sys.argv[1], {}).get("count", "НЕТ"))' "$2"; }
check "счёт по непустым строкам, а не по всем" "3" "$(cnt "$out" three.lst)"
check "доменный список отличим от адресного путём" "1" "$(cnt "$out" domains/one.lst)"
check "время файла не потерялось" "yes" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print("yes" if json.load(sys.stdin)["files"]["three.lst"]["mtime"] > 1000000000 else "no")')"
rm -f "$T/lists/three.lst" "$T/lists/domains/one.lst"

# ---- I-157: «устройств в сети» считалось по одной подсети network.lan ----------------
# Человек отметил в перечне сетей клиентов tailscale0 и ztXXXXXX, трафик оттуда
# маршрутизируется, а в числе на обзоре его нет: считались только адреса из network.lan.
# Занижение молчаливое, при подписи «устройств в сети» — число выглядит осмысленным и потому
# убедительно врёт. Заменить одну подсеть списком нельзя: у tailscale0 адрес на роутере /32,
# и подсеть пиров из него не выводится. Считаются разные ЧАСТНЫЕ адреса-инициаторы, кроме
# адресов самого роутера.
cat > "$T/nf_conntrack" <<'EOF'
ipv4 2 udp 17 30 src=192.168.1.77 dst=192.168.1.1 sport=9 dport=53 src=192.168.1.1 dst=192.168.1.77 sport=53 dport=9 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.50 dst=1.1.1.1 sport=1 dport=443 src=1.1.1.1 dst=46.42.17.15 sport=443 dport=1 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.50 dst=8.8.8.8 sport=2 dport=443 src=8.8.8.8 dst=46.42.17.15 sport=443 dport=2 mark=0
ipv4 2 udp 17 30 src=192.168.9.7 dst=1.1.1.1 sport=3 dport=53 src=1.1.1.1 dst=46.42.17.15 sport=53 dport=3 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=100.64.1.9 dst=140.82.121.4 sport=4 dport=443 src=140.82.121.4 dst=46.42.17.15 sport=443 dport=4 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=10.147.17.31 dst=140.82.121.4 sport=5 dport=443 src=140.82.121.4 dst=46.42.17.15 sport=443 dport=5 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.1 dst=1.1.1.1 sport=6 dport=443 src=1.1.1.1 dst=46.42.17.15 sport=443 dport=6 mark=0
ipv4 2 tcp 6 120 SYN_SENT src=185.200.1.7 dst=46.42.17.15 sport=7 dport=22 src=46.42.17.15 dst=185.200.1.7 sport=22 dport=7 mark=0
EOF
out="$(rpcd net_info)"
# Четыре разных частных инициатора: телефон (192.168.1.50, два соединения — одно устройство),
# гостевая сеть (192.168.9.7), пир Tailscale (100.64.1.9) и хост ZeroTier (10.147.17.31).
# НЕ считаются: адрес самого роутера (192.168.1.1), сканер из интернета (185.200.1.7) и
# устройство, которое только спросило DNS у роутера (192.168.1.77) — это соединение К нему, а
# не через него. Считались бы — здесь стояло бы семь.
check "клиенты считаются по всем сетям, а не по одной (I-157)" "4" \
      "$(printf '%s' "$out" | jget active_clients)"

# Сторона провайдера бывает частной: роутер за роутером, адрес wan вида 10.x. Тогда всякий,
# кто подключился К РОУТЕРУ оттуда, выглядел бы клиентом — на стенде 10.8.1.87 это была
# ssh-сессия, и число на обзоре росло от самого факта подключения. Подсеть wan исключается
# целиком, а домашние сети при этом считаются по-прежнему.
cat > "$T/nf_conntrack2" <<'EOF'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.50 dst=1.1.1.1 sport=1 dport=443 src=1.1.1.1 dst=10.8.1.87 sport=443 dport=1 mark=0
ipv4 2 tcp 6 431999 ESTABLISHED src=10.8.0.3 dst=10.8.1.87 sport=2 dport=22 src=10.8.1.87 dst=10.8.0.3 sport=22 dport=2 mark=0
EOF
check "пришедший со стороны провайдера клиентом не считается" "1" \
      "$(IP_WAN_ADDR=10.8.1.87/16 CONNTRACK_FIXTURE="$T/nf_conntrack2" rpcd net_info | jget active_clients)"

# ---- круг опроса одним вызовом ------------------------------------------------------
# Пять вызовов на круг стоили роутеру 1220 мс, из них 630 — пятикратный разбор одного и того
# же 250-килобайтного скрипта (замер на стенде 10.8.1.87, mipsel 24kc). Метод отдаёт то же
# самое одним запуском. Проверяется здесь СОСТАВ ответа: раскладку полей читает интерфейс, и
# разъехавшись, она молча оставит экран без чисел.
cat > "$T/etc/spec.json" <<'EOF'
{ "schema": 1, "outputs": { "vpn": { "kind": "interface", "device": "wg0" } }, "channels": [] }
EOF
out="$(rpcd live)"
check "круг: состояние движка отдано дословно" "interface" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print(json.load(sys.stdin)["status"]["outputs"]["vpn"]["kind"])' 2>/dev/null)"
check "круг: счётчики устройств на месте" "223000000" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print(json.load(sys.stdin)["devices"]["wg0"]["rx"])' 2>/dev/null)"
check "круг: lo не считается устройством" "no" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print("yes" if "lo" in json.load(sys.stdin)["devices"] else "no")' 2>/dev/null)"
check "круг: сведения о сети на месте" "yes" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
d=json.load(sys.stdin)["net"]; print("yes" if "uptime" in d and "active_clients" in d else "no")' 2>/dev/null)"
# Проверки движка — ТОЛЬКО по просьбе: они вдвое дороже состояния, а меняются реже. Молча
# считать их каждый круг значило бы вернуть половину сэкономленного.
check "круг: без просьбы проверок нет" "no" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print("yes" if "diag" in json.load(sys.stdin) else "no")' 2>/dev/null)"
out2="$(rpcd live '{"diag":true}')"
check "круг: по просьбе проверки приходят дословно" "таблица на месте" \
      "$(printf '%s' "$out2" | python3 -c 'import json,sys
print(json.load(sys.stdin)["diag"]["checks"][0]["what"])' 2>/dev/null)"
# Движок не ответил — честная ошибка, а не пустой объект: интерфейс покажет пустоту как
# «всё в порядке», и это худшая из возможных неправд.
# Спека, которую движок не разбирает: `steer status` не печатает ничего, и это ошибка, а не
# пустота. Пустой объект интерфейс покажет как «всё в порядке» — худшая из возможных неправд.
printf 'не json\n' > "$T/etc/spec.json"
check "круг: молчание движка — это ошибка, а не пустота" "false" \
      "$(rpcd live | jget ok)"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"

check "метод объявлен в списке ubus" "yes" "$(rpcd_list | grep -q '"live"' && echo yes || echo no)"


# ---- xsteer: состояние туннелей и ссылка xs:// ---------------------------------
#
# Три метода, и у каждого своя цена ошибки.
#
# xsteer_state отвечает на вопрос, который иначе не задать: встала ли разгрузка, сколько раз
# соединение переподнималось, отвечает ли вообще процесс. Здесь важно, что «файла нет» и «файл
# лежит» РАЗЛИЧАЮТСЯ в ответе: первое означает «туннель не поднимался», второе — состояние, и
# показать одно вместо другого значит соврать про настройку роутера.
#
# xsteer_link ходит к движку в обе стороны и НЕ РАЗБИРАЕТ формат сам. Проверяется именно это: что
# ссылка уходит движку стандартным ВВОДОМ (аргументы видны в списке процессов, а в ссылке лежит
# приватный ключ) и что отказ движка доезжает до человека его словами.
#
# xsteer_link_put пишет настройку сети — единственный метод в этом файле, который это делает.
# Проверяется, что он не создаёт интерфейсов, замещает пира целиком и не трогает чужие поля.
mkdir -p "$T/var/lib/steer" "$T/var/run/xsteer"
uci_set "network.home.proto" "xsteer"
uci_set "network.home.private_key" "OLDKEY"
uci_set "network.lan.proto" "static"

check "xsteer_state: туннель из настройки виден и без файла состояния" "xs-home" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(json.load(sys.stdin)["tunnels"]["home"]["device"])')"
check "xsteer_state: без файла состояние ПУСТОЕ, а не выдуманное" "null" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["tunnels"]["home"]["state"]))')"
check "xsteer_state: чужой протокол в перечень не попал" "" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(",".join(k for k in json.load(sys.stdin)["tunnels"] if k=="lan"))')"

cat > "$T/var/lib/steer/xsteer-xs-home.json" <<'JEOF'
{"schema":1,"out":"xs-home","up":true,"mtu":1420,"conns":2,"hub":"198.51.100.9:8443",
 "hub_key":"QYkH5bWO","handshake_age":37,"stream":false,
 "offload":{"gso":true,"gro":true,"rx":false},"mtu_confirmed":1420,"resets":3,
 "tx_packets":10,"tx_bytes":2048,"rx_packets":12,"rx_bytes":4096,"dropped":0,
 "last_down":"путь молчит"}
JEOF
check "xsteer_state: состояние движка отдано КАК ЕСТЬ, без пересборки схемы" "198.51.100.9:8443" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(json.load(sys.stdin)["tunnels"]["home"]["state"]["hub"])')"
check "xsteer_state: разгрузка доезжает по частям, а не одним словом" "false" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["tunnels"]["home"]["state"]["offload"]["rx"]))')"
check "xsteer_state: возраст файла назван — по нему видно убитый процесс" "yes" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print("yes" if "age" in json.load(sys.stdin)["tunnels"]["home"] else "no")')"

# Имя устройства из настройки, а не выведенное: файл состояния лежит под ИМЕНЕМ УСТРОЙСТВА, и
# перепутать их значит показать пустое состояние работающему туннелю.
uci_set "network.home.device_name" "xs-dom"
mv "$T/var/lib/steer/xsteer-xs-home.json" "$T/var/lib/steer/xsteer-xs-dom.json"
check "xsteer_state: заданное имя устройства уважается" "198.51.100.9:8443" \
      "$(rpcd xsteer_state | python3 -c 'import json,sys; print(json.load(sys.stdin)["tunnels"]["home"]["state"]["hub"])')"
uci "-q" delete "network.home.device_name" 2>/dev/null || :
grep -v '^network.home.device_name=' "$T/uci.store" > "$T/uci.store.t"; mv "$T/uci.store.t" "$T/uci.store"
mv "$T/var/lib/steer/xsteer-xs-dom.json" "$T/var/lib/steer/xsteer-xs-home.json"

# ---- ссылка наружу ----
check "xsteer_link: у выключенного интерфейса причина названа, а не пустая ссылка" "yes" \
      "$(rpcd xsteer_link '{"iface":"home"}' | jget error | grep -q 'выключен' && echo yes || echo no)"
printf '[Interface]\n' > "$T/var/run/xsteer/home.conf"
: > "$T/steer.log"
out="$(rpcd xsteer_link '{"iface":"home"}')"
check "xsteer_link: ссылка отдана" "xs://PRIV@198.51.100.9:8443?pk=PUB&ip=10.77.0.5/24" \
      "$(printf '%s' "$out" | jget link)"
check "xsteer_link: печатает её ДВИЖОК, из готового файла настройки" "yes" \
      "$(grep -q "xsteer-link $T/var/run/xsteer/home.conf --name home" "$T/steer.log" && echo yes || echo no)"
check "xsteer_link: чужой интерфейс не обслуживается" "yes" \
      "$(rpcd xsteer_link '{"iface":"lan"}' | jget error | grep -q 'не xsteer' && echo yes || echo no)"
check "xsteer_link: негодное имя отвергнуто до всякого запуска движка" "yes" \
      "$(rpcd xsteer_link '{"iface":"../etc/passwd"}' | jget error | grep -qi 'негодное' && echo yes || echo no)"
XS_LINK_RC=2 XS_LINK_ERR="это конфигурация хаба" out="$(XS_LINK_RC=2 XS_LINK_ERR="это конфигурация хаба" rpcd xsteer_link '{"iface":"home"}')"
check "xsteer_link: отказ движка доезжает его словами" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'конфигурация хаба' && echo yes || echo no)"

# ---- ссылка внутрь: разбор ----
: > "$T/steer.log"
out="$(rpcd xsteer_link '{"link":"xs://k@198.51.100.9:8443?pk=p&ip=10.77.0.5/24"}')"
check "xsteer_link: ссылка превращается в текст настройки" "yes" \
      "$(printf '%s' "$out" | jget conf | grep -q 'PrivateKey' && echo yes || echo no)"
check "xsteer_link: ссылка уходит движку СТАНДАРТНЫМ ВВОДОМ, не аргументом" "yes" \
      "$(grep -q '^stdin=xs://k@198.51.100.9:8443' "$T/steer.log" && echo yes || echo no)"
check "xsteer_link: ссылки в аргументах движка нет вовсе" "no" \
      "$(grep '^xsteer-link' "$T/steer.log" | grep -q 'xs://' && echo yes || echo no)"
check "xsteer_link: не ссылка отвергнута до движка" "yes" \
      "$(rpcd xsteer_link '{"link":"vless://x@h:443"}' | jget error | grep -q 'не ссылка' && echo yes || echo no)"

# ---- ссылка внутрь: запись в настройку ----
: > "$T/ifup.log"
out="$(rpcd xsteer_link_put '{"iface":"home","link":"xs://k@198.51.100.9:8443?pk=p&ip=10.77.0.5/24"}')"
check "xsteer_link_put: принято" "true" "$(printf '%s' "$out" | jget ok)"
check "xsteer_link_put: хаб назван в ответе" "198.51.100.9:8443" "$(printf '%s' "$out" | jget hub)"
check "xsteer_link_put: приватный ключ взят из разбора движка" \
      "6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=" "$(uci_get network.home.private_key)"
check "xsteer_link_put: адрес взят оттуда же" "10.77.0.5/24" "$(uci_get network.home.addresses)"
check "xsteer_link_put: SNI перенесён" "www.microsoft.com" "$(uci_get network.home.sni)"
_peer="$(sed -n 's/^network\.\(@*[^.=]*\)=xsteer_home$/\1/p' "$T/uci.store" | head -1)"
check "xsteer_link_put: секция пира создана" "yes" "$([ -n "$_peer" ] && echo yes || echo no)"
check "xsteer_link_put: ключ хаба записан" \
      "QYkH5bWOsEOCgIMldHPATSG7yvNyJ8st7o/HMelWKxs=" "$(uci_get "network.$_peer.public_key")"
check "xsteer_link_put: хост и порт разделены" "198.51.100.9" "$(uci_get "network.$_peer.endpoint_host")"
check "xsteer_link_put: порт отдельно" "8443" "$(uci_get "network.$_peer.endpoint_port")"
check "xsteer_link_put: список AllowedIPs разобран по запятым" "10.77.0.0/24 192.168.9.0/24" \
      "$(uci_get "network.$_peer.allowed_ips")"
check "xsteer_link_put: keepalive перенесён" "25" "$(uci_get "network.$_peer.persistent_keepalive")"
check "xsteer_link_put: интерфейс поднят заново — иначе запись без действия" "yes" \
      "$(grep -q '^home$' "$T/ifup.log" && echo yes || echo no)"

# Повторный приём НЕ ПЛОДИТ пиров: пиру нужен ровно один хаб, и оставленный второй означал бы
# туннель к двум хабам сразу — состояния, которого в звезде не бывает.
rpcd xsteer_link_put '{"iface":"home","link":"xs://k@198.51.100.9:8443?pk=p&ip=10.77.0.5/24"}' >/dev/null
check "xsteer_link_put: повторный приём оставляет ровно одного пира" "1" \
      "$(grep -c '=xsteer_home$' "$T/uci.store" | tr -d ' ')"

# Интерфейса нет — метод его НЕ СОЗДАЁТ и говорит, где создать. Созданный здесь туннель остался бы
# без зоны фаервола: выглядел бы настроенным и не вёз бы трафик.
out="$(rpcd xsteer_link_put '{"iface":"newone","link":"xs://k@1.2.3.4:443?pk=p&ip=10.0.0.1/24"}')"
check "xsteer_link_put: несуществующий интерфейс не создаётся" "false" "$(printf '%s' "$out" | jget ok)"
check "xsteer_link_put: сказано, где его создать" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'настройках сети' && echo yes || echo no)"
check "xsteer_link_put: и в настройке его не появилось" "" "$(uci_get network.newone.proto)"

out="$(XS_LINK_RC=2 XS_LINK_ERR="неизвестный параметр snii" rpcd xsteer_link_put \
       '{"iface":"home","link":"xs://k@1.2.3.4:443?snii=a"}')"
check "xsteer_link_put: негодная ссылка не портит настройку" \
      "6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=" "$(uci_get network.home.private_key)"
check "xsteer_link_put: отказ движка доезжает его словами" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'snii' && echo yes || echo no)"

for m in xsteer_state xsteer_link xsteer_link_put; do
    check "метод $m объявлен в списке ubus" "yes" \
          "$(rpcd_list | grep -q "\"$m\"" && echo yes || echo no)"
    check "метод $m назван в ACL" "yes" \
          "$(grep -q "\"$m\"" "$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json" \
             && echo yes || echo no)"
done


# ---- отчёт для поддержки: один текст, который человек вставляет в чат ---------------
#
# ЗАЧЕМ ЭТОТ РАЗДЕЛ. Части у проекта есть (приговоры diag, состояние выходов, версии,
# каталог стратегий, резолвер), а собрать их в ОДИН текст было нечем: в трекере висят
# обращения, которые начинаются с «а как узнать, что у меня стоит». Метод собирает этот
# текст сам, и проверяется здесь ДВА разных вопроса.
#
# Первый — попало ли в отчёт то, ради чего его собирают. Пустой отчёт бесполезен так же,
# как отсутствующий.
#
# Второй — И ОН ГЛАВНЫЙ — не попало ли в отчёт то, чего в публичном чате быть не должно:
# ссылка подписки с ключом, ссылки узлов, приватные ключи туннелей, имена узлов (в них
# панели прячут и сообщения, и логины) и внешний адрес роутера. Отчёт, который нельзя
# показать людям, не выполняет своей задачи вовсе — поэтому проверки на секреты стоят
# рядом с проверками на состав, а не «когда-нибудь потом».
mkdir -p "$T/etc/subs" "$T/zapret" "$T/etc/config"

# Прошивка и архитектура: обе строки из одного файла описания системы. DISTRIB_DESCRIPTION
# берётся ради версии OpenWrt — до этого метода её не спрашивал никто.
cat > "$T/etc/openwrt_release" <<'EOF'
DISTRIB_ARCH='aarch64_cortex-a53'
DISTRIB_RELEASE='24.10.0'
DISTRIB_DESCRIPTION='OpenWrt 24.10.0 r28427-6df0e3d02a'
EOF

# Номер сборки интерфейса — тот же файл, который читает загрузчик страницы на каждой
# загрузке (luci/.../view/splify2/home.js).
printf '26.9-ab12cd\n' > "$T/etc/build-id.txt"

# Спека: выход-туннель, выход-локация подписки и «напрямую», плюс два правила — адресное и
# доменное. Из неё же заглушка движка собирает `status`, поэтому состояние выходов и
# перечень правил в отчёте приезжают из одного источника, как на роутере.
cat > "$T/etc/spec.json" <<EOF
{ "schema": 1,
  "outputs": {
    "vpn":    { "kind": "interface", "device": "wg0" },
    "nl":     { "kind": "vless", "sub_file": "$T/etc/sub.txt", "node": -1 },
    "direct": { "kind": "direct" }
  },
  "channels": [
    { "name": "Новости", "match": { "prefixes_files": ["$T/lists/news.lst"] }, "out": "vpn" },
    { "name": "Соцсети", "match": { "domains_files": ["$T/lists/domains/news.lst"] }, "out": "nl" }
  ] }
EOF

# Обход DPI: пакет «установлен» (заглушка nfqws исполнима), в каталоге одна стратегия, она же
# отмечена активной в конфигурации — ровно так её отмечает Zapret Manager.
printf '#v1\n--filter-tcp=443\n' > "$T/zapret/strategies.txt"
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v1\n--filter-tcp=443\n'\n" > "$T/etc/config-zapret"

# DoH: выбран резолвер из каталога.
printf '#!/bin/sh\nexit 0\n' > "$T/bin/initd-doh"; chmod +x "$T/bin/initd-doh"
printf "config https-dns-proxy\n\toption resolver_url 'https://dns.comss.one/dns-query'\n" \
    > "$T/etc/config-doh"

# ---- СЕКРЕТЫ, которые лежат на роутере рядом и в отчёт попасть не должны -------------
# Ссылка подписки с ключом — в uci, файл подписки — со ссылкой узла и его UUID.
uci_set splify2.main.sub_url 'https://panel.example.org/sub?token=SECRETTOKEN123'
printf 'vless://8f14e45f-ceea-467a-9fb2-1111deadbeef@203.0.113.9:443?sni=a#%%F0%%9F%%87%%A9%%F0%%9F%%87%%AA-Germania-login-pupkin\n' \
    > "$T/etc/sub.txt"
rm -f "$T/etc/subs"/*.txt
# Приватный ключ туннеля xsteer — в настройке сети и отдельным файлом.
uci_set network.home.private_key '6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU='
mkdir -p "$T/etc/steer-xsteer"
printf '[Interface]\nPrivateKey = 6Gtidge6FqhO/0LhrAWpRiyYaKdLZF/gib/HePLC9GU=\n' \
    > "$T/etc/steer-xsteer/home.conf"

# Проверки «в отчёте нет секрета» зелены и на отчёте, которого нет вовсе, и на фикстуре без
# секрета. Поэтому сначала — что секреты в песочнице действительно лежат: иначе ниже
# проверялась бы не защита отчёта, а собственная опечатка в фикстуре.
check "фикстура: ссылка подписки с ключом лежит в настройке" "yes" \
      "$(case "$(uci_get splify2.main.sub_url)" in *SECRETTOKEN123*) echo yes ;; *) echo no ;; esac)"
check "фикстура: файл подписки несёт ссылку узла с UUID и именем" "yes" \
      "$(grep -q 'vless://8f14e45f' "$T/etc/sub.txt" && echo yes || echo no)"
check "фикстура: приватный ключ туннеля лежит в настройке сети" "yes" \
      "$(case "$(uci_get network.home.private_key)" in *6Gtidge6*) echo yes ;; *) echo no ;; esac)"

# Имена узлов приходят от ПАНЕЛИ, поэтому в ответе движка на `vless-nodes` они и подделаны
# именем с логином. Отчёт берёт оттуда только числа — это и проверяется ниже.
# STEER_NOISE — предупреждение движка перед JSON: отчёт обязан пережить его так же, как
# его переживает метод vless_nodes (json_tail).
SR_JSON='{"output":"nl","sub_file":"'"$T"'/etc/sub.txt","node":-1,"usable":3,"skipped":1,"foreign":0,
"nodes":[{"name":"🇩🇪 Germania-login-pupkin","host":"203.0.113.9","uuid":"8f14e45f-ceea-467a-9fb2-1111deadbeef"}]}'

out="$(BUILD_ID_FILE="$T/etc/build-id.txt" ZP_NFQWS_FIXTURE="$T/bin/nfqws" \
       STEER_JSON="$SR_JSON" STEER_NOISE='steer[warn]: узел 2 не ответил' \
       rpcd support_report)"
rep="$(printf '%s' "$out" | jget text)"
has() {  # ПОДСТРОКА — есть ли она в отчёте
    case "$rep" in *"$1"*) echo yes ;; *) echo no ;; esac
}

check "отчёт собран" "true" "$(printf '%s' "$out" | jget ok)"
check "отчёт — один готовый к копированию текст, а не JSON по полям" "yes" \
      "$([ "$(printf '%s\n' "$rep" | grep -c .)" -gt 15 ] && echo yes || echo no)"

# ---- состав: версии, устройство ----
check "модель роутера названа" "yes" "$(has 'Xiaomi AX3000T')"
check "версия OpenWrt названа" "yes" "$(has '24.10.0')"
check "архитектура пакетов названа" "yes" "$(has 'aarch64_cortex-a53')"
check "версия пакета интерфейса названа" "yes" "$(has '26.9-ab12cd')"
check "версия пакета движка названа" "yes" "$(has '0.9.5')"
check "вариант сборки движка назван словом, а не признаком" "yes" "$(has 'расширенн')"
check "состояние службы движка названо" "yes" "$(has 'автозапуск')"

# ---- состав: приговоры diag по-русски, а не JSON ----
check "приговоры diag попали в отчёт читаемым видом" "yes" "$(has 'таблица на месте')"
check "и не JSON'ом" "no" "$(has '"verdict"')"
check "итог проверок назван числом" "yes" "$(has 'провалов 0')"

# ---- состав: выходы и правила ----
check "выход-туннель назван" "yes" "$(has 'vpn')"
# Устройство выхода занимает в строке отдельное место, и пустое оно значит «туннель не
# поднялся» — самое частое состояние в обращениях. Проверяется именно эта половина: заглушка
# движка печатает в `status` только kind/up/mark/table, поэтому имени устройства в стенде
# взяться неоткуда, а на роутере его печатает движок (контракт steer §2: состояние выхода —
# это его запись в спеке плюс поля состояния).
check "устройство выхода названо отдельным словом" "yes" "$(has 'устройство не создано')"
check "состояние выхода названо словом" "yes" "$(has 'поднят')"
check "выход-локация подписки назван своим видом" "yes" "$(has 'vless')"
check "правила из спеки перечислены" "yes" "$(has 'Новости')"
check "и второе правило тоже" "yes" "$(has 'Соцсети')"

# ---- состав: обход DPI ----
check "обход DPI: сказано, что пакет стоит" "yes" "$(has 'обход DPI')"
check "обход DPI: активная стратегия названа" "yes" "$(has 'v1')"
check "обход DPI: число стратегий в каталоге названо" "yes" "$(has 'стратегий в каталоге: 1')"

# ---- состав: DNS ----
check "DoH: выбранный резолвер назван" "yes" "$(has 'comss')"
check "резолвер доменов и перенаправление DNS описаны" "yes" "$(has 'force_dns')"

# ---- состав: подписка ----
check "подписка: сказано, что она есть" "yes" "$(has 'подписка')"
check "подписка: число пригодных узлов названо" "yes" "$(has 'пригодных узлов: 3')"

# ---- ГЛАВНОЕ: секретов в отчёте нет -------------------------------------------------
check "в отчёте нет ссылок узлов" "no" "$(has 'vless://')"
check "в отчёте нет ссылки подписки" "no" "$(has 'panel.example.org')"
check "в отчёте нет ключа из ссылки подписки" "no" "$(has 'SECRETTOKEN123')"
check "в отчёте нет UUID узла" "no" "$(has '8f14e45f')"
check "в отчёте нет имени узла подписки" "no" "$(has 'Germania')"
check "в отчёте нет приватного ключа туннеля" "no" "$(has '6Gtidge6')"
check "в отчёте нет адреса узла" "no" "$(has '203.0.113.9')"
# Внешний адрес роутера: тот, который отдаёт заглушка `ip` на wan. В отчёте его нет вовсе —
# ни измеренного (outbound_geo), ни взятого из настройки сети.
check "в отчёте нет внешнего адреса роутера" "no" "$(has '46.42.17.15')"
# И отдельно — что отчёт сам говорит человеку, чего в нём нет: он вставляет текст в общий
# чат и вправе это знать, не читая наш исходник.
check "отчёт сам говорит, что секретов в нём нет" "yes" "$(has 'не попали')"

# ---- ребра контракта: список ubus и ACL ---------------------------------------------
check "метод support_report объявлен в списке ubus" "yes" \
      "$(rpcd_list | grep -q '"support_report"' && echo yes || echo no)"
check "метод support_report назван в ACL" "yes" \
      "$(grep -q '"support_report"' "$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json" \
         && echo yes || echo no)"
# Отчёт только читает состояние, поэтому он в группе read: попав в write, он потребовал бы
# от вызывающего прав, которых у страницы обзора нет.
check "и назван он именно в разделе read" "yes" \
      "$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))["luci-app-splify2"]
print("yes" if "support_report" in d["read"]["ubus"]["splify2"] else "no")' \
        "$ROOT/luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json")"

# ---- отчёт на сломанном роутере ------------------------------------------------------
# Отчёт собирают ИМЕННО ТОГДА, когда что-то не работает, поэтому он обязан собираться и без
# движка, и без спеки. Пустой ответ или отказ в этом состоянии оставил бы человека без
# единственного, что он мог показать помогающему.
mv "$T/bin/steer" "$T/bin/steer.off"
printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$T/etc/spec.json"
out="$(BUILD_ID_FILE="$T/etc/build-id.txt" rpcd support_report)"
rep="$(printf '%s' "$out" | jget text)"
check "без движка отчёт всё равно собирается" "true" "$(printf '%s' "$out" | jget ok)"
check "и говорит, что движка нет" "yes" "$(has 'НЕ УСТАНОВЛЕН')"
# Незнание называется незнанием: «движок не ответил» и «движка нет» — разные диагнозы, и
# второй уводит помогающего чинить не то.
check "и не выдаёт молчание diag за исправность" "yes" "$(has 'не ответил на diag')"
check "модель и прошивка при этом на месте — их знает не движок" "yes" "$(has 'Xiaomi AX3000T')"
check "пустая спека — это «правил нет», а не пустой раздел" "yes" \
      "$(has 'правил нет')"
mv "$T/bin/steer.off" "$T/bin/steer"

# Подписки нет вовсе — тоже состояние, а не пустое место: с него начинается половина
# обращений («поставил, а интернета нет»).
rm -f "$T/etc/sub.txt" "$T/etc/subs"/*.txt
uci_set splify2.main.sub_url ''
out="$(BUILD_ID_FILE="$T/etc/build-id.txt" rpcd support_report)"
rep="$(printf '%s' "$out" | jget text)"
check "отсутствие подписки названо словами" "yes" "$(has 'подписок нет')"

# ---- источники трафика: свой исходящий туннель источником быть не может ---------------
# Перечень сетей клиентов (splify2#16, выше по файлу) отдавал ВСЁ, что нашлось в /sys, кроме
# lo и портов моста. А в /sys лежат и наши СОБСТВЕННЫЕ исходящие туннели: устройство выхода
# kind=vless, wg-клиент до провайдера, туннель xsteer. Отметить такое устройство «сетью
# клиентов» человек мог прямо на экране — и получал попытку забрать трафик из того самого
# туннеля, через который сам уходит наружу, ожидая ровно обратного. Подпись экрана обещает
# «тех, кто ко мне приходит», и в этом вся ловушка: она не врёт, врёт список под ней.
#
# Два вида туннелей надо РАЗЛИЧАТЬ, и различие содержательное:
#  * через который МЫ уходим наружу (tun-vless, wg до провайдера, xsteer) — источником быть
#    не может;
#  * через который к НАМ приходят чужие устройства (сервер wireguard, Tailscale, ZeroTier) —
#    законный источник, ради него перечень и заведён.
# В /sys они выглядят одинаково (оба ARPHRD_NONE, у обоих бывает адрес /32), поэтому ниже —
# по проверке на каждый признак, которым они всё-таки различаются.
#
# НЕГОДНОЕ ОСТАЁТСЯ В ОТВЕТЕ, и это проверяется первым. Выкинутое устройство человек ищет
# глазами, не находит и решает, что перечень сломан («куда делся мой wg0») — тот же довод, по
# которому и wan помечается, а не прячется.
#
# Фикстура своя (шов SYSNET_FIXTURE): набор устройств здесь другой, чем у раздела выше, и
# дописать его туда значило бы менять ожидания уже написанных проверок. Помощники names,
# netof и flagof — оттуда же: вопрос к ответу тот же, и второй их набор разошёлся бы с первым.
mkdir -p "$T/sysnet-src/lo" "$T/sysnet-src/br-lan" "$T/sysnet-src/lan1" "$T/sysnet-src/wan" \
         "$T/sysnet-src/tun-vless" "$T/sysnet-src/wg-prov" "$T/sysnet-src/wg-b" \
         "$T/sysnet-src/wg-vpn" "$T/sysnet-src/wg-home" "$T/sysnet-src/xs-hub" \
         "$T/sysnet-src/xs-dc9" "$T/sysnet-src/tun-def" "$T/sysnet-src/tailscale0"
ln -s ../br-lan "$T/sysnet-src/lan1/master"
for d in lo br-lan lan1 wan tun-vless wg-prov wg-b wg-vpn wg-home xs-hub xs-dc9 tun-def \
         tailscale0; do
    printf 'up\n' > "$T/sysnet-src/$d/operstate"
done

# Спека с выходами всех трёх видов, у которых есть устройство. Каждый выход здесь закрывает
# свой путь, которым устройство попадает в ответ движка:
#  * tun-vless — kind=vless БЕЗ явного device: имя устройства выводится из имени выхода, и
#    знает об этом только движок, в спеке такого поля нет вовсе;
#  * vpn — kind=interface с явным `device`: wg-клиент до провайдера, самый частый выход;
#  * pool — kind=interface с `devices`: движок печатает у выхода ОДНО устройство (devices[0]),
#    поэтому второй член пула виден только в самой спеке. Он такое же наше исходящее.
cat > "$T/etc/spec.json" <<'EOF'
{ "schema": 1,
  "outputs": {
    "tun-vless": { "kind": "vless", "sub_file": "/etc/steer/sub.txt" },
    "vpn":       { "kind": "interface", "device": "wg-prov" },
    "pool":      { "kind": "interface", "devices": ["wg-prov", "wg-b"] },
    "plain":     { "kind": "direct" }
  },
  "channels": [] }
EOF

# Настройки сети: что наружу и какие интерфейсы поднимает наш обработчик netifd. Имя
# устройства у proto=xsteer берётся из `device_name`, а без него выводится приставкой
# `xs-` из имени интерфейса — ровно так его создаёт files/lib/netifd/proto/xsteer.sh, и
# проверяются оба пути: секция hub без device_name даёт xs-hub, секция dc9 — своё имя.
uci_set network.wan.device wan
uci_set network.hub.proto xsteer
uci_set network.dc9.proto xsteer
uci_set network.dc9.device_name xs-dc9

# `ip` для этого раздела: адреса И МАРШРУТ ПО УМОЛЧАНИЮ. Общая заглушка выше на `route`
# молчит — там маршруты никого не интересовали; здесь маршрут по умолчанию как раз и
# опознаёт туннель, через который роутер уходит наружу, когда о нём не сказано больше
# ничего: ни выхода в спеке, ни proto=xsteer, ни утилиты wg. Форма строки списана с живой
# машины: `default via 10.0.0.1 dev ens3 onlink`. Заглушка ставится в конце файла и после
# этого раздела ничего не проверяется — иначе её пришлось бы возвращать на место.
cat > "$T/bin/ip" <<'EOF'
#!/bin/sh
args=" $* "
case "$args" in
    *" rule "*) exit 0 ;;
    *" route "*)
        case "$args" in
            *" default "*)
                [ -n "${IP_DEFAULT_DEV:-}" ] &&
                    printf 'default via 192.0.2.1 dev %s onlink\n' "$IP_DEFAULT_DEV" ;;
        esac
        exit 0 ;;
esac
# Адреса — с хвостом после префикса, как у настоящего `ip -4 -o addr show`: разбор обязан
# брать второе поле после `inet`, а не всю строку.
echo "3: br-lan    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan"
echo "4: wan    inet 46.42.17.15/22 brd 46.42.19.255 scope global wan"
echo "9: tailscale0    inet 100.64.1.5/32 scope global tailscale0"
echo "11: wg-home    inet 10.9.0.1/24 scope global wg-home"
echo "12: wg-vpn    inet 10.66.0.2/32 scope global wg-vpn"
exit 0
EOF
chmod +x "$T/bin/ip"

# `wg show all allowed-ips`: устройство, ключ пира и разрешённые сети через ТАБУЛЯЦИЮ, сети
# между собой — через пробел. Форма проверена на живой машине (wireguard-tools, ядерный
# wireguard): у пира-клиента там стоит 0.0.0.0/0, у пиров сервера — по адресу на пира.
#
# WG_SILENT=1 — «утилита есть, а сказать ей нечего»: нет ядерного модуля, нет прав, нет ни
# одного интерфейса. Признака тогда не существует, и перечень обязан это пережить. Случай
# «wg не установлен вовсе» стендом не проверяется: заглушка живёт в PATH, а отсутствие в
# PATH означало бы, что находится настоящий wg машины разработчика, — то есть проверка
# зависела бы от того, что поднято на ней. В объекте эта ветка закрыта `command -v wg`.
cat > "$T/bin/wg" <<'EOF'
#!/bin/sh
[ -n "${WG_SILENT:-}" ] && exit 1
case "$*" in
    "show all allowed-ips")
        printf 'wg-vpn\tKCLIENT=\t0.0.0.0/0 ::/0\n'
        printf 'wg-home\tKPEER1=\t10.9.0.2/32\n'
        printf 'wg-home\tKPEER2=\t10.9.0.3/32 192.168.5.0/24\n'
        ;;
esac
exit 0
EOF
chmod +x "$T/bin/wg"

# Причина — СТРОКОЙ, как её прочитает человек: flagof печатает JSON-значение (в кавычках),
# а здесь проверяется, что в тексте есть нужное слово.
whyof() { printf '%s' "$1" | python3 -c 'import json,sys
n=[d for d in json.load(sys.stdin)["nets"] if d["name"]==sys.argv[1]]
print(n[0].get("why", "ПОЛЯ НЕТ") if n else "НЕТ")' "$2"; }

out="$(IP_DEFAULT_DEV=tun-def SYSNET_FIXTURE="$T/sysnet-src" rpcd client_nets)"

check "негодные в источники из перечня НЕ выброшены" \
      "br-lan tailscale0 tun-def tun-vless wan wg-b wg-home wg-prov wg-vpn xs-dc9 xs-hub" \
      "$(names "$out")"
# ---- признак 1: устройство названо в спеке устройством нашего выхода (точный) ----
check "устройство выхода kind=vless источником не годится" "false" \
      "$(flagof "$out" tun-vless usable)"
check "и причина названа словами, а не кодом" "yes" \
      "$(whyof "$out" tun-vless | grep -q 'выход' && echo yes || echo no)"
check "явно названное устройство выхода kind=interface — тоже" "false" \
      "$(flagof "$out" wg-prov usable)"
check "и второе устройство пула, которого движок не печатает" "false" \
      "$(flagof "$out" wg-b usable)"
# ---- признак 2: маршрут по умолчанию ----
# Туннель, поднятый руками и никак не названный в наших настройках, опознаётся только так.
check "через устройство идёт маршрут по умолчанию — значит наружу" "false" \
      "$(flagof "$out" tun-def usable)"
check "и про маршрут в причине сказано" "yes" \
      "$(whyof "$out" tun-def | grep -q 'маршрут' && echo yes || echo no)"
# ---- признак 3: proto=xsteer в /etc/config/network ----
check "туннель proto=xsteer с выведенным именем устройства — наш" "false" \
      "$(flagof "$out" xs-hub usable)"
check "и он же, названный device_name" "false" "$(flagof "$out" xs-dc9 usable)"
# ---- признак 4: пиры wireguard ----
# ГЛАВНОЕ РАЗЛИЧЕНИЕ. Оба устройства — ядерный wireguard, в /sys неотличимы; разница в том,
# КУДА разрешён трафик пирам: весь мир (мы клиент) против адреса на пира (мы сервер).
check "wg-клиент до провайдера (у пира 0.0.0.0/0) источником не годится" "false" \
      "$(flagof "$out" wg-vpn usable)"
check "сервер wireguard для своих устройств — ЗАКОННЫЙ источник" "true" \
      "$(flagof "$out" wg-home usable)"
# ---- wan и обычные сети ----
# Забирать трафик С wan значило бы заворачивать в туннель то, что из туннеля и вышло.
check "wan источником не предлагается" "false" "$(flagof "$out" wan usable)"
check "домашний мост годится" "true" "$(flagof "$out" br-lan usable)"
check "tailscale0 годится: через него к нам как раз приходят" "true" \
      "$(flagof "$out" tailscale0 usable)"
check "у годного причины отказа нет" "" "$(whyof "$out" br-lan)"
# Причина нужна на КАЖДОМ негодном: пустая строка на экране — это серая строка без
# объяснения, то есть ровно то «куда делся мой wg0», от которого перечень и защищает.
check "у каждого негодного причина непустая" "" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys
print(" ".join(d["name"] for d in json.load(sys.stdin)["nets"]
                if not d.get("usable", True) and not d.get("why")))')"
# ---- прежние поля не сломаны: их читает вкладка ----
check "wan по-прежнему помечен своим полем" "true" "$(flagof "$out" wan wan)"
check "подсеть моста на месте" "192.168.1.0/24" "$(netof "$out" br-lan)"
check "поднятость на месте" "true" "$(flagof "$out" br-lan up)"

# ---- wg молчит: признака нет, а перечень есть ----
out="$(WG_SILENT=1 IP_DEFAULT_DEV=tun-def SYSNET_FIXTURE="$T/sysnet-src" rpcd client_nets)"
check "без ответа wg перечень всё равно собирается" "true" "$(flagof "$out" br-lan usable)"
check "и законный источник не запрещён заодно" "true" "$(flagof "$out" wg-home usable)"
# Обратная сторона названа здесь честно: без wg клиент до провайдера ничем не отличается от
# сервера, и перечень его предложит. Запрещать всё ядерное wireguard «на всякий случай»
# хуже: это отняло бы у человека тот самый случай, ради которого перечень заведён. Точный
# признак остаётся на месте — заведите на этот туннель выход, и он уйдёт из источников.
check "wg-клиента без wg отличить нечем — и он остаётся предложенным" "true" \
      "$(flagof "$out" wg-vpn usable)"
# А то, что названо в спеке, молчание wg не спасает: признак спеки от wg не зависит.
check "устройство выхода негодно и без wg" "false" "$(flagof "$out" wg-prov usable)"

# ---- бэкенд старее приговора: поля просто нет ----
# Проверять здесь нечего кроме того, что поле ПЕЧАТАЕТСЯ ВСЕГДА: «поля нет» и «поле false»
# вкладка обязана различать, иначе на старом объекте она покрасила бы серым весь список.
check "приговор печатается и у годного устройства, а не только у негодного" "true" \
      "$(flagof "$out" br-lan usable)"
printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'все проверки прошли' || echo "ЕСТЬ ПРОВАЛЫ: $fails")"
[ "$fails" -eq 0 ]
