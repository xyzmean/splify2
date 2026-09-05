#!/bin/sh
# Автоподбор стратегии обхода DPI: рейтинг, приговор, применение победителя и откат.
#
# ЗАЧЕМ ЭТОТ СТЕНД. Здесь единственное место продукта, где программа САМА меняет то, что
# работает у всех клиентов роутера. Ошибка тут не падает и не молчит вполовину — она
# применяет не ту стратегию, и человек узнаёт об этом, когда у него перестал открываться
# сайт. Из трёх частей подбора две проверяются только так: правило разрыва ничьей (без
# стенда оно неотличимо от «повезло с порядком файлов») и три условия отказа — «не лучше,
# чем без обхода», «не лучше работающей», «уже лучшая». Каждое из них означает НЕ МЕНЯТЬ
# ничего, то есть его провал выглядит как успешная работа.
#
# ОТКУДА БЕРУТСЯ РЕЗУЛЬТАТЫ. Кладутся здесь же руками, в том же формате, в котором их пишет
# splify2-zapret-test: имя, набор, удач, целей, открывшееся, время — через табуляцию, по
# файлу на стратегию, имя файла считает zp_res_file. Гонять настоящую проверку ради
# ранжирования не нужно и нельзя: она ходит в сеть.
#
# Запуск: sh tests/autoselmatch.sh
set -u
cd "$(dirname "$0")/.." || exit 2
LIB=files/usr/lib/splify2/zapret.sh
CMD=files/usr/sbin/splify2-zapret-autoselect
[ -s "$LIB" ] || { echo "нет $LIB"; exit 2; }
[ -s "$CMD" ] || { echo "нет $CMD"; exit 2; }

pass=0 fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
        fail=$((fail + 1))
        printf 'FAIL %s\n  ожидалось: %s\n  вышло:     %s\n' "$1" "$2" "$3"
    fi
}

TAB="$(printf '\t')"

ZP_DIR="$tmp/state"
ZP_CATALOG="$ZP_DIR/strategies.txt"
ZP_RESULTS="$ZP_DIR/results.json"
ZP_RESULTS_DIR="$ZP_DIR/results.d"
ZP_STAMP="$ZP_DIR/updated"
ZP_CONF="$tmp/zapret.conf"
ZP_NFQWS="$tmp/nfqws"
ZP_OPTS_DIR="$tmp/opts"
ZP_INIT="$tmp/init-zapret"
ZP_RCD="$tmp/rcd"
ZP_PREV="$ZP_DIR/previous.opts"
ZP_AUTOSEL="$ZP_DIR/autoselect"
mkdir -p "$ZP_DIR" "$ZP_RESULTS_DIR" "$ZP_OPTS_DIR" "$ZP_RCD" "$tmp/bin"
printf '#!/bin/sh\nexit 0\n' > "$ZP_NFQWS"; chmod +x "$ZP_NFQWS"
cat > "$ZP_INIT" <<EOF
#!/bin/sh
echo "\$1" >> "$tmp/init.log"
exit 0
EOF
chmod +x "$ZP_INIT"

# uci стенда: помнит ключи splify2.* в файле, чтобы расписание можно было включить и выключить.
cat > "$tmp/bin/uci" <<EOF
#!/bin/sh
db="$tmp/uci.db"
case "\$*" in
    *"get splify2.main.zapret_autoselect")
        sed -n 's/^autosel=//p' "\$db" 2>/dev/null | head -n1
        [ -s "\$db" ] || exit 1 ;;
    *"set splify2.main.zapret_autoselect="*)
        printf 'autosel=%s\n' "\${*##*=}" > "\$db" ;;
    *commit*) : ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/uci"
PATH="$tmp/bin:$PATH"
. "$LIB"

# ---- каталог: четыре основных и один слой ---------------------------------------------
# Числа ключей выбраны НАРОЧНО так, чтобы ничью разрывали именно они: у v1 три ключа, у v2
# два, доля у обоих будет одинаковой. Порядок в каталоге при этом обратный ожидаемому
# ответу — иначе стенд не отличил бы правило от «взяли первое подходящее».
cat > "$ZP_CATALOG" <<'EOF'
#general
--filter-tcp=80
--dpi-desync=fake
--dpi-desync-ttl=1
#v1
--filter-tcp=443
--dpi-desync=fake,split2
--dpi-desync-fooling=badseq
#v2
--filter-tcp=443
--dpi-desync=fake
#v3
--filter-tcp=443
--dpi-desync=disorder2
#v10
--filter-tcp=443
--dpi-desync=fake
--dpi-desync-ttl=1
--dpi-desync-fooling=badseq
--dpi-desync-repeats=2
--dpi-desync-split-pos=1
--dpi-desync-any-protocol
--dpi-desync-cutoff=n2
--hostlist-auto=/tmp/a.txt
--hostlist-exclude=/tmp/b.txt
#v11
--filter-tcp=443
--dpi-desync=fake
--dpi-desync-ttl=1
--dpi-desync-fooling=badseq
--dpi-desync-repeats=2
--dpi-desync-split-pos=1
--dpi-desync-any-protocol
--dpi-desync-cutoff=n2
--hostlist-auto=/tmp/a.txt
#v9
--filter-tcp=443
--dpi-desync=fake,disorder2
--dpi-desync-ttl=2
--dpi-desync-fooling=md5sig
#Yv1
--filter-tcp=443
--hostlist=/opt/zapret/ipset/zapret-hosts-google.txt
EOF

check "ключи считаются: v1" "3" "$(zp_keys_count v1)"
check "ключи считаются: v2" "2" "$(zp_keys_count v2)"
check "заголовок за ключ не считается" "2" "$(zp_keys_count v2)"

# ---- результаты проверки ---------------------------------------------------------------
res() {  # ИМЯ НАБОР УДАЧ ЦЕЛЕЙ
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "" "$(date +%s)" \
        > "$(zp_res_file "$1")"
}
base() {  # НАБОР СКОЛЬКО ЦЕЛЕЙ
    printf '%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "" "$(date +%s)" "" \
        > "$ZP_RESULTS_DIR/_baseline.$1"
}

base general 4 30
res general general 20 30
res v1 general 26 30
res v2 general 26 30
res v3 general 10 30
res Yv1 youtube 12 12
base youtube 2 12
# Равная доля у пары с девятью и десятью ключами — материал для проверки разрыва ничьей
# на числах, которые побайтово сравниваются наоборот (см. ниже).
res v10 general 15 30
res v11 general 15 30

# ---- рейтинг ---------------------------------------------------------------------------
rank="$(zp_rank)"
check "в рейтинге шесть строк (слой не попал)" "6" "$(printf '%s\n' "$rank" | grep -c .)"
check "слоя Yv в рейтинге нет" "0" "$(printf '%s\n' "$rank" | cut -f6 | grep -c '^Yv')"
# ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА: при равной доле выигрывает стратегия с МЕНЬШИМ числом ключей.
# v1 и v2 обе открыли 26 из 30; v2 дешевле на один ключ и потому старше. Порядок в каталоге
# у них обратный, так что «взяли первое» дало бы здесь v1.
check "ничья разрывается числом ключей" "v2" "$(printf '%s\n' "$rank" | head -n1 | cut -f6)"
check "и вторым идёт равный по доле, но дороже" "v1" \
    "$(printf '%s\n' "$rank" | sed -n 2p | cut -f6)"
check "доля считается десятитысячными" "8666" \
    "$(printf '%s\n' "$rank" | head -n1 | cut -f1)"
check "худшая внизу" "v3" "$(printf '%s\n' "$rank" | tail -n1 | cut -f6)"

# ТОТ ЖЕ РАЗРЫВ НИЧЬЕЙ, НО НА ЧИСЛАХ, КОТОРЫЕ ПОБАЙТОВО СРАВНИВАЮТСЯ НАОБОРОТ. Первая
# редакция этого стенда проверку на ключи имела и всё равно пропускала мутацию «убрать
# разрыв по ключам»: у sort последнее средство — побайтовое сравнение всей строки, а поле
# ключей стоит в строке РАНЬШЕ имени, поэтому «2» против «3» и без всякого ключа сортировки
# давало верный ответ. То есть порядок держался не на правиле, а на форме строки.
#
# Здесь ключей 9 и 10: побайтово «10» меньше «9», и без числового сравнения наверх уехала бы
# дорогая стратегия. Проверка стоит на относительном порядке двух строк, а не на первенстве:
# доля у этой пары ниже, чем у v2, и наверх им подниматься незачем.
check "ничья на двузначном числе ключей: дешевле — старше" "v11 v10" \
    "$(printf '%s\n' "$rank" | awk -F'\t' '$6 == "v10" || $6 == "v11" { printf "%s%s", (n++ ? " " : ""), $6 }')"

# Стратегия, которая не поднялась вовсе, применяться не может — и в рейтинг не идёт.
res v3 general -1 30
check "не поднявшаяся стратегия выпала из рейтинга" "5" "$(zp_rank | grep -c .)"
res v3 general 10 30

# ДОЛЯ, А НЕ ЧИСЛО УДАЧ, и ключи её не перебивают. v9 открыла 12 из 12 — вдвое меньше целей,
# чем у v2 (26 из 30), и ключей у неё БОЛЬШЕ (четыре против двух). Побеждать она обязана всё
# равно: по абсолютному числу удач стратегия с коротким набором целей не выиграла бы никогда,
# а число ключей — это только разрыв ничьей, а не второй критерий.
res v9 general 12 12
check "доля важнее числа удач и важнее ключей" "v9" "$(zp_rank | head -n1 | cut -f6)"
rm -f "$(zp_res_file v9)"

# ---- приговор: три отказа и одно согласие ----------------------------------------------
printf "config zapret 'config'\n\toption NFQWS_OPT '\n" > "$ZP_CONF"
printf "#general\n--filter-tcp=80\n'\n" >> "$ZP_CONF"
check "активная читается" "general" "$(zp_active_global)"

zp_winner
check "победитель есть" "0" "$?"
check "победитель — v2" "v2" "$(printf '%s' "$ZP_WINNER" | cut -f6)"

# Отказ 1: работающая стратегия и есть победитель. Применять нечего, и молчать нельзя —
# «уже лучшая» и «проверка не проходила» человек различает только по строке.
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#v2\n--filter-tcp=443\n'\n" > "$ZP_CONF"
zp_winner >/dev/null 2>&1
check "уже применена лучшая — отказ" "1" "$?"
check "и сказано, что уже лучшая" "1" \
    "$(printf '%s' "$ZP_NOTE" | grep -c 'уже применена лучшая')"

# Отказ 2: победитель не лучше работающей. general открыл 26, как и v2 — менять не на что.
res general general 26 30
printf "config zapret 'config'\n\toption NFQWS_OPT '\n#general\n--filter-tcp=80\n'\n" > "$ZP_CONF"
zp_winner >/dev/null 2>&1
check "не лучше работающей — отказ" "1" "$?"
check "и названы оба числа" "1" \
    "$(printf '%s' "$ZP_NOTE" | grep -c 'не лучше работающей')"
res general general 20 30

# Отказ 3: без обхода открывается столько же. Тогда обход не даёт ничего, а применение —
# это перезапуск службы на живом роутере.
base general 26 30
zp_winner >/dev/null 2>&1
check "не лучше, чем без обхода — отказ" "1" "$?"
check "и сказано про «без обхода вовсе»" "1" \
    "$(printf '%s' "$ZP_NOTE" | grep -c 'без обхода вовсе')"
base general 4 30

# Отказ 4: результатов нет вовсе.
mv "$ZP_RESULTS_DIR" "$tmp/saved.d"
mkdir -p "$ZP_RESULTS_DIR"
zp_winner >/dev/null 2>&1
check "рейтинга нет — отказ" "1" "$?"
# Ответ приезжает переменной, а не потоком — ради причины отказа: `$(zp_winner)` унёс бы
# ZP_NOTE вместе с подоболочкой. Значит на отказе переменная обязана быть ПУСТОЙ, иначе
# вызывающий применит прошлого победителя, приняв его за нового.
check "и на отказе переменная пуста" "" "$ZP_WINNER"
check "а причина отказа — нет" "1" "$(printf '%s' "$ZP_NOTE" | grep -c 'рейтинга нет')"
rm -rf "$ZP_RESULTS_DIR"; mv "$tmp/saved.d" "$ZP_RESULTS_DIR"

# ---- применение победителя и откат -----------------------------------------------------
printf "config zapret 'config'\n\toption NFQWS_PORTS_TCP '80,443'\n\toption NFQWS_OPT '\n" > "$ZP_CONF"
printf "#general\n--filter-tcp=80\n'\n" >> "$ZP_CONF"
before="$(cat "$ZP_CONF")"

check "слой как основную применить нельзя" "1" \
    "$(zp_apply_winner Yv1 12 12 youtube manual all >/dev/null 2>&1; echo $?)"
check "и копии после отказа не осталось" "0" "$([ -e "$ZP_PREV" ] && echo 1 || echo 0)"

zp_apply_winner v2 26 30 general auto all
check "победитель применён" "0" "$?"
check "активной стала v2" "v2" "$(zp_active_global)"
check "копия прежней настройки сохранена" "1" "$([ -s "$ZP_PREV" ] && echo 1 || echo 0)"
check "копия — файл в том виде, в каком он был" "" "$(printf '%s\n' "$before" | diff - "$ZP_PREV")"
check "записано, что применено" "v2" "$(zp_autosel_get name)"
check "записано, кем" "auto" "$(zp_autosel_get by)"
check "записано, что было до" "general" "$(zp_autosel_get prev)"
check "записан результат прежней" "20" "$(zp_autosel_get prev_ok)"
check "записан контрольный проход" "4" "$(zp_autosel_get baseline)"
check "откат доступен" "0" "$(zp_undo_ready; echo $?)"

zp_undo_global
check "откат сработал" "0" "$?"
check "вернулась general" "general" "$(zp_active_global)"
check "файл вернулся байт в байт" "" "$(printf '%s\n' "$before" | diff - "$ZP_CONF")"
check "копия одноразовая — её больше нет" "0" "$([ -e "$ZP_PREV" ] && echo 1 || echo 0)"
check "второй откат подряд — отказ" "1" "$(zp_undo_global >/dev/null 2>&1; echo $?)"
check "и отметка об откате осталась в записи" "1" \
    "$(grep -c '^undone_at=' "$ZP_AUTOSEL")"

# ГЛАВНАЯ ПРОВЕРКА ОТКАТА: он отказывается работать, если после автоподбора человек выбрал
# стратегию руками. Копия хранит файл целиком, поэтому откат поверх чужой правки унёс бы её.
zp_apply_winner v2 26 30 general auto all >/dev/null 2>&1
zp_apply_global v1
check "после ручного выбора откат недоступен" "1" "$(zp_undo_ready; echo $?)"
check "и он отказывает, а не молчит" "1" "$(zp_undo_global >/dev/null 2>&1; echo $?)"
zp_undo_global >/dev/null 2>&1
check "и объясняет, что отменил бы выбор человека" "1" \
    "$(printf '%s' "$ZP_NOTE" | grep -c 'ваш выбор')"
check "и настройка при отказе не тронута" "v1" "$(zp_active_global)"

# ---- команда: по умолчанию не меняет ничего --------------------------------------------
run_cmd() {  # аргументы
    ZAPRET_SH="$LIB" ZAPRET_TEST="$tmp/test-stub" \
    ZA_PROGRESS="$tmp/za.progress" ZA_LOCK="$tmp/za.lock" \
    ZA_LOADAVG="$tmp/loadavg" ZA_SYSFS="$tmp/sysfs" ZA_IDLE_SAMPLE=1 \
    ZP_DIR="$ZP_DIR" ZP_CATALOG="$ZP_CATALOG" ZP_RESULTS="$ZP_RESULTS" \
    ZP_RESULTS_DIR="$ZP_RESULTS_DIR" ZP_CONF="$ZP_CONF" ZP_NFQWS="$ZP_NFQWS" \
    ZP_OPTS_DIR="$ZP_OPTS_DIR" ZP_INIT="$ZP_INIT" ZP_RCD="$ZP_RCD" \
    ZP_PREV="$ZP_PREV" ZP_AUTOSEL="$ZP_AUTOSEL" ZP_STAMP="$ZP_STAMP" \
    sh "$CMD" "$@" 2>&1
}
# Заглушка проверки: результаты уже лежат, поэтому ей достаточно ответить успехом. Факт
# вызова записывается — по нему проверяется, что --no-test её действительно не зовёт.
cat > "$tmp/test-stub" <<EOF
#!/bin/sh
echo "\$@" >> "$tmp/test.log"
exit 0
EOF
chmod +x "$tmp/test-stub"
printf '0.10 0.20 0.30 1/50 100\n' > "$tmp/loadavg"
# Ссылка автозапуска — настоящая, в своём rc.d: без неё zp_enabled отвечает «выключен», и
# расписание выходит РАНЬШЕ проверки покоя. Первая редакция стенда об этом забыла, и три его
# проверки были зелены по неверной причине — расписание молчало не потому, что роутер занят.
ln -sf "$ZP_INIT" "$ZP_RCD/S21zapret"

printf "config zapret 'config'\n\toption NFQWS_OPT '\n#general\n--filter-tcp=80\n'\n" > "$ZP_CONF"
rm -f "$ZP_PREV" "$ZP_AUTOSEL" "$tmp/test.log"
out="$(run_cmd --no-test)"
check "без --apply команда отработала" "0" "$?"
check "рейтинг напечатан" "1" "$(printf '%s' "$out" | grep -c 'рейтинг')"
check "победитель назван" "1" "$(printf '%s' "$out" | grep -c 'победитель: v2')"
check "и сказано, что ничего не изменено" "1" \
    "$(printf '%s' "$out" | grep -c 'ничего не изменено')"
check "активная не изменилась" "general" "$(zp_active_global)"
check "--no-test проверку не зовёт" "0" "$([ -s "$tmp/test.log" ] && echo 1 || echo 0)"

out="$(run_cmd --apply --no-test)"
check "с --apply применилось" "v2" "$(zp_active_global)"
check "и по записи это ручной запуск" "manual" "$(zp_autosel_get by)"
check "обход перезапущен не был (он не работает)" "0" \
    "$([ -s "$tmp/init.log" ] && grep -c restart "$tmp/init.log" || echo 0)"

# ---- расписание ------------------------------------------------------------------------
rm -f "$tmp/uci.db" "$tmp/test.log"
out="$(run_cmd --scheduled)"
check "выключено — расписание молчит и это не ошибка" "0" "$?"
check "и проверку не запускает" "0" "$([ -s "$tmp/test.log" ] && echo 1 || echo 0)"

uci -q set splify2.main.zapret_autoselect=7 >/dev/null 2>&1
# Запись о применении только что поставлена — значит срок не вышел, и подбор обязан
# промолчать. Без этой проверки роутер гонял бы проверку каждую ночь.
run_cmd --scheduled >/dev/null 2>&1
check "срок не вышел — подбор не идёт" "0" "$([ -s "$tmp/test.log" ] && echo 1 || echo 0)"

# Отметку сдвигаем на восемь дней назад: срок вышел.
sed "s/^at=.*/at=$(( $(date +%s) - 8 * 86400 ))/" "$ZP_AUTOSEL" > "$ZP_AUTOSEL.x"
mv "$ZP_AUTOSEL.x" "$ZP_AUTOSEL"
# Загрузка выше предела — подбор откладывается. ЭТО ПРОВЕРКА НА ПОКОЙ, и она важнее
# остальных в разделе: без неё расписание греет процессор роутера в момент, когда человек
# смотрит кино, и он видит просадку без всякой связи с обходом.
printf '3.50 2.00 1.00 1/50 100\n' > "$tmp/loadavg"
out="$(run_cmd --scheduled)"
check "роутер занят — подбор отложен" "1" "$(printf '%s' "$out" | grep -c 'занят')"
check "и проверку не запускал" "0" "$([ -s "$tmp/test.log" ] && echo 1 || echo 0)"

printf '0.10 0.20 0.30 1/50 100\n' > "$tmp/loadavg"
run_cmd --scheduled >/dev/null 2>&1
check "покой и срок вышел — проверка запущена" "1" \
    "$([ -s "$tmp/test.log" ] && echo 1 || echo 0)"
check "и запущена с той областью, что просили" "1" \
    "$(grep -c -- '--scope all' "$tmp/test.log")"

# Проверка не удалась — подбор прекращается, а не ранжирует вчерашнее как сегодняшнее.
cat > "$tmp/test-stub" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$tmp/test-stub"
out="$(run_cmd --apply)"
check "провал проверки — отказ подбора" "1" \
    "$(printf '%s' "$out" | grep -c 'проверка не удалась')"

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
