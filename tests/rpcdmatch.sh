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
esac
exit 0
EOF

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
S="$SANDBOX/uci.store"
[ -f "$S" ] || : > "$S"
while [ $# -gt 0 ]; do
    case "$1" in -*) shift ;; *) break ;; esac
done
case "${1:-}" in
    get)
        line="$(grep "^${2:-}=" "$S" | tail -1)" || exit 1
        [ -n "$line" ] || exit 1
        printf '%s\n' "${line#*=}"
        ;;
    set)
        k="${2%%=*}"; v="${2#*=}"
        grep -v "^$k=" "$S" > "$S.t" 2>/dev/null
        mv "$S.t" "$S" 2>/dev/null || : > "$S"
        printf '%s=%s\n' "$k" "$v" >> "$S"
        ;;
    delete)
        grep -v "^${2:-}=" "$S" > "$S.t" 2>/dev/null
        mv "$S.t" "$S" 2>/dev/null || : > "$S"
        ;;
esac
exit 0
EOF
# ubus: код возврата прежний (на машине разработчика его нет, и скрипт обязан это
# переживать), но вызовы теперь протоколируются — сигнал экземпляру виден только так.
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
if [ "$1" = outputs ]; then
    spec=""; kind=""; obfs=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --spec) spec="$2"; shift 2 ;;
            --kind) kind="$2"; shift 2 ;;
            --obfs) obfs=1; shift ;;
            *) shift ;;
        esac
    done
    [ -s "$spec" ] && KIND="$kind" OBFS="$obfs" python3 - "$spec" <<'PYEOF'
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

# ---- вызов настоящего скрипта -------------------------------------------------
# Один вход на все проверки: разница между ними — только в фикстурах и переменных.
rpcd() {  # МЕТОД [JSON_ЗАПРОСА]  — вызов метода; для перечня методов есть rpcd_list
    printf '%s\n' "${2:-}" | env \
        SANDBOX="$T" \
        PATH="$T/bin:$PATH" \
        JSHN_SH="$ROOT/tests/stub/jshn.sh" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        STEER="$T/bin/steer" \
        SPEC="$T/etc/spec.json" \
        LISTS="$T/lists" \
        SUB="$T/etc/sub.txt" \
        MANIFEST="$T/etc/manifest.json" \
        INITD="$T/bin/initd-steer" \
        RPCD_INITD="$T/bin/initd-rpcd" \
        OPENWRT_RELEASE="${OPENWRT_RELEASE_FIXTURE:-$T/etc/openwrt_release}" \
        VLESS_DIRTY="$T/var/vless-dirty" \
        OBFS_DIRTY="$T/var/obfs-dirty" \
        HWID_SYSNET="${HWID_SYSNET_FIXTURE:-$T/sys/class/net}" \
        UCI_SPLIFY2="${UCI_SPLIFY2_FIXTURE:-$T/etc/config/splify2}" \
        SYSINFO_MODEL="$T/etc/sysinfo-model" \
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
        GH_CACHE="$T/var/releases.json" \
        STEER_ERR="${STEER_ERR:-}" \
        APK_ADD_RC="${APK_ADD_RC:-0}" \
        APK_ADD_OUT="${APK_ADD_OUT:-}" \
        ENGINE_ENABLED="${ENGINE_ENABLED:-0}" \
        sh "$SCRIPT" call "$1" 2>"$T/stderr"
}

rpcd_list() {
    env SANDBOX="$T" PATH="$T/bin:$PATH" JSHN_SH="$ROOT/tests/stub/jshn.sh" FETCH_SH="$ROOT/files/usr/lib/splify2/fetch.sh" \
        sh "$SCRIPT" list 2>"$T/stderr"
}

# Булево печатается как в JSON (true/false), а не как в python (True/False): иначе
# проверка сравнивала бы ожидание с языком, на котором написана сама проверка.
jget() {  # ПОЛЕ < JSON
    python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: print("НЕ JSON"); raise SystemExit
v = d.get(sys.argv[1])
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

# Метод, которого нет в списке методов, ubus не покажет вовсе.
out="$(rpcd_list)"
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
# Четыре места: sub_set, backup-подобная ветка настроек, ui_get|ui_set и fetch_mode|
# fetch_mode_set. Число растёт вместе с методами, которые пишут в uci, — и это ровно тот
# случай, когда барьер должен ломаться: новый метод обязан заводить файл той же функцией.
check "файл заводится одной функцией на все места" "4" \
      "$(grep -c '^ *uci_file ||' "$SCRIPT")"
check "перенаправлением файл больше не заводится" "0" \
      "$(grep -c ': > "\?/etc/config' "$SCRIPT")"
# И поведением: на недоступном каталоге метод обязан ОТВЕТИТЬ отказом, а не умереть.
out="$(UCI_SPLIFY2_FIXTURE=/proc/nonexistent/splify2 rpcd sub_set '{"url":"vless://k@h:443#n"}')"
check "недоступный файл настройки — отказ с причиной, а не тишина" "yes" \
      "$(printf '%s' "$out" | jget error | grep -q 'кончилось место' && echo yes || echo no)"

# ---- идентификатор устройства для панели подписки (HWID) --------------------------
# Панель, привязывающая подписку к устройствам, требует заголовок `x-hwid`. Клиенту без него
# она отвечает не отказом, а ЗАГЛУШКОЙ: HTTP 200 и пара законных ссылок vless:// на
# 0.0.0.0:1, где сообщение спрятано в имя узла. То есть подписка «скачалась», узлы «есть»,
# туннель не поднимется никогда.
rm -f "$T/curl.hdrs" "$T/etc/sub.txt"
out="$(rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "подписка скачалась" "true" "$(printf '%s' "$out" | jget ok)"
check "запрос несёт идентификатор устройства" "yes" \
      "$(grep -qi '^x-hwid: splify2-' "$T/curl.hdrs" && echo yes || echo no)"
# Постоянство — главное свойство: идентификатор считается из MAC, а не из файла, потому что
# сброс к заводским настройкам стирает overlay целиком, а MAC живёт в устройстве.
h1="$(grep -i '^x-hwid:' "$T/curl.hdrs" | head -1)"
rm -f "$T/curl.hdrs"
out="$(rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "тот же роутер — тот же идентификатор" "$h1" \
      "$(grep -i '^x-hwid:' "$T/curl.hdrs" | head -1)"
# Берётся ФИЗИЧЕСКИЙ порт с постоянным адресом: мост исключён отсутствием ссылки `device`,
# wifi — битом «назначен локально». Проверяется значением: sha256 от 'splify2:<mac>'.
want="splify2-$(printf 'splify2:9c:53:22:1f:0a:bc' | sha256sum | cut -c1-20)"
check "идентификатор выведен из MAC физического порта" "x-hwid: $want" \
      "$(grep -i '^x-hwid:' "$T/curl.hdrs" | head -1 | tr -d '\r')"
check "MAC наружу не уходит" "no" \
      "$(grep -qi '9c:53:22' "$T/curl.hdrs" && echo yes || echo no)"
check "устройство названо честно, а не выдуманным телефоном" "yes;yes" \
      "$(grep -qi '^x-device-os: OpenWrt' "$T/curl.hdrs" && echo yes || echo no);$(grep -qi '^x-device-model: Xiaomi AX3000T' "$T/curl.hdrs" && echo yes || echo no)"
check "sub_info отдаёт идентификатор до всякого скачивания" "$want" \
      "$(rpcd sub_info | jget hwid)"

# Сигналы панели читаются из ответных заголовков: без них отказ выглядел бы как «подписка
# скачалась, узлы не работают».
out="$(CURL_RESP_HDRS='x-hwid-active: true
x-hwid-not-supported: true' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "«панель не увидела HWID» названо словами" "yes" \
      "$(printf '%s' "$out" | jget warn | grep -q 'не увидела идентификатора' && echo yes || echo no)"
out="$(CURL_RESP_HDRS='x-hwid-limit: true' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "«лимит устройств» назван вместе со следующим шагом" "yes" \
      "$(printf '%s' "$out" | jget warn | grep -q 'освободите слот' && echo yes || echo no)"
out="$(rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "на исправном ответе предупреждения нет" "" "$(printf '%s' "$out" | jget warn)"

# Роутер без пригодного MAC (только мост и локально назначенный wifi) — идентификатор не
# выдумывается: пустая строка честнее случайного числа, которое после перезагрузки станет
# другим устройством.
rm -rf "$T/sys-nomac"; mkdir -p "$T/sys-nomac/br-lan" "$T/sys-nomac/wlan0/device"
printf 'aa:bb:cc:dd:ee:ff\n' > "$T/sys-nomac/br-lan/address"
printf '02:11:22:33:44:55\n' > "$T/sys-nomac/wlan0/address"
check "без постоянного MAC идентификатор не выдумывается" "" \
      "$(HWID_SYSNET_FIXTURE="$T/sys-nomac" rpcd sub_info | jget hwid)"
rm -f "$T/curl.hdrs"
out="$(HWID_SYSNET_FIXTURE="$T/sys-nomac" rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "и заголовок тогда не уходит" "no" \
      "$([ -f "$T/curl.hdrs" ] && echo yes || echo no)"
check "но об этом сказано" "yes" \
      "$(printf '%s' "$out" | jget warn | grep -q 'не ушёл' && echo yes || echo no)"

# Вставленные руками ссылки vless:// никуда не ходят, значит и устройство называть некому.
rm -f "$T/curl.hdrs"
out="$(rpcd sub_set '{"url":"vless://key@host:443#node"}')"
check "для ссылок vless:// запроса нет вовсе" "links;no" \
      "$(printf '%s' "$out" | jget kind);$([ -f "$T/curl.hdrs" ] && echo yes || echo no)"

# ---- остаток трафика подписки (Andromeda: карточка «Подписка» на обзоре) ----------
# Панель говорит остаток ЗАГОЛОВКОМ ответа, и больше нигде: в теле подписки этих чисел нет.
# Значит запомнить их можно только в момент запроса — и вся проверка про это.
USERINFO='subscription-userinfo: upload=1288490188; download=139458183168; total=214748364800; expire=1789200000'
rm -f "$T/etc/sub.userinfo"
out="$(CURL_RESP_HDRS="$USERINFO" rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "остаток приезжает в ответе на «Обновить»" "214748364800" \
      "$(printf '%s' "$out" | jqget quota total)"
check "разобраны обе половины расхода" "1288490188;139458183168" \
      "$(printf '%s' "$out" | jqget quota up);$(printf '%s' "$out" | jqget quota down)"
check "срок подписки разобран" "1789200000" "$(printf '%s' "$out" | jqget quota expire)"
# Байты — СТРОКАМИ: 200 ГБ не влезают в int32, и обрезанное число выглядело бы законным
# остатком. Проверяется именно тип, а не значение: значение сверено выше.
check "объёмы отданы строками, а не числами" "yes" \
      "$(printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if isinstance(json.load(sys.stdin)["quota"]["total"], str) else "no")')"
check "sub_info отдаёт запомненный остаток без запроса наружу" "214748364800" \
      "$(rpcd sub_info | jqget quota total)"
rm -f "$T/curl.log"
rpcd sub_info > /dev/null
check "и правда не ходит к панели" "no" \
      "$([ -f "$T/curl.log" ] && echo yes || echo no)"

# Панель промолчала — прежние числа СНИМАЮТСЯ. «Осталось 68 ГБ» от прежней подписки
# выглядит свежим и ничем не отличимо от правды; честное «остатка нет» дешевле.
out="$(CURL_RESP_HDRS='x-hwid-active: true' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "молчание панели не оставляет прежних чисел" ";" \
      "$(printf '%s' "$out" | jget quota);$(rpcd sub_info | jget quota)"

# Заголовок есть, а чисел в нём нет — то же молчание: полоса «осталось 0 из 0» была бы
# выдумкой интерфейса, а не ответом панели.
out="$(CURL_RESP_HDRS='subscription-userinfo: upload=; download=' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
check "заголовок без чисел считается молчанием" "" "$(printf '%s' "$out" | jget quota)"

# sub_quota — обновление остатка БЕЗ подмены подписки. Спрашиваются одни заголовки, файл
# подписки не трогается: метод зовут при открытии обзора, и подменять там узлы нельзя.
out="$(CURL_RESP_HDRS="$USERINFO" rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
sub_before="$(cat "$T/etc/sub.txt")"
rm -f "$T/curl.log" "$T/curl.head.log" "$T/var/vless-dirty"
out="$(CURL_HEAD_HDRS='subscription-userinfo: upload=0; download=214748364800; total=214748364800; expire=1789200000' rpcd sub_quota)"
check "остаток обновлён" "true;true;214748364800" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget asked);$(printf '%s' "$out" | jqget quota down)"
check "спрошены одни заголовки, а не подписка целиком" "1;1" \
      "$(wc -l < "$T/curl.head.log" | tr -d ' ');$(wc -l < "$T/curl.log" | tr -d ' ')"
check "файл подписки не подменён" "$sub_before" "$(cat "$T/etc/sub.txt")"
check "клиента перечитывать не просят" "no" \
      "$([ -f "$T/var/vless-dirty" ] && echo yes || echo no)"

# Панель на HEAD ответила отказом (так делают не все, но делают) — тогда обычная загрузка,
# и она обязана уйти в ВЫБРОСНЫЙ файл, а не поверх подписки.
rm -f "$T/curl.log" "$T/curl.head.log"
# Расход в этом состоянии заведомо МЕНЬШЕ того, что приедет ниже: иначе уменьшение расхода
# само по себе означало бы новый период, и проверка смотрела бы не на то.
out="$(CURL_RESP_HDRS='subscription-userinfo: upload=0; download=1073741824; total=214748364800; expire=1789200000' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
since0="$(printf '%s' "$out" | jqget quota since)"
rm -f "$T/curl.log" "$T/curl.head.log"
out="$(CURL_HEAD_RC=22 CURL_HEAD_HDRS='' CURL_RESP_HDRS="$USERINFO" CURL_BODY='vless://other@host:443#new' rpcd sub_quota)"
check "отказ на HEAD не оставляет остаток непрочитанным" "214748364800" \
      "$(printf '%s' "$out" | jqget quota total)"
check "и подписку это не подменяет" "$sub_before" "$(cat "$T/etc/sub.txt")"
# Найдено на живом роутере: панель отвечала на HEAD отказом, проба снимала файл остатка, а
# загрузка вслед записывала его заново — и точка отсчёта периода переезжала на каждый вызов.
# Вместе с ней терялся измеренный темп расхода, который набирается сутками, поэтому «в среднем
# в сутки» на обзоре не появлялось никогда.
check "отказ на HEAD не сдвигает точку отсчёта периода" "$since0" \
      "$(printf '%s' "$out" | jqget quota since)"
# То же и для ответа БЕЗ чисел: проба прошла, но сказать ей нечего — решает загрузка.
rm -f "$T/curl.log" "$T/curl.head.log"
out="$(CURL_HEAD_HDRS='x-hwid-active: true' CURL_RESP_HDRS="$USERINFO" rpcd sub_quota)"
check "проба без чисел не сдвигает точку отсчёта" "$since0" \
      "$(printf '%s' "$out" | jqget quota since)"

# Узлы вставлены ссылками vless:// — спрашивать некого, и это не отказ: человек ничего не
# сделал не так, а кнопка «Обновить» у ссылки лишена смысла ровно по той же причине.
out="$(rpcd sub_set '{"url":"vless://key@host:443#node"}')"
rm -f "$T/curl.log"
out="$(rpcd sub_quota)"
check "для ссылок vless:// остаток не выдумывается" "true;false;no" \
      "$(printf '%s' "$out" | jget ok);$(printf '%s' "$out" | jget asked);$([ -f "$T/curl.log" ] && echo yes || echo no)"
check "и сказано, почему" "yes" \
      "$(printf '%s' "$out" | jget why | grep -q 'сообщает панель' && echo yes || echo no)"

# Начало периода панель не сообщает, а без него средний расход в сутки не посчитать. Оно
# запоминается ПЕРВЫМ наблюдением и переносится дальше как есть — иначе темп считался бы от
# каждого нового опроса и был бы тем меньше, чем чаще смотрят.
rm -f "$T/etc/sub.userinfo"
out="$(CURL_RESP_HDRS='subscription-userinfo: upload=0; download=1073741824; total=214748364800; expire=1789200000' rpcd sub_set '{"url":"https://panel.invalid/sub/abc"}')"
since1="$(printf '%s' "$out" | jqget quota since)"
check "первое наблюдение периода запомнено" "yes;1073741824" \
      "$([ "$since1" -gt 0 ] 2>/dev/null && echo yes || echo no);$(printf '%s' "$out" | jqget quota since_used)"
out="$(CURL_HEAD_HDRS='subscription-userinfo: upload=0; download=3221225472; total=214748364800; expire=1789200000' rpcd sub_quota)"
check "точка отсчёта не переносится на каждый опрос" "$since1;1073741824" \
      "$(printf '%s' "$out" | jqget quota since);$(printf '%s' "$out" | jqget quota since_used)"
# Сменился срок — период новый, и точка отсчёта обязана переехать: иначе темп считался бы
# по расходу, которого в этом периоде не было.
out="$(CURL_HEAD_HDRS='subscription-userinfo: upload=0; download=104857600; total=214748364800; expire=1791792000' rpcd sub_quota)"
check "смена срока начинает период заново" "104857600" \
      "$(printf '%s' "$out" | jqget quota since_used)"
# Панель обнулила расход, не меняя срок, — это тоже новый период.
out="$(CURL_HEAD_HDRS='subscription-userinfo: upload=0; download=1048576; total=214748364800; expire=1791792000' rpcd sub_quota)"
check "обнуление расхода начинает период заново" "1048576" \
      "$(printf '%s' "$out" | jqget quota since_used)"

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
      "$(grep -q '^fetch_missing_lists()' "$SCRIPT" && echo yes || echo no)"
# Мест стало три: к spec_set и apply добавилось восстановление из архива (backup_put) —
# оно тоже проверяет спеку компилятором, а на чистом роутере зеркал категорий ещё нет, и в
# архив они намеренно не едут. Проверка на число, а не на перечень имён: имена ниже.
check "функция вызывается трижды: spec_set, apply, backup_put" "3" \
      "$(grep -c 'fetch_missing_lists "' "$SCRIPT")"
set_line=$(grep -n 'set_warn="$(fetch_missing_lists' "$SCRIPT" | cut -d: -f1)
dry_line=$(grep -n 'apply --dry-run --spec "$tmp"' "$SCRIPT" | cut -d: -f1)
check "в spec_set загрузка идёт ДО проверки движком" "yes" \
      "$([ -n "$set_line" ] && [ -n "$dry_line" ] && [ "$set_line" -lt "$dry_line" ] && echo yes || echo no)"
# Порядок ищется ВНУТРИ ветки, а не по всему файлу: `fetch_warn=` встречается и в apply, и
# в backup_put, и общий `grep -n` отдал бы два номера строк, на которых `[` спотыкается о
# «Illegal number». Расхождение такого рода стенд однажды уже прятал.
apply_body="$(sed -n '/^    apply)/,/^        ;;/p' "$SCRIPT")"
apply_fetch=$(printf '%s\n' "$apply_body" | grep -n 'fetch_missing_lists' | head -1 | cut -d: -f1)
apply_run=$(printf '%s\n' "$apply_body" | grep -n 'apply --spec "$SPEC" 2>&1)"; rc=' | head -1 | cut -d: -f1)
check "в apply загрузка идёт ДО применения" "yes" \
      "$([ -n "$apply_fetch" ] && [ -n "$apply_run" ] && [ "$apply_fetch" -lt "$apply_run" ] && echo yes || echo no)"
put_body="$(sed -n '/^    backup_put)/,/^        ;;/p' "$SCRIPT")"
put_fetch=$(printf '%s\n' "$put_body" | grep -n 'fetch_missing_lists' | head -1 | cut -d: -f1)
put_dry=$(printf '%s\n' "$put_body" | grep -n 'apply --dry-run --spec "$D/spec"' | head -1 | cut -d: -f1)
check "в восстановлении загрузка идёт ДО проверки движком" "yes" \
      "$([ -n "$put_fetch" ] && [ -n "$put_dry" ] && [ "$put_fetch" -lt "$put_dry" ] && echo yes || echo no)"
# Сообщение об отказе обязано называть ПРИЧИНУ, а не только следствие: «cannot read a
# channel's list» отправляет искать испорченный файл, которого никогда не было.
check "при неудачной загрузке причина ставится перед ошибкой движка" "yes" \
      "$(grep -q 'fail "${set_warn:+$set_warn; }' "$SCRIPT" && echo yes || echo no)"

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

doc="$(backup_doc)"
check "архив приезжает несколькими кусками и склеивается" "yes" \
      "$([ "$(cat "$T/doc-parts")" -gt 1 ] && echo yes || echo no)"
check "склеенный архив не потерял ни строки на границах кусков" "1200" \
      "$(printf '%s\n' "$doc" | grep -c '^host[0-9]*\.example$')"
check "архив начинается своим заголовком с версией" "splify2-backup 1" \
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
      "$(grep -q 'opkg list-installed' "$SCRIPT" && echo yes || echo no)"
check "установка идёт через обёртку, а не через apk напрямую" "0" \
      "$(sed -n '/^pkg_install()/,$p' "$SCRIPT" | grep -c 'apk add\|apk del')"
check "имена файлов пакетов зависят от менеджера" "yes" \
      "$(grep -q 'pkg_ext)' "$SCRIPT" && grep -q 'pkg_noarch)' "$SCRIPT" && echo yes || echo no)"

# ---- заголовки об устройстве чистятся ПОД BUSYBOX, а не под coreutils ------------
#
# Проверка запускается busybox явно, и это единственный способ её осмыслить: у coreutils
# `tr -cd '[:print:]'` работает, у busybox — НЕТ, он классов не знает и разбирает их как
# обычный набор символов. Стенд на машине разработчика поэтому и не заметил, как
# «TP-Link Archer C6U v1» уезжал в панель строкой «inrr», а «OpenWrt 25.12.5» — строкой
# «pnrt»: на GNU tr обе строки проходят целиком.
#
# Функция берётся ИЗ САМОГО СКРИПТА, а не переписывается здесь: копия проверяла бы копию.
if command -v busybox >/dev/null 2>&1; then
    sed -n '/^hdr_clean()/,/^}/p' "$SCRIPT" > "$T/hdr_clean.sh"
    printf '%s\n' 'hdr_clean "$1"' >> "$T/hdr_clean.sh"
    check "модель роутера не искажается чисткой (busybox)" "TP-Link Archer C6U v1" \
          "$(busybox sh "$T/hdr_clean.sh" 'TP-Link Archer C6U v1')"
    check "версия системы не искажается чисткой (busybox)" "OpenWrt 25.12.5" \
          "$(busybox sh "$T/hdr_clean.sh" 'OpenWrt 25.12.5')"
    # Кириллица выбрасывается намеренно: в заголовке HTTP она приезжает панели байтами
    # UTF-8 и показывается там мусором, поэтому лучше её отсутствие.
    check "кириллица в модели выбрасывается (busybox)" "AX3000T" \
          "$(busybox sh "$T/hdr_clean.sh" 'тестAX3000T')"
    # И то, ради чего чистка вообще существует: перевод строки внутри значения — это
    # вставка чужого заголовка в запрос.
    check "перевод строки не проходит в заголовок (busybox)" "aaaX-Evil: 1" \
          "$(busybox sh "$T/hdr_clean.sh" "$(printf 'aaa\nX-Evil: 1')")"
else
    printf 'busybox нет — чистку заголовков проверить нечем, пропускаю\n'
fi

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

mv "$T/bin/uci.stub" "$T/bin/uci"

printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'все проверки прошли' || echo "ЕСТЬ ПРОВАЛЫ: $fails")"
[ "$fails" -eq 0 ]
