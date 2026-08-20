#!/bin/sh
# Установка splify2 на OpenWrt одной строкой.
#
#   sh -c "$(wget -qO- https://raw.githubusercontent.com/xyzmean/splify2/main/install.sh)"
#
# Что делает: определяет архитектуру, ставит движок steer, если его нет, ставит интерфейс,
# включает службу. Ничего не спрашивает, если спрашивать не о чем.
#
# Почему движок ставится отсюда, а не объявлен зависимостью пакета. Зависимость apk умеет
# только «нужен пакет steer», а выбор между базовым и расширенным — это выбор ЧЕЛОВЕКА, и
# зависит он от того, поднимает ли туннель сам движок. Пакетный менеджер такого не решает, а
# угадать за него значит либо поставить лишние полмегабайта, либо не поставить нужное и
# получить «выход vless не работает» без объяснения.
set -eu

REPO_STEER=xyzmean/steer
REPO_UI=xyzmean/splify2
TMP=/tmp/splify2-install
API=https://api.github.com/repos
RAW=https://raw.githubusercontent.com

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- окружение ---------------------------------------------------------------
#
# Менеджер пакетов определяется, а не предполагается. Раньше здесь стоял отказ «нужен apk:
# это OpenWrt 24.10+, на старых opkg ставьте вручную» — то есть установка одной строкой не
# работала на 23.05 и 22.03 вовсе, а именно они стоят на слабых роутерах, которые никто не
# обновит. Теперь релизы содержат оба формата, и выбор делается здесь.
#
# Дальше по скрипту менеджер вызывается через три обёртки — pm_installed, pm_add,
# pm_suffix, — а не проверкой «если apk» в каждом месте: пять таких проверок означали бы
# пятое место, где про opkg забыли.
if command -v apk >/dev/null 2>&1; then
    PM=apk
elif command -v opkg >/dev/null 2>&1; then
    PM=opkg
else
    die "не нашёл ни apk, ни opkg — это точно OpenWrt?"
fi
command -v wget >/dev/null 2>&1 || die "нужен wget"

# Список установленного. Имена пакетов в обоих менеджерах одни и те же.
# Полноценный if, а не `[ ... ] && A || B`: у той идиомы A, вернувшая ненулевой код,
# запускает ещё и B — то есть пустой список установленного у apk дёрнул бы opkg, которого
# на этой системе нет.
pm_installed() {
    if [ "$PM" = apk ]; then apk list -I 2>/dev/null
    else opkg list-installed 2>/dev/null
    fi
}

# Установка локального файла. --allow-untrusted нужен ТОЛЬКО apk: пакеты не подписаны
# ключом репозитория OpenWrt, они лежат в GitHub Releases, а opkg подпись локального
# файла не проверяет вовсе и такого флага не знает. --force-overwrite нужен обоим:
# интерфейс кладёт файлы в /www/luci-static, и при переустановке поверх прежней версии
# менеджер видит там чужие с его точки зрения файлы.
pm_add() {
    if [ "$PM" = apk ]; then
        apk add --allow-untrusted --force-overwrite "$1" >/dev/null
    else
        opkg install --force-overwrite "$1" >/dev/null
    fi
}

# Расширение файла пакета и суффикс архитектуры у пакета без бинарного кода: apk называет
# такой noarch, opkg — all. Перепутать их значит скачать несуществующий файл.
pm_suffix() { if [ "$PM" = apk ]; then echo "noarch.apk"; else echo "all.ipk"; fi; }
pm_ext()    { if [ "$PM" = apk ]; then echo "apk"; else echo "ipk"; fi; }

# Архитектура ПАКЕТОВ, а не процессора: `apk --print-arch` отдаёт `aarch64`, а пакеты
# OpenWrt называются `aarch64_cortex-a53`. По первому имя файла собирается неверно, и
# скачивание молча не находит релиз — проверено на живом роутере.
if [ -f /etc/openwrt_release ]; then
    ARCH="$( . /etc/openwrt_release; printf '%s' "${DISTRIB_ARCH:-}" )"
fi
# Запасной путь — только для apk: у opkg своего «print-arch» нет, а DISTRIB_ARCH выше
# есть на обеих ветках OpenWrt, так что сюда доходят лишь совсем странные системы.
[ -n "${ARCH:-}" ] || [ "$PM" != apk ] || ARCH="$(apk --print-arch 2>/dev/null || true)"
[ -n "$ARCH" ] || die "не удалось определить архитектуру пакетов"

mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "splify2: установка"
info "архитектура: $ARCH"

# ---- какой движок стоит сейчас ------------------------------------------------
have_steer=no
have_ext=no
if pm_installed | grep -q '^steer-extended'; then
    have_steer=yes; have_ext=yes
elif pm_installed | grep -q '^steer'; then
    have_steer=yes
fi

# ---- выбор варианта движка ----------------------------------------------------
# Спрашиваем ТОЛЬКО если движка нет и есть кому ответить. При запуске без терминала
# (из скрипта, по ssh с перенаправленным вводом) берём расширенный: он умеет всё, что
# базовый, и не спросить — безопаснее, чем поставить половину и оставить человека с
# нерабочим выходом vless.
WANT_EXT=yes
if [ "$have_steer" = yes ]; then
    info "движок уже стоит$([ "$have_ext" = yes ] && echo ' (расширенный)' || echo ' (базовый)')"
elif [ -t 0 ]; then
    say ""
    say "Какой движок поставить?"
    cat <<'TXT'
  1) расширенный — умеет поднимать туннель VLESS/Reality сам: вставили ссылку
     подписки, и всё. Больше на ~250 КБ. Берите этот, если туннеля ещё нет.
  2) базовый — только маршрутизация. Туннель поднимаете вы: wireguard, amneziawg,
     что угодно уже работающее. Берите, если туннель уже настроен.
TXT
    printf '  Ваш выбор [1]: '
    read -r ans || ans=1
    case "${ans:-1}" in
        2) WANT_EXT=no ;;
        *) WANT_EXT=yes ;;
    esac
fi

# ---- последний релиз ----------------------------------------------------------
# Версия берётся из релизов, а не зашита: иначе скрипт из main ставил бы прошлое.
#
# Путей два, и второй не «на всякий случай». У аудитории splify2 api.github.com
# недоступен чаще, чем сам github.com: его блокируют отдельно, а за CGNAT
# неавторизованный лимит GitHub API (60 запросов в час на адрес) выбирают соседи по
# адресу — тогда API отвечает 403, tag_name в ответе нет, и установка падала на «не
# удалось узнать версию движка (нет релизов?)», хотя релиз и пакет под эту архитектуру
# существовали. Так это и пришло: splify2#5, два человека, mipsel_24kc, и оба поставили
# те же пакеты руками.
#
# Второй путь идёт по raw.githubusercontent.com — тому самому хосту, с которого только
# что скачался этот скрипт, то есть заведомо доступному. Файл VERSION в главной ветке
# содержит ровно то число, которое релизный workflow записал перед выкладкой пакетов.
latest() {  # РЕПОЗИТОРИЙ
    ver="$(wget -qO- "$API/$1/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
    if [ -z "$ver" ]; then
        # Только цифры и точки: в VERSION не должно быть ничего другого, а если есть —
        # лучше остаться без версии и сказать об этом, чем подставить мусор в имя файла.
        ver="$(wget -qO- "$RAW/$1/main/VERSION" 2>/dev/null |
            sed -n 's/^[[:blank:]]*\([0-9][0-9.]*\).*/\1/p' | head -1)"
        if [ -n "$ver" ]; then
            info "версия $1 взята из VERSION в main: api.github.com не ответил" >&2
        fi
    fi
    echo "$ver"
}

fetch() {  # URL ФАЙЛ
    wget -qO "$2" "$1" || die "не скачалось: $1"
}

dl_url() {  # РЕПОЗИТОРИЙ ВЕРСИЯ ИМЯ
    echo "https://github.com/$1/releases/download/v$2/$3"
}

# ---- движок -------------------------------------------------------------------
if [ "$have_steer" = no ]; then
    SV="$(latest "$REPO_STEER")"
    [ -n "$SV" ] || die "не удалось узнать версию движка: не ответили ни api.github.com, ни raw.githubusercontent.com. Пакеты можно поставить руками с https://github.com/$REPO_STEER/releases"
    if [ "$WANT_EXT" = yes ]; then
        PKG="steer-extended-${SV}-1_${ARCH}.$(pm_ext)"
    else
        PKG="steer-${SV}-1_${ARCH}.$(pm_ext)"
    fi
    say ""
    say "Движок steer $SV"
    info "$PKG"
    fetch "$(dl_url "$REPO_STEER" "$SV" "$PKG")" "$TMP/$PKG"
    pm_add "$TMP/$PKG" || die "движок не установился"
    info "установлен"
fi

# ---- интерфейс ----------------------------------------------------------------
UV="$(latest "$REPO_UI")"
[ -n "$UV" ] || die "не удалось узнать версию интерфейса: не ответили ни api.github.com, ни raw.githubusercontent.com. Пакет можно поставить руками с https://github.com/$REPO_UI/releases"
UI_PKG="luci-app-splify2-${UV}-1_$(pm_suffix)"
say ""
say "Интерфейс splify2 $UV"
info "$UI_PKG"
fetch "$(dl_url "$REPO_UI" "$UV" "$UI_PKG")" "$TMP/$UI_PKG"
pm_add "$TMP/$UI_PKG" || die "интерфейс не установился"
info "установлен"

# ---- запуск -------------------------------------------------------------------
/etc/init.d/rpcd restart >/dev/null 2>&1 || true   # чтобы ubus увидел новый бэкенд
if [ -x /etc/init.d/steer ]; then
    /etc/init.d/steer enable >/dev/null 2>&1 || true
fi

say ""
say "Готово."
info "Откройте LuCI → Сервисы → splify2"
info "Дальше: вставить ссылку подписки и отметить сервисы — больше ничего не нужно."
