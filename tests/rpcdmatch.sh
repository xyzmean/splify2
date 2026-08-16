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
        printf '[{"tag_name": "v0.9.6"},{"tag_name": "v0.9.5-rc1"},{"tag_name": "v0.9.4"},{"tag_name": "nightly"}]\n'
        ;;
    *)
        [ -n "$out" ] && echo "пакет" > "$out"
        ;;
esac
exit 0
EOF

# jsonfilter: поддерживаются те выражения, которые встречаются на проверяемых путях.
cat > "$T/bin/jsonfilter" <<'EOF'
#!/bin/sh
file=""; str=""; expr=""
while [ $# -gt 0 ]; do
    case "$1" in
        -i) file="$2"; shift 2 ;;
        -s) str="$2"; shift 2 ;;
        -e) expr="$2"; shift 2 ;;
        *) shift ;;
    esac
done
python3 - "$file" "$str" "$expr" <<'PY'
import json, re, sys
path, raw, expr = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.loads(raw) if raw else json.load(open(path, encoding='utf-8'))
except Exception:
    sys.exit(1)
m = re.match(r"@\.(categories|domain_lists)\[@\.id='([^']*)'\]\.file$", expr)
if m:
    for e in d.get(m.group(1), []):
        if e.get('id') == m.group(2):
            print(e['file'])
    sys.exit(0)
m = re.match(r'@\.([A-Za-z_]+)$', expr)
if m:
    v = d.get(m.group(1))
    if v is not None:
        print(v if not isinstance(v, bool) else ('true' if v else 'false'))
PY
EOF

printf '#!/bin/sh\nexit 0\n' > "$T/bin/logger"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/uci"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/ubus"
# curl: им ходит download(), то есть и списки издателя, и «свой список по ссылке».
# Протокол отдельный от wget: через wget идут пакеты и GitHub API, и смешивать их в
# одном журнале значило бы проверять «что-то скачалось» вместо «скачалось это».
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
echo "$url" >> "$SANDBOX/curl.log"
[ -n "$out" ] && printf 'remote.example\n10.1.0.0/16\n' > "$out"
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/bin/steer"
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

# ---- вызов настоящего скрипта -------------------------------------------------
# Один вход на все проверки: разница между ними — только в фикстурах и переменных.
rpcd() {  # МЕТОД [JSON_ЗАПРОСА]  — вызов метода; для перечня методов есть rpcd_list
    printf '%s\n' "${2:-}" | env \
        SANDBOX="$T" \
        PATH="$T/bin:$PATH" \
        JSHN_SH="$ROOT/tests/stub/jshn.sh" \
        STEER="$T/bin/steer" \
        SPEC="$T/etc/spec.json" \
        LISTS="$T/lists" \
        SUB="$T/etc/sub.txt" \
        MANIFEST="$T/etc/manifest.json" \
        INITD="$T/bin/initd-steer" \
        RPCD_INITD="$T/bin/initd-rpcd" \
        OPENWRT_RELEASE="${OPENWRT_RELEASE_FIXTURE:-$T/etc/openwrt_release}" \
        VLESS_DIRTY="$T/var/vless-dirty" \
        APK_ADD_RC="${APK_ADD_RC:-0}" \
        APK_ADD_OUT="${APK_ADD_OUT:-}" \
        ENGINE_ENABLED="${ENGINE_ENABLED:-0}" \
        sh "$SCRIPT" call "$1" 2>"$T/stderr"
}

rpcd_list() {
    env SANDBOX="$T" PATH="$T/bin:$PATH" JSHN_SH="$ROOT/tests/stub/jshn.sh" \
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
check "теги не вида X.Y.Z до выпадающего списка не доходят (I-052)" \
      '["0.9.6", "0.9.4"]' "$(printf '%s' "$out" | jget versions)"

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
check "теги не вида X.Y.Z отсеиваются и здесь (R-042)" \
      '["0.9.6", "0.9.4"]' "$(printf '%s' "$out" | jget versions)"
check "установленная версия названа, чтобы было с чем сравнить (R-042)" \
      "0.7.6" "$(printf '%s' "$out" | jget current)"

reset_logs
out="$(rpcd splify2_install '{"version":"0.7.7"}')"
check "качается noarch-пакет интерфейса (R-042)" \
      "https://github.com/xyzmean/splify2/releases/download/v0.7.7/luci-app-splify2-0.7.7-1_noarch.apk" \
      "$(grep 'luci-app-splify2' "$T/wget.log" | head -1)"
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
      "" "$(grep -c . "$T/wget.log" 2>/dev/null | sed 's/^0$//')"

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
check "spec_set помечает смену НАБОРА выходов vless как instances" "instances" \
      "$(grep -A4 'vless_before_n" != "\$vless_after_n' "$SCRIPT" | grep -o 'instances' | head -1)"
check "apply пересобирает экземпляры на instances" "yes" \
      "$(grep -A22 'if \[ -f "\$VLESS_DIRTY" \]' "$SCRIPT" | grep -q '"\$INITD" start' && echo yes || echo no)"

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

printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'все проверки прошли' || echo "ЕСТЬ ПРОВАЛЫ: $fails")"
[ "$fails" -eq 0 ]
