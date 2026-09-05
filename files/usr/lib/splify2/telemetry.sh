# Сборка пакета телеметрии. Контракт — docs/TELEMETRY.md, он же читается панелью.
#
# ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Собирают пакет двое: метод `telemetry_preview` (человек смотрит,
# что уедет, ДО согласия) и команда отправки по расписанию. Две копии сборки означали бы, что
# экран «вот что уедет» показывает не то, что уезжает, — то есть обещание, которое нельзя
# проверить. Здесь одна функция, и стенд сверяет байты предпросмотра с байтами отправки.
#
# ГЛАВНОЕ ПРАВИЛО — ТО ЖЕ, ЧТО У ОТЧЁТА ДЛЯ ПОДДЕРЖКИ: читать ТОЛЬКО НАЗВАННЫЕ ПОЛЯ чужих
# ответов и никогда не пересказывать документ целиком. `steer status` несёт поля спеки (путь
# к файлу подписки, номера узлов, адрес сервера обфускации), `vless-nodes` — весь список
# узлов с именами и адресами. Дословный пересказ любого из двух это готовая утечка, а не
# «лишние подробности». Поэтому ниже нет ни одного `cat` чужого ответа: каждое поле берётся
# по имени и приводится к своему виду.
#
# И ВТОРОЕ ПРАВИЛО, КОТОРОГО У ОТЧЁТА НЕТ. Отчёт человек копирует глазами и вставляет туда,
# куда решил; телеметрия уезжает по расписанию без него. Поэтому три вещи, законные в отчёте,
# здесь запрещены: имена выходов, имена правил и названия подписок — их писал человек либо
# панель провайдера, и они говорят о нём, а не о работе продукта.
#
# `set -u` здесь не ставится: файл подключают и объект rpcd, и команда отправки, а объект
# живёт с необъявленными переменными законно.

TM_SCHEMA=1

STEER=${STEER:-/usr/sbin/steer}
SPEC=${SPEC:-/etc/steer/spec.json}
LISTS=${LISTS:-/etc/steer/lists}
GEO_DIR=${GEO_DIR:-/var/lib/splify2}
SYSINFO_MODEL=${SYSINFO_MODEL:-/tmp/sysinfo/model}
OPENWRT_RELEASE=${OPENWRT_RELEASE:-/etc/openwrt_release}
BUILD_ID_FILE=${BUILD_ID_FILE:-/www/luci-static/resources/splify2/build-id.txt}
# Признак загрузки: восемь знаков, свои у каждой загрузки. В /tmp нарочно — он и обязан
# теряться при перезагрузке, в этом весь его смысл.
TM_BOOT_FILE=${TM_BOOT_FILE:-/var/run/splify2-boot-id}
# Счётчики событий — тоже в /tmp: обработчик hotplug при флапающем WAN срабатывает десятки
# раз в минуту, и писать это во флеш значило бы убивать память роутера ровно в том случае,
# который мы и хотим измерить.
TM_EVENTS=${TM_EVENTS:-/var/run/splify2-events}
# Возраст страны выхода, после которого она в пакет не идёт. Сутки: страна меняется редко, а
# «Эстония» рядом с только что выбранной Польшей выглядит как ответ, хотя это память.
TM_GEO_MAX_AGE=${TM_GEO_MAX_AGE:-86400}

# ---- вывод JSON ----------------------------------------------------------------------
# Печатается потоком, без сборки документа в памяти: пакет читают дважды (предпросмотр и
# отправка), а собирать его в переменной оболочки значит один раз обжечься на строке в
# полтора килобайта с чужими байтами внутри.
tm_str() {  # СТРОКА -> строка JSON в кавычках
    printf '"'
    printf '%s' "${1:-}" | awk '
        BEGIN { RS = "^$" }
        {
            gsub(/\\/, "\\\\")
            gsub(/"/, "\\\"")
            gsub(/\n/, " ")
            gsub(/\r/, " ")
            gsub(/\t/, " ")
            printf "%s", $0
        }'
    printf '"'
}

# Число или ноль. Всё, что пришло не числом, — ноль: пакет читает чужая программа, и «null»
# вместо числа ей дороже, чем честный ноль.
tm_int() {  # ЗНАЧЕНИЕ
    case "${1:-}" in
        ''|*[!0-9-]*) printf '0' ;;
        *)            printf '%s' "$1" ;;
    esac
}

tm_bool() { [ "${1:-0}" = 1 ] && printf 'true' || printf 'false'; }

# ---- признак загрузки ------------------------------------------------------------------
tm_boot_id() {
    if [ -s "$TM_BOOT_FILE" ]; then
        sed -n '1{s/[^0-9a-f]//g;p;}' "$TM_BOOT_FILE" | cut -c1-8
        return 0
    fi
    mkdir -p "$(dirname "$TM_BOOT_FILE")" 2>/dev/null
    _tb="$(sed -n '1{s/[^0-9a-f]//g;p;}' /proc/sys/kernel/random/uuid 2>/dev/null | cut -c1-8)"
    [ -n "$_tb" ] || _tb="$(date +%s | cksum | tr -d ' -' | cut -c1-8)"
    printf '%s\n' "$_tb" > "$TM_BOOT_FILE" 2>/dev/null
    printf '%s' "$_tb"
}

# ---- идентификатор ---------------------------------------------------------------------
#
# СЧИТАЕТ ДВИЖОК И СЧИТАЕТ МЕДЛЕННО (PBKDF2, 600 000 проходов) — поэтому ответ запоминается
# в настройке, а не спрашивается каждый раз. Счёт детерминирован: запомненное только
# избавляет от повторной платы и не становится вторым источником истины. После сброса к
# заводским настройкам роутер посчитает то же самое значение заново — ради этого свойства
# идентификатор и выводится из MAC, а не берётся случайным.
tm_id() {
    _ti="$(uci -q get splify2.main.telemetry_id 2>/dev/null)"
    case "${_ti:-}" in
        sp-[0-9a-f]*) printf '%s' "$_ti"; return 0 ;;
    esac
    [ -x "$STEER" ] || return 1
    _ti="$("$STEER" dev-id 2>/dev/null | sed -n 's/.*"tid":"\(sp-[0-9a-f]*\)".*/\1/p')"
    [ -n "$_ti" ] || return 1
    uci_file 2>/dev/null || true
    uci -q set "splify2.main.telemetry_id=$_ti" 2>/dev/null
    uci -q commit splify2 2>/dev/null
    printf '%s' "$_ti"
}

# ---- согласие --------------------------------------------------------------------------
# Три состояния, и третье не блажь: «не спрашивали» даёт интерфейсу право предложить один
# раз, «отказался» не даёт никогда.
tm_consent() {  # -> unset | off | on
    case "$(uci -q get splify2.main.telemetry 2>/dev/null)" in
        1|on|yes|true) printf 'on' ;;
        '')            printf 'unset' ;;
        *)             printf 'off' ;;
    esac
}

# ---- счётчики событий ------------------------------------------------------------------
# Кумулятивные С ЗАГРУЗКИ, а не разностные, и это то, что позволяет не копить очередь при
# недоступной панели: пропущенная отправка не теряет ни одного события — следующая покажет
# число побольше, а `boot` и `uptime` объяснят перезагрузку.
tm_event() {  # ИМЯ -> число
    [ -s "$TM_EVENTS" ] || { printf '0'; return 0; }
    _te="$(sed -n "s/^${1:-}=\([0-9]*\)$/\1/p" "$TM_EVENTS" | tail -n1)"
    printf '%s' "${_te:-0}"
}

# ---- страны выходов --------------------------------------------------------------------
# ТОЛЬКО ИЗ КЭША, и это решение про цену: свежее измерение — это запрос через КАЖДЫЙ выход
# по восемь секунд, то есть скрытая плата за телеметрию на роутере, который человек в этот
# момент не трогает. Кэш наполняет вкладка, когда человек её открывает.
#
# Из строки кэша берётся ВТОРОЕ поле и только оно. В третьем лежит внешний адрес выхода —
# ровно то, чего в пакете быть не должно, и лежит оно в том же файле, в соседнем поле.
tm_geo_cc() {  # ВЫХОД -> код страны или пусто
    _tg="$GEO_DIR/geo-${1:-}"
    [ -s "$_tg" ] || return 1
    read -r _tg_at _tg_cc _tg_rest < "$_tg" 2>/dev/null || return 1
    case "${_tg_at:-}" in ''|*[!0-9]*) return 1 ;; esac
    _tg_age=$(( $(date +%s) - _tg_at ))
    [ "$_tg_age" -le "$TM_GEO_MAX_AGE" ] || return 1
    case "${_tg_cc:-}" in
        [A-Za-z][A-Za-z]) printf '%s' "$_tg_cc" | tr 'a-z' 'A-Z' ;;
        *) return 1 ;;
    esac
}

# ---- домен панели подписки -------------------------------------------------------------
#
# Отправляется РЕГИСТРИРУЕМЫЙ домен — две последние метки, — а не хост целиком. У части
# панелей токен живёт в поддомене (`https://<токен>.sub.example.org/`), и «отрезали всё после
# хоста» там не спасает: секретом оказывается сам хост.
#
# Схема (`https://`) не отправляется вовсе. Пользы в ней ноль — панели работают по HTTPS, — а
# её отсутствие делает запрет «в пакете нет ни одного ://» сплошным и потому проверяемым.
#
# Признак `deep` говорит панели, что меток было больше двух: тогда группировка приблизительна
# (у суффиксов вида `co.uk` две последние метки — это не домен), и она об этом знает.
tm_sub_host() {  # ССЫЛКА -> «домен deep» либо пусто
    _th="${1:-}"
    case "$_th" in *://*) _th="${_th#*://}" ;; esac
    _th="${_th%%/*}"          # путь
    _th="${_th%%\?*}"         # запрос
    _th="${_th##*@}"          # логин с паролём
    _th="${_th%%:*}"          # порт
    case "$_th" in ''|*[!A-Za-z0-9.-]*) return 1 ;; esac
    _th_n="$(printf '%s' "$_th" | awk -F. '{ print NF }')"
    [ "${_th_n:-0}" -ge 2 ] || return 1
    _th_last="$(printf '%s' "$_th" | awk -F. '{ print $(NF-1) "." $NF }')"
    # Признак «меток было больше двух». Он честнее любого нашего списка суффиксов: у
    # `co.uk` две последние метки — это не домен, а хвост, и без полного перечня публичных
    # суффиксов (мегабайт данных ради одного поля) отличить один случай от другого нечем.
    # Панель по этому признаку знает, что группировка здесь приблизительная.
    _th_deep=0
    [ "$_th_n" -gt 2 ] && _th_deep=1
    printf '%s %s' "$_th_last" "$_th_deep"
}

# Пути списков из спеки, по одному на строку.
#
# СПЕКА ЧИТАЕТСЯ КАК ОДНА СТРОКА, а не построчно: её пишет и человек, и восстановление из
# архива, и она бывает и в одну строку, и с переносами. Построчный разбор молча терял бы
# половину списков на второй форме — то есть пакет говорил бы «этими списками не
# пользуются», а ими пользуются.
tm_list_files() {
    tr -d '\n' < "$SPEC" 2>/dev/null |
        sed 's/"\(prefixes_files\|domains_files\)":\[/\n@@[/g' |
        sed -n 's/^@@\[\([^]]*\)\].*/\1/p' |
        tr ',' '\n' | tr -d '" ' | grep . | sort -u
}

# ---- сам пакет -------------------------------------------------------------------------
#
# Печатается ОДНОЙ строкой JSON. Ни одного поля с неизвестным значением: если величины нет,
# нет и поля — панель обязана это пережить (правило совместимости в docs/TELEMETRY.md).
# «Ноль вместо неизвестного» здесь хуже отсутствия: ноль неотличим от измеренного нуля.
RPCD_OBJ=${RPCD_OBJ:-/usr/libexec/rpcd/splify2}
ZAPRET_SH=${ZAPRET_SH:-/usr/lib/splify2/zapret.sh}
DOH_SH=${DOH_SH:-/usr/lib/splify2/doh.sh}

# Значение поля из ответа объекта rpcd. Разбор по ИМЕНИ ПОЛЯ, а не по порядку: ответ читается
# как данные, а не как текст известной формы.
tm_field() {  # JSON ИМЯ
    printf '%s' "${1:-}" | sed -n "s/.*\"${2:-}\":\"\([^\"]*\)\".*/\1/p" | head -1
}
tm_field_num() {  # JSON ИМЯ
    printf '%s' "${1:-}" | sed -n "s/.*\"${2:-}\":\([0-9-]*\).*/\1/p" | head -1
}

tm_build() {
    _tm_id="$(tm_id)" || return 1
    printf '{"v":%s,"id":' "$TM_SCHEMA"
    tm_str "$_tm_id"
    printf ',"at":%s,"boot":' "$(date +%s)"
    tm_str "$(tm_boot_id)"
    printf ',"uptime":%s' "$(tm_int "$(cut -d. -f1 /proc/uptime 2>/dev/null)")"

    # ---- устройство и версии ----
    #
    # ЧЕРЕЗ СВОЙ ЖЕ МЕТОД `engine`, подпроцессом, а не копией его помощников. Версия пакета,
    # архитектура, вариант сборки и состояние службы считаются в группе движка четырьмя
    # помощниками; копия здесь означала бы пятое место, где решается «какая версия стоит», —
    # причём в пакете, по которому потом судят о роутере. Тот же довод, что у отчёта для
    # поддержки, и та же цена: один лишний разбор скрипта объекта, раз в сутки.
    _tm_e=""
    [ -x "$RPCD_OBJ" ] && _tm_e="$(sh "$RPCD_OBJ" call engine </dev/null 2>/dev/null)"
    printf ',"dev":{'
    printf '"model":'; tm_str "$(sed -n '1{s/[[:space:]]*$//;p;}' "$SYSINFO_MODEL" 2>/dev/null)"
    _tm_os=""
    [ -f "$OPENWRT_RELEASE" ] && _tm_os="$( . "$OPENWRT_RELEASE" 2>/dev/null
        printf '%s' "${DISTRIB_DESCRIPTION:-${DISTRIB_RELEASE:-}}" )"
    printf ',"os":'; tm_str "$_tm_os"
    _tm_arch="$(tm_field "$_tm_e" arch)"
    [ -n "$_tm_arch" ] && { printf ',"arch":'; tm_str "$_tm_arch"; }
    printf '}'

    printf ',"ver":{'
    printf '"ui":'; tm_str "$(sed -n '1{s/[[:space:]]*$//;p;}' "$BUILD_ID_FILE" 2>/dev/null)"
    _tm_sv="$(tm_field "$_tm_e" version)"
    [ -n "$_tm_sv" ] && { printf ',"steer":'; tm_str "$_tm_sv"; }
    # Вид сборки движка. Без него вся статистика перекошена: базовая сборка не умеет VLESS, и
    # «у них не работает подписка» на ней — не поломка, а не та сборка.
    _tm_present="$(tm_field_num "$_tm_e" present)"
    _tm_vless="$(tm_field_num "$_tm_e" vless)"
    if [ "${_tm_present:-0}" = 1 ]; then
        [ "${_tm_vless:-0}" = 1 ] && _tm_kind=extended || _tm_kind=base
    else
        _tm_kind=absent
    fi
    printf ',"steer_kind":'; tm_str "$_tm_kind"
    printf ',"steer_up":%s' "$(tm_bool "$(tm_field_num "$_tm_e" running)")"
    printf '}'

    # ---- выходы ----
    #
    # ПО НОМЕРУ, А НЕ ПО ИМЕНИ. Имя выхода писал человек, и «vpn-для-тёщи» это сведения о нём.
    # Номер — порядок в спеке, тот же, каким выходы перечисляет отчёт для поддержки.
    #
    # Из ответа движка берутся ТРИ поля: вид, поднятость и состояние пробы. Рядом в том же
    # объекте лежат `device`, `mark`, `table`, `nodes[]`, `opts_file` и `obfs.server` — адрес
    # и порт сервера обфускации; пересказ объекта целиком был бы утечкой, а не подробностью.
    _tm_st=""
    [ -x "$STEER" ] && _tm_st="$("$STEER" status --spec "$SPEC" 2>/dev/null)"
    printf ',"out":['
    _tm_i=0
    _tm_first=1
    for _tm_name in $(printf '%s' "$_tm_st" |
            sed -n 's/.*"outputs":{\(.*\)/\1/p' |
            grep -o '"[A-Za-z0-9_.:@-]*":{"kind"' | sed 's/":{"kind"//; s/^"//'); do
        _tm_i=$((_tm_i + 1))
        _tm_obj="$(printf '%s' "$_tm_st" | grep -o "\"$_tm_name\":{[^{}]*\(}[^{}]*\)\?" | head -1)"
        _tm_kindv="$(tm_field "$_tm_obj" kind)"
        case "$_tm_kindv" in direct|interface|vless|zapret|obfs|xsteer|tgws) ;; *) _tm_kindv=other ;; esac
        [ "$_tm_first" = 1 ] || printf ','
        _tm_first=0
        printf '{"i":%s,"kind":' "$_tm_i"
        tm_str "$_tm_kindv"
        case "$(printf '%s' "$_tm_obj" | grep -o '"up":[a-z]*' | head -1)" in
            '"up":true')  printf ',"up":true' ;;
            '"up":false') printf ',"up":false' ;;
        esac
        _tm_cc="$(tm_geo_cc "$_tm_name" 2>/dev/null)" && { printf ',"cc":'; tm_str "$_tm_cc"; }
        printf '}'
    done
    printf ']'

    # ---- списки ----
    #
    # ЧЕМ пользуются, а не сколько в них записей: число записей владелец не просил, и это
    # верно — оно ничего не говорит о продукте, зато самый дорогой вопрос из всех.
    #
    # Хозяин списка узнаётся ПО ПУТИ, тем же правилом, каким он записан на диске: свой
    # подкаталог у второго издателя, `custom` у человека. Имена своих списков не уезжают —
    # только их число: их набирал человек.
    printf ',"lists":{"cat":['
    _tm_first=1
    for _tm_f in $(tm_list_files); do
        case "$_tm_f" in
            "$LISTS"/itdog/*|"$LISTS"/custom/*|'') continue ;;
            "$LISTS"/*) ;;
            *) continue ;;
        esac
        _tm_n="${_tm_f#"$LISTS"/}"; _tm_n="${_tm_n%.lst}"; _tm_n="${_tm_n#domains/}"
        case "$_tm_n" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
        [ "$_tm_first" = 1 ] || printf ','
        _tm_first=0
        tm_str "$_tm_n"
    done
    printf '],"itdog":['
    _tm_first=1
    for _tm_f in $(tm_list_files); do
        case "$_tm_f" in "$LISTS"/itdog/*) ;; *) continue ;; esac
        _tm_n="${_tm_f##*/}"; _tm_n="${_tm_n%.lst}"
        case "$_tm_n" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
        [ "$_tm_first" = 1 ] || printf ','
        _tm_first=0
        tm_str "$_tm_n"
    done
    _tm_custom="$(tm_list_files | grep -c "^$LISTS/custom/")"
    printf '],"custom":%s}' "$(tm_int "$_tm_custom")"

    # ---- DoH ----
    # Провайдер — ТОЛЬКО id из нашего каталога: вписанную руками ссылку `doh_active` не
    # отдаёт вовсе, и это решено не здесь, а там, где ей и место.
    if [ -r "$DOH_SH" ]; then
        ( . "$DOH_SH" 2>/dev/null
          printf ',"doh":{"installed":%s,"running":%s,"enabled":%s,"provider":' \
              "$(tm_bool "$(doh_installed && echo 1 || echo 0)")" \
              "$(tm_bool "$(doh_running && echo 1 || echo 0)")" \
              "$(tm_bool "$(doh_enabled && echo 1 || echo 0)")"
          tm_str "$(doh_active 2>/dev/null)"
          printf '}' )
    fi

    # ---- обход DPI ----
    if [ -r "$ZAPRET_SH" ]; then
        ( . "$ZAPRET_SH" 2>/dev/null
          printf ',"zapret":{"installed":%s,"running":%s,"enabled":%s' \
              "$(tm_bool "$(zp_installed && echo 1 || echo 0)")" \
              "$(tm_bool "$(zp_running && echo 1 || echo 0)")" \
              "$(tm_bool "$(zp_enabled && echo 1 || echo 0)")"
          _tm_v="$(zp_version 2>/dev/null)"
          [ -n "$_tm_v" ] && { printf ',"version":'; tm_str "$_tm_v"; }
          # Имя стратегии уезжает, только если оно ЕСТЬ В КАТАЛОГЕ. Иначе это чужая или
          # правленная руками строка, и вместо неё едет слово `custom`: имя, которого нет у
          # автора, ничего не говорит о продукте, зато может быть чем угодно.
          _tm_a="$(zp_active_global 2>/dev/null)"
          if [ -n "$_tm_a" ]; then
              if zp_has "$_tm_a" 2>/dev/null; then
                  printf ',"strategy":'; tm_str "$_tm_a"
              else
                  printf ',"strategy":"custom"'
              fi
              printf ',"drifted":%s' \
                  "$(tm_bool "$(zp_drifted_global >/dev/null 2>&1 && echo 1 || echo 0)")"
          fi
          _tm_yv="$(zp_yv_get 2>/dev/null)"; [ -n "$_tm_yv" ] && printf ',"yv":%s' "$(tm_int "$_tm_yv")"
          _tm_dv="$(zp_dv_get 2>/dev/null)"; [ -n "$_tm_dv" ] && printf ',"dv":%s' "$(tm_int "$_tm_dv")"
          _tm_gv="$(zp_game_gv 2>/dev/null)"; [ -n "$_tm_gv" ] && printf ',"gv":%s' "$(tm_int "$_tm_gv")"
          printf ',"strategies":%s}' "$(tm_int "$(zp_count 2>/dev/null)")" )
    fi

    # ---- подписки ----
    #
    # НОМЕРОМ И ДОМЕНОМ. Названия не уезжают: их пишет либо человек, либо панель провайдера,
    # а в её строках встречаются и рекламные сообщения, и логин владельца — этот же отказ уже
    # принят для отчёта поддержки, и два разных ответа на один вопрос разошлись бы молча.
    printf ',"subs":['
    _tm_i=0
    _tm_first=1
    for _tm_key in $(uci -q show splify2 2>/dev/null |
                     sed -n 's/^splify2\.\(main\|sub_[A-Za-z0-9_]*\)\.sub_url=.*/\1.sub_url/p;
                             s/^splify2\.\(sub_[A-Za-z0-9_]*\)\.url=.*/\1.url/p'); do
        _tm_url="$(uci -q get "splify2.${_tm_key%.*}.${_tm_key##*.}" 2>/dev/null)"
        [ -n "$_tm_url" ] || continue
        _tm_i=$((_tm_i + 1))
        _tm_hd="$(tm_sub_host "$_tm_url")" || continue
        [ "$_tm_first" = 1 ] || printf ','
        _tm_first=0
        printf '{"i":%s,"host":' "$_tm_i"
        tm_str "${_tm_hd% *}"
        printf ',"deep":%s}' "$(tm_bool "${_tm_hd#* }")"
    done
    printf ']'

    # ---- приговоры проверок ----
    #
    # ТОЛЬКО `id` И `verdict`, ни одного символа `what`/`why`: там подставлены имена выходов
    # («выход vpn-для-тёщи: …»). Это не ошибки, а готовые диагнозы, и «у 30% роутеров
    # dns_redirect: fail» — указание, что чинить в продукте.
    _tm_d=""
    [ -x "$STEER" ] && _tm_d="$("$STEER" diag --spec "$SPEC" 2>/dev/null)"
    printf ',"diag":{'
    _tm_dfirst=1
    for _tm_v in fail warn note; do
        [ "$_tm_dfirst" = 1 ] || printf ','
        _tm_dfirst=0
        printf '"%s":[' "$_tm_v"
        _tm_first=1
        for _tm_c in $(printf '%s' "$_tm_d" | grep -o "{\"id\":\"[a-z_]*\",\"verdict\":\"$_tm_v\"" |
                       sed 's/{"id":"//; s/",".*//'); do
            [ "$_tm_first" = 1 ] || printf ','
            _tm_first=0
            tm_str "$_tm_c"
        done
        printf ']'
    done
    printf '}'

    # ---- события ----
    printf ',"ev":{"wan_down":%s,"iface_down":%s,"since":%s}' \
        "$(tm_int "$(tm_event wan_down)")" \
        "$(tm_int "$(tm_event iface_down)")" \
        "$(tm_int "$(cut -d. -f1 /proc/uptime 2>/dev/null)")"
    printf '}\n'
}
