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

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- окружение ---------------------------------------------------------------
command -v apk >/dev/null 2>&1 || die "нужен apk: это OpenWrt 24.10+ (на старых opkg — ставьте пакеты вручную)"
command -v wget >/dev/null 2>&1 || die "нужен wget"

# Архитектура ПАКЕТОВ, а не процессора: `apk --print-arch` отдаёт `aarch64`, а пакеты
# OpenWrt называются `aarch64_cortex-a53`. По первому имя файла собирается неверно, и
# скачивание молча не находит релиз — проверено на живом роутере.
if [ -f /etc/openwrt_release ]; then
    ARCH="$( . /etc/openwrt_release; printf '%s' "${DISTRIB_ARCH:-}" )"
fi
[ -n "${ARCH:-}" ] || ARCH="$(apk --print-arch 2>/dev/null || true)"
[ -n "$ARCH" ] || die "не удалось определить архитектуру пакетов"

mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "splify2: установка"
info "архитектура: $ARCH"

# ---- какой движок стоит сейчас ------------------------------------------------
have_steer=no
have_ext=no
if apk list -I 2>/dev/null | grep -q '^steer-extended'; then
    have_steer=yes; have_ext=yes
elif apk list -I 2>/dev/null | grep -q '^steer'; then
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
latest() {  # РЕПОЗИТОРИЙ
    wget -qO- "$API/$1/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1
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
    [ -n "$SV" ] || die "не удалось узнать версию движка (нет релизов?)"
    if [ "$WANT_EXT" = yes ]; then
        PKG="steer-extended-${SV}-1_${ARCH}.apk"
    else
        PKG="steer-${SV}-1_${ARCH}.apk"
    fi
    say ""
    say "Движок steer $SV"
    info "$PKG"
    fetch "$(dl_url "$REPO_STEER" "$SV" "$PKG")" "$TMP/$PKG"
    apk add --allow-untrusted "$TMP/$PKG" >/dev/null || die "движок не установился"
    info "установлен"
fi

# ---- интерфейс ----------------------------------------------------------------
UV="$(latest "$REPO_UI")"
[ -n "$UV" ] || die "не удалось узнать версию интерфейса (нет релизов?)"
UI_PKG="luci-app-splify2-${UV}-1_noarch.apk"
say ""
say "Интерфейс splify2 $UV"
info "$UI_PKG"
fetch "$(dl_url "$REPO_UI" "$UV" "$UI_PKG")" "$TMP/$UI_PKG"
# --force-overwrite: интерфейс кладёт файлы в /www/luci-static, где при переустановке
# поверх прежней версии apk видит чужие с его точки зрения файлы.
apk add --allow-untrusted --force-overwrite "$TMP/$UI_PKG" >/dev/null || die "интерфейс не установился"
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
