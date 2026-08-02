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

command -v docker >/dev/null 2>&1 || { echo "нужен docker (сборка пакета в alpine)"; exit 1; }

echo "splify2 $VERSION"
( cd ui && npm run build >/dev/null 2>&1 ) || { echo "сборка интерфейса провалилась"; exit 1; }

rm -rf "$PKG"
mkdir -p "$RES" "$PKG/etc/init.d" "$PKG/usr/libexec/rpcd" "$PKG/usr/sbin" "$PKG/etc/splify2"
cp -r ui/dist/* "$RES/"
cp -r luci/htdocs/luci-static/resources/view "$PKG/www/luci-static/resources/"
cp -r luci/root/usr/share "$PKG/usr/"
cp files/usr/libexec/rpcd/splify2 "$PKG/usr/libexec/rpcd/splify2"
cp files/usr/sbin/splify2-update-lists "$PKG/usr/sbin/splify2-update-lists"
chmod 0755 "$PKG/usr/libexec/rpcd/splify2" "$PKG/usr/sbin/splify2-update-lists"

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
exit 0
EOF
chmod +x build/scripts/post-install

mkdir -p "$OUT"
docker run --rm -v "$PWD":/w -w /w alpine:latest sh -c \
    "apk add --no-cache apk-tools >/dev/null 2>&1; apk mkpkg \
       --info name:luci-app-splify2 --info version:$VERSION-r1 \
       --info description:'splify2: каналы, выходы и списки поверх движка steer' \
       --info arch:noarch --info depends:'luci-base steer' \
       --script post-install:build/scripts/post-install \
       -F $PKG -o $OUT/luci-app-splify2-$VERSION-1_noarch.apk" >/dev/null 2>&1 \
    || { echo "упаковка провалилась"; exit 1; }

ls -la "$OUT"
