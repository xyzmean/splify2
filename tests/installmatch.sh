#!/bin/sh
# Установщик splify2: определение версии (оба пути и оба отказа) и обнаружение splify
# первой версии на том же роутере.
#
# Зачем отдельный стенд. Однострочный установщик — заявленный основной способ установки,
# и версию он спрашивал ровно в одном месте: у api.github.com. У аудитории splify2 этот
# хост недоступен чаще, чем сам github.com — его блокируют отдельно, а за CGNAT
# неавторизованный лимит API (60 запросов в час на адрес) выбирают соседи. Тогда установка
# падала на «не удалось узнать версию движка (нет релизов?)», хотя релиз и пакет под
# нужную архитектуру существовали: splify2#5, два человека на mipsel_24kc, оба поставили
# те же самые пакеты руками. Находка I-058, roadmap R-048.
#
# Как проверяется. Функция latest() достаётся из install.sh текстом и выполняется в этой
# оболочке — тот же приём, что у dnsmatch.c и submatch.c в steer («файл включает
# исходник»): установщик целиком запускать нельзя, он поставит пакеты. wget подменяется
# заглушкой в PATH, и каждый случай задаёт ответы обоих хостов по отдельности.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0 fail=0
check() {
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  получено:  %s\n' "$1" "$2" "$3"
    fi
}

SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT INT TERM
mkdir -p "$SB/bin"

# Заглушка wget: отвечает из файлов по признаку хоста в URL. Отсутствие файла — это
# «хост не ответил»: пустой вывод и ненулевой код, как у настоящего wget -q.
cat > "$SB/bin/wget" <<'STUB'
#!/bin/sh
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
echo "$url" >> "$SB/wget.log"
case "$url" in
    # contents API — отдельная ветка: это ТРЕТИЙ путь к версии, и смешивать его с
    # ответом про релизы значило бы проверять «api ответил» вместо «ответил чем».
    *api.github.com*contents*) f="$SB/resp-contents" ;;
    *api.github.com*)          f="$SB/resp-api" ;;
    *raw.githubusercontent*)   f="$SB/resp-raw" ;;
    *gitlab.com*)              f="$SB/resp-mirror" ;;
    *codeload.github.com*)     f="$SB/resp-codeload" ;;
    *)                         exit 1 ;;
esac
[ -f "$f" ] || exit 1
# Файл, а не поток: архив ветки уезжает в файл (-qO ФАЙЛ), и cat в stdout его бы испортил.
outf=""
prev=""
for a in "$@"; do
    [ "$prev" = "-qO" ] && outf="$a"
    prev="$a"
done
if [ -n "$outf" ] && [ "$outf" != "-" ]; then cat "$f" > "$outf"; else cat "$f"; fi
STUB
chmod +x "$SB/bin/wget"
PATH="$SB/bin:$PATH"
export SB

# Сама проверяемая функция. Вместе с ней берутся и переменные хостов: если API или RAW
# в install.sh переименуют, стенд упадёт здесь, а не молча начнёт проверять пустоту.
# Вместе с latest() достаётся и обход по хостам самого GitHub: третий путь к версии
# идёт через него, и без этих функций стенд проверял бы отказ вместо обхода.
eval "$(sed -n '/^API=/p; /^RAW=/p; /^CODELOAD=/p; /^MIRROR=/p; /^DIST_BRANCH=/p; /^info()/p; /^gl_file() {/,/^}/p; /^gh_api_file() {/,/^}/p; /^gh_tarball() {/,/^}/p; /^gh_file() {/,/^}/p; /^latest() {/,/^}/p; /^fetch() {/,/^}/p; /^dl_url() {/,/^}/p' "$ROOT/install.sh")"
TMP="$SB/tmp"; mkdir -p "$TMP"
die() { printf 'die: %s\n' "$*" >&2; return 1; }
check "функция latest достана из install.sh" "latest" "$(command -v latest >/dev/null && echo latest)"

# ---- обычный путь: API отвечает -----------------------------------------------
printf '{"tag_name": "v1.2.3", "name": "x"}\n' > "$SB/resp-api"
printf '9.9.9\n' > "$SB/resp-raw"
check "версия берётся из релиза" "1.2.3" "$(latest xyzmean/steer 2>/dev/null)"

# ---- api.github.com недоступен ------------------------------------------------
# Ровно случай splify2#5: API молчит, github.com и raw доступны, релиз существует.
rm -f "$SB/resp-api"
check "API молчит — версия берётся из VERSION в main" "1.1.2" \
    "$(printf '1.1.2\n' > "$SB/resp-raw"; latest xyzmean/steer 2>/dev/null)"
check "переход на второй путь объявлен вслух" "1" \
    "$(latest xyzmean/steer 2>&1 >/dev/null | grep -c 'api.github.com не ответил')"
# Объяснение обязано идти в stderr: stdout функции — это сама версия, и строка в нём
# уехала бы в имя файла пакета.
check "объяснение не попало в stdout" "1.1.2" "$(latest xyzmean/steer 2>/dev/null)"

# ---- лимит API: 403 вместо релиза ---------------------------------------------
# Тело ответа есть, tag_name в нём нет — это не «пусто», а именно ответ про лимит.
printf '{"message": "API rate limit exceeded for 203.0.113.7."}\n' > "$SB/resp-api"
check "403 про лимит не читается как версия" "1.1.2" "$(latest xyzmean/steer 2>/dev/null)"

# ---- оба пути молчат ----------------------------------------------------------
rm -f "$SB/resp-api" "$SB/resp-raw"
check "оба хоста молчат — версии нет" "" "$(latest xyzmean/steer 2>/dev/null)"

# ---- мусор в VERSION ---------------------------------------------------------
# Пустая версия честнее подставленного мусора: с ним установщик пошёл бы качать файл с
# именем, которого нет, и сказал бы «не скачалось» вместо «не узнал версию».
printf 'dev\n' > "$SB/resp-raw"
check "нечисловой VERSION версией не считается" "" "$(latest xyzmean/steer 2>/dev/null)"
printf ' 1.0.0-rc1\n' > "$SB/resp-raw"
check "версия с хвостом обрезается до чисел" "1.0.0" "$(latest xyzmean/steer 2>/dev/null)"

# ---- закрыт githubusercontent: третий путь к версии и к пакету -----------------
#
# splify2#15. `raw.` и `release-assets.` — это одни и те же адреса Fastly, поэтому у
# человека с закрытым `githubusercontent.com` отваливались РАЗОМ второй путь к версии и
# скачивание самих пакетов: splify2 нельзя было ни поставить, ни обновить. Хосты самого
# GitHub при этом работают, и оба умеют отдать файл из ветки.
rm -f "$SB/resp-api" "$SB/resp-raw" "$SB/resp-codeload" "$SB/resp-contents"
printf '2.0.0\n' > "$SB/resp-mirror"
check "версия взята с зеркала, когда молчат и релизы, и raw" "2.0.0" \
    "$(latest xyzmean/steer 2>/dev/null)"
check "к хостам GitHub при живом зеркале не ходили" "" \
    "$(: > "$SB/wget.log"; latest xyzmean/steer >/dev/null 2>&1; grep -c 'codeload\|contents' "$SB/wget.log" | sed 's/^0$//')"
rm -f "$SB/resp-mirror"

printf '2.0.1\n' > "$SB/resp-contents"
check "версия взята через contents API, когда молчат и релизы, и raw" "2.0.1" \
    "$(latest xyzmean/steer 2>/dev/null)"
check "третий путь объявлен вслух" "1" \
    "$(latest xyzmean/steer 2>&1 >/dev/null | grep -c 'contents API')"

# contents API тоже молчит (лимит 60 в час за CGNAT) — остаётся архив ветки.
rm -f "$SB/resp-contents" "$TMP"/*.tgz
mkdir -p "$SB/tar/steer-main"
printf '2.0.2\n' > "$SB/tar/steer-main/VERSION"
( cd "$SB/tar" && tar -czf "$SB/resp-codeload" steer-main )
check "версия вынута из архива ветки, когда молчит и contents API" "2.0.2" \
    "$(latest xyzmean/steer 2>/dev/null)"

# Пакет: прямая ссылка релиза не отдаёт (перенаправление на release-assets), тот же файл
# лежит в ветке dist.
rm -f "$TMP"/*.tgz
mkdir -p "$SB/tar2/steer-dist"
printf 'PKG\n' > "$SB/tar2/steer-dist/steer-2.0.2-1_x86_64.apk"
( cd "$SB/tar2" && tar -czf "$SB/resp-codeload" steer-dist )
rm -f "$SB/resp-contents"
url="$(dl_url xyzmean/steer 2.0.2 steer-2.0.2-1_x86_64.apk)"
printf 'PKG-MIRROR\n' > "$SB/resp-mirror"
check "прямая ссылка релиза не отдала — пакет берётся с зеркала" "PKG-MIRROR" \
    "$(fetch "$url" "$SB/pkg2.apk" xyzmean/steer steer-2.0.2-1_x86_64.apk >/dev/null 2>&1; cat "$SB/pkg2.apk" 2>/dev/null)"
rm -f "$SB/resp-mirror"
check "зеркало молчит — тогда ветка dist через хосты GitHub" "PKG" \
    "$(fetch "$url" "$SB/pkg.apk" xyzmean/steer steer-2.0.2-1_x86_64.apk >/dev/null 2>&1; cat "$SB/pkg.apk" 2>/dev/null)"
rm -f "$SB/resp-codeload" "$TMP"/*.tgz

# ---- отказ называет оба хоста -------------------------------------------------
# Сообщение «нет релизов?» отправляло человека искать релиз, которого не было только у
# него в сети. Проверяется, что в отказе названы оба источника и ручной путь.
for what in движка интерфейса; do
    check "отказ по версии $what называет все источники" "1" \
        "$(grep -c "не удалось узнать версию $what: не ответили ни api.github.com, ни raw.githubusercontent.com, ни зеркало на gitlab.com" "$ROOT/install.sh")"
done
check "отказ ведёт на страницу релизов" "2" \
    "$(grep -c 'Пакеты\|Пакет можно поставить руками' "$ROOT/install.sh")"

# ---- обнаружение splify первой версии (R-018) ----------------------------------
#
# Зачем стенд именно здесь. Обнаружение по НЕВЕРНОМУ признаку хуже отсутствия
# обнаружения: оно пугает человека, у которого ничего лишнего не стоит, и первым делом
# оно рискует опознать как «первую версию» наши же пакеты — имена у них однокоренные
# (`luci-app-splify2` против `luci-app-splify`). Поэтому главная проверка здесь — не
# «нашёл», а «на чистом роутере со splify2 не нашёл ничего».
#
# Как проверяется. Функции обнаружения достаются из install.sh тем же приёмом, что и
# latest() выше. Файловые признаки ищутся не в настоящем `/`, а в песочнице: в
# install.sh для этого есть шов V1ROOT, пустой на роутере. Пакеты, команды и nft
# подменяются заглушками в PATH.
V1BOX="$SB/root"
mkdir -p "$V1BOX/etc/init.d" "$V1BOX/usr/share/nftables.d/ruleset-post"
V1ROOT="$V1BOX"
PM=apk

# apk: список установленного берётся из файла, чтобы каждый случай задавал свой.
cat > "$SB/bin/apk" <<'STUB'
#!/bin/sh
[ -f "$SB/pkglist" ] && cat "$SB/pkglist"
exit 0
STUB
# nft: успех только для того набора, который назван в файле. Так проверяется, что
# смотрят именно на набор первой версии, а не на факт наличия nft.
cat > "$SB/bin/nft" <<'STUB'
#!/bin/sh
want="$(cat "$SB/nftset" 2>/dev/null)"
[ -n "$want" ] || exit 1
for a in "$@"; do [ "$a" = "$want" ] && exit 0; done
exit 1
STUB
chmod +x "$SB/bin/apk" "$SB/bin/nft"

eval "$(sed -n '/^V1ROOT=/p; /^V1_SIGNS=/p; /^v1_add() {/,/^}/p; /^v1_scan() {/,/^}/p; /^pm_installed() {/,/^}/p' "$ROOT/install.sh")"
check "функция v1_scan достана из install.sh" "v1_scan" "$(command -v v1_scan >/dev/null && echo v1_scan)"
check "песочница подставилась вместо корня" "$V1BOX" "$V1ROOT"

scan() { V1_SIGNS=""; v1_scan; printf '%s' "$V1_SIGNS"; }

# ---- чистый роутер со splify2: ни одного признака ------------------------------
# Ровно тот случай, в котором ложное срабатывание было бы виднее всего: наши пакеты
# однокоренные с пакетами первой версии, и наивный `grep splify` опознал бы их.
printf '%s\n' 'luci-app-splify2-1.1.1-r1 noarch {luci-app-splify2} (GPL-2.0)' \
               'steer-extended-1.1.2-r1 aarch64_cortex-a53 {steer-extended} (GPL-2.0)' \
               'nftables-1.0.9-r2 aarch64_cortex-a53 {nftables} (GPL-2.0)' > "$SB/pkglist"
check "свои пакеты за первую версию не принимаются" "" "$(scan)"

# ---- пакет первой версии -------------------------------------------------------
# Имя пакета v1 нигде не записано, поэтому шаблон описывает родство, а не имя: любой
# установленный пакет со splify в имени, кроме наших. Проверяются оба вероятных вида.
printf '%s\n' 'luci-app-splify2-1.1.1-r1 noarch {luci-app-splify2} (GPL-2.0)' \
               'luci-app-splify-1.0.3-r1 all {luci-app-splify} (GPL-2.0)' > "$SB/pkglist"
check "пакет luci-app-splify опознан" "  - пакет luci-app-splify" "$(scan)"
printf '%s\n' 'splify-1.0.3-r1 aarch64_cortex-a53 {splify} (GPL-2.0)' > "$SB/pkglist"
check "пакет splify опознан" "  - пакет splify" "$(scan)"

printf '%s\n' 'luci-app-splify2-1.1.1-r1 noarch {luci-app-splify2} (GPL-2.0)' > "$SB/pkglist"

# ---- службы (i18n.ts:430,463) --------------------------------------------------
: > "$V1BOX/etc/init.d/splify"
check "служба /etc/init.d/splify опознана" "  - служба /etc/init.d/splify" "$(scan)"
: > "$V1BOX/etc/init.d/splify-agent"
check "агент удалённого управления опознан отдельной строкой" "2" "$(scan | grep -c 'служба')"
rm -f "$V1BOX/etc/init.d/splify" "$V1BOX/etc/init.d/splify-agent"

# ---- команды (i18n.ts:287-479) -------------------------------------------------
printf '#!/bin/sh\n' > "$SB/bin/splify-apply"; chmod +x "$SB/bin/splify-apply"
check "команда splify-apply опознана" "  - команда splify-apply" "$(scan)"
rm -f "$SB/bin/splify-apply"

# ---- наборы nft в общей таблице fw4 (steer/src/dnsd.c:3,773,2028) --------------
printf 'splify_vpn_v4\n' > "$SB/nftset"
check "набор splify_vpn_v4 в inet fw4 опознан" "  - набор nft inet fw4 splify_vpn_v4" "$(scan)"
# Наличие самого nft признаком не является: иначе сработало бы на любом OpenWrt.
printf 'steer_direct_v4\n' > "$SB/nftset"
check "чужой набор в fw4 признаком не считается" "" "$(scan)"
rm -f "$SB/nftset"

# ---- файл правил 30-splify.nft (i18n.ts:477) ----------------------------------
# Имя файла известно точно, каталог — по соглашению OpenWrt, поэтому маска, а не путь.
: > "$V1BOX/usr/share/nftables.d/ruleset-post/30-splify.nft"
check "файл правил 30-splify.nft опознан" "1" "$(scan | grep -c '30-splify.nft')"
rm -f "$V1BOX/usr/share/nftables.d/ruleset-post/30-splify.nft"

# ---- несколько признаков разом -------------------------------------------------
: > "$V1BOX/etc/init.d/splify"
printf 'splify_fakeip_map\n' > "$SB/nftset"
printf '%s\n' 'splify-1.0.3-r1 aarch64_cortex-a53 {splify} (GPL-2.0)' > "$SB/pkglist"
check "перечисляется всё найденное, а не первое" "3" "$(scan | grep -c '  - ')"
rm -f "$V1BOX/etc/init.d/splify" "$SB/nftset"

# ---- что установщик делает с находкой ------------------------------------------
# Главное ограничение из roadmap (R-018, риск): автоматическое удаление чужой
# настройки недопустимо. Проверяется буквально — в установщике нет ни одной команды
# удаления пакета или файлов.
check "установщик ничего не удаляет" "0" \
    "$(grep -c 'apk del\|opkg remove\|rm -rf /etc\|uci -q delete' "$ROOT/install.sh")"
check "сказано, что удаление и перенос — не его дело" "1" \
    "$(grep -c 'ничего из первой версии не удаляет и не переносит' "$ROOT/install.sh")"
# Обе ветки обязаны существовать: с терминалом человек решает сам, без терминала
# (`sh -c "$(wget -qO- ...)"` из скрипта) спрашивать некого, и упереться в вопрос там
# значило бы не установиться вовсе.
check "с терминалом спрашивают разрешение продолжить" "1" \
    "$(grep -c 'Продолжить установку splify2?' "$ROOT/install.sh")"
check "без терминала установка не упирается в вопрос" "1" \
    "$(grep -c 'Запуск без терминала — спросить некого' "$ROOT/install.sh")"
# Предупреждение повторяется в финале: без терминала первое уезжает за экран, и
# «Готово.» читается как «всё чисто».
check "в финале напоминают о первой версии" "1" \
    "$(grep -c 'Первая версия splify осталась на роутере' "$ROOT/install.sh")"

# README — второе место, куда приходит человек с первой версией, и там же названы
# признаки: без них совет «выключите первую версию» не выполним.
check "README объясняет, что делать с первой версией" "да" \
    "$(grep -qF 'Если на роутере стоит splify первой версии' "$ROOT/README.md" && echo да || echo нет)"
check "README называет ту же таблицу, что и установщик" "да" \
    "$(grep -qF 'inet fw4' "$ROOT/README.md" && echo да || echo нет)"

# ---- вес вариантов движка назван и совпадает везде (R-044) ---------------------
# Варианты уже были и в установщике, и в интерфейсе, но снаружи их просили как
# отсутствующие: вес был назван только у расширенного и только словами «больше на».
# Риск теперь другой — что три места разойдутся в числах, поэтому они и сверяются.
has() { grep -qF "$2" "$ROOT/$1" && echo да || echo нет; }
for f in install.sh ui/src/components/EngineCard.tsx; do
    check "вес расширенного назван в $f" "да" "$(has "$f" 'флеше ~500 КБ')"
    check "вес базового назван в $f" "да" "$(has "$f" 'флеше ~250 КБ')"
done
check "README называет пакет расширенного варианта" "да" "$(has README.md '(`steer-extended`)')"
check "README называет пакет базового варианта" "да" "$(has README.md '(`steer`)')"
for r in '240–270 КБ' '470–590 КБ' '110–125 КБ' '220–295 КБ'; do
    check "README называет размеры: $r" "да" "$(has README.md "$r")"
done
check "README говорит, где переключить вариант потом" "да" \
    "$(has README.md 'Выбор не окончательный')"

printf '\n%d проверок пройдено\n' "$pass"
if [ "$fail" -gt 0 ]; then
    printf 'ПРОВАЛЕНО: %d\n' "$fail"
    exit 1
fi
printf 'все проверки прошли\n'
