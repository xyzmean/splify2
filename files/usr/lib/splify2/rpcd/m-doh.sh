#!/bin/sh
# Часть объекта rpcd splify2 — подключается диспетчером /usr/libexec/rpcd/splify2 по имени
# метода. ЗАЧЕМ ФАЙЛОВ НЕСКОЛЬКО. busybox ash разбирает файл целиком, и объект в 4500 строк
# стоил 110 мс разбора на КАЖДЫЙ вызов — при том, что сам ответ считается за 30-90 мс.
# Диспетчер разбирает только себя, общие помощники (common.sh) и группу вызванного метода.
# Переменные и швы для стендов объявлены в диспетчере и здесь доступны как есть.


case "$2" in

    # ================ DNS over HTTPS ==========================================
    doh_state)
        need_doh
        # Всё, что нужно вкладке, одним вызовом: без этого она делала бы четыре — за
        # состоянием службы, за каталогом, за выбранным и за туннелем, — а каждый вызов
        # это запуск скрипта объекта (см. шапку файла про 126 мс платы).
        json_init
        doh_installed && json_add_boolean installed 1 || json_add_boolean installed 0
        doh_running   && json_add_boolean running 1   || json_add_boolean running 0
        doh_enabled   && json_add_boolean enabled 1   || json_add_boolean enabled 0
        # Выбранный пункт каталога. Пусто — законное состояние: либо ничего не настроено,
        # либо в конфигурации стоит чужая ссылка (вписана руками, взята из версии менеджера
        # новее нашей). Второй случай отличается от первого непустым urls.
        json_add_string active "$(doh_active 2>/dev/null)"
        # БЕЗ КОНВЕЙЕРА, и это не стиль. `... | while read` исполняет тело в ПОДОБОЛОЧКЕ, а
        # jshn накапливает ответ в переменных оболочки: из подоболочки они не возвращаются
        # никуда. Массив выходил ПУСТЫМ при полностью исправном на вид коде — то есть вкладка
        # DoH открывалась без единого резолвера в списке, и выбрать было нечего. Поймано
        # стендом rpcdmatch. Поэтому строки перебираются подстановкой с IFS по переводу
        # строки: сама подстановка происходит в этой же оболочке.
        _dl_ifs="$IFS"
        json_add_array urls
        IFS='
'
        for u in $(doh_urls 2>/dev/null); do
            IFS="$_dl_ifs"
            [ -n "$u" ] && json_add_string "" "$u"
            IFS='
'
        done
        IFS="$_dl_ifs"
        json_close_array
        json_add_array providers
        IFS='
'
        for row in $(doh_items 2>/dev/null); do
            IFS="$_dl_ifs"
            pid="${row%%|*}"; ptitle="${row#*|}"
            if [ -n "$pid" ]; then
                json_add_object
                json_add_string id "$pid"
                json_add_string title "$ptitle"
                json_close_object
            fi
            IFS='
'
        done
        IFS="$_dl_ifs"
        json_close_array
        doh_tunnel_on && json_add_boolean via_tunnel 1 || json_add_boolean via_tunnel 0
        # Через какой выход пойдёт (или уже идёт) DoH. Называется он здесь ровно затем,
        # чтобы человек не думал, будто есть отдельный выбор: выбора нет, это первый
        # ПОДНЯТЫЙ выход с устройством. Считает его та же функция, что ставит маршрут, —
        # иначе интерфейс обещал бы один выход, а трафик шёл бы через другой. Ищется (два запуска
        # движка и jsonfilter на выход) только когда туннель включён — иначе поле пусто по
        # смыслу, а вкладка ждала эти запуски зря.
        if doh_tunnel_on; then
            json_add_string out "$(doh_out 2>/dev/null | cut -d' ' -f1)"
        else
            json_add_string out ""
        fi
        # force_dns — ключ, который заворачивает весь DNS сети на роутер. Мы его выключаем,
        # когда движку нужен свой резолвер доменных каналов: два перенаправления на порт 53
        # в одной точке дают гонку, и проиграв, наш резолвер молча перестаёт видеть запросы
        # (доменные правила действуют «через раз»). Показывается, потому что иначе это
        # выглядит как «включил force_dns в файле, а splify2 его сбросил».
        # Нужда в резолвере спрашивается у движка ОДИН раз: force_dns выводится из неё тем же
        # правилом, что в doh_force_dns, а не вторым запуском движка.
        if doh_needs_dnsd; then
            json_add_boolean needs_dnsd 1; json_add_string force_dns 0
        else
            json_add_boolean needs_dnsd 0; json_add_string force_dns 1
        fi
        json_dump
        ;;

    doh_set)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var provider provider
        [ -n "$provider" ] || fail "не выбран резолвер"
        doh_installed || fail "https-dns-proxy не установлен"
        doh_has "$provider" || fail "нет такого резолвера в каталоге: $provider"
        doh_write "$provider" || fail "не удалось записать $DOH_CONF — кончилось место?"
        doh_apply || fail "настройка записана, но служба не перезапустилась"
        # Правила «через туннель» пересобираются здесь же: пользователь службы задаётся той
        # же записью настройки, и правило ссылается на него. Порядок обратный оставил бы
        # правило, отбирающее трафик пользователя, которого в настройке уже нет.
        doh_rules_sync
        json_init
        json_add_boolean ok 1
        json_add_string active "$(doh_active 2>/dev/null)"
        json_add_string force_dns "$(doh_force_dns)"
        json_dump
        ;;

    doh_off)
        need_doh
        doh_installed || fail "https-dns-proxy не установлен"
        doh_off
        doh_rules_sync
        json_init; json_add_boolean ok 1; json_dump
        ;;

    doh_tunnel_set)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var on on
        uci_file || fail "не удалось создать $UCI_SPLIFY2 — кончилось место?"
        uci -q get splify2.main >/dev/null 2>&1 || uci -q set splify2.main=splify2
        case "$on" in
            1|true) uci -q set splify2.main.doh_via_tunnel=1 ;;
            0|false) uci -q set splify2.main.doh_via_tunnel=0 ;;
            *) fail "нужно true или false" ;;
        esac
        uci -q commit splify2
        doh_rules_sync
        json_init
        json_add_boolean ok 1
        doh_tunnel_on && json_add_boolean on 1 || json_add_boolean on 0
        json_add_string out "$(doh_out 2>/dev/null | cut -d' ' -f1)"
        json_dump
        ;;

    *) fail "неизвестный метод" ;;
esac
