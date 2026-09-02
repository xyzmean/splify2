#!/bin/sh
# Часть объекта rpcd splify2 — подключается диспетчером /usr/libexec/rpcd/splify2 по имени
# метода. ЗАЧЕМ ФАЙЛОВ НЕСКОЛЬКО. busybox ash разбирает файл целиком, и объект в 4500 строк
# стоил 110 мс разбора на КАЖДЫЙ вызов — при том, что сам ответ считается за 30-90 мс.
# Диспетчер разбирает только себя, общие помощники (common.sh) и группу вызванного метода.
# Переменные и швы для стендов объявлены в диспетчере и здесь доступны как есть.


# Путь внутри каталогов настроек — и никуда больше. Спека несёт пути к файлам списков и к
# файлу подписки, то есть присланный файл может попросить движок читать что угодно
# («отсутствие путей за пределы каталогов настроек»). Правило то же, что у local_path для
# путей от издателя: только под $LISTS (или ровно $SUB) и без '..' в любом виде.
backup_safe_path() {  # ПУТЬ
    case "$1" in
        *..*) return 1 ;;
    esac
    case "$1" in
        "$SUB") return 0 ;;
        "$LISTS"/*) return 0 ;;
    esac
    return 1
}

# Разложить присланный файл по разделам в каталог-песочницу. Печатает причину и
# возвращает 1 на негодном файле.
#
# Разбор строгий и с отказом, а не «что понял — то и взял»: непонятный раздел означает
# либо чужой формат, либо файл от версии, которой этот интерфейс не знает, и в обоих
# случаях молча восстановить половину хуже, чем не восстановить ничего. Имена файлов в
# песочнице собираются ЗДЕСЬ из проверенных регулярным выражением частей — из присланного
# файла ни один путь не берётся.
backup_split() {  # ФАЙЛ КАТАЛОГ
    awk -v dir="$2" -v ver="$BACKUP_FORMAT" '
    NR == 1 {
        if ($0 !~ /^splify2-backup [0-9]+$/) { print "это не файл настроек splify2"; exit 1 }
        if ($2 != ver) { print "файл версии " $2 ", этот интерфейс понимает " ver; exit 1 }
        next
    }
    /^#/ { next }
    /^\[/ {
        if ($0 == "[spec]")         { cur = dir "/spec" }
        else if ($0 == "[sub]")     { cur = dir "/sub" }
        else if ($0 == "[options]") { cur = dir "/options" }
        else if ($0 ~ /^\[list (domains|prefixes) [A-Za-z0-9_-]+\]$/) {
            split(substr($0, 2, length($0) - 2), p, " ")
            cur = dir "/list." p[2] "." p[3]
        }
        else { print "непонятный раздел: " substr($0, 1, 40); exit 1 }
        if (seen[cur]++) { print "раздел повторяется: " substr($0, 1, 40); exit 1 }
        printf "" > cur
        next
    }
    {
        if (cur == "") {
            if ($0 ~ /^[ \t]*$/) next
            print "строка вне раздела: " substr($0, 1, 40)
            exit 1
        }
        print > cur
    }
    ' "$1"
}

# Спека из архива. Судья по-прежнему компилятор движка (--dry-run), но ДО него проверяется
# то, о чём компилятор не знает: размер, экранированные управляющие символы, набор
# символов в именах и пути, уходящие за каталоги настроек.
backup_check_spec() {  # ФАЙЛ
    sz="$(wc -c 2>/dev/null < "$1" || echo 0)"
    [ "$sz" -le "$BACKUP_SPEC_MAX" ] || { echo "спека больше $((BACKUP_SPEC_MAX / 1024)) КБ"; return 1; }
    # Экранированный перевод строки внутри строки JSON — не опечатка, а способ разложить
    # одно значение на две строки там, где строки читаются по одной (jsonfilter печатает
    # по совпадению на строку, и оболочка режет вывод по строкам). Интерфейс таких
    # значений не пишет: в спеке нет ни одного поля, где перевод строки был бы осмыслен.
    if grep -q '\\[nrtu]' "$1"; then
        echo "в спеке экранированные управляющие символы — так интерфейс не пишет"
        return 1
    fi
    json_load "$(cat "$1")" 2>/dev/null || { echo "спека не разбирается как JSON"; return 1; }
    # Переменные обнуляются ПЕРЕД каждым чтением: json_get_var на отсутствующем ключе
    # оставляет прежнее значение, и без этого выход без device унаследовал бы device
    # предыдущего — то есть проверка смотрела бы не на то, что проверяет.
    lan=''
    json_get_var lan lan_device
    if [ -n "$lan" ] && ! backup_safe_word "$lan"; then
        echo "lan_device «$lan»: имя устройства так не выглядит"
        return 1
    fi
    # Множественная форма того же поля (splify2#16). Проверять только одиночную значило бы
    # оставить дыру ровно того вида, ради которого проверка и написана: поле в спеке новое,
    # проверка старая, и недоверенный архив снова проезжает в командную строку. Имя отсюда
    # уходит и в текст правил nftables, и в командные строки движка.
    if json_select lan_devices 2>/dev/null; then
        json_get_keys lan_idx
        for i in $lan_idx; do
            lan=''
            json_get_var lan "$i"
            if [ -n "$lan" ] && ! backup_safe_word "$lan"; then
                echo "lan_devices «$lan»: имя устройства так не выглядит"
                json_select ..
                return 1
            fi
        done
        json_select ..
    fi
    if json_select outputs 2>/dev/null; then
        json_get_keys onames
        for o in $onames; do
            # Проверка двойная, и вторая половина не лишняя: имена приезжают из
            # json_get_keys одной строкой через пробел, поэтому имя С ПРОБЕЛОМ приехало
            # бы двумя годными на вид словами. Такого ключа в объекте нет, значит
            # json_select по нему не пройдёт — и файл будет отвергнут.
            backup_safe_word "$o" || { echo "имя выхода «$o» — только латиница, цифры, точка, двоеточие, дефис"; return 1; }
            json_select "$o" 2>/dev/null || { echo "имя выхода «$o» не читается как ключ — пробел или кавычка внутри?"; return 1; }
            dev=''; sf=''
            json_get_var dev device
            if [ -n "$dev" ] && ! backup_safe_word "$dev"; then
                echo "устройство «$dev» у выхода $o: так имя устройства не выглядит"
                return 1
            fi
            json_get_var sf sub_file
            if [ -n "$sf" ] && ! backup_safe_path "$sf"; then
                echo "файл подписки «$sf» у выхода $o лежит вне каталогов настроек"
                return 1
            fi
            json_select ..
        done
        json_select ..
    fi
    # Каналы — массивом, поэтому через jsonfilter, а не через jshn: у него для массивов
    # своя нумерация ключей, и полагаться на неё в проверке недоверенного ввода незачем.
    for v in $(jsonfilter -i "$1" -e '@.channels[*].name' -e '@.channels[*].out' 2>/dev/null); do
        backup_safe_word "$v" || { echo "«$v» в канале — только латиница, цифры, точка, двоеточие, дефис"; return 1; }
    done
    # Оба написания списочных полей: короткое документировано контрактом v1 и движком
    # реализовано (см. normalizeSpec в интерфейсе), значит присланный файл вправе его
    # содержать — и проверять его надо тоже.
    for p in $(jsonfilter -i "$1" \
        -e '@.channels[*].match.prefixes_files[*]' -e '@.channels[*].match.domains_files[*]' \
        -e '@.channels[*].match.prefixes_file'    -e '@.channels[*].match.domains_file' 2>/dev/null); do
        backup_safe_path "$p" || { echo "список «$p» лежит вне каталога списков"; return 1; }
    done
    return 0
}

# Подписка из архива: либо ссылки vless:// по строке, либо один блок base64 (подписка
# ровно так и приезжает от провайдера). Файл читает движок, разбор base64 у него свой —
# здесь проверяется только то, что это вообще похоже на подписку, а не на что-то ещё.
backup_check_sub() {  # ФАЙЛ
    sz="$(wc -c 2>/dev/null < "$1" || echo 0)"
    [ "$sz" -le "$BACKUP_SUB_MAX" ] || { echo "подписка больше $((BACKUP_SUB_MAX / 1024)) КБ"; return 1; }
    lines="$(grep -c "[^[:space:]]" "$1")"
    [ "$lines" -gt 0 ] || { echo "раздел подписки пуст"; return 1; }
    [ "$(grep -c '^vless://' "$1")" = "$lines" ] && return 0
    grep -qvE '^[A-Za-z0-9+/=]*$' "$1" || return 0
    echo "подписка: ждём строки vless:// или один блок base64"
    return 1
}

# Поля uci. Ключи — по белому списку: непонятное поле здесь означало бы, что архив
# принесён из другой версии и его смысл нам неизвестен.
backup_check_options() {  # ФАЙЛ
    sz="$(wc -c 2>/dev/null < "$1" || echo 0)"
    [ "$sz" -le "$BACKUP_OPT_MAX" ] || { echo "раздел настроек больше $((BACKUP_OPT_MAX / 1024)) КБ"; return 1; }
    while IFS= read -r ln; do
        [ -n "$ln" ] || continue
        k="${ln%%=*}"; v="${ln#*=}"
        case "$k" in
            sub_url)
                case "$v" in http://*|https://*) ;; *) echo "sub_url: нужна ссылка http:// или https://"; return 1 ;; esac
                # Ссылка уезжает в uci и оттуда в командную строку загрузчика. Пробелы,
                # кавычки и подстановки в ней не значат ничего хорошего ни в одном из
                # этих мест.
                case "$v" in *[\ \"\'\`\$\;\|\&\<\>]*) echo "sub_url: недопустимые символы в ссылке"; return 1 ;; esac
                ;;
            sub_kind)
                case "$v" in url|links|none) ;; *) echo "sub_kind: ждём url, links или none"; return 1 ;; esac
                ;;
            wizard) ;;
            *) echo "непонятная настройка: $k"; return 1 ;;
        esac
    done < "$1"
    return 0
}

# Отказ с уборкой за собой: развёрнутый архив и накопленный файл убираются, причина уезжает
# человеку. Отдельной функцией потому, что проверок восемь, и «забыть убрать» в одной из них
# означало бы файл в /tmp, переживший отказ.
backup_giveup() {  # ПРИЧИНА
    rm -rf "$D"
    rm -f "$BACKUP_IN"
    fail "$1"
}

case "$2" in

    backup_get)
        # Архив уезжает СТРОКОЙ и по кускам, а файл собирается в браузере. Готового способа
        # отдать файл в проекте нет (экспорта логов или диагностики не было), а cgi-io
        # означал бы второй путь наружу со своими правами и своей проверкой — ровно тот
        # довод, по которому и свой список грузится через ubus, а не загрузкой файла.
        read -r input
        off="$(jsonfilter -s "$input" -e '@.offset' 2>/dev/null)"
        case "$off" in ''|*[!0-9]*) off=0 ;; esac
        # Пересобирается только на первом куске: пересборка на каждом означала бы, что
        # куски приезжают из разных мгновений и склеиваются в файл, которого не было.
        if [ "$off" = 0 ]; then
            backup_build > "$BACKUP_OUT" || { rm -f "$BACKUP_OUT"; fail "не удалось собрать архив"; }
        fi
        [ -s "$BACKUP_OUT" ] || fail "архив не собран — запросите его с начала"
        total="$(wc -c 2>/dev/null < "$BACKUP_OUT" || echo 0)"
        # Отказ на СОБСТВЕННОМ пределе восстановления, а не молчаливая отдача. Иначе экспорт
        # выдавал бы файл, который его же импорт откажется принять, — а узнать об этом
        # человек смог бы только в тот день, когда бекап понадобился.
        if [ "$total" -gt "$BACKUP_MAX_BYTES" ]; then
            rm -f "$BACKUP_OUT"
            fail "настройки со своими списками не влезают в архив: $((total / 1024)) КБ при пределе $((BACKUP_MAX_BYTES / 1024)) КБ"
        fi
        # Заплатка `printf X` и срезание её обратно: подстановка команды съедает
        # ЗАВЕРШАЮЩИЕ переводы строки, а кусок обязан приехать байт в байт — иначе на
        # границе куска пропадает перевод строки и две строки настроек склеиваются в одну.
        text="$(tail -c "+$((off + 1))" "$BACKUP_OUT" | head -c "$BACKUP_CHUNK"; printf X)"
        text="${text%X}"
        got="$(printf '%s' "$text" | wc -c)"
        next=$((off + got))
        eof=0
        [ "$next" -ge "$total" ] && eof=1
        json_init
        json_add_boolean ok 1
        json_add_int format "$BACKUP_FORMAT"
        json_add_int total "$total"
        json_add_int offset "$off"
        json_add_int next "$next"
        json_add_boolean eof "$eof"
        json_add_string text "$text"
        json_dump
        # Через `if`, а не через `&&`: последняя команда ветки задаёт код возврата всего
        # скрипта, и на непоследнем куске он оказался бы ненулевым без всякой ошибки.
        if [ "$eof" = 1 ]; then rm -f "$BACKUP_OUT"; fi
        ;;

    backup_put)
        # Восстановление. Присланный файл — НЕДОВЕРЕННЫЙ ВВОД, и это главная мысль всей
        # ветки: до сих пор спеку писал только root через spec_set, а теперь её содержимое
        # приносит человек файлом, взятым неизвестно откуда (I-003: движок подставляет
        # lan_device в popen без фильтрации, и до импорта это была теоретическая слабость).
        # Поэтому порядок такой: принять по кускам с пределом на размер → разложить строгим
        # разборщиком по разделам → проверить КАЖДЫЙ раздел отдельно → и только потом
        # писать на диск.
        #
        # Применения здесь нет и быть не должно: восстановленное человек видит как
        # неприменённое и применяет сам (модель «сохранено ≠ применено», ApplyPill).
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        text=''; append=''; final=''
        json_get_var text text
        json_get_var append append
        json_get_var final final
        case "$append" in 1|true) ;; *) rm -f "$BACKUP_IN" ;; esac
        # Размер накопленного — через проверку существования И с верным порядком
        # перенаправлений (подробно — у backup_check_spec): отсутствующий файл иначе печатает
        # жалобу самой оболочки рядом с ответом, а пустое значение уезжает в json_add_int.
        have=0
        [ -f "$BACKUP_IN" ] && have="$(wc -c 2>/dev/null < "$BACKUP_IN" || echo 0)"
        add="$(printf '%s' "$text" | wc -c)"
        # Предел считается по НАКОПЛЕННОМУ, а не по куску: иначе он обходится самым обычным
        # способом им пользоваться — прислать двадцать кусков по пределу каждый. Ровно эта
        # ошибка уже была в list_put и стоила отдельной правки.
        if [ "$((have + add))" -gt "$BACKUP_MAX_BYTES" ]; then
            rm -f "$BACKUP_IN"
            fail "архив больше $((BACKUP_MAX_BYTES / 1024)) КБ — столько настроек не бывает"
        fi
        printf '%s' "$text" >> "$BACKUP_IN" || { rm -f "$BACKUP_IN"; fail "не записалось — кончилось место?"; }
        case "$final" in
            1|true) ;;
            *)  json_init; json_add_boolean ok 1; json_add_int bytes "$((have + add))"; json_dump; exit 0 ;;
        esac
        [ -s "$BACKUP_IN" ] || { rm -f "$BACKUP_IN"; fail "пустой архив"; }
        # Управляющие байты — отдельной проверкой на весь файл и до разбора: перевод строки
        # и табуляция законны, всё прочее в текстовом файле настроек означает либо двоичный
        # мусор, либо попытку спрятать строку от построчного разборщика.
        if [ "$(LC_ALL=C tr -d '\11\12\40-\377' < "$BACKUP_IN" | wc -c)" != 0 ]; then
            rm -f "$BACKUP_IN"
            fail "в архиве двоичные данные — это не файл настроек"
        fi
        D="/tmp/splify2-restore.$$"
        rm -rf "$D"
        mkdir -p "$D/clean" || fail "не удалось развернуть архив"
        why="$(backup_split "$BACKUP_IN" "$D")" || backup_giveup "${why:-архив не разбирается}"
        any=0
        for f in "$D/spec" "$D/sub" "$D/options" "$D"/list.*; do [ -f "$f" ] && any=1; done
        [ "$any" = 1 ] || backup_giveup "в архиве нет ни настроек, ни списков"
        if [ -f "$D/spec" ]; then
            why="$(backup_check_spec "$D/spec")" || backup_giveup "спека из архива: ${why:-не годится}"
        fi
        if [ -f "$D/sub" ]; then
            why="$(backup_check_sub "$D/sub")" || backup_giveup "${why:-подписка из архива не годится}"
        fi
        if [ -f "$D/options" ]; then
            why="$(backup_check_options "$D/options")" || backup_giveup "${why:-настройки из архива не годятся}"
        fi
        # Свои списки — ТЕМ ЖЕ санитайзером, что и list_put. Второй проверки формата здесь
        # быть не должно: расхождение между «что принимает загрузка» и «что принимает
        # восстановление» означало бы список, который нельзя вернуть на свой же роутер.
        # Одна строка на список, поля через двоеточие: в имени списка двоеточия быть не
        # может (проверено разборщиком), поэтому разбирается обратно однозначно.
        entries=''
        for f in "$D"/list.*; do
            [ -f "$f" ] || continue
            b="${f##*/}"; rest="${b#list.}"; k="${rest%%.*}"; nm="${rest#*.}"
            sz="$(wc -c 2>/dev/null < "$f" || echo 0)"
            [ "$sz" -le "$LIST_MAX_BYTES" ] ||
                backup_giveup "список «$nm» больше $((LIST_MAX_BYTES / 1024)) КБ — столько на роутер не кладём"
            sanitize_list "$k" "$f" "$D/clean/$b" "$D/clean/$b.stat"
            kept=0; dropped=0
            read -r kept dropped < "$D/clean/$b.stat"
            entries="$entries $k:$nm:${kept:-0}:${dropped:-0}"
        done
        # ---- с этого места пишем на диск ----
        # Списки и подписка ложатся ДО проверки спеки движком, и это не небрежность: спека
        # из архива ссылается на них путями, а движок при --dry-run читает и файлы списков,
        # и файл подписки. Положив спеку первой, мы получили бы отказ компилятора на
        # файлах, которые едут в том же архиве.
        warn=''
        for e in $entries; do
            k="${e%%:*}"; rest="${e#*:}"; nm="${rest%%:*}"
            dest="$(custom_path "$nm" "$k")"
            mkdir -p "$(dirname "$dest")"
            # Перенос внутри одной ФС, как в list_put: между /tmp (tmpfs) и overlay busybox
            # копирует, и обрыв оставил бы на месте рабочего списка обрубок.
            cp "$D/clean/list.$k.$nm" "$dest.new.$$" && mv "$dest.new.$$" "$dest" ||
                { rm -f "$dest.new.$$"; warn="${warn}список $nm не записался; "; }
        done
        sub_done=0
        if [ -f "$D/sub" ]; then
            mkdir -p "$(dirname "$SUB")"
            cp "$D/sub" "$SUB.new.$$" && mv "$SUB.new.$$" "$SUB" ||
                { rm -f "$SUB.new.$$"; backup_giveup "подписка не записалась — кончилось место?"; }
            sub_done=1
        fi
        if [ -f "$D/options" ]; then
            # Файл конфигурации создаётся здесь по той же причине, что и в sub_set: `uci set`
            # в несуществующий файл молча ничего не делает, и настройка «восстанавливалась»
            # бы, отчитываясь успехом.
            #
            # Почему через uci_file, а не перенаправлением, — в объяснении у самой функции:
            # отказ перенаправления у встроенной команды уносит оболочку целиком, и метод
            # умирает без ответа. Стенд это и поймал — сначала здесь.
            uci_file || backup_giveup "не удалось создать $UCI_SPLIFY2 — кончилось место?"
            uci -q get splify2.main >/dev/null 2>&1 || uci -q set splify2.main=splify2
            while IFS= read -r ln; do
                [ -n "$ln" ] || continue
                uci -q set "splify2.main.${ln%%=*}=${ln#*=}"
            done < "$D/options"
            uci -q commit splify2
        fi
        spec_done=0
        if [ -f "$D/spec" ]; then
            mkdir -p "$(dirname "$SPEC")"
            # Списки издателя доскачиваются перед проверкой — ровно как в spec_set: движок
            # умирает на отсутствующем файле списка, а восстановление на чистый роутер тем и
            # отличается, что зеркал категорий там ещё нет (в архив они не едут намеренно).
            fetch_warn="$(fetch_missing_lists "$D/spec")"
            if ! err="$("$STEER" apply --dry-run --spec "$D/spec" 2>&1 >/dev/null)"; then
                backup_giveup "${fetch_warn:+$fetch_warn; }${err:-движок отверг спеку из архива}. Списки и подписка из архива при этом уже восстановлены."
            fi
            [ -n "$fetch_warn" ] && warn="$warn$fetch_warn; "
            # Снимок применённого — ДО подмены. Иначе восстановленное выглядело бы
            # применённым: applied_get при отсутствии снимка отдаёт саму спеку, и пилюля
            # «Применить · N» показала бы ноль на только что заменённой настройке.
            if [ ! -s "$APPLIED" ]; then
                if [ -s "$SPEC" ]; then cp "$SPEC" "$APPLIED" 2>/dev/null
                else printf '{"schema":1,"outputs":{},"channels":[]}\n' > "$APPLIED"
                fi
            fi
            cp "$D/spec" "$SPEC.new.$$" && mv "$SPEC.new.$$" "$SPEC" ||
                { rm -f "$SPEC.new.$$"; backup_giveup "спека не записалась — кончилось место?"; }
            spec_done=1
        fi
        # Восстановление меняет и подписку, и САМ НАБОР выходов, а клиент vless с
        # обфускатором читают своё один раз при старте. Признак поэтому instances, а не
        # params: экземпляра для появившегося выхода ещё нет, и сигналить некому.
        dirty_mark "$VLESS_DIRTY" instances
        dirty_mark "$VLESS_DIRTY" params
        dirty_mark "$OBFS_DIRTY" instances
        dirty_mark "$OBFS_DIRTY" params
        dirty_mark "$ZAPRET_DIRTY" instances
        json_init
        json_add_boolean ok 1
        json_add_boolean spec "$spec_done"
        json_add_boolean sub "$sub_done"
        json_add_array lists
        for e in $entries; do
            k="${e%%:*}"; rest="${e#*:}"; nm="${rest%%:*}"; rest="${rest#*:}"
            json_add_object ""
            json_add_string name "$nm"
            json_add_string kind "$k"
            json_add_int count "${rest%%:*}"
            json_add_int dropped "${rest#*:}"
            json_close_object
        done
        json_close_array
        [ -n "$warn" ] && json_add_string warn "$warn"
        json_dump
        rm -rf "$D"
        rm -f "$BACKUP_IN"
        ;;

    *) fail "неизвестный метод" ;;
esac
