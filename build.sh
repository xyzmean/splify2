#!/bin/sh
# Собирает один noarch-пакет: бандл интерфейса, точка входа LuCI, rpcd-обёртка.
#
# Архитектуры тут нет и быть не должно — весь бинарный код живёт в steer. Поэтому
# пакет один на все роутеры, а зависимость от движка объявлена явно.
set -eu

VERSION="$(cat VERSION 2>/dev/null || echo 0.1.0)"
OUT=out
PKG=build/pkg
RES="$PKG/www/luci-static/resources/splify2"

echo "splify2 $VERSION"

# Каждый метод rpcd обязан быть в ACL LuCI, иначе он работает из ssh и НЕ работает из
# браузера. Проверяется здесь, потому что этот сбой не виден ни в одном другом месте:
# `ubus call splify2 diag` с роутера отвечает, а тот же вызов со страницы получает отказ
# доступа — и если у вызова есть запасной путь (а у нас у половины есть), страница молча
# показывает «нет данных». Так уже уехали в релиз dev_stats, ui_get/ui_set, diag,
# engine_state и установка движка: семь методов, проверенных не на том слое.
#
# Цифра в имени в наборе символов не случайна: без неё `splify2_versions` резался до
# `splify`, барьер искал в ACL несуществующее имя и валился на верных данных. Заметить
# это удалось только когда проверка стала запускаться без docker.
acl=luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json
missing=''
for m in $(sed -n '/^list)/,/^    ;;/p' files/usr/libexec/rpcd/splify2 |
           grep -o 'json_add_object [a-z0-9_]*' | awk '{print $2}'); do
    grep -q "\"$m\"" "$acl" || missing="$missing $m"
done
[ -z "$missing" ] || {
    echo "методы rpcd не объявлены в ACL ($acl):$missing"
    echo "из браузера они получат отказ доступа, из ssh будут работать"
    exit 1
}

# Docker нужен только для упаковки, поэтому проверяется здесь, а не в шапке. Пока он
# стоял первым, ни один барьер выше не запускался на машине без docker — то есть ровно
# там, где правят rpcd и ACL, проверить их было нечем.
command -v docker >/dev/null 2>&1 || { echo "нужен docker (сборка пакета в alpine)"; exit 1; }

# Цвета в Tailwind называются БЕЗ приставки sp-: `bg-card`, `text-muted-foreground`,
# `bg-success`. Приставка живёт только у CSS-переменных (--sp-card), из которых конфиг эти
# цвета и собирает.
#
# Написать `bg-sp-card` — значит получить класс, которого нет: Tailwind его не сгенерирует,
# браузер молча пропустит, и элемент останется без цвета. Ошибка не видна ничем, кроме глаз:
# сборка проходит, tsc проходит, страница открывается. Так в интерфейсе прожили 219 таких
# классов — зелёного кружка «Работает» не было вовсе, а карточки стояли без фона, и заметил
# это человек, а не мы.
bad="$(grep -rEo '\b(bg|text|border|ring|from|to|via|fill|stroke)-sp-[a-z-]*' ui/src 2>/dev/null | head -5)"
[ -z "$bad" ] || {
    echo "в классах есть приставка sp-, таких классов не существует:"
    printf '%s\n' "$bad"
    echo "цвета называются без неё: bg-card, text-muted-foreground, bg-success"
    exit 1
}

# Размер и вес заголовка утилитой на самом h1–h4 НЕ ЗАДАТЬ, и это не стилистика.
#
# Сброс в ui/src/index.css объявляет у h1–h4 `font-size: inherit` и `font-weight: inherit`, и
# написан он ВНЕ каскадных слоёв (почему — в комментарии к сбросам). Утилиты Tailwind живут в
# @layer utilities, а неслоёные правила главнее любого слоя, поэтому `text-[26px] font-semibold`
# на h1 не действует вовсе: получается 14 пикселей и вес 400. Специфичность не спасает —
# проигрывает слой, а не селектор.
#
# Ошибка не видна ничем, кроме глаз: сборка проходит, tsc проходит, стенды на jsdom тоже —
# jsdom не считает каскад из index.css. Поймано на снимке живого роутера, где вердикт
# «Маршрутизация работает» оказался ростом с подпись в рельсе. Взамен есть три класса:
# sp-verdict (26/600), sp-title (22/600), sp-sub (15/600).
bad="$(grep -rEn --include='*.tsx' '<h[1-6][^>]*className="[^"]*(text-\[[0-9]|text-(xs|sm|base|lg|xl|2xl|3xl)|font-(medium|semibold|bold))' ui/src 2>/dev/null | head -5)"
[ -z "$bad" ] || {
    echo "у заголовка задан размер или вес утилитой — она не подействует:"
    printf '%s\n' "$bad"
    echo "используйте классы sp-verdict / sp-title / sp-sub (ui/src/index.css)"
    exit 1
}

( cd ui && npm run build >/dev/null 2>&1 ) || { echo "сборка интерфейса провалилась"; exit 1; }

rm -rf "$PKG"
mkdir -p "$RES" "$PKG/etc/init.d" "$PKG/usr/libexec/rpcd" "$PKG/usr/sbin" "$PKG/etc/splify2" \
         "$PKG/lib/netifd/proto" "$PKG/www/luci-static/resources/protocol"
cp -r ui/dist/* "$RES/"
cp -r luci/htdocs/luci-static/resources/view "$PKG/www/luci-static/resources/"
cp -r luci/root/usr/share "$PKG/usr/"
cp files/usr/libexec/rpcd/splify2 "$PKG/usr/libexec/rpcd/splify2"
cp files/usr/sbin/splify2-update-lists "$PKG/usr/sbin/splify2-update-lists"
# Настройка uci объявляется системе пакетом: почему именно так — в шапке самого файла.
mkdir -p "$PKG/etc/uci-defaults"
cp files/etc/uci-defaults/99-splify2 "$PKG/etc/uci-defaults/99-splify2"
chmod 0755 "$PKG/etc/uci-defaults/99-splify2"
chmod 0755 "$PKG/usr/libexec/rpcd/splify2" "$PKG/usr/sbin/splify2-update-lists"

# Протокол xsteer: обработчик netifd и страница LuCI.
#
# ПОЧЕМУ ЗДЕСЬ, А НЕ В steer. Клиент xsteer — часть движка: он живёт в пакете steer-extended и
# запускается как `steer xsteer`. А эти два файла — часть ИНТЕРФЕЙСА: они описывают netifd и
# LuCI, как показать туннель обычным интерфейсом и что у него за поля. Отдельный третий пакет
# (luci-proto-xsteer) означал бы третью версию, третий барьер релиза и третий способ поставить
# половину — например обработчик без страницы, и тогда LuCI говорит «не поддерживаемый тип
# протокола» на работающем туннеле.
#
# ОБА ФАЙЛА ОБЯЗАНЫ ЕХАТЬ ВМЕСТЕ, и это ровно то, на чём стенд стоит ниже: без обработчика
# интерфейс не поднимется вовсе, без страницы его нельзя настроить из браузера. Один из двух
# забыть особенно легко потому, что лежат они в разных деревьях (files/ и luci/).
cp files/lib/netifd/proto/xsteer.sh "$PKG/lib/netifd/proto/xsteer.sh"
chmod 0755 "$PKG/lib/netifd/proto/xsteer.sh"
cp luci/htdocs/luci-static/resources/protocol/xsteer.js \
   "$PKG/www/luci-static/resources/protocol/xsteer.js"

# Идентификатор сборки: загрузчик читает его на каждой загрузке страницы и добавляет
# к URL бандлов. Без него браузер держал бы старый интерфейс после обновления пакета —
# ровно то, что в splify 1 переживало и обновления, и перезагрузки.
printf '%s\n' "$VERSION" > "$RES/build-id.txt"
# И версию нужно проштамповать в сами бандлы: npm build оставляет заглушку ?v=0.0.0,
# иначе один чанк оказывается доступен по двум URL и preact грузится дважды.
sed -i -E "s/\?v=[0-9]+\.[0-9]+\.[0-9]+/?v=$VERSION/g" "$RES"/splify-*.js

# ВНЕ каталога пакета: всё, что лежит внутри, попадает в пакет как файл, и такой
# .post-install приезжает на роутер как /.post-install — где сталкивается с чужим,
# потому что имя одно у всех. Скрипт передаётся ключом --script, содержимым он быть
# не должен.
mkdir -p build/scripts
cat > build/scripts/post-install <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
# Расписание обновления списков. Раз в сутки со случайной минутой: если все роутеры
# постучатся в одну секунду, это выглядит как всплеск на источнике, и первым страдает
# тот, кто раздаёт списки бесплатно.
# Настройка uci: скрипт uci-defaults штатно запускает загрузка системы (образ) или
# postinst пакетного менеджера (установка). Свой postinst здесь написан руками, поэтому
# запуск делаем сами и файл убираем после успеха — ровно как это делает default_postinst
# в сборочной системе OpenWrt. Без этой строки файл существовал бы только в пакете.
if [ -x /etc/uci-defaults/99-splify2 ]; then
    ( . /etc/uci-defaults/99-splify2 ) >/dev/null 2>&1 && rm -f /etc/uci-defaults/99-splify2
fi
if ! grep -q splify2-update-lists /etc/crontabs/root 2>/dev/null; then
    mkdir -p /etc/crontabs
    printf '%s 5 * * * /usr/sbin/splify2-update-lists\n' "$(awk "BEGIN{srand();print int(rand()*60)}")" \
        >> /etc/crontabs/root
    /etc/init.d/cron enable 2>/dev/null
    /etc/init.d/cron restart 2>/dev/null
fi
# Кеш LuCI обязателен к сбросу: иначе меню и view остаются прежними до перезагрузки.
rm -f /tmp/luci-indexcache.* 2>/dev/null
rm -rf /tmp/luci-modulecache/ 2>/dev/null
/etc/init.d/rpcd reload 2>/dev/null

# Набор опций обработчика протокола netifd читает ОДИН РАЗ, при своём запуске, и всё, чего в
# наборе нет, молча отбрасывает из настройки интерфейса. Значит опция, приехавшая с новым
# пакетом, до перезапуска netifd не существует вовсе: галочка в интерфейсе стоит, `uci` её
# помнит, а движок работает по-старому. Ровно так не включался «режим потока» — netifd держал
# набор от версии, где опции ещё не было, и туннель шёл поддельным TCP в порт, где у хаба
# настоящий слушающий сокет. Ни одной строчки об этом не сказал никто.
#
# Перезапускать сеть ОТСЮДА НЕЛЬЗЯ, и это не осторожность: netifd управляет туннелем, через
# который пакет в том числе и ставят, — обновление обрывало бы само себя на середине. Тот же
# довод, по которому rpcd не перезапускает выходы без нужды. Поэтому расхождение
# обнаруживается и НАЗЫВАЕТСЯ, а решение остаётся человеку.
proto_set() {
    # Строка ЦЕЛИКОМ, а не только имя опции: у proto_config_add_array аргумент несёт тип
    # ('addresses:list(cidr4)'), и его смена — такое же изменение набора, как новая опция.
    grep -o 'proto_config_add_[a-z]*.*' "$1" 2>/dev/null | sort | md5sum | cut -d' ' -f1
}
mark=/etc/splify2/netifd-proto-set
now="$(proto_set /lib/netifd/proto/xsteer.sh)"
was="$(cat "$mark" 2>/dev/null)"
if [ -n "$now" ] && [ "$now" != "$was" ]; then
    mkdir -p /etc/splify2
    printf '%s\n' "$now" > "$mark"
    [ -n "$was" ] && echo "splify2: набор опций протокола xsteer изменился." \
                  || echo "splify2: обработчик протокола xsteer установлен."
    echo "         netifd держит прежний набор и молча отбрасывает новые опции — до"
    echo "         перезапуска они не действуют, хотя в интерфейсе видны:"
    echo "             /etc/init.d/network restart"
    echo "         Сеть отсюда не перезапускается нарочно: этим туннелем идёт и сама установка."
fi
exit 0
EOF
chmod +x build/scripts/post-install

# Движок в depends НЕ объявлен, хотя без него интерфейс бесполезен. Причина практическая:
# steer лежит в GitHub Releases, а не в репозитории apk, и жёсткая зависимость делает пакет
# неустанавливаемым — «ERROR: steer (no such package)» у любого, кто ставит интерфейс
# первым. А первым его ставят как раз новички.
#
# Вместо зависимости движок ставится двумя путями, и оба, в отличие от apk, объясняют выбор
# варианта: install.sh при установке одной строкой и карточка в самом интерфейсе, если
# движка нет. Отсутствие движка интерфейс переживает и говорит об этом прямо — это
# предусмотренное состояние, а не поломка.
mkdir -p "$OUT"
docker run --rm -v "$PWD":/w -w /w alpine:latest sh -c \
    "apk add --no-cache apk-tools >/dev/null 2>&1; apk mkpkg \
       --info name:luci-app-splify2 --info version:$VERSION-r1 \
       --info description:'splify2: каналы, выходы и списки поверх движка steer' \
       --info arch:noarch --info depends:'luci-base' \
       --script post-install:build/scripts/post-install \
       -F $PKG -o $OUT/luci-app-splify2-$VERSION-1_noarch.apk" >/dev/null 2>&1 \
    || { echo "упаковка apk провалилась"; exit 1; }

# ---- тот же пакет в формате opkg ---------------------------------------------
#
# OpenWrt перешёл на apk в 24.10, но 23.05 и 22.03 стоят на роутерах и будут стоять: на
# 4/32 их никто не обновит. Интерфейс к движку нужен там ровно так же, а apk на таком
# роутере нет вовсе — то есть пакет только в новом формате отрезает половину устройств,
# ничего об этом не сказав.
#
# Дерево файлов ОДНО ($PKG) на оба формата: разные деревья означали бы пакет, который в
# одном формате работает, а в другом нет, и заметить это можно было бы только на роутере.
# Отличаются только метаданные.
#
# ipkg-build — родной скрипт OpenWrt, тот же, что собирает пакеты в их SDK. Качается один
# раз в build/ (см. .gitignore): своя реализация формата дала бы .ipk, который opkg
# принимает не везде.
IPKG=build/ipkg-build
if [ ! -x "$IPKG" ]; then
    echo "качаю ipkg-build из OpenWrt"
    # curl или wget: на машине сборщика бывает любой из двух, а требовать конкретный
    # значит уронить сборку там, где всё для неё есть.
    URL=https://raw.githubusercontent.com/openwrt/openwrt/master/scripts/ipkg-build
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$URL" -o "$IPKG" || { echo "не удалось скачать ipkg-build"; exit 1; }
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$IPKG" "$URL" || { echo "не удалось скачать ipkg-build"; exit 1; }
    else
        echo "нужен curl или wget, чтобы взять ipkg-build"; exit 1
    fi
    chmod +x "$IPKG"
fi

# CONTROL кладётся ВНУТРЬ дерева пакета, поэтому строго ПОСЛЕ apk mkpkg по тому же
# дереву: иначе служебные файлы уехали бы в полезную нагрузку apk.
mkdir -p "$PKG/CONTROL"
cat > "$PKG/CONTROL/control" <<EOF
Package: luci-app-splify2
Version: $VERSION-1
Depends: luci-base
Architecture: all
Maintainer: xyzmean
Section: luci
Description: splify2: каналы, выходы и списки поверх движка steer
EOF
cp build/scripts/post-install "$PKG/CONTROL/postinst"
chmod 0755 "$PKG/CONTROL/postinst"
if "$PWD/$IPKG" "$PKG" "$PWD/$OUT" >/dev/null 2>&1; then
    # ipkg-build называет файл через подчёркивания; приводим к тому же виду, что у apk,
    # чтобы в релизе оба формата одного пакета лежали рядом и читались одинаково.
    mv "$OUT/luci-app-splify2_${VERSION}-1_all.ipk" \
       "$OUT/luci-app-splify2-${VERSION}-1_all.ipk" 2>/dev/null || true
else
    echo "упаковка ipk провалилась"; exit 1
fi
rm -rf "$PKG/CONTROL"

ls -la "$OUT"
