#!/bin/sh
# Часть объекта rpcd splify2 — подключается диспетчером /usr/libexec/rpcd/splify2 по имени
# метода. ЗАЧЕМ ФАЙЛОВ НЕСКОЛЬКО. busybox ash разбирает файл целиком, и объект в 4500 строк
# стоил 110 мс разбора на КАЖДЫЙ вызов — при том, что сам ответ считается за 30-90 мс.
# Диспетчер разбирает только себя, общие помощники (common.sh) и группу вызванного метода.
# Переменные и швы для стендов объявлены в диспетчере и здесь доступны как есть.


# Этой группе нужно скачивание (fetch.sh): подключается здесь, а не каждым вызовом объекта.
need_fetch


# Архитектура ПАКЕТОВ, а не процессора.
#
# `apk --print-arch` отдаёт `aarch64`, а пакеты OpenWrt называются `aarch64_cortex-a53`:
# по первому имя файла собирается неверно, и скачивание молча не находит релиз. Верный
# источник — DISTRIB_ARCH из /etc/openwrt_release, то же значение, что показывает
# `apk list -I` в колонке архитектуры.
# Фолбэка на `apk --print-arch` здесь СОЗНАТЕЛЬНО нет, хотя он напрашивается. Он отдаёт
# `aarch64`, а в релизе нет ни одного файла с таким именем: имя собирается неверно,
# скачивание не находит пакет и отвечает «нет такой версии для aarch64» — то есть винит
# издателя в том, чего не делал. Пустой ответ честнее: и steer_versions, и steer_install
# на нём говорят «не определилась архитектура», и это правда.
pkg_arch() {
    [ -f "$OPENWRT_RELEASE" ] || return 0
    ( . "$OPENWRT_RELEASE"; printf '%s' "${DISTRIB_ARCH:-}" )
}

gh_load() {  # ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ
    GH_VERS=""
    GH_NAMES="|"
    GH_NOTE=""
    _gl_c="${GH_CACHE:-/tmp/splify2-releases.json}.$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_').cache"
    if [ -s "$_gl_c" ] && [ -z "$(find "$_gl_c" -mmin "+$GH_CACHE_TTL_MIN" 2>/dev/null)" ]; then
        . "$_gl_c" 2>/dev/null && [ -n "$GH_VERS" ] && return 0
        GH_VERS=""; GH_NAMES="|"; GH_NOTE=""
    fi
    gh_load_api "$1" || gh_load_version "$1" || return 1
    # Запись в кавычках shell: значения — версии, имена выпусков и наша же строка-примечание;
    # одинарная кавычка в них экранируется, остальное для `.` безопасно.
    _gl_q() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
    printf "GH_VERS='%s'\nGH_NAMES='%s'\nGH_NOTE='%s'\n" "$(_gl_q "$GH_VERS")" "$(_gl_q "$GH_NAMES")" "$(_gl_q "$GH_NOTE")" > "$_gl_c" 2>/dev/null
    return 0
}

gh_load_api() {  # ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ
    _f="${GH_CACHE:-/tmp/splify2-releases.json}"
    rm -f "$_f"
    wget -qO "$_f" --timeout=20 \
        "https://api.github.com/repos/$1/releases?per_page=10" 2>/dev/null || {
            rm -f "$_f"; return 1; }
    [ -s "$_f" ] || { rm -f "$_f"; return 1; }
    _nl='
'
    _i=0
    while [ "$_i" -lt 10 ]; do
        # Два поля ОДНИМ запуском jsonfilter: он печатает по строке на выражение и в порядке
        # выражений. Двадцать запусков вместо десяти стоили бы роутеру вдвое больше процессов
        # ради того же ответа. Разбор по строкам — подстановкой, а не sed: ещё двадцать
        # процессов на то, что оболочка умеет сама.
        _both="$(jsonfilter -i "$_f" -e "@[$_i].tag_name" -e "@[$_i].name" 2>/dev/null)"
        _tag="${_both%%"$_nl"*}"
        [ -n "$_tag" ] || break
        _name="${_both#*"$_nl"}"
        # Строки одна — значит названия у релиза нет вовсе (в ответе `null`): jsonfilter в
        # этом случае не печатает ничего, и вторая строка не появляется.
        [ "$_name" != "$_both" ] || _name=""
        _ver="${_tag#v}"
        _i=$((_i + 1))
        case "$_ver" in ''|*[!0-9.]*) continue ;; esac
        # Название с вертикальной чертой сломало бы разметку GH_NAMES — тогда обходимся
        # числом. Отказываться от релиза из-за его заголовка было бы хуже: ставится он всё
        # равно по версии.
        case "$_name" in ''|*"|"*) _name="$_ver" ;; esac
        GH_VERS="$GH_VERS$_ver "
        GH_NAMES="$GH_NAMES$_ver=$_name|"
    done
    rm -f "$_f"
    [ -n "$GH_VERS" ]
}

# Запасной источник перечня: файл VERSION в главной ветке репозитория.
#
# ЗАЧЕМ. splify2#15. Пакеты и списки обход блокировки уже имеют — их берёт общая download()
# с лестницей «зеркало gitlab.com → contents API → архив через codeload → туннель». А сам
# ПЕРЕЧЕНЬ версий спрашивался у одного-единственного хоста, api.github.com. Там, где его
# закрыли, и там, где за CGNAT соседи выбрали неавторизованный лимит в 60 запросов в час
# (так и пришла splify2#5), обе карточки показывали пустой список: обновиться из интерфейса
# было нельзя, хотя пакет с зеркала скачался бы прекрасно. Установщик этот путь имеет
# давно (R-048), бэкенд — не имел, и асимметрия была ровно наоборот полезной: установить
# получалось, а обновить нет.
#
# ПОЧЕМУ VERSION, А НЕ СПИСОК РЕЛИЗОВ С ЗЕРКАЛА. Зеркалирование копирует коммиты, ветки и
# теги; релизы GitHub живут вне репозитория и на зеркало не переезжают. Зато VERSION в
# главной ветке содержит ровно то число, которое релизный workflow записал перед выкладкой
# пакетов, — и берётся оно через ту же download(), то есть все обходы достаются даром.
#
# ЧТО ЭТОТ ПУТЬ НЕ ДАЁТ. Одну версию вместо десяти и без названия выпуска: выбрать старую
# отсюда нельзя. Это честно сказано полем `note` — молчание здесь читалось бы как «релиз
# всего один».
gh_load_version() {  # ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ
    _vf="${GH_CACHE:-/tmp/splify2-releases.json}.version"
    rm -f "$_vf"
    download "https://raw.githubusercontent.com/$1/main/VERSION" "$_vf" || {
        rm -f "$_vf"; return 1; }
    # Первая строка без хвостовых пробелов. Состав проверяется целиком: в VERSION бывают
    # только цифры и точки (на это стоит барьер в build.sh), и подставить в имя файла
    # пакета что-то другое хуже, чем остаться без версии и сказать об этом.
    _vv="$(sed -n '1{s/[[:space:]]*$//;p;}' "$_vf" 2>/dev/null)"
    rm -f "$_vf"
    case "${_vv:-}" in ''|*[!0-9.]*) return 1 ;; esac
    GH_VERS="$_vv "
    GH_NAMES="|$_vv=$_vv|"
    GH_NOTE="список релизов не отдали — версия взята из VERSION в main${FETCH_NOTE:+ ($FETCH_NOTE)}"
    return 0
}

# Название выпуска по его версии — в GH_NAME. Через переменную, а не печатью: `$(...)` на
# каждую версию это ещё десять подоболочек там, где хватает подстановки.
gh_name_of() {  # ВЕРСИЯ
    GH_NAME="$1"
    _t="${GH_NAMES#*|$1=}"
    [ "$_t" = "$GH_NAMES" ] || GH_NAME="${_t%%|*}"
}

# Оба поля ответа: `versions` — чем ставить, `names` — как называется. Массив и объект, а не
# два массива: параллельные списки расходятся молча, а по версии название находится всегда.
gh_add_releases() {
    json_add_array versions
    for _v in $GH_VERS; do json_add_string "" "$_v"; done
    json_close_array
    json_add_object names
    for _v in $GH_VERS; do gh_name_of "$_v"; json_add_string "$_v" "$GH_NAME"; done
    json_close_object
    # Почему список такой, какой есть. Только когда есть что сказать: примечание на здоровом
    # пути было бы шумом, а на больном — единственным объяснением, почему версия одна.
    [ -n "$GH_NOTE" ] && json_add_string note "$GH_NOTE"
}

# Расширение файла пакета для этого менеджера и суффикс архитектуры у пакета без
# бинарного кода: apk называет такой noarch, opkg — all.
pkg_ext()    { if [ "$PM" = apk ]; then echo apk; else echo ipk; fi; }

pkg_noarch() { if [ "$PM" = apk ]; then echo noarch.apk; else echo all.ipk; fi; }

# Установленная версия пакета по его имени.
#
# Форматы вывода разные: `apk list -I` печатает «имя-1.2.3-r1 ...», `opkg list-installed`
# — «имя - 1.2.3-1». Разбирается каждый своим выражением, а не одним «на всякий случай»:
# общее выражение здесь молча выдавало бы пустоту на одном из двух.
# Версия установленного пакета — С ПАМЯТЬЮ. `apk list -I` перебирает базу пакетов и стоит на
# роутере триста миллисекунд, а спрашивают её на каждом открытии страницы (метод engine).
# Ответ меняется только вместе с базой пакетов, поэтому запоминается в /tmp до тех пор, пока
# файл базы не станет новее записи: ставить и снимать пакеты мимо базы нечем.
pkg_version() {  # ИМЯ_ПАКЕТА
    _pv_db="${PKG_DB:-/lib/apk/db/installed}"
    [ "$PM" = opkg ] && _pv_db="${PKG_DB:-/usr/lib/opkg/status}"
    _pv_c="/tmp/splify2-pkgver-$1"
    if [ -f "$_pv_db" ] && [ -f "$_pv_c" ] && [ "$_pv_c" -nt "$_pv_db" ]; then
        cat "$_pv_c"
        return 0
    fi
    _pv_v="$(case "$PM" in
        apk)  apk list -I 2>/dev/null | sed -n "s/^$1-\([0-9][^ ]*\)-r.*/\1/p" | head -1 ;;
        opkg) opkg list-installed 2>/dev/null | sed -n "s/^$1 - \([0-9][^ ]*\)/\1/p" | head -1 ;;
    esac)"
    [ -f "$_pv_db" ] && printf '%s' "$_pv_v" > "$_pv_c" 2>/dev/null
    printf '%s' "$_pv_v"
}

pkg_install() {  # ФАЙЛ [ИМЯ_ДЛЯ_СНЯТИЯ...]
    file="$1"; shift
    PKG_OUT="$(pkg_add_file "$file")"
    rc=$?
    PKG_REMOVED=0
    [ "$rc" = 0 ] && return 0
    # Шаблон намеренно узкий — только слово «конфликт». `unable to select packages` сюда
    # не годится, хотя apk печатает его и при конфликте тоже: это его общий текст на
    # любую неудовлетворимую зависимость, включая «нет nftables». Снимать по нему
    # рабочий пакет значило бы вернуть ровно ту поломку, ради которой порядок и
    # переставлен.
    case "$PKG_OUT" in
        *conflict*|*Conflict*|*КОНФЛИКТ*|*конфликт*) ;;
        *) return "$rc" ;;
    esac
    [ "$#" -gt 0 ] || return "$rc"
    for n in "$@"; do pkg_del "$n"; done
    PKG_REMOVED=1
    PKG_OUT="$(pkg_add_file "$file")"
    return $?
}

# Включён ли автозапуск. Именно это, а не «работает ли», меняет кнопка «Остановить всё»:
# без снятого автозапуска перезагрузка вернула бы движок, и человек, нажавший «остановить
# всё», получил бы его обратно молча.
engine_enabled() {
    # На роутере — по ссылке в /etc/rc.d: ровно её и ставит `enable`, а спрашивать об этом сам
    # init-скрипт значит запускать оболочку с rc.common (сотня миллисекунд на 880 МГц) на
    # каждом открытии страницы. Подменённый стендом init-скрипт спрашивается как раньше.
    if [ "$INITD" = /etc/init.d/steer ] && [ -d /etc/rc.d ]; then
        set -- /etc/rc.d/S[0-9][0-9]steer
        [ -e "$1" ] && printf 1 || printf 0
        return 0
    fi
    "$INITD" enabled >/dev/null 2>&1 && printf 1 || printf 0
}

# Работает ли хоть один экземпляр. Спрашивается у procd, а не по наличию процесса:
# у движка их несколько (сам steer и клиенты vless), и «жив ли процесс с таким именем»
# на это не отвечает.
#
# ВНИМАНИЕ: внутри json_load, поэтому вызывать только ДО json_init своего ответа — тот же
# порядок, что уже соблюдает engine_state.
engine_running() {
    r=0
    state="$(ubus call service list '{"name":"steer","verbose":true}' 2>/dev/null)"
    if [ -n "$state" ] && json_load "$state" 2>/dev/null &&
       json_select steer 2>/dev/null && json_select instances 2>/dev/null; then
        json_get_keys inames
        for nm in $inames; do
            json_select "$nm" 2>/dev/null || continue
            json_get_var run running
            [ "$run" = 1 ] && r=1
            json_select ..
        done
    fi
    printf '%s' "$r"
}

case "$2" in

    engine)
        # Что за движок стоит и умеет ли он VLESS.
        #
        # Спрашивается у самого движка, а не по имени пакета: пакет мог быть поставлен
        # руками, переименован или собран из исходников. Признак — отвечает ли `vless`
        # отказом «нужен steer-extended». Без этой проверки интерфейс предлагал бы выход
        # kind=vless на базовой сборке, и человек получал бы отказ уже при сохранении,
        # не понимая, чего от него хотят.
        # Сначала — есть ли движок вообще. Без этой проверки отсутствие steer выглядело бы
        # как «VLESS поддержан»: сообщение «команда не найдена» тоже не содержит слова
        # steer-extended, и признак по отсутствию сработал бы наоборот.
        # Состояние сервиса добывается ДО json_init: engine_running разбирает ответ ubus
        # через json_load, а он затирает документ, который мы бы в этот момент собирали.
        svc_enabled="$(engine_enabled)"
        svc_running="$(engine_running)"
        if [ ! -x "$STEER" ]; then
            json_init
            json_add_boolean present 0
            json_add_boolean vless 0
            json_add_boolean enabled "$svc_enabled"
            json_add_boolean running "$svc_running"
            json_dump
            exit 0
        fi
        vless=1
        out="$("$STEER" vless '' 2>&1)"
        case "$out" in *steer-extended*) vless=0 ;; esac
        json_init
        json_add_boolean present 1
        json_add_boolean vless "$vless"
        # Автозапуск и работа — разные вещи, и тумблеру нужны обе. Движок могли
        # остановить из консоли между двумя открытиями страницы, поэтому подпись обязана
        # читать состояние, а не помнить своё.
        json_add_boolean enabled "$svc_enabled"
        json_add_boolean running "$svc_running"
        json_add_string arch "$(pkg_arch)"
        # Версия любого из двух вариантов пакета. Через pkg_version, а не своим разбором
        # `apk list`: на opkg-роутере тот отдавал пустоту, и карточка движка показывала
        # установленный движок без версии.
        json_add_string version "$(v="$(pkg_version steer-extended)"; [ -n "$v" ] || v="$(pkg_version steer)"; printf '%s' "$v")"
        json_dump
        ;;

    engine_stop)
        # «Остановить всё» — одно действие вместо консоли.
        #
        # Просьба из публичного теста звучала дословно так: «жизненно необходима кнопка
        # Остановить, причём всё — и сервис, и движок». До неё вернуть роутер в состояние
        # «как будто не установлено» можно было только по ssh.
        #
        # disable, а не только stop. Разница не косметическая: без него перезагрузка
        # поднимает движок обратно, и человек, нажавший «остановить всё», получает его
        # снова — молча и без объяснения, почему кнопка «не сработала». Именно поэтому
        # обратное действие обязано быть рядом: снятый автозапуск сам не вернётся.
        #
        # Правила из ядра убирать отдельно не нужно: stop_service движка сносит таблицу
        # nft и вычищает ip rule сам.
        "$INITD" stop >/dev/null 2>&1
        "$INITD" disable >/dev/null 2>&1
        en="$(engine_enabled)"; run="$(engine_running)"
        json_init
        json_add_boolean ok 1
        json_add_boolean enabled "$en"
        json_add_boolean running "$run"
        json_dump
        ;;

    engine_start)
        # Обратная половина тумблера. enable перед start, а не после: иначе состояние
        # «работает, но после перезагрузки не поднимется» существует между двумя
        # вызовами, и увидеть его можно ровно в тот момент, когда роутер перезагрузили.
        "$INITD" enable >/dev/null 2>&1
        "$INITD" start >/dev/null 2>&1
        en="$(engine_enabled)"; run="$(engine_running)"
        json_init
        json_add_boolean ok 1
        json_add_boolean enabled "$en"
        json_add_boolean running "$run"
        json_dump
        ;;

    steer_versions)
        # Какие версии движка можно поставить и как они называются.
        gh_load xyzmean/steer
        json_init
        json_add_string arch "$(pkg_arch)"
        gh_add_releases
        json_dump
        ;;

    splify2_versions)
        # Какие версии САМОГО интерфейса можно поставить.
        #
        # Зачем это вообще нужно. Ни один из пакетов проекта не лежит в feeds OpenWrt,
        # поэтому `apk upgrade` их не видит и обновить интерфейс можно было только по
        # ssh — при том что движок из интерфейса ставится с первого дня. Асимметрия
        # заметная: обновлять умели то, что реже меняется.
        gh_load xyzmean/splify2
        json_init
        json_add_string current "$(pkg_version luci-app-splify2)"
        gh_add_releases
        json_dump
        ;;

    splify2_install)
        # Скачать и поставить интерфейс выбранной версии.
        #
        # Пакет один и он noarch: интерфейс — это собранный бандл и shell-скрипты, под
        # архитектуру здесь ничего не собирается. Поэтому ни выбора варианта, ни
        # pkg_arch тут нет, и единственный отказ до сети — по виду версии.
        read -r input
        ver="$(jsonfilter -s "$input" -e '@.version' 2>/dev/null)"
        json_init
        case "$ver" in
            ''|*[!0-9.]*) json_add_boolean ok 0; json_add_string error "в версии допустимы только цифры и точки"; json_dump; exit 0 ;;
        esac
        name="luci-app-splify2-${ver}-1_$(pkg_noarch)"
        url="https://github.com/xyzmean/splify2/releases/download/v${ver}/${name}"
        tmp="/tmp/${name}"
        rm -f "$tmp"
        # Через download(), а не своим wget: у этой ссылки тот же изъян, что у списков —
        # она перенаправляет на release-assets.githubusercontent.com, и там, где этот хост
        # закрыт, обновление из интерфейса не работало вовсе (splify2#15).
        if ! download "$url" "$tmp"; then
            rm -f "$tmp"
            json_add_boolean ok 0
            json_add_string error "не скачалось: $name (нет такой версии?)${FETCH_NOTE:+ — $FETCH_NOTE}"
            json_dump; exit 0
        fi
        [ -n "$FETCH_NOTE" ] && json_add_string via "$FETCH_NOTE"
        pkg_install "$tmp" luci-app-splify2
        rc=$?
        rm -f "$tmp"
        if [ "$rc" != 0 ]; then
            json_add_boolean ok 0
            json_add_string error "$PKG_OUT"
            json_add_boolean removed "$PKG_REMOVED"
            json_dump; exit 0
        fi
        # Перезапуск rpcd — обязательная часть, а не любезность: список методов ubus и
        # ACL читаются им при старте, поэтому без перезапуска новая версия интерфейса
        # обращается к методам, которых работающий rpcd ещё не знает. Выглядит это как
        # «обновился и всё сломалось».
        #
        # В фоне и с задержкой, потому что этот процесс — сам rpcd: перезапусти его
        # сейчас, и ответ, который мы вот-вот напечатаем, до браузера не доедет.
        ( sleep 2; "$RPCD_INITD" restart >/dev/null 2>&1 ) &
        json_add_boolean ok 1
        json_add_string installed "$name"
        # Вывод менеджера пакетов отдаётся и на УСПЕХЕ, а не только в отказе. Причина не в
        # полноте: в этом выводе печатает свои строки post-install пакета, и там сказано
        # единственное, чего интерфейс знать не может, — что netifd держит прежний набор
        # опций протокола и новые до `/etc/init.d/network restart` не действуют. Пока
        # $PKG_OUT на успехе выбрасывался, эта строка существовала только в терминале того,
        # кто ставит пакет руками, — то есть для человека с браузером её не было вовсе.
        json_add_string output "$PKG_OUT"
        # Страницу придётся перезагрузить: бандл у браузера в кеше, а его версия
        # читается из build-id.txt при загрузке документа (см. home.js).
        json_add_boolean reload_needed 1
        json_dump
        ;;

    steer_install)
        # Скачать и поставить движок выбранной версии и варианта.
        #
        # Ставит именно ЭТО, а не «что-нибудь»: вариант (базовый или расширенный) — выбор
        # человека, зависящий от того, поднимает ли туннель сам движок, и угадывать за него
        # значит либо положить лишнее, либо не положить нужное и получить «выход vless не
        # работает» без объяснения.
        read -r input
        ver="$(jsonfilter -s "$input" -e '@.version' 2>/dev/null)"
        ext="$(jsonfilter -s "$input" -e '@.extended' 2>/dev/null)"
        arch="$(pkg_arch)"
        json_init
        case "$ver" in
            ''|*[!0-9.]*) json_add_boolean ok 0; json_add_string error "в версии допустимы только цифры и точки"; json_dump; exit 0 ;;
        esac
        [ -n "$arch" ] || { json_add_boolean ok 0; json_add_string error "не определилась архитектура"; json_dump; exit 0; }

        case "$ext" in
            1|true) name="steer-extended-${ver}-1_${arch}.$(pkg_ext)" ;;
            *)      name="steer-${ver}-1_${arch}.$(pkg_ext)" ;;
        esac
        url="https://github.com/xyzmean/steer/releases/download/v${ver}/${name}"
        tmp="/tmp/${name}"
        rm -f "$tmp"
        if ! download "$url" "$tmp"; then
            rm -f "$tmp"
            json_add_boolean ok 0
            json_add_string error "не скачалось: $name (нет такой версии для $arch?)${FETCH_NOTE:+ — $FETCH_NOTE}"
            json_dump; exit 0
        fi
        [ -n "$FETCH_NOTE" ] && json_add_string via "$FETCH_NOTE"
        # Порядок apk и разбор конфликта — в pkg_install: он же обслуживает установку
        # самого интерфейса, и две копии этой логики означали бы два разных ответа на
        # вопрос «что делать, когда apk отказал».
        #
        # Снимаем оба имени: расширенный и базовый пакеты владеют одним /usr/sbin/steer
        # и объявлены конфликтующими, поэтому смена варианта иначе не проходит.
        pkg_install "$tmp" steer steer-extended
        rc=$?
        out="$PKG_OUT"
        removed="$PKG_REMOVED"
        rm -f "$tmp"
        if [ "$rc" != 0 ]; then
            json_add_boolean ok 0
            # Про снятый пакет обязан сказать ответ, а не журнал: человек видит только
            # его, а в stderr apk про снос нет ни слова. Молчание здесь означало бы, что
            # роутер стоит без движка, а сообщение говорит только «не удалось поставить».
            if [ "$removed" = 1 ]; then
                json_add_string error "$out
Прежний движок при этом снят: маршрутизации сейчас нет. Поставьте любую версию заново или перезагрузите роутер после установки."
            else
                json_add_string error "$out"
            fi
            json_add_boolean removed "$removed"
            json_dump; exit 0
        fi
        "$INITD" enable >/dev/null 2>&1 || true
        # Переинициализация — обязательная часть установки, а не любезность. Замена
        # пакета останавливает сервис (а на ветке с удалением pre-deinstall ещё и сносит
        # таблицу nft вместе с ip rule): без restart роутер после «обновить движок»
        # оставался без маршрутизации до ручного вмешательства или перезагрузки, и
        # выглядело это как «переустановил — всё сломалось». restart применяет спеку,
        # поднимает резолвер и туннели vless — то же, что происходит при загрузке.
        restarted=0
        if [ -f "$SPEC" ]; then
            "$INITD" restart >/dev/null 2>&1 && restarted=1
        fi
        json_add_boolean ok 1
        json_add_string installed "$name"
        json_add_boolean restarted "$restarted"
        # Слова менеджера пакетов — и на успехе тоже: именно там сказано, например, что
        # списки пакетов были пусты и их пришлось обновить. Без этой строки человек видит
        # «установлено» и не знает, что по дороге чинилось.
        [ -n "$out" ] && json_add_string output "$out"
        json_dump
        ;;

    ui_get|ui_set)
        # Память мастера: какие выходы он создал, как человек их назвал, что в каждом.
        #
        # Отдельно от спеки, и это принципиально. Спека — вход движка, и «как человек назвал
        # outbound» ему не нужно ни для чего; дописать туда своё поле значило бы, что движок
        # обязан его сохранять при любой правке, то есть управляющий слой протёк в модель.
        #
        # А знать это надо, иначе мастер не отличит свои записи от чужих. Прежде он узнавал их
        # по зашитым именам («сервисы», выход «vpn»), и на живом роутере это провалилось сразу:
        # там канал назывался funny и выход vless, настроенные руками. Мастер их не увидел и
        # предложил создать рядом второй туннель — то есть тихо развёл настройку на две.
        #
        # Хранится как непрозрачная строка: разбирать её здесь нечем и незачем, а формат
        # принадлежит интерфейсу и будет меняться вместе с ним.
        uci_file || fail "не удалось создать $UCI_SPLIFY2 — кончилось место?"
        uci -q get splify2.main >/dev/null 2>&1 || uci -q set splify2.main=splify2
        if [ "$2" = ui_set ]; then
            read -r input
            json_load "$input" 2>/dev/null || fail "неразбираемый запрос"
            json_get_var state state
            uci -q set splify2.main.wizard="$state"
            uci -q commit splify2
            json_init; json_add_boolean ok 1; json_dump
        else
            json_init
            json_add_string state "$(uci -q get splify2.main.wizard)"
            json_dump
        fi
        ;;

    *) fail "неизвестный метод" ;;
esac
