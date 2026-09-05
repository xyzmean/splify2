#!/bin/sh
# Часть объекта rpcd splify2 — подключается диспетчером /usr/libexec/rpcd/splify2 по имени
# метода. ЗАЧЕМ ФАЙЛОВ НЕСКОЛЬКО. busybox ash разбирает файл целиком, и объект в 4500 строк
# стоил 110 мс разбора на КАЖДЫЙ вызов — при том, что сам ответ считается за 30-90 мс.
# Диспетчер разбирает только себя, общие помощники (common.sh) и группу вызванного метода.
# Переменные и швы для стендов объявлены в диспетчере и здесь доступны как есть.


# Этой группе нужно скачивание (fetch.sh): подключается здесь, а не каждым вызовом объекта.
need_fetch


# Поставить пакет ПО ИМЕНИ, из репозитория. Не то же, что pkg_install: тот ставит СКАЧАННЫЙ
# ФАЙЛ (движок и интерфейс приезжают из GitHub Releases), а здесь речь про обычные пакеты
# OpenWrt — unzip и curl, без которых половина работы с обходом DPI невозможна.
#
# Списки пакетов обновляются при неудаче и ровно один раз. Причина та же, что у pkg_add_file:
# на свежей прошивке списков нет — они не переживают перезагрузку, — и установка падает не
# потому, что пакета нет, а потому, что о нём нечего знать. У apk это ровно так же, как у
# opkg, хотя беда с зависимостями локального файла у него не воспроизводится.
pkg_add_name() {  # ИМЯ
    if [ "$PM" = apk ]; then
        apk add "$1" >/dev/null 2>&1 && return 0
        apk update >/dev/null 2>&1
        apk add "$1" >/dev/null 2>&1
    else
        opkg install "$1" >/dev/null 2>&1 && return 0
        opkg update >/dev/null 2>&1
        opkg install "$1" >/dev/null 2>&1
    fi
}

case "$2" in

    # ================ обход DPI (zapret) ======================================
    zapret_state)
        need_zapret
        json_init
        zp_installed && json_add_boolean installed 1 || json_add_boolean installed 0
        zp_running   && json_add_boolean running 1   || json_add_boolean running 0
        # Выключатель обхода всего роутера — по ссылке автозапуска. «Не запущен» и «выключен»
        # для человека разные состояния: первое — поломка, второе — его собственное решение.
        zp_enabled   && json_add_boolean enabled 1   || json_add_boolean enabled 0
        # Игровой фильтр (Gv) всего роутера — состояние тем же ответом: три grep по конфигурации,
        # а вкладка без него не знает, что показывать в карточке. `gv`: '' — нет, 0 — встроенный
        # фильтр стратегии Flowseal (у менеджера «GvF»), 1..4 — свой. `fakes` — что менеджер
        # предлагает подделкой и есть ли файл: без файла nfqws молча ничего не подменяет.
        json_add_object game
        json_add_string gv "$(zp_game_gv 2>/dev/null)"
        zp_game_xtreme && json_add_boolean xtreme 1 || json_add_boolean xtreme 0
        json_add_string fake "$(zp_game_fake 2>/dev/null)"
        json_add_array fakes
        for _gf in $ZP_GV_FAKES; do
            json_add_object
            json_add_string name "$_gf"
            [ -s "$ZP_FAKE_DIR/$_gf" ] && json_add_boolean present 1 || json_add_boolean present 0
            json_close_object
        done
        json_close_array
        json_close_object
        json_add_string version "$(zp_version 2>/dev/null)"
        # Чем проверять стратегии. Без curl проверка невозможна, и сказать об этом надо ДО
        # того, как человек нажмёт кнопку: ключи, которыми меряет Zapret Manager (сроки,
        # предел скорости, диапазон байт), у uclient-fetch выразить нечем, а мерить другим
        # инструментом значило бы получить числа, несравнимые с его числами.
        command -v curl >/dev/null 2>&1 && json_add_boolean curl 1 || json_add_boolean curl 0
        json_add_int strategies "$(zp_count)"
        json_add_int updated "$(cat "$ZP_STAMP" 2>/dev/null || echo 0)"
        json_add_string active "$(zp_active_global 2>/dev/null)"
        # Разошлась ли активная стратегия с тем, что теперь в каталоге. Ночное обновление
        # активную НЕ трогает (требование владельца), поэтому расхождение — законное
        # состояние, и единственный способ узнать о нём — спросить.
        _za="$(zp_active_global 2>/dev/null)"
        if [ -n "$_za" ] && zp_drifted_global "$_za" 2>/dev/null; then
            json_add_boolean drifted 1
        else
            json_add_boolean drifted 0
        fi
        json_dump
        ;;

    zapret_install)
        need_zapret
        # Ставится ОТСЮДА, а не зависимостью пакета, и это решение: обход нужен не всем, а
        # архив релиза весит под полмегабайта на архитектуру и приезжает не из репозитория
        # OpenWrt, а из GitHub Releases — жёсткая зависимость сделала бы splify2
        # неустанавливаемым у тех, кто ставит интерфейс первым. Тот же довод, по которому в
        # depends нет самого движка (см. шапку build.sh).
        zp_installed && { json_init; json_add_boolean ok 1
                          json_add_string note "обход DPI уже установлен"; json_dump; exit 0; }
        arch="$(awk -F\' '/DISTRIB_ARCH/ { print $2 }' /etc/openwrt_release 2>/dev/null)"
        [ -n "$arch" ] || fail "не определилась архитектура роутера"
        ver="${ZAPRET_VERSION:-72.20260307}"
        url="https://github.com/remittor/zapret-openwrt/releases/download/v$ver/zapret_v${ver}_${arch}.zip"
        tmpd="$(mktemp -d /tmp/splify2-zapret-pkg.XXXXXX)" || fail "нет места в /tmp"
        if ! download "$url" "$tmpd/z.zip"; then
            rm -rf "$tmpd"
            fail "не удалось скачать $url${FETCH_NOTE:+ ($FETCH_NOTE)}"
        fi
        command -v unzip >/dev/null 2>&1 || pkg_add_name unzip
        command -v unzip >/dev/null 2>&1 || { rm -rf "$tmpd"; fail "нужен unzip, поставить не удалось"; }
        unzip -oq "$tmpd/z.zip" -d "$tmpd" 2>/dev/null || { rm -rf "$tmpd"; fail "архив не распаковался"; }
        # apk на 24.10+ и opkg на 23.05 и старше: в архиве лежат оба формата, и брать нужно
        # тот, который понимает менеджер этого роутера.
        # Порядок важен: сам обход первым, страница LuCI второй — она от него зависит.
        # Ставится через pkg_add_file, а не своим вызовом менеджера: там уже разобрано и
        # различие ключей у apk и opkg, и повтор после `opkg update` на свежей прошивке,
        # где списков пакетов нет вовсе.
        err=""
        if [ "$PM" = apk ]; then zglob="$tmpd/apk/zapret-*.apk $tmpd/apk/luci-app-zapret-*.apk"
        else zglob="$tmpd/zapret_*.ipk $tmpd/luci-app-zapret_*.ipk"
        fi
        for f in $zglob; do
            [ -f "$f" ] || continue
            pkg_add_file "$f" >/dev/null 2>&1 || err="$err $(basename "$f")"
        done
        rm -rf "$tmpd"
        zp_installed || fail "пакеты не встали:${err:- неизвестно почему}"
        # curl нужен проверке стратегий, и ставится он ЗДЕСЬ, а не при нажатии «Проверить»:
        # там человек ждёт результата, а не установки пакета. Неудача не отменяет установки
        # обхода — она только лишает проверки, о чём скажет zapret_state.
        command -v curl >/dev/null 2>&1 || pkg_add_name curl
        # Каталог стратегий сразу: без него вкладка открывается пустой, и человек не понимает,
        # установилось ли что-нибудь.
        zp_sync >/dev/null 2>&1
        json_init
        json_add_boolean ok 1
        json_add_string version "$(zp_version 2>/dev/null)"
        json_add_int strategies "$(zp_count)"
        command -v curl >/dev/null 2>&1 && json_add_boolean curl 1 || json_add_boolean curl 0
        json_dump
        ;;

    zapret_remove)
        need_zapret
        zp_installed || { json_init; json_add_boolean ok 1; json_dump; exit 0; }
        # Проверка снимается первой: она держит своё правило nftables и свой обработчик, и
        # снести пакет под ними значило бы оставить очередь, в которую никто не смотрит.
        start-stop-daemon -K -p "$ZP_PIDFILE" >/dev/null 2>&1
        "$ZP_INIT" stop >/dev/null 2>&1
        # Через pkg_del, а не своим вызовом менеджера: различие ключей у apk и opkg
        # разобрано там, и второй его разбор здесь разошёлся бы с первым. Порядок обратный
        # установке — страница LuCI первой, обход вторым: она от него зависит.
        pkg_del luci-app-zapret
        pkg_del zapret
        # Каталог и результаты остаются: они ничего не занимают, а поставить обход заново —
        # обычное дело, и терять из-за этого результаты часовой проверки незачем.
        json_init
        zp_installed && json_add_boolean ok 0 || json_add_boolean ok 1
        json_dump
        ;;

    zapret_sync)
        need_zapret
        zp_installed || fail "обход DPI не установлен"
        # ZP_NOTE — «скачалось, но не всё, прежний список цел», и рядом с ним FETCH_NOTE
        # лишний: тот рассказывает про удавшуюся половину и делает строку противоречивой.
        if ! zp_sync; then
            [ -n "$ZP_NOTE" ] && fail "$ZP_NOTE"
            fail "каталог стратегий обновить не удалось${FETCH_NOTE:+: $FETCH_NOTE}"
        fi
        json_init
        json_add_boolean ok 1
        json_add_int strategies "$(zp_count)"
        json_add_int updated "$(cat "$ZP_STAMP" 2>/dev/null || echo 0)"
        [ -n "$FETCH_NOTE" ] && json_add_string note "$FETCH_NOTE"
        json_dump
        ;;

    zapret_strategies)
        need_zapret
        # Имена и семейства — здесь; числа проверки — отдельным методом (zapret_results),
        # дословным файлом. Соединяет их интерфейс: разбирать пятьдесят объектов JSON в
        # shell ради того же самого JSON — работа ради работы.
        #
        # Семейство печатается, а не выводится в интерфейсе из имени: правило «начинается
        # с Yv» — это знание о чужом каталоге, и держать его на двух сторонах значило бы
        # переименование у автора ломает разбор молча.
        json_init
        json_add_string active "$(zp_active_global 2>/dev/null)"
        json_add_int updated "$(cat "$ZP_STAMP" 2>/dev/null || echo 0)"
        # Без конвейера — по той же причине, что в doh_state выше: тело конвейера идёт в
        # подоболочке, и накопленный jshn из неё не возвращается. Массив выходил пустым, то
        # есть каталог в интерфейсе был пуст при полном каталоге на диске.
        _zs_ifs="$IFS"
        json_add_array strategies
        IFS='
'
        for n in $(zp_names 2>/dev/null); do
            IFS="$_zs_ifs"
            if [ -n "$n" ]; then
                json_add_object
                json_add_string name "$n"
                case "$n" in
                    general*) json_add_string family flowseal ;;
                    Yv*)      json_add_string family yv ;;
                    v[0-9]*)  json_add_string family v ;;
                    *)        json_add_string family other ;;
                esac
                json_close_object
            fi
            IFS='
'
        done
        IFS="$_zs_ifs"
        json_close_array
        # Какие выходы kind=zapret есть и что у каждого применено. Спрашивается у движка
        # (`steer status`), а не у файлов: имя выхода и его вид знает он, а мы знаем только
        # содержимое файла ключей — и файл, оставшийся от удалённого выхода, выглядел бы
        # как живой выход.
        json_add_array outputs
        st="$("$STEER" status --spec "$SPEC" 2>/dev/null)"
        for o in $("$STEER" outputs --kind zapret --spec "$SPEC" 2>/dev/null); do
            json_add_object
            json_add_string name "$o"
            json_add_string strategy "$(zp_active_out "$o" 2>/dev/null)"
            json_add_int queue "$(printf '%s' "$st" | jsonfilter -e "@.outputs.$o.queue" 2>/dev/null || echo 0)"
            case "$(printf '%s' "$st" | jsonfilter -e "@.outputs.$o.up" 2>/dev/null)" in
                true) json_add_boolean up 1 ;;
                *)    json_add_boolean up 0 ;;
            esac
            json_close_object
        done
        json_close_array
        json_dump
        ;;

    zapret_strategy)
        need_zapret
        # Ключи одной стратегии — как их запустит nfqws, по строке на ключ. Дословно из
        # каталога: интерфейс показывает их человеку, чтобы тот видел, ЧТО применяет, а не
        # только имя. Заголовок «#Имя» из блока снимается — он служебный (см. zp_block).
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var name name
        [ -n "$name" ] || fail "не названа стратегия"
        zp_has "$name" || fail "нет такой стратегии в каталоге: $name"
        json_init
        json_add_string name "$name"
        case "$name" in
            general*) json_add_string family flowseal ;;
            Yv*)      json_add_string family yv ;;
            v[0-9]*)  json_add_string family v ;;
            *)        json_add_string family other ;;
        esac
        json_add_array opts
        # Без конвейера — как в zapret_strategies: тело конвейера идёт в подоболочке, и
        # накопленный jshn из неё не возвращается.
        _zo_ifs="$IFS"
        IFS='
'
        for _zo_l in $(zp_block "$name" 2>/dev/null); do
            IFS="$_zo_ifs"
            case "$_zo_l" in ''|\#*) ;; *) json_add_string "" "$_zo_l" ;; esac
            IFS='
'
        done
        IFS="$_zo_ifs"
        json_close_array
        json_dump
        ;;

    zapret_apply)
        need_zapret
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var name name
        json_get_var out out
        [ -n "$name" ] || fail "не выбрана стратегия"
        zp_installed || fail "обход DPI не установлен"
        zp_has "$name" || fail "нет такой стратегии в каталоге: $name"
        if [ -n "$out" ]; then
            # Выход обязан существовать И быть нужного вида: файл ключей, положенный для
            # выхода kind=interface, никто никогда не прочитает, а в интерфейсе стратегия
            # будет выглядеть применённой.
            "$STEER" outputs --kind zapret --spec "$SPEC" 2>/dev/null |
                grep -qxF "$out" || fail "нет выхода kind=zapret с именем $out"
            zp_apply_out "$out" "$name" || fail "стратегия $name не записалась (её не принял nfqws?)"
            # Сигнал, а не перезапуск движка: перезапуск снял бы правила и уронил туннели,
            # то есть каждая проба другой стратегии стоила бы секунд без интернета.
            "$INITD" reload_zapret >/dev/null 2>&1
            # А если обработчика нет ВОВСЕ — сигналить некому, и procd о таком экземпляре не
            # знает. Так бывает у только что заведённого выхода: стратегию ему выбирают
            # раньше, чем движок успел разобрать спеку. `start` сверяет набор экземпляров и
            # заводит недостающий, не трогая остальные.
            if zapret_needs_instances; then
                "$INITD" start >/dev/null 2>&1
            fi
        else
            zp_apply_global "$name" || fail "стратегия $name не записалась в $ZP_CONF"
            # Выбрать стратегию выключенному обходу значит захотеть его включить: иначе
            # «Применить» отвечает успехом, а стратегия не действует, и человек ищет поломку.
            zp_enabled || "$ZP_INIT" enable >/dev/null 2>&1
            zp_restart || fail "стратегия записана, но обход не перезапустился"
        fi
        json_init
        json_add_boolean ok 1
        json_add_string name "$name"
        [ -n "$out" ] && json_add_string out "$out"
        json_dump
        ;;

    # Выключатель обхода всего роутера. Стратегия при этом не стирается — снимается и
    # останавливается служба (см. zp_disable в zapret.sh): Zapret Manager видит свою
    # конфигурацию, а обработчики выходов kind=zapret продолжают работать своими экземплярами.
    zapret_enable)
        need_zapret
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var on on
        case "$on" in
            1|true)  _on=1 ;;
            0|false) _on=0 ;;
            *) fail "on: ожидается true или false" ;;
        esac
        zp_installed || fail "обход DPI не установлен"
        if [ "$_on" = 1 ]; then
            zp_enable  || fail "нет init-скрипта $ZP_INIT — включать нечего"
        else
            zp_disable || fail "нет init-скрипта $ZP_INIT — выключать нечего"
        fi
        json_init
        json_add_boolean ok 1
        zp_enabled && json_add_boolean enabled 1 || json_add_boolean enabled 0
        zp_running && json_add_boolean running 1 || json_add_boolean running 0
        json_dump
        ;;

    # Игровой фильтр всего роутера: номер (0 снимает), подделка, Xtreme — любое подмножество
    # одним вызовом, в этом порядке, и один перезапуск обхода. Выхода kind=zapret у него нет и
    # не нужно: он ловит весь игровой UDP роутера, как у менеджера (владелец).
    zapret_game_set)
        need_zapret
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var gv gv
        json_get_var fake fake
        json_get_var xtreme xtreme
        zp_installed || fail "обход DPI не установлен"
        [ -s "$ZP_CONF" ] || fail "нет $ZP_CONF"
        [ -n "$gv$fake$xtreme" ] || fail "нечего менять: нужен gv, fake или xtreme"
        if [ -n "$gv" ]; then
            case "$gv" in 0|1|2|3|4) ;; *) fail "gv: ожидается 0..4" ;; esac
            zp_game_set "$gv" || fail "игровая стратегия не записалась в $ZP_CONF"
        fi
        if [ -n "$fake" ]; then
            [ -n "$(zp_game_gv)" ] || fail "подделку не к чему применить: игровой блок не стоит"
            zp_game_fake_set "$fake" || fail "подделка $fake: нет в списке или нет файла"
        fi
        if [ -n "$xtreme" ]; then
            case "$xtreme" in
                1|true)  zp_game_xtreme_on  || fail "Xtreme не к чему включать: игровой блок не стоит" ;;
                0|false) zp_game_xtreme_off || fail "нет файла восстановления $ZP_GV_XTREME_FILE — снять Xtreme нечем" ;;
                *) fail "xtreme: ожидается true или false" ;;
            esac
        fi
        zp_restart || fail "записано, но обход не перезапустился"
        json_init
        json_add_boolean ok 1
        json_add_string gv "$(zp_game_gv 2>/dev/null)"
        zp_game_xtreme && json_add_boolean xtreme 1 || json_add_boolean xtreme 0
        json_add_string fake "$(zp_game_fake 2>/dev/null)"
        json_dump
        ;;

    zapret_test_start)
        need_zapret
        # rpcd отдаёт запрос БЕЗ перевода строки, и `read` на нём возвращает ненулевой код,
        # УЖЕ заполнив переменную. Прежнее `|| input='{}'` затирало прочитанный запрос пустым —
        # и любой набор превращался в «all»: снято с роутера владельца («какие бы группы я не
        # выбрал, тестирует все 58»). Умолчание — только если запроса нет вовсе.
        read -r input 2>/dev/null
        [ -n "$input" ] || input='{}'
        json_load "$input" 2>/dev/null
        json_get_var scope scope 2>/dev/null
        # Набор — семейство либо одна стратегия («one:имя»). Одиночная проверка нужна ради
        # вопроса «а эта у меня пойдёт?» и стоит секунды вместо часа; её результат ложится
        # рядом с остальными, а не затирает их (см. хранение в splify2-zapret-test).
        case "${scope:-all}" in
            all|flowseal|v|yv) ;;
            one:?*) zp_has "${scope#one:}" || fail "нет такой стратегии в каталоге: ${scope#one:}" ;;
            *) fail "набор бывает all, flowseal, v, yv или one:<стратегия>" ;;
        esac
        zp_installed || fail "обход DPI не установлен"
        [ -s "$ZP_CATALOG" ] || fail "каталог стратегий пуст — обновите его"
        command -v curl >/dev/null 2>&1 || fail "нужен curl: без него проверять нечем"
        [ -x "$ZAPRET_TEST" ] || fail "нет $ZAPRET_TEST"
        # Уже идёт — не запускаем вторую: две проверки поделили бы одну очередь и один
        # диапазон портов, и числа обеих оказались бы неверны, ни разу об этом не сказав.
        if start-stop-daemon -K -t -p "$ZP_PIDFILE" >/dev/null 2>&1; then
            fail "проверка уже идёт"
        fi
        # ФОНОМ, и в этом весь смысл: у вызова ubus свой срок жизни, а проверка идёт
        # десятки минут, и человек имеет право закрыть окно роутера. Ход и результат
        # проверка пишет в файлы, страница их читает.
        start-stop-daemon -S -b -m -p "$ZP_PIDFILE" -x "$ZAPRET_TEST" -- \
            --scope "${scope:-all}" >/dev/null 2>&1 || fail "проверку не удалось запустить"
        json_init; json_add_boolean ok 1; json_add_string scope "${scope:-all}"; json_dump
        ;;

    zapret_test_stop)
        need_zapret
        start-stop-daemon -K -p "$ZP_PIDFILE" >/dev/null 2>&1
        # Правила изоляции и обработчик проверка снимает сама (trap на выходе). Но если её
        # убили жёстко, снять их некому — поэтому убираем и здесь: оставленная таблица
        # уводила бы в мёртвую очередь всё, что сядет на её диапазон портов.
        nft delete table inet "${ZT_TABLE:-splify2_ztest}" 2>/dev/null
        rm -f "$ZP_PROGRESS"
        json_init; json_add_boolean ok 1; json_dump
        ;;

    zapret_test)
        need_zapret
        # Ход проверки. Дёшево нарочно: этот метод опрашивают раз в две секунды, пока
        # проверка идёт, поэтому здесь только чтение одного файла в /var — ни пакетного
        # менеджера, ни движка, ни каталога.
        json_init
        if [ -s "$ZP_PROGRESS" ]; then
            while IFS='=' read -r k v; do
                case "$k" in
                    state|scope|current) json_add_string "$k" "$v" ;;
                    started|total|done|targets) json_add_int "$k" "${v:-0}" ;;
                    error) json_add_string error_text "$v" ;;
                esac
            done < "$ZP_PROGRESS"
        else
            json_add_string state idle
        fi
        # Жив ли процесс НА САМОМ ДЕЛЕ. Файл хода мог остаться от проверки, которую убили
        # (снятие питания, OOM): без этой проверки страница показывала бы «идёт» вечно и не
        # давала запустить новую.
        start-stop-daemon -K -t -p "$ZP_PIDFILE" >/dev/null 2>&1 &&
            json_add_boolean running 1 || json_add_boolean running 0
        json_add_int results_at "$(sed -n 's/.*"at":\([0-9]*\).*/\1/p' "$ZP_RESULTS" 2>/dev/null | head -1 || echo 0)"
        json_dump
        ;;

    zapret_results)
        need_zapret
        # ДОСЛОВНО тем файлом, который написала проверка. Файл — уже JSON нашего формата, и
        # пересборка его через jshn означала бы разбор и сборку пятидесяти объектов ради того
        # же самого текста. Тот же приём, что с `status` движка.
        if [ -s "$ZP_RESULTS" ]; then
            cat "$ZP_RESULTS"
        else
            printf '{"at":0,"targets":0,"baseline":0,"results":[]}\n'
        fi
        ;;

    *) fail "неизвестный метод" ;;
esac
