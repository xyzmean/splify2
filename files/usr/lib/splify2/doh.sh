# DNS over HTTPS: каталог резолверов, настройка https-dns-proxy и его состояние.
#
# ЗАЧЕМ ВООБЩЕ. Провайдер видит имена сайтов раньше, чем что-либо ещё: DNS идёт открытым
# текстом, и по нему и блокируют, и подменяют ответы. Обход по SNI и обход по адресу от этого
# не спасают — до них дело не доходит, потому что адрес уже подменён. Поэтому DoH здесь не
# «ещё одна настройка», а первая ступень: без неё половина стратегий обхода лечит симптом.
#
# ЧТО ЗДЕСЬ, А ЧЕГО НЕТ. Здесь каталог резолверов и запись /etc/config/https-dns-proxy. Правил
# nftables здесь НЕТ: «DoH через туннель» — это метка в цепочке output, и живёт она рядом с
# такой же меткой фикса Zapret Manager, в объекте rpcd, где уже есть и опрос движка, и разбор
# его состояния. Две реализации одного приёма разошлись бы.
#
# `set -u` не ставится: файл подключает объект rpcd, который на необъявленных переменных
# живёт законно.

DOH_CONF=${DOH_CONF:-/etc/config/https-dns-proxy}
DOH_INIT=${DOH_INIT:-/etc/init.d/https-dns-proxy}
DOH_LIST=${DOH_LIST:-/usr/share/splify2/doh-providers.conf}
DOH_STEER=${DOH_STEER:-/usr/sbin/steer}
DOH_SPEC=${DOH_SPEC:-/etc/steer/spec.json}
# С какого порта раздавать резолверам listen_port. 5053 — то же, что у менеджера и у
# умолчаний пакета: на этот порт ссылается dnsmasq, и менять его без нужды значило бы
# разойтись с чужой настройкой, которая уже могла быть сделана.
DOH_PORT0=${DOH_PORT0:-5053}

doh_installed() { [ -x "$DOH_INIT" ]; }
# Работает ли и включён ли автозапуск — на роутере по процессу и по ссылке в /etc/rc.d, а не
# через init-скрипт: тот стоит оболочки с rc.common на каждый вопрос, а вкладка задаёт их два
# при каждом открытии. Подменённый стендом init-скрипт спрашивается как раньше.
doh_running()   {
    doh_installed || return 1
    if [ "$DOH_INIT" = /etc/init.d/https-dns-proxy ]; then pidof https-dns-proxy >/dev/null 2>&1
    else "$DOH_INIT" running >/dev/null 2>&1
    fi
}
# Включён ли автозапуск. Отдельно от «работает»: выключенная служба после перезагрузки не
# вернётся, и человеку это надо видеть до перезагрузки, а не после.
doh_enabled()   {
    doh_installed || return 1
    if [ "$DOH_INIT" = /etc/init.d/https-dns-proxy ] && [ -d /etc/rc.d ]; then
        set -- /etc/rc.d/S[0-9][0-9]https-dns-proxy
        [ -e "$1" ]
    else "$DOH_INIT" enabled >/dev/null 2>&1
    fi
}

# ---- каталог ------------------------------------------------------------------------
# Строки каталога без комментариев и пустых.
doh_providers() {
    [ -s "$DOH_LIST" ] || return 1
    grep -v '^[[:space:]]*#' "$DOH_LIST" | grep '|'
}

# Пункты списка: id и название, по одному на пункт. Несколько строк с одним id — это один
# пункт с несколькими резолверами (см. шапку файла каталога).
doh_items() {
    doh_providers | awk -F'|' '!seen[$1]++ { print $1 "|" $2 }'
}

doh_has() { doh_providers | cut -d'|' -f1 | grep -qxF "${1:-}"; }

# ---- какой резолвер стоит сейчас -----------------------------------------------------
# По ссылкам в конфигурации, а не по своей записи «что мы выбрали». Своя запись разошлась бы
# с настоящей настройкой ровно в тот момент, когда её поменяли не нами — руками, менеджером
# или страницей luci-app-https-dns-proxy. Тот же довод, что с активной стратегией обхода.
#
# Сравниваются НАБОРЫ ссылок: у пункта «по умолчанию» их две, и совпадение по одной означало
# бы, что «Cloudflare» и «по умолчанию» неразличимы.
doh_active() {
    [ -s "$DOH_CONF" ] || return 1
    _da_cur="$(sed -n "s/^[[:space:]]*option resolver_url '\([^']*\)'.*/\1/p" "$DOH_CONF" |
               sort | tr '\n' ' ')"
    [ -n "$_da_cur" ] || return 1
    for _da_id in $(doh_providers | cut -d'|' -f1 | awk '!seen[$0]++'); do
        _da_want="$(doh_providers | awk -F'|' -v id="$_da_id" '$1 == id { print $3 }' |
                    sort | tr '\n' ' ')"
        [ "$_da_cur" = "$_da_want" ] && { printf '%s' "$_da_id"; return 0; }
    done
    # Ссылка есть, а в каталоге её нет — законное состояние: человек вписал свою руками или
    # взял из версии менеджера новее нашей. Пустой ответ здесь означает «чужой», и интерфейс
    # обязан показать ссылку как есть, а не «не настроено».
    return 1
}

# Ссылки как есть — чтобы показать чужой резолвер, которого нет в каталоге.
doh_urls() {
    [ -s "$DOH_CONF" ] || return 1
    sed -n "s/^[[:space:]]*option resolver_url '\([^']*\)'.*/\1/p" "$DOH_CONF"
}

# ---- запись настройки ----------------------------------------------------------------
# Нужен ли роутеру наш резолвер доменных каналов. Спрашивается у движка, а не выводится из
# спеки: то же правило, что у init-скрипта (см. needs-dnsd там).
doh_needs_dnsd() {
    [ -x "$DOH_STEER" ] && "$DOH_STEER" needs-dnsd --spec "$DOH_SPEC" >/dev/null 2>&1
}

# ГЛАВНАЯ ТОНКОСТЬ ВСЕГО ФАЙЛА — force_dns.
#
# Этот ключ заставляет https-dns-proxy завернуть весь DNS локальной сети (порты 53 и 853) на
# роутер. Zapret Manager ставит его в 1 всегда, и для роутера без движка это верно.
#
# У нас же на том же порту 53 стоит СВОЁ перенаправление — на резолвер движка (steer dnsd,
# порт 5300), и именно он превращает доменные правила в маршрутизацию. Два перенаправления на
# один порт в одной точке (nat prerouting, приоритет dstnat) выигрывает то, которое
# зарегистрировалось раньше, а это зависит от порядка запуска служб. Проиграв, наш резолвер
# перестаёт видеть запросы — и доменные правила молча перестают действовать: сайты
# открываются, но идут мимо туннеля, и понять это можно только по счётчику канала, который
# стоит на нуле.
#
# Поэтому: движку нужен резолвер — force_dns выключаем. Ничего при этом не теряется, DNS всё
# равно заворачивается на роутер, только нашим правилом. Не нужен — ставим 1, как менеджер.
doh_force_dns() { doh_needs_dnsd && printf '0' || printf '1'; }

# Записать конфигурацию под выбранный пункт каталога.
#
# ФАЙЛ ПЕРЕПИСЫВАЕТСЯ ЦЕЛИКОМ, как это делает менеджер (`rm -f "$fileDoH"; printf ... >`), и
# это осознанно: набор секций у резолверов разный (у «по умолчанию» их две, у остальных одна),
# а править многострочный uci вслепую в shell — способ однажды оставить половину прежней
# настройки. Цена — потеря чужих правок в этом файле; она названа в интерфейсе.
doh_write() {  # ID
    doh_has "${1:-}" || return 1
    _dw_tmp="$DOH_CONF.splify2.tmp"
    {
        # Шапка — дословно та же, что у менеджера, кроме force_dns (см. выше). Каждый ключ
        # тут неспроста: canary_* отключают у Firefox и iOS их собственный DoH (иначе они
        # ходят мимо роутера), dnsmasq_config_update '*' переставляет dnsmasq на наш прокси,
        # notrack_dns снимает лишний учёт conntrack, heartbeat_* — проверка живости.
        printf "config main 'config'\n"
        printf "\toption canary_domains_icloud '1'\n"
        printf "\toption canary_domains_mozilla '1'\n"
        printf "\toption dnsmasq_config_update '*'\n"
        printf "\toption force_dns '%s'\n" "$(doh_force_dns)"
        printf "\toption notrack_dns '1'\n"
        printf "\tlist force_dns_port '53'\n"
        printf "\tlist force_dns_port '853'\n"
        printf "\tlist force_dns_src_interface 'lan'\n"
        printf "\toption procd_trigger_wan6 '0'\n"
        printf "\toption heartbeat_domain 'heartbeat.mossdef.org'\n"
        printf "\toption heartbeat_sleep_timeout '10'\n"
        printf "\toption heartbeat_wait_timeout '10'\n"
        # Пользователь nobody — не косметика: под ним же ходят исходящие запросы прокси, и
        # именно по нему их узнаёт правило «DoH через туннель» (объект rpcd, doh_rules_sync).
        printf "\toption user 'nobody'\n"
        printf "\toption group 'nogroup'\n"
        printf "\toption listen_addr '127.0.0.1'\n"
        printf "\toption force_ip_family 'auto'\n"
        _dw_port="$DOH_PORT0"
        doh_providers | awk -F'|' -v id="$1" '$1 == id { print $3 "|" $4 }' |
        while IFS='|' read -r _dw_url _dw_boot; do
            [ -n "$_dw_url" ] || continue
            printf "\nconfig https-dns-proxy\n"
            printf "\toption resolver_url '%s'\n" "$_dw_url"
            [ -n "$_dw_boot" ] && printf "\toption bootstrap_dns '%s'\n" "$_dw_boot"
            printf "\toption listen_port '%s'\n" "$_dw_port"
            _dw_port=$((_dw_port + 1))
        done
    } > "$_dw_tmp" || { rm -f "$_dw_tmp"; return 1; }
    grep -q 'resolver_url' "$_dw_tmp" || { rm -f "$_dw_tmp"; return 1; }
    mv "$_dw_tmp" "$DOH_CONF"
}

# Привести force_dns в согласие с тем, нужен ли движку свой резолвер.
#
# ЗАЧЕМ ОТДЕЛЬНО ОТ doh_write. Пакет https-dns-proxy — зависимость splify2, то есть он
# приезжает всем и включается со своей стандартной настройкой, где force_dns = 1. Пока
# доменных правил нет, это верно и безобидно. Но правило по доменам человек заводит ПОЗЖЕ —
# и с этой минуты на порт 53 претендуют двое: наш резолвер и прокси. Проигравший (а кто
# проиграет, решает порядок запуска служб) молча остаётся без запросов, и доменные правила
# перестают действовать: сайты открываются, счётчик канала стоит на нуле.
#
# Поэтому вызывается это из `apply` — ровно в тот момент, когда доменные каналы появляются
# или исчезают, — и из скрипта установки пакета. Ничего не делает, когда значение уже верное:
# перезапуск прокси на каждом «Применить» стоил бы человеку паузы в DNS на ровном месте.
#
# Через uci, а не переписыванием файла: у человека в этом файле может стоять свой резолвер,
# вписанный руками, и терять его ради одного ключа незачем. Секция берётся по ТИПУ (@main[0]),
# а не по имени: имя задаёт пакет, и держаться за него — держаться за чужое умолчание.
doh_force_sync() {
    doh_installed || return 0
    [ -s "$DOH_CONF" ] || return 0
    _dfs_want="$(doh_force_dns)"
    _dfs_now="$(uci -q get https-dns-proxy.@main[0].force_dns 2>/dev/null)"
    [ "$_dfs_now" = "$_dfs_want" ] && return 0
    uci -q set "https-dns-proxy.@main[0].force_dns=$_dfs_want" || return 1
    uci -q commit https-dns-proxy || return 1
    "$DOH_INIT" restart >/dev/null 2>&1
    return 0
}

# Применить: перезапустить прокси и dnsmasq.
#
# dnsmasq перезапускается ОБЯЗАТЕЛЬНО и вторым: список серверов ему переписывает сам
# https-dns-proxy (dnsmasq_config_update '*'), но подхватывает он его только при перезапуске.
# Без этой строки настройка выглядит применённой, а запросы идут прежним путём.
doh_apply() {
    doh_installed || return 1
    "$DOH_INIT" enable >/dev/null 2>&1
    "$DOH_INIT" restart >/dev/null 2>&1
    /etc/init.d/dnsmasq restart >/dev/null 2>&1
    return 0
}

# Выключить, не удаляя. Служба остаётся установленной (пакет — зависимость splify2), но не
# запускается и не трогает dnsmasq: это и есть «DoH выключен» на нашей вкладке.
doh_off() {
    doh_installed || return 0
    "$DOH_INIT" disable >/dev/null 2>&1
    "$DOH_INIT" stop >/dev/null 2>&1
    /etc/init.d/dnsmasq restart >/dev/null 2>&1
    return 0
}
