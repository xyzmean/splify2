#!/bin/sh
# Каталог стратегий обхода DPI: превращение стратегий Flowseal в ключи nfqws, разбор
# стратегий `v` и `Dv` из скрипта Zapret Manager, отметка активной стратегии и обновление
# каталога.
#
# ЗАЧЕМ ЭТОТ СТЕНД. Здесь два десятка замен `sed`, перенесённых из чужого скрипта, и ошибка в
# любой из них молчит: каталог собирается, список стратегий в интерфейсе полон, стратегия
# применяется — и не действует, потому что путь к файлу-подделке остался виндовым (%BIN%…) или
# фильтр вычеркнулся вместе с профилем. Увидеть это можно только по тому, что сайт не
# открылся, то есть не увидеть вовсе.
#
# ОБРАЗЕЦ ЖДЁТ РЯДОМ, СЕТИ НЕ НУЖНО. tests/zapret/general.bat — настоящий файл Flowseal,
# tests/zapret/general.expected — то, во что его превращает ДОСЛОВНЫЙ перенос
# download_strategies из Zapret-Manager.sh (сверено прогоном обоих на всех 21 стратегиях
# ветки main: расхождений ноль). То есть стенд стоит не на нашем представлении о правильном
# ответе, а на ответе первоисточника.
#
# Архив для проверки пути «скачали — распаковали» СОБИРАЕТСЯ ЗДЕСЬ ЖЕ из тех же образцов:
# держать в репозитории двоичный .tgz значило бы держать файл, который никто не прочитает.
set -u
cd "$(dirname "$0")/.." || exit 2
LIB=files/usr/lib/splify2/zapret.sh
FIX=tests/zapret
[ -s "$LIB" ] || { echo "нет $LIB"; exit 2; }

pass=0 fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  вышло:     %s\n' "$1" "$2" "$3"
    fi
}

# Заглушка скачивания вместо download() из fetch.sh: отдаёт образцы вместо сети. Ровно тот
# же шов, которым пользуются остальные стенды пакета.
download() {
    case "$1" in
        *codeload*)           cp "$tmp/flowseal.tgz" "$2" ;;
        *Zapret-Manager.sh)   cp "$FIX/zm-snippet.sh" "$2" ;;
        *StrYoutube)          cp "$FIX/StrYoutube" "$2" ;;
        *)                    return 1 ;;
    esac
    [ -s "$2" ]
}

# Архив в том же виде, в каком его отдаёт codeload: верхний каталог «репозиторий-ветка».
mkdir -p "$tmp/zapret-discord-youtube-main/bin"
cp "$FIX/general.bat" "$tmp/zapret-discord-youtube-main/general.bat"
cp "$FIX/general (ALT5).bat" "$tmp/zapret-discord-youtube-main/general (ALT5).bat"
printf 'подделка\n' > "$tmp/zapret-discord-youtube-main/bin/stun2.bin"
( cd "$tmp" && tar -czf flowseal.tgz zapret-discord-youtube-main ) || exit 2

ZP_DIR="$tmp/state"
ZP_CATALOG="$ZP_DIR/strategies.txt"
ZP_STAMP="$ZP_DIR/updated"
ZP_OPTS_DIR="$tmp/opts"
ZP_CONF="$tmp/zapret.conf"
ZP_NFQWS="$tmp/nfqws-none"
ZP_FAKE_DIR="$tmp/fake"
mkdir -p "$ZP_FAKE_DIR"
# Служба zapret стенда: init-скрипт записывает команды, а ссылка автозапуска — настоящая,
# в своём rc.d. Так проверяется и порядок команд, и то, что «выключен» читается по ссылке.
ZP_INIT="$tmp/init-zapret"
ZP_RCD="$tmp/rcd"
mkdir -p "$ZP_RCD"
cat > "$ZP_INIT" <<EOF
#!/bin/sh
echo "\$1" >> "$tmp/init.log"
case "\$1" in
    enable)  ln -sf "$ZP_INIT" "$ZP_RCD/S21zapret" ;;
    disable) rm -f "$ZP_RCD/S21zapret" ;;
esac
EOF
chmod +x "$ZP_INIT"
# uci стенда: помнит один ключ — zapret.config.run_on_boot — в файле. Ключ появляется у
# обёртки remittor и без него ссылка в rc.d ещё не значит «встанет после перезагрузки».
mkdir -p "$tmp/bin"
cat > "$tmp/bin/uci" <<EOF
#!/bin/sh
case "\$*" in
    *"get zapret.config.run_on_boot") cat "$tmp/run_on_boot" 2>/dev/null ;;
    *"set zapret.config.run_on_boot="*) printf '%s\n' "\${*##*=}" > "$tmp/run_on_boot" ;;
    *commit*) : ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/uci"
PATH="$tmp/bin:$PATH"
. "$LIB"

# ---- сборка каталога ---------------------------------------------------------
mkdir -p "$ZP_DIR"
zp_build "$ZP_CATALOG" >/dev/null 2>&1
check "каталог собрался" "0" "$?"

# Источники складываются: стратегии Flowseal, `v` и `Dv` из скрипта менеджера, `Yv` из его
# файла.
check "стратегий в каталоге" "7" "$(grep -c '^#' "$ZP_CATALOG")"
check "Flowseal взят" "1" "$(grep -c '^#general$' "$ZP_CATALOG")"
check "v взяты" "2" "$(grep -c '^#v[0-9]' "$ZP_CATALOG")"
check "Yv взяты" "2" "$(grep -c '^#Yv' "$ZP_CATALOG")"
check "Dv взяты" "2" "$(grep -c '^#Dv[0-9]' "$ZP_CATALOG")"

# general (ALT5).bat пропускается — его пропускает и менеджер: ни одного профиля из тех
# шести, что мы забираем, в нём нет, и блок вышел бы пустым заголовком.
check "ALT5 пропущен" "0" "$(grep -c 'ALT5' "$ZP_CATALOG")"

# Строка без заголовка «#vN» стратегией не считается: это может быть что угодно, и молча
# выдать её за стратегию значило бы показать человеку блок, которого у автора нет.
check "строка без заголовка не стратегия" "0" "$(grep -c '^#v99' "$ZP_CATALOG")"

# Стратегии `Dv` объявлены переменными, а не функциями, и заголовка `#DvN` в самом скрипте
# нет — его ставим мы, из имени переменной. Значит проверять надо не заголовок, а то, что
# тело действительно ключи nfqws: иначе в каталог уехала бы любая переменная, чьё имя начали
# с Dv, и человек увидел бы в списке блок, которого у автора нет.
check "тело не из ключей — не стратегия" "0" "$(grep -c '^#Dv98' "$ZP_CATALOG")"
check "объявленная иначе — не стратегия" "0" "$(grep -c '^#Dv99' "$ZP_CATALOG")"

# ---- главное: превращение совпадает с первоисточником ------------------------
zp_block general > "$tmp/got.txt"
if cmp -s "$tmp/got.txt" "$FIX/general.expected"; then
    pass=$((pass + 1))
else
    fail=$((fail + 1))
    echo 'FAIL блок Flowseal совпадает с переносом download_strategies'
    diff "$FIX/general.expected" "$tmp/got.txt" | head -20
fi

# Отдельными проверками — то, что ломается по одной замене за раз. Каждая строка ниже
# соответствует одному `sed` из download_strategies, и провал называет ровно его.
check "виндовых переменных не осталось" "0" "$(grep -c '%BIN%\|%LISTS%\|%GameFilter' "$ZP_CATALOG")"
check "подделки переставлены в каталог zapret" "1" \
    "$([ "$(grep -c '/opt/zapret/files/fake/' "$ZP_CATALOG")" -gt 0 ] && echo 1 || echo 0)"
check "список исключений — файл zapret" "1" \
    "$(grep -c '^--hostlist-exclude=/opt/zapret/ipset/zapret-hosts-user-exclude.txt$' "$ZP_CATALOG")"
check "список google — файл zapret" "1" \
    "$(grep -c '^--hostlist=/opt/zapret/ipset/zapret-hosts-google.txt$' "$ZP_CATALOG")"
check "игровые порты подставлены числами" "1" \
    "$(grep -c '^--filter-tcp=2802,2302' "$ZP_CATALOG")"
check "продолжение строки .bat убрано" "0" "$(grep -c '\^' "$ZP_CATALOG")"
# Пустых строк в каталоге нет — так же, как у менеджера: последним шагом он вычёркивает их
# все, и блок из его каталога должен копироваться в наш без правки.
check "пустых строк нет" "0" "$(grep -c '^$' "$ZP_CATALOG")"
check "каждый ключ на своей строке" "0" "$(grep -c '^--[a-z-]*=[^ ]* --' "$ZP_CATALOG")"

# Файлы-подделки, которых нет в пакете zapret, достаются из того же архива: без них nfqws
# поднимается и молча не делает того, что написано в стратегии.
check "подделка из архива разложена" "1" "$([ -s "$ZP_FAKE_DIR/stun2.bin" ] && echo 1 || echo 0)"

# ---- каталог как справочник --------------------------------------------------
check "имена перечисляются" "1" "$(zp_names | grep -cx 'general')"
check "есть — есть" "0" "$(zp_has v1; echo $?)"
check "нет — нет" "1" "$(zp_has 'нет такой'; echo $?)"
check "блок начинается заголовком" "#v1" "$(zp_block v1 | head -1)"
check "блок кончается перед следующим" "3" "$(zp_block v1 | grep -c '^--')"
# Блок `Dv` — такой же житель каталога, как остальные: узнаётся по имени, отдаётся вместе с
# заголовком, кончается перед следующим блоком. Число ключей сверяется с переменными автора
# (у Dv1 их шесть, у Dv2 девять): блоки разной длины, и съехавшая граница видна сразу.
check "Dv узнаётся" "0" "$(zp_has Dv1; echo $?)"
check "имя Dv перечисляется" "1" "$(zp_names | grep -cx 'Dv1')"
check "блок Dv начинается заголовком" "#Dv1" "$(zp_block Dv1 | head -1)"
check "ключей в блоке Dv1 — как у автора" "6" "$(zp_block Dv1 | grep -c '^--')"
check "блок Dv кончается перед следующим" "9" "$(zp_block Dv2 | grep -c '^--')"
# Порты discord.media — та самая строка, по которой менеджер находит место подмены (см.
# switch_Dv). Пропала она — блок применить некуда, и это уже не стратегия для discord.media.
check "первый ключ блока Dv — порты discord.media" "--filter-tcp=2053,2083,2087,2096,8443" \
    "$(zp_block Dv1 | sed -n '2p')"

# ---- отметка активной стратегии: совместимость с Zapret Manager ---------------
#
# Менеджер записывает выбранную стратегию в NFQWS_OPT ВМЕСТЕ со строкой `#Имя` и по ней же
# потом узнаёт активную (`grep -o '#v[0-9]*'`). Если отрезать заголовок, менеджер рядом
# покажет «стратегия не выбрана» на выбранной стратегии.
cp "$FIX/zapret.conf" "$ZP_CONF"
# Свежий роутер: пакет zapret приезжает со своей стратегией, но БЕЗ отметки `#Имя` — там
# только `--comment=Strategy__v6_by_StressOzz`, подпись автора внутри ключей. Пустой ответ
# здесь законен и обязан быть пустым: менеджер в этом случае тоже не показывает ничего, а
# разбор чужой подписи назвал бы стратегию именем, которого в каталоге может не быть.
check "без отметки активная неизвестна" "" "$(zp_active_global)"
zp_apply_global v2 >/dev/null 2>&1
check "стратегия применилась" "0" "$?"
check "активной стала выбранная" "v2" "$(zp_active_global)"
check "отметка стоит там же, где её ставит менеджер" "1" \
    "$(awk "/option NFQWS_OPT '/{on=1;next} on&&/^'\$/{exit} on&&/^#v2\$/{n++} END{print n+0}" "$ZP_CONF")"
check "ключи стратегии на месте" "1" \
    "$(grep -c '^--dpi-desync=fake,multisplit$' "$ZP_CONF")"
# Порты Discord и игровые дописываются: стратегии Flowseal их ловят, а в пакете zapret их в
# NFQWS_PORTS_* нет — без этого стратегия применяется и не действует на половине того, для
# чего написана.
check "порты Discord дописаны" "1" "$(grep -c "option NFQWS_PORTS_TCP '80,443,2053," "$ZP_CONF")"
check "порты QUIC дописаны" "1" "$(grep -c "option NFQWS_PORTS_UDP '443,19294-" "$ZP_CONF")"
zp_apply_global v2 >/dev/null 2>&1
check "повторное применение не дублирует порты" "1" \
    "$(grep -c "option NFQWS_PORTS_TCP '80,443,2053,2083,2087,2096,8443'" "$ZP_CONF")"
check "остальная конфигурация цела" "1" "$(grep -c "option FWTYPE 'nftables'" "$ZP_CONF")"

# ---- игровой фильтр (Gv) -----------------------------------------------------------------
# Повторяет fix_GAME / GV_FAKE / Gv_Xtreme менеджера: блок #GvN в хвосте, порты по одному,
# подделка первым вхождением, Xtreme с его же файлом восстановления. Проверяется не «похоже»,
# а обратимостью: поставить и снять — та же конфигурация байт в байт.
ZP_GV_XTREME_FILE="$tmp/GvXtreme"
check "игрового блока нет" "" "$(zp_game_gv)"
cp "$ZP_CONF" "$tmp/conf.nogame"
zp_game_set 2
check "Gv2 поставлен" "2" "$(zp_game_gv)"
check "метка в хвосте, одна" "1" "$(grep -c '^#Gv' "$ZP_CONF")"
check "UDP-часть с cutoff n2" "1" "$(grep -c '^--dpi-desync-cutoff=n2$' "$ZP_CONF")"
check "общая TCP-часть на месте" "1" "$(grep -c "^--filter-tcp=$ZP_PORTS_TCP\$" "$ZP_CONF")"
check "игровые порты UDP дописаны по одному" "1" \
      "$(grep -c "option NFQWS_PORTS_UDP '443,19294-19344,50000-50100,88,1024-2407," "$ZP_CONF")"
check "игровые порты TCP дописаны" "1" "$(grep -c "option NFQWS_PORTS_TCP '.*,60442'" "$ZP_CONF")"
check "файл закрыт кавычкой" "'" "$(tail -n1 "$ZP_CONF")"
check "основная стратегия не тронута" "v2" "$(zp_active_global)"
check "подделка по умолчанию stun.bin" "stun.bin" "$(zp_game_fake)"
# Подделка: только из списка менеджера и только если файл есть.
: > "$ZP_FAKE_DIR/stun2.bin"; printf x > "$ZP_FAKE_DIR/stun2.bin"
check "смена подделки на stun2" "0" "$(zp_game_fake_set stun2.bin; echo $?)"
check "подделка сменилась" "stun2.bin" "$(zp_game_fake)"
check "а в TCP-части pattern остался stun.bin" "1" \
      "$(grep -c 'seqovl-pattern=/opt/zapret/files/fake/stun.bin$' "$ZP_CONF")"
check "чужая подделка отвергается" "1" "$(zp_game_fake_set evil.bin; echo $?)"
check "подделка без файла отвергается" "1" "$(zp_game_fake_set quic_initial_rutube_ru.bin; echo $?)"
# Xtreme: расширенные порты, метка с суффиксом, файл восстановления в формате менеджера.
cp "$ZP_CONF" "$tmp/conf.noxtreme"
check "Xtreme включается" "0" "$(zp_game_xtreme_on; echo $?)"
check "Xtreme отмечен" "0" "$(zp_game_xtreme; echo $?)"
check "метка Gv2Xtreme" "1" "$(grep -c '^#Gv2Xtreme$' "$ZP_CONF")"
check "порты nfqws расширены" "2" "$(grep -c "option NFQWS_PORTS_[TU][CD]P '80,88,443-65535'" "$ZP_CONF")"
check "фильтр блока расширен" "2" "$(grep -c '^--filter-[ut][dc]p=80,88,444-65535$' "$ZP_CONF")"
check "файл восстановления — пять строк" "5" "$(wc -l < "$ZP_GV_XTREME_FILE")"
check "номер читается и под Xtreme" "2" "$(zp_game_gv)"
zp_game_xtreme_off
check "после выключения Xtreme конфигурация та же байт в байт" "1" \
      "$(cmp -s "$ZP_CONF" "$tmp/conf.noxtreme" && echo 1 || echo 0)"
check "файл восстановления убран" "0" "$([ -e "$ZP_GV_XTREME_FILE" ] && echo 1 || echo 0)"
# Смена основной стратегии игровой фильтр не теряет (как автоподбор менеджера).
zp_game_xtreme_on
zp_apply_global v1 >/dev/null 2>&1
check "основная сменилась" "v1" "$(zp_active_global)"
check "игровая осталась" "2" "$(zp_game_gv)"
check "подделка осталась" "stun2.bin" "$(zp_game_fake)"
check "Xtreme остался" "0" "$(zp_game_xtreme; echo $?)"
check "метка одна" "1" "$(grep -c '^#Gv' "$ZP_CONF")"
zp_game_xtreme_off
check "Xtreme снимается и после смены основной" "1" "$(zp_game_xtreme; echo $?)"
# Снять: хвост срезан, порты убраны — как до установки (основная — снова v2 для сравнения).
zp_apply_global v2 >/dev/null 2>&1
zp_game_set 0
check "игровой блок снят" "" "$(zp_game_gv)"
check "снятие возвращает конфигурацию байт в байт" "1" \
      "$(cmp -s "$ZP_CONF" "$tmp/conf.nogame" && echo 1 || echo 0)"
check "чужой номер отвергается" "1" "$(zp_game_set 7; echo $?)"
# Стратегия Flowseal несёт свой игровой фильтр — менеджер метит его #Gv0 («GvF»), и GvN
# ставится ВМЕСТО него, а не под ним.
zp_apply_global general >/dev/null 2>&1
check "встроенный фильтр Flowseal помечен Gv0" "0" "$(zp_game_gv)"
check "метка стоит перед --new + --filter-tcp=2802" "1" \
      "$(awk '/^#Gv0$/{g=NR} g&&NR==g+1&&/^--new$/{n=1} n&&NR==g+2&&/^--filter-tcp=2802/{print 1; exit}' "$ZP_CONF")"
zp_game_set 1
check "Gv1 заменил встроенный" "1" "$(zp_game_gv)"
check "меток по-прежнему одна" "1" "$(grep -c '^#Gv' "$ZP_CONF")"
check "встроенного TCP-блока Flowseal больше нет" "1" "$(grep -c '^--filter-tcp=2802' "$ZP_CONF")"
# Дальше стенд ждёт v2 без игрового блока — как было до этого раздела.
zp_game_set 0
zp_apply_global v2 >/dev/null 2>&1
zp_apply_global 'нет такой' >/dev/null 2>&1
check "неизвестная стратегия — отказ" "1" "$?"
check "и конфигурация не тронута" "v2" "$(zp_active_global)"

# ---- стратегия выходу kind=zapret -------------------------------------------
zp_apply_out yt v1 >/dev/null 2>&1
check "файл ключей выхода записан" "0" "$?"
check "первой строкой — отметка активной" "#v1" "$(head -1 "$ZP_OPTS_DIR/yt.opts")"
check "активная у выхода читается" "v1" "$(zp_active_out yt)"
check "ключи выхода на месте" "3" "$(grep -c '^--' "$ZP_OPTS_DIR/yt.opts")"
zp_apply_out 'плохое имя' v1 >/dev/null 2>&1
check "негодное имя выхода — отказ" "1" "$?"
zp_apply_out yt 'нет такой' >/dev/null 2>&1
check "неизвестная стратегия выходу — отказ" "1" "$?"
check "и прежний файл цел" "v1" "$(zp_active_out yt)"

# ---- обновление каталога -----------------------------------------------------
#
# Два правила владельца: обновлять раз в сутки и НЕ ТРОГАТЬ активную стратегию. Второе здесь
# и проверяется: после zp_sync и конфигурация обхода, и файл ключей выхода обязаны остаться
# теми же байтами — иначе правка стратегии у автора меняла бы работающий роутер ночью, без
# ведома человека и с перезапуском обхода.
cp "$ZP_CONF" "$tmp/conf.before"
cp "$ZP_OPTS_DIR/yt.opts" "$tmp/opts.before"
cp "$ZP_CATALOG" "$tmp/cat.before"
zp_sync >/dev/null 2>&1
check "обновление прошло" "0" "$?"
check "конфигурация обхода не тронута" "1" \
    "$(cmp -s "$ZP_CONF" "$tmp/conf.before" && echo 1 || echo 0)"
check "файл ключей выхода не тронут" "1" \
    "$(cmp -s "$ZP_OPTS_DIR/yt.opts" "$tmp/opts.before" && echo 1 || echo 0)"
check "отметка времени поставлена" "1" "$([ -s "$ZP_STAMP" ] && echo 1 || echo 0)"

# Файл каталога переписывается ТОЛЬКО при изменении содержимого: он лежит во флеш-разделе, а
# переписывать «то же самое» раз в сутки — износ ради ничего.
touch -t 200001010000 "$ZP_CATALOG"
was="$(date -r "$ZP_CATALOG" +%s 2>/dev/null || echo 0)"
zp_sync >/dev/null 2>&1
now="$(date -r "$ZP_CATALOG" +%s 2>/dev/null || echo 0)"
check "неизменившийся каталог не переписан" "$was" "$now"

# ---- обедневший каталог на диск не пускается ---------------------------------
#
# Источников три и они независимы: Flowseal из своего репозитория, `v` с `Dv` и `Yv` из
# скрипта менеджера. На живом роутере raw.githubusercontent.com не отдаёт регулярно — это и видно в
# отчёте ночного обновления, — и без этой проверки ночная попытка заменила бы каталог из
# пятидесяти восьми стратегий каталогом из двадцати одной. Выбранная человеком стратегия
# просто исчезла бы из списка, и он не понял бы, куда.
#
# Сравниваются СЕМЕЙСТВА, а не число стратегий: у автора количество законно меняется в обе
# стороны, а пропажа целого семейства — всегда недокачка.
check "семейства каталога перечисляются" "flowseal v yv dv" \
    "$(zp_families "$ZP_CATALOG" | sed 's/ $//')"

cp "$ZP_CATALOG" "$tmp/cat.full"
full_families="$(zp_families "$ZP_CATALOG")"

# Скачивание перестаёт отдавать скрипт менеджера — пропадают и `v`, и `Dv`, и `Yv`.
download() {
    case "$1" in
        *codeload*)         cp "$tmp/flowseal.tgz" "$2" ;;
        *Zapret-Manager.sh) return 1 ;;
        *StrYoutube)        return 1 ;;
        *)                  return 1 ;;
    esac
    [ -s "$2" ]
}
ZP_NOTE=""
zp_sync >/dev/null 2>&1
check "обновление с недокачкой отказано" "1" "$?"
check "прежний каталог цел байт в байт" "1" \
    "$(cmp -s "$ZP_CATALOG" "$tmp/cat.full" && echo 1 || echo 0)"
check "семейства не потеряны" "$full_families" "$(zp_families "$ZP_CATALOG")"
# Причина названа: без неё отказ читается как «сеть не отдала», хотя половина каталога
# приехала и была отвергнута нарочно.
check "причина отказа названа" "1" \
    "$([ -n "$ZP_NOTE" ] && echo 1 || echo 0)"
check "в причине названо семейство" "1" \
    "$(printf '%s' "$ZP_NOTE" | grep -c 'v')"

# Отметка времени НЕ обновляется: «проверяли, всё то же» здесь неправда, и следующий прогон
# обязан попробовать снова.
touch -t 200001010000 "$ZP_STAMP"
was_stamp="$(date -r "$ZP_STAMP" +%s 2>/dev/null || echo 0)"
zp_sync >/dev/null 2>&1
check "отметка времени после отказа не сдвинута" "$was_stamp" \
    "$(date -r "$ZP_STAMP" +%s 2>/dev/null || echo 0)"

# На ПУСТОМ месте половина каталога лучше пустого списка: там терять нечего.
rm -f "$ZP_CATALOG"
zp_sync >/dev/null 2>&1
check "на пустом месте половина каталога принимается" "0" "$?"
check "и это ровно Flowseal" "flowseal" "$(zp_families "$ZP_CATALOG" | sed 's/ $//')"

# Возвращаем полное скачивание и полный каталог для проверок ниже.
download() {
    case "$1" in
        *codeload*)           cp "$tmp/flowseal.tgz" "$2" ;;
        *Zapret-Manager.sh)   cp "$FIX/zm-snippet.sh" "$2" ;;
        *StrYoutube)          cp "$FIX/StrYoutube" "$2" ;;
        *)                    return 1 ;;
    esac
    [ -s "$2" ]
}
zp_sync >/dev/null 2>&1
check "полное скачивание возвращает все семейства" "flowseal v yv dv" \
    "$(zp_families "$ZP_CATALOG" | sed 's/ $//')"

# Разошлась ли активная стратегия с каталогом — единственный способ ответить человеку на
# «то, что у меня работает, ещё то же самое?».
check "совпавшая стратегия не считается разошедшейся" "1" \
    "$(zp_drifted v1 "$ZP_OPTS_DIR/yt.opts"; echo $?)"
printf '#v1\n--filter-tcp=443\n--dpi-desync=НЕ ТО\n' > "$ZP_OPTS_DIR/yt.opts"
check "изменившаяся — считается" "0" \
    "$(zp_drifted v1 "$ZP_OPTS_DIR/yt.opts"; echo $?)"

# ---- проверка ключей перед применением читает файл ЦЕЛИКОМ --------------------
#
# zp_dry_run собирает аргументы для `nfqws --dry-run` тем же циклом `while IFS= read -r`,
# которым обёртка обработчика читает файл ключей, — и `read` роняет последнюю строку файла без
# завершающего перевода строки: код возврата у него в этом случае ненулевой, хотя переменная
# УЖЕ заполнена, и тело цикла не исполняется (I-148).
#
# Почему это не косметика и почему хуже, чем было. Обёртка последнюю строку теперь читает
# (правка на стороне steer), а проверка — нет. Значит негодный последний ключ проходит
# dry-run и роняет уже живой экземпляр: procd поднимает и роняет его по кругу, а при
# on_fail=drop помеченный трафик в это время стоит. Пока обе половины теряли одну и ту же
# строку, они были согласованно неправы; теперь они расходятся.
#
# Стенд поведенческий, а не грепом по тексту: подставной nfqws записывает свои аргументы, и
# проверяется, что последний ключ до них дошёл. Файл пишется printf БЕЗ \n в конце — ровно так
# он выглядит после правки руками по ssh.
zp_nfqws_args="$tmp/dry-args"
cat > "$tmp/nfqws-rec" <<'REC'
#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done > "$ZP_NFQWS_ARGS"
exit 0
REC
chmod +x "$tmp/nfqws-rec"
ZP_NFQWS="$tmp/nfqws-rec"
export ZP_NFQWS_ARGS="$zp_nfqws_args"
printf '#Стратегия\n--filter-tcp=443\n--dpi-desync=fake' > "$tmp/no-eol.opts"
zp_dry_run "$tmp/no-eol.opts"
check "проверка ключей: последний ключ файла без перевода строки дошёл" "1" \
    "$(grep -c -- '--dpi-desync=fake' "$zp_nfqws_args" 2>/dev/null; true)"
check "проверка ключей: имя стратегии в ключи не уехало" "0" \
    "$(grep -c -- '#Стратегия' "$zp_nfqws_args" 2>/dev/null; true)"
printf -- '--filter-tcp=443\n--dpi-desync=fake\n' > "$tmp/eol.opts"
zp_dry_run "$tmp/eol.opts"
check "проверка ключей: обычный файл с переводом строки не сдвоил последнюю" "1" \
    "$(grep -c -- '--dpi-desync=fake' "$zp_nfqws_args" 2>/dev/null; true)"
ZP_NFQWS="$tmp/nfqws-none"

printf '\n%d проверок пройдено' "$pass"
# ---- выключатель обхода всего роутера -------------------------------------------------
# «Как мне отключить стратегию на весь роутер?» — владелец. Выключается СЛУЖБА, а не
# стирается стратегия: отметка `#Имя` остаётся на месте, Zapret Manager видит свою
# конфигурацию, а обработчики выходов kind=zapret это не трогает.
zp_apply_global v2 >/dev/null 2>&1
: > "$tmp/init.log"
"$ZP_INIT" enable >/dev/null
check "включённый автозапуск виден по ссылке" "0" "$(zp_enabled; echo $?)"
: > "$tmp/init.log"
zp_disable
check "выключение снимает автозапуск и останавливает — в этом порядке" "disable stop" \
      "$(tr '\n' ' ' < "$tmp/init.log" | sed 's/ $//')"
check "после выключения автозапуск снят" "1" "$(zp_enabled; echo $?)"
check "а стратегия осталась отмеченной" "v2" "$(zp_active_global)"
: > "$tmp/init.log"
zp_enable
check "включение ставит автозапуск и запускает" "enable start" \
      "$(tr '\n' ' ' < "$tmp/init.log" | sed 's/ $//')"
check "и автозапуск снова включён" "0" "$(zp_enabled; echo $?)"
# Обёртка remittor: ссылка есть, а run_on_boot=0 — после перезагрузки обхода не будет, и
# «включён» здесь было бы ложью. Выключение снимает ключ, включение ставит.
printf '0\n' > "$tmp/run_on_boot"
check "ссылка есть, run_on_boot=0 — не включён" "1" "$(zp_enabled; echo $?)"
zp_enable
check "включение ставит run_on_boot" "1" "$(cat "$tmp/run_on_boot")"
check "и теперь включён" "0" "$(zp_enabled; echo $?)"
zp_disable
check "выключение снимает run_on_boot" "0" "$(cat "$tmp/run_on_boot")"
rm -f "$tmp/run_on_boot"
ZP_INIT="$tmp/нет-такого"
check "без init-скрипта выключать нечего — отказ" "1" "$(zp_disable; echo $?)"

if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
