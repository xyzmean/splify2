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
                # Свой — тот, что можно удалить; у каталожных этой кнопки нет.
                case "$pid" in my_*) json_add_boolean custom 1 ;; esac
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
        # ЧТО ВЫБРАЛ ЧЕЛОВЕК — отдельным полем от того, что получилось. Пусто значит «сами
        # решите» (первый поднятый выход), и это законный выбор, а не отсутствие настройки.
        # Два поля, а не одно, потому что они отвечают на разные вопросы: выбранный выход
        # может лежать, и тогда запросы идут через другой — сказать об этом можно, только
        # зная оба.
        json_add_string out_pick "$(doh_out_pick 2>/dev/null)"
        # force_dns — ключ, который заворачивает весь DNS сети на роутер. Мы его выключаем,
        # когда движку нужен свой резолвер доменных каналов: два перенаправления на порт 53
        # в одной точке дают гонку, и проиграв, наш резолвер молча перестаёт видеть запросы
        # (доменные правила действуют «через раз»). Показывается, потому что иначе это
        # выглядит как «включил force_dns в файле, а splify2 его сбросил».
        # С запуска 65 оба поля постоянны: резолвер держим всегда, поэтому перенаправление
        # порта 53 наше всегда, а force_dns у прокси всегда выключен. Поля остаются в ответе,
        # потому что вкладка ими объясняет человеку, почему его force_dns сброшен, — и это
        # объяснение нужно ровно так же, как раньше.
        #
        # У движка ничего не спрашивается: `needs-dnsd` теперь отвечает «да» безусловно, и
        # лишний его запуск на каждое открытие вкладки платил бы за ответ, известный заранее.
        json_add_boolean needs_dnsd 1
        json_add_string force_dns "$(doh_force_dns)"
        # Ведём ли настройку прокси МЫ. От этого зависит не показ, а права: у чужого
        # хозяйства мы ключей не правим и службу не выключаем — только показываем и
        # предлагаем. Вкладка по этому же признаку рисует «настроено вами» и кнопки
        # запуска.
        doh_managed && json_add_boolean managed 1 || json_add_boolean managed 0
        # Что реально стоит в чужом файле и спорит ли это с нашим резолвером. Пусто —
        # ключа нет вовсе, а у прокси умолчание единица.
        json_add_string force_dns_now "$(doh_force_now 2>/dev/null)"
        doh_force_conflict && json_add_boolean force_conflict 1 ||
            json_add_boolean force_conflict 0
        # Системный DNS адресом: второй род резолвера, живёт в dnsmasq. Пустой список —
        # «как отдаёт провайдер», и это законное состояние, а не «не настроено».
        _dl_ifs2="$IFS"
        json_add_array sys
        IFS='
'
        for a in $(doh_sys_get 2>/dev/null); do
            IFS="$_dl_ifs2"
            [ -n "$a" ] && json_add_string "" "$a"
            IFS='
'
        done
        IFS="$_dl_ifs2"
        json_close_array
        json_dump
        ;;

    # Запуск и остановка ЧУЖОЙ службы по просьбе человека. Хозяином настройки нас не
    # делают: файл не трогается вовсе. Нужны потому, что кнопка «Start» на странице
    # https-dns-proxy у людей не срабатывает, а спрашивают про DoH здесь.
    doh_start)
        need_doh
        doh_installed || fail "https-dns-proxy не установлен"
        doh_start || fail "служба не запустилась — смотрите logread -e https-dns-proxy"
        json_init; json_add_boolean ok 1; json_dump
        ;;

    doh_stop)
        need_doh
        doh_installed || fail "https-dns-proxy не установлен"
        doh_stop || fail "служба не остановилась"
        json_init; json_add_boolean ok 1; json_dump
        ;;

    # Исправить force_dns у ЧУЖОЙ настройки — однократно и по нажатию. Молча этого больше
    # не делает никто: чужой настройкой распоряжается её хозяин.
    doh_force_fix)
        need_doh
        doh_installed || fail "https-dns-proxy не установлен"
        doh_force_fix || fail "не удалось исправить force_dns"
        json_init
        json_add_boolean ok 1
        json_add_string force_dns_now "$(doh_force_now 2>/dev/null)"
        json_dump
        ;;

    # Системный DNS адресом: список простых адресов для dnsmasq. Пустой — вернуть как было.
    doh_sys_set)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var servers servers
        doh_sys_set "${servers:-}" ||
            fail "адрес резолвера пишется как 1.2.3.4 или 1.2.3.4#порт"
        json_init
        json_add_boolean ok 1
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

    doh_custom_add)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var url url
        json_get_var title title
        json_get_var bootstrap bootstrap
        [ -n "$url" ] || fail "нужна ссылка резолвера"
        case "$url" in https://?*) ;; *) fail "ссылка резолвера начинается с https://" ;; esac
        _ca_id="$(doh_custom_add "$url" "${title:-}" "${bootstrap:-}")" ||
            fail "резолвер не записался: в ссылке или названии недопустимые знаки, либо кончилось место"
        # Добавленное сразу и выбирается: ради этого его и вписывали. Отказ выбора не отменяет
        # записи — резолвер остаётся в списке, а причина уходит человеку.
        if doh_installed; then
            doh_write "$_ca_id" && doh_apply && doh_rules_sync ||
                { json_init; json_add_boolean ok 1; json_add_string id "$_ca_id"
                  json_add_string warn "резолвер добавлен, но включить его не удалось"; json_dump; exit 0; }
        fi
        json_init; json_add_boolean ok 1; json_add_string id "$_ca_id"; json_dump
        ;;

    doh_custom_del)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var id id
        case "$id" in my_?*) ;; *) fail "удалять можно только свои резолверы" ;; esac
        _cd_active="$(doh_active 2>/dev/null)"
        doh_custom_del "$id" || fail "нет такого резолвера"
        # Удалили тот, что работает, — DoH не остаётся с пустотой: возвращается пункт по
        # умолчанию, а не выключается молча. Выключение — отдельное решение (doh_off).
        if [ "$_cd_active" = "$id" ] && doh_installed; then
            doh_write default && doh_apply && doh_rules_sync
        fi
        json_init; json_add_boolean ok 1; json_dump
        ;;

    doh_tunnel_set)
        need_doh
        read -r input
        json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
        json_get_var on on
        # Через КАКОЙ выход. Поле необязательное: вызов без него менять выбор не должен —
        # переключатель и выбор выхода нажимают по отдельности. Пустая строка — «решайте
        # сами», то есть снять выбор.
        out=""
        have_out=0
        if json_get_type _ot out 2>/dev/null && [ -n "${_ot:-}" ]; then
            have_out=1
            json_get_var out out
        fi
        uci_file || fail "не удалось создать $UCI_SPLIFY2 — кончилось место?"
        uci -q get splify2.main >/dev/null 2>&1 || uci -q set splify2.main=splify2
        case "$on" in
            1|true) uci -q set splify2.main.doh_via_tunnel=1 ;;
            0|false) uci -q set splify2.main.doh_via_tunnel=0 ;;
            *) fail "нужно true или false" ;;
        esac
        if [ "$have_out" = 1 ]; then
            case "${out:-}" in
                '') uci -q delete splify2.main.doh_out 2>/dev/null ;;
                *[!a-zA-Z0-9_-]*) fail "имя выхода состоит из латиницы, цифр, дефиса и подчёркивания" ;;
                direct) fail "выход direct не уводит трафик никуда — DoH через него это DoH напрямую" ;;
                *)
                    # Существование выхода спрашивается у ДВИЖКА, а не у спеки: спека могла
                    # быть сохранена, но не применена, и обещать маршрут через выход, которого
                    # в ядре нет, значило бы соврать в тот же миг.
                    "$STEER" outputs --spec "$SPEC" 2>/dev/null | grep -qxF "$out" ||
                        fail "выхода $out нет"
                    uci -q set "splify2.main.doh_out=$out"
                    ;;
            esac
        fi
        uci -q commit splify2
        doh_rules_sync
        json_init
        json_add_boolean ok 1
        doh_tunnel_on && json_add_boolean on 1 || json_add_boolean on 0
        json_add_string out "$(doh_out 2>/dev/null | cut -d' ' -f1)"
        json_add_string out_pick "$(doh_out_pick 2>/dev/null)"
        json_dump
        ;;

    *) fail "неизвестный метод" ;;
esac
