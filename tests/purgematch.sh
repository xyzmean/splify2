#!/bin/sh
# Полное удаление следов пакета (files/usr/sbin/splify2-purge) — ПОВЕДЕНИЕ, а не текст.
#
# ЗАЧЕМ СТЕНД. Этот скрипт — единственный в пакете, который удаляет чужое окружение целиком:
# зоны фаервола, конфиг соседнего пакета, каталоги с настройками человека. Ошибка здесь не
# видна вовсе (удалили лишнее — узнаётся через неделю, когда человек хватится настройки) и
# неотменима, потому что удалённое из uci не возвращается. Проверять такое можно только
# запуском настоящего скрипта в песочнице.
#
# ЧТО ИМЕННО СТЕРЕЖЁТСЯ, четыре вещи, и каждая — про молчаливую беду:
#
#   1. Без --yes не удаляется НИЧЕГО. Показ по умолчанию — единственная оборона от «позвал
#      посмотреть и остался без спеки»; спросить в диалоге нельзя, скрипт зовут из ubus.
#   2. Чужая зона не удаляется. Расписка $FW_OWNED (см. m-spec.sh) — то же условие, что у
#      fw_adopt_if_ours: одно устройство, которое заводили не мы, делает зону чужой.
#   3. Правила проброса уходят РАНЬШЕ зоны. Это порядок ВЫЗОВОВ, а не итог: удалив зону
#      первой, скрипт получит то же самое хранилище uci, а живой fw4 откажется перезагрузить
#      набор, в котором forwarding ссылается в пустоту, — и роутер останется без фаервола.
#      Поэтому заглушка uci ведёт журнал, и проверка смотрит в него.
#   4. --keep-config оставляет настройки. Иначе флаг есть, а доверия к нему нет.
#
# Заглушки uci/nft/ip/fw4 и init-скриптов стоят в PATH, пути внутри скрипта подменены швами
# (SPLIFY2_DIR, STEER_DIR, CRONTAB и прочие). Имена зон, таблиц nftables и номера таблицы
# маршрутов НАРОЧНО оставлены умолчаниями скрипта: переименование steer_vless или splify2_doh
# в одном месте должно ронять стенд, а не тихо расходиться с рабочей системой.
#
# Запуск: sh tests/purgematch.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/files/usr/sbin/splify2-purge"
[ -f "$SCRIPT" ] || { echo "нет $SCRIPT"; exit 2; }

T="$(mktemp -d /tmp/purgematch.XXXXXX)"
trap 'rm -rf "$T"' EXIT INT TERM

pass=0 fail=0
check() {  # ОПИСАНИЕ ОЖИДАЕМОЕ ПОЛУЧЕННОЕ
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        printf 'ПРОВАЛ %s\n  ожидалось: %s\n  получено:  %s\n' "$1" "$2" "$3"
    fi
}

mkdir -p "$T/bin"

# ---- заглушка uci ------------------------------------------------------------------
# Плоское хранилище «ключ=значение», как в tests/rpcdmatch.sh, плюс две добавки, без которых
# этот стенд не сторожил бы главного.
#
# ПЕРВАЯ — ЖУРНАЛ ВЫЗОВОВ: порядок «forwarding раньше зоны» виден только в нём (см. шапку).
#
# ВТОРАЯ — ПЕРЕНУМЕРАЦИЯ безымянных секций. Настоящий uci после удаления @zone[1] сдвигает
# @zone[2] на её место. Заглушка без этого пропустила бы самую вероятную ошибку такого
# скрипта — индекс, добытый до удаления и использованный после.
#
# Сравнение ключей — `case` и awk по длине строки, а не grep: в имени безымянной секции есть
# квадратные скобки, а в шаблоне grep они означают класс символов (урок заглушки rpcdmatch).
cat > "$T/bin/uci" <<'EOF'
#!/bin/sh
S="$SANDBOX/uci.store"
[ -f "$S" ] || : > "$S"
while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done
printf '%s\n' "$*" >> "$SANDBOX/uci.log"
case "${1:-}" in
    get)
        v=""; found=0
        while IFS= read -r line; do
            case "$line" in "${2:-}="*) v="${line#*=}"; found=1 ;; esac
        done < "$S"
        [ "$found" = 1 ] || exit 1
        printf '%s\n' "$v"
        ;;
    set)
        k="${2%%=*}"; v="${2#*=}"
        : > "$S.t"
        while IFS= read -r line; do
            case "$line" in "$k="*) continue ;; esac
            printf '%s\n' "$line" >> "$S.t"
        done < "$S"
        printf '%s=%s\n' "$k" "$v" >> "$S.t"
        mv "$S.t" "$S"
        ;;
    delete)
        k="${2:-}"
        # Удаление секции уносит и её опции: «@zone[1]» — это и строка типа, и все «@zone[1].*».
        awk -v k="$k" '{ key = $0; sub(/=.*/, "", key)
            if (key == k) next
            if (substr(key, 1, length(k) + 1) == k ".") next
            print }' "$S" > "$S.t"
        case "$k" in
            *.@*\[*\])
                cfg="${k%%.*}"; rest="${k#*.@}"
                typ="${rest%%[*}"; idx="${rest#*[}"; idx="${idx%]}"
                awk -v pfx="$cfg.@$typ[" -v idx="$idx" '{
                    if (substr($0, 1, length(pfx)) == pfx) {
                        r = substr($0, length(pfx) + 1)
                        p = index(r, "]")
                        n = substr(r, 1, p - 1) + 0
                        if (n > idx) { print pfx (n - 1) substr(r, p); next }
                    }
                    print }' "$S.t" > "$S.t2"
                mv "$S.t2" "$S.t"
                ;;
        esac
        mv "$S.t" "$S"
        ;;
    del_list)
        k="${2%%=*}"; v="${2#*=}"
        : > "$S.t"
        while IFS= read -r line; do
            case "$line" in
                "$k="*)
                    old="${line#*=}"; new=""
                    for e in $old; do
                        [ "$e" = "$v" ] && continue
                        new="${new:+$new }$e"
                    done
                    [ -n "$new" ] && printf '%s=%s\n' "$k" "$new" >> "$S.t"
                    ;;
                *) printf '%s\n' "$line" >> "$S.t" ;;
            esac
        done < "$S"
        mv "$S.t" "$S"
        ;;
    show)
        pfx="${2:-}"
        while IFS= read -r line; do
            k="${line%%=*}"; v="${line#*=}"
            case "$k" in "$pfx"|"$pfx".*) ;; *) continue ;; esac
            case "$k" in
                *.*.*)
                    # Список настоящий uci печатает как key='a' 'b'. Разница значима: по этой
                    # строке ищут зону устройства, и склейка в одни кавычки скрыла бы промах.
                    q=""
                    for e in $v; do q="${q:+$q }'$e'"; done
                    printf '%s=%s\n' "$k" "$q"
                    ;;
                *) printf '%s=%s\n' "$k" "$v" ;;
            esac
        done < "$S"
        ;;
    commit) : ;;
esac
exit 0
EOF

# ---- заглушка nft ------------------------------------------------------------------
# Таблицы живут списком в файле: `list` отвечает кодом (есть/нет), `delete` уносит. Код
# возврата нужен затем, что показ обязан назвать только СУЩЕСТВУЮЩИЕ таблицы — обещание
# удалить то, чего нет, читается как «скрипт не знает, что на роутере».
cat > "$T/bin/nft" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SANDBOX/nft.log"
t="${4:-}"
case "${1:-}" in
    list)   grep -qxF "$t" "$SANDBOX/nft.tables" 2>/dev/null || exit 1 ;;
    delete)
        grep -qxF "$t" "$SANDBOX/nft.tables" 2>/dev/null || exit 1
        grep -vxF "$t" "$SANDBOX/nft.tables" > "$SANDBOX/nft.t" 2>/dev/null
        mv "$SANDBOX/nft.t" "$SANDBOX/nft.tables"
        ;;
esac
exit 0
EOF

# ---- заглушка ip -------------------------------------------------------------------
# Правила — строками «ПРЕФ: ...», как их печатает настоящий ip. Отказ `rule del` на
# отсутствующем правиле обязателен: им кончается цикл, снимающий накопившиеся копии.
cat > "$T/bin/ip" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SANDBOX/ip.log"
case "${1:-} ${2:-}" in
    "rule show") cat "$SANDBOX/ip.rules" 2>/dev/null ;;
    "rule del")
        p="${4:-}"
        grep -q "^$p:" "$SANDBOX/ip.rules" 2>/dev/null || exit 2
        grep -v "^$p:" "$SANDBOX/ip.rules" > "$SANDBOX/ip.t" 2>/dev/null
        mv "$SANDBOX/ip.t" "$SANDBOX/ip.rules"
        ;;
    "route show") cat "$SANDBOX/ip.routes" 2>/dev/null ;;
    "route flush") : > "$SANDBOX/ip.routes" ;;
esac
exit 0
EOF

cat > "$T/bin/fw4" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SANDBOX/fw4.log"
exit 0
EOF

for s in steer cron firewall; do
    cat > "$T/bin/initd-$s" <<EOF
#!/bin/sh
printf '%s %s\n' "$s" "\$1" >> "\$SANDBOX/initd.log"
exit 0
EOF
done

chmod +x "$T/bin"/*

# ---- песочница ---------------------------------------------------------------------
# Состояние роутера «пакет стоит и работает»: две наших зоны с пробросами, чужая зона lan,
# чужая таблица nftables, чужое правило маршрутизации, чужая строка в crontab и чужой
# интерфейс. Всё чужое здесь нужно ровно затем, чтобы проверить, что его не тронули.
setup() {  # [УСТРОЙСТВА_ЗОНЫ_STEER_VLESS] [СРОК_RPCD] [RUN_ON_BOOT] [FORCE_DNS]
    _dev="${1:-tun-vless}"; _rt="${2:-120}"; _zb="${3:-0}"; _fd="${4:-0}"
    rm -rf "$T/etc" "$T/var"
    mkdir -p "$T/etc/config" "$T/etc/crontabs" "$T/etc/splify2" "$T/etc/steer/lists" \
             "$T/var/lib/splify2" "$T/var/lib/steer" "$T/var/run/xsteer"
    : > "$T/uci.log"; : > "$T/nft.log"; : > "$T/ip.log"; : > "$T/fw4.log"; : > "$T/initd.log"

    cat > "$T/uci.store" <<EOF
firewall.@zone[0]=zone
firewall.@zone[0].name=lan
firewall.@zone[0].device=br-lan
firewall.@zone[1]=zone
firewall.@zone[1].name=steer_vless
firewall.@zone[1].device=$_dev
firewall.@zone[2]=zone
firewall.@zone[2].name=steer_iface
firewall.@zone[2].device=wg0
firewall.@forwarding[0]=forwarding
firewall.@forwarding[0].src=lan
firewall.@forwarding[0].dest=wan
firewall.@forwarding[1]=forwarding
firewall.@forwarding[1].src=lan
firewall.@forwarding[1].dest=steer_vless
firewall.@forwarding[2]=forwarding
firewall.@forwarding[2].src=lan
firewall.@forwarding[2].dest=steer_iface
rpcd.@rpcd[0]=rpcd
rpcd.@rpcd[0].timeout=$_rt
zapret.config=zapret
zapret.config.run_on_boot=$_zb
network.lan=interface
network.lan.proto=static
network.xs0=interface
network.xs0.proto=xsteer
EOF

    # Расписка: обе зоны и обе устройства заведены нами. Постороннее устройство в первой
    # зоне (если его просит вызов) в расписку НЕ попадает — этим и проверяется чужая зона.
    cat > "$T/etc/splify2/fw-owned" <<'EOF'
zone steer_vless
dev steer_vless tun-vless
zone steer_iface
dev steer_iface wg0
EOF
    echo '{"manifest":1}' > "$T/etc/splify2/manifest.json"
    echo '{"outputs":{}}' > "$T/etc/steer/spec.json"
    echo '{"outputs":{}}' > "$T/etc/steer/spec.applied.json"
    echo 'https://panel.example/sub' > "$T/etc/steer/sub.txt"
    printf "config splify2 'main'\n\toption sub 'x'\n" > "$T/etc/config/splify2"
    printf "config main 'config'\n\toption force_dns '%s'\n\nconfig https-dns-proxy\n\toption resolver_url 'https://cloudflare-dns.com/dns-query'\n" \
        "$_fd" > "$T/etc/config/https-dns-proxy"
    printf '%s\n%s\n' '0 3 * * * /usr/bin/чужое-обновление' \
        '17 5 * * * /usr/sbin/splify2-update-lists' > "$T/etc/crontabs/root"
    : > "$T/var/run/splify2-vless-dirty"
    printf '%s\n%s\n%s\n%s\n' splify2_doh splify2_zm steer fw4 > "$T/nft.tables"
    printf '%s\n%s\n' '29000:	from all uidrange 65534-65534 lookup 290' \
        '30000:	from all lookup main' > "$T/ip.rules"
    printf '%s\n' 'default dev wg0 scope link' > "$T/ip.routes"
}

rc=0
run_purge() {  # КЛЮЧИ СКРИПТА
    SANDBOX="$T" PATH="$T/bin:$PATH" \
    SPLIFY2_DIR="$T/etc/splify2" \
    STEER_DIR="$T/etc/steer" \
    UCI_SPLIFY2="$T/etc/config/splify2" \
    DOH_CONF="$T/etc/config/https-dns-proxy" \
    CRONTAB="$T/etc/crontabs/root" \
    CRON_INITD="$T/bin/initd-cron" \
    INITD="$T/bin/initd-steer" \
    FW_INITD="$T/bin/initd-firewall" \
    STATE_PATHS="$T/var/lib/splify2 $T/var/lib/steer $T/var/run/xsteer $T/var/run/splify2-vless-dirty" \
        sh "$SCRIPT" "$@" > "$T/out" 2>&1
    rc=$?
}

store() { printf '%s' "$(grep -c . "$T/uci.store")"; }
has()  { grep -qxF "$1" "$T/uci.store" && echo yes || echo no; }
val()  { v="$(grep "^$1=" "$T/uci.store" | head -1)"; printf '%s' "${v#*=}"; }
zones() { sed -n 's/^firewall\.@zone\[[0-9]*\]\.name=//p' "$T/uci.store" | tr '\n' ' '; }
fwds()  { sed -n 's/^firewall\.@forwarding\[[0-9]*\]\.dest=//p' "$T/uci.store" | tr '\n' ' '; }
# Порядок удалений в фаерволе: только тип секции, по порядку вызовов.
del_seq() { sed -n 's/^delete firewall\.@\([a-z]*\)\[.*/\1/p' "$T/uci.log" | tr '\n' ' '; }
exists() { [ -e "$1" ] && echo yes || echo no; }
outhas() { grep -q -e "$1" "$T/out" && echo yes || echo no; }

# ---- без --yes не делается НИЧЕГО --------------------------------------------------
# Первая и главная проверка: показ обязан быть полным (человек по нему решает) и при этом
# совершенно безвредным. Ни одного удаления в журналах, ни одного пропавшего файла.
setup
run_purge
check "показ завершается успехом" "0" "$rc"
check "показ ничего не удаляет в uci" "" "$(del_seq)"
check "показ ничего не пишет в uci" "0" "$(grep -c '^set \|^commit \|^del_list ' "$T/uci.log")"
check "показ не трогает таблицы nftables" "0" "$(grep -c '^delete ' "$T/nft.log")"
check "показ не трогает маршрутизацию" "0" "$(grep -c 'del\|flush' "$T/ip.log")"
check "показ не перезагружает фаервол" "0" "$(grep -c . "$T/fw4.log")"
check "показ не останавливает движок" "0" "$(grep -c . "$T/initd.log")"
check "показ оставляет спеку" "yes" "$(exists "$T/etc/steer/spec.json")"
check "показ оставляет настройку" "yes" "$(exists "$T/etc/config/splify2")"
check "показ оставляет расписку" "yes" "$(exists "$T/etc/splify2/fw-owned")"
check "показ оставляет конфиг DoH" "yes" "$(exists "$T/etc/config/https-dns-proxy")"
check "показ оставляет запись в crontab" "1" "$(grep -c splify2-update-lists "$T/etc/crontabs/root")"
check "показ оставляет состояние в /var" "yes" "$(exists "$T/var/lib/splify2")"
# Показ, по которому не видно, что будет удалено, бесполезен: человек не узнает ни про зону,
# ни про свою спеку — а именно они и есть цена ошибки.
check "показ называет зону" "yes" "$(outhas steer_vless)"
check "показ называет спеку" "yes" "$(outhas spec.json)"
check "показ называет таблицу nftables" "yes" "$(outhas splify2_doh)"
check "показ говорит, чем удалять" "yes" "$(outhas '--yes')"

# ---- с --yes: своё уходит, чужое остаётся ------------------------------------------
setup
run_purge --yes
check "удаление завершается успехом" "0" "$rc"
# ПОРЯДОК. Сначала правило проброса, потом зона — и так по каждой зоне. Обратный порядок даёт
# то же хранилище, но живой fw4 отказывается перезагрузить набор со ссылкой в пустоту.
check "проброс удаляется раньше своей зоны" "forwarding zone forwarding zone " "$(del_seq)"
check "наши зоны удалены" "lan " "$(zones)"
check "чужая зона lan не тронута" "br-lan" "$(val 'firewall.@zone\[0\].device')"
check "пробросы в наши зоны удалены" "wan " "$(fwds)"
check "фаервол перезагружен один раз" "1" "$(grep -c reload "$T/fw4.log")"
check "движок остановлен и снят с автозапуска" "steer stop steer disable" \
    "$(grep '^steer ' "$T/initd.log" | tr '\n' ' ' | sed 's/ $//')"
check "наши таблицы nftables удалены" "fw4" "$(cat "$T/nft.tables")"
check "чужую таблицу не удаляли" "0" "$(grep -c 'delete table inet fw4' "$T/nft.log")"
# splify2_ztest в песочнице нет: удалять отсутствующее незачем, а обещать — вводить в
# заблуждение, поэтому попытки быть не должно вовсе.
check "отсутствующую таблицу не удаляли" "0" "$(grep -c 'delete table inet splify2_ztest' "$T/nft.log")"
check "правило DoH снято" "30000:	from all lookup main" "$(cat "$T/ip.rules")"
check "таблица маршрутов очищена" "" "$(cat "$T/ip.routes")"
check "наша запись в crontab убрана" "0" "$(grep -c splify2-update-lists "$T/etc/crontabs/root")"
check "чужая запись в crontab осталась" "1" "$(grep -c 'чужое-обновление' "$T/etc/crontabs/root")"
check "cron перезапущен" "1" "$(grep -c '^cron restart' "$T/initd.log")"
check "срок вызова rpcd снят" "no" "$(has 'rpcd.@rpcd[0].timeout=120')"
# Ключ ЧУЖОГО пакета не удаляется, а возвращается к его умолчанию: ноль в нём — это наше
# «обход выключен», и уйти, оставив человека без автозапуска обхода, значило бы наследить.
check "run_on_boot возвращён zapret-у" "1" "$(val 'zapret\.config\.run_on_boot')"
check "конфиг DoH удалён" "no" "$(exists "$T/etc/config/https-dns-proxy")"
check "каталог /etc/splify2 удалён" "no" "$(exists "$T/etc/splify2")"
check "каталог настроек движка удалён" "no" "$(exists "$T/etc/steer")"
check "настройка splify2 удалена" "no" "$(exists "$T/etc/config/splify2")"
check "состояние в /var удалено" "no" "$(exists "$T/var/lib/splify2")"
check "признак в /var удалён" "no" "$(exists "$T/var/run/splify2-vless-dirty")"
# Интерфейс с протоколом xsteer заводил человек — он его и уберёт. Но молчать о нём нельзя:
# без обработчика протокола он не поднимется, и выглядеть это будет как поломка сети.
check "интерфейс xsteer не удалён" "yes" "$(has 'network.xs0.proto=xsteer')"
check "но о нём сказано" "yes" "$(outhas xs0)"

# ---- повторный прогон ничего не делает ---------------------------------------------
# Идемпотентность здесь не украшение: человек, не увидевший вывода с первого раза, позовёт
# команду ещё раз, и второй прогон обязан быть тихим, а не отказом.
: > "$T/uci.log"; : > "$T/nft.log"; : > "$T/fw4.log"
run_purge --yes
check "второй прогон успешен" "0" "$rc"
check "второй прогон ничего не удаляет" "" "$(del_seq)"
check "второй прогон не перезагружает фаервол" "0" "$(grep -c . "$T/fw4.log")"

# ---- чужая зона -------------------------------------------------------------------
# В зоне steer_vless лежит eth7, которого в расписке нет: значит зону правили руками, и она
# чужая. Своё устройство из неё всё равно выносим — «убрать только своё» — но ни зону, ни
# проброс в неё не трогаем.
setup "tun-vless eth7"
run_purge --yes
check "чужая зона осталась" "lan steer_vless " "$(zones)"
check "проброс в чужую зону остался" "wan steer_vless " "$(fwds)"
check "чужое устройство не вынесено" "eth7" "$(val 'firewall.@zone\[1\].device')"
check "своё устройство вынесено" "1" "$(grep -c '^del_list firewall.@zone\[1\].device=tun-vless' "$T/uci.log")"
# Вторая зона в этой же песочнице наша целиком — она уходит, и уходит после своего
# проброса. То есть чужая зона останавливает чистку только себя, а не всей работы.
check "наша вторая зона удалена, и снова после проброса" "forwarding zone " "$(del_seq)"
check "о чужой зоне сказано" "yes" "$(outhas 'steer_vless')"

# ---- --keep-config -----------------------------------------------------------------
# Смысл флага: снести правила и зоны, оставив настройки. Спека и /etc/config/splify2 при этом
# обязаны выжить, иначе флаг есть, а верить ему нельзя.
setup
run_purge --yes --keep-config
check "с --keep-config спека осталась" "yes" "$(exists "$T/etc/steer/spec.json")"
check "с --keep-config подписка осталась" "yes" "$(exists "$T/etc/steer/sub.txt")"
check "с --keep-config настройка осталась" "yes" "$(exists "$T/etc/config/splify2")"
check "с --keep-config конфиг DoH остался" "yes" "$(exists "$T/etc/config/https-dns-proxy")"
check "с --keep-config зоны всё равно удалены" "lan " "$(zones)"
check "с --keep-config таблицы всё равно удалены" "fw4" "$(cat "$T/nft.tables")"
check "с --keep-config запись в crontab всё равно убрана" "0" \
    "$(grep -c splify2-update-lists "$T/etc/crontabs/root")"

# ---- чужой конфиг https-dns-proxy --------------------------------------------------
# force_dns '1' пишет сам пакет и пишет Zapret Manager; ноль пишем только мы (doh.sh). Значит
# файл с единицей — не наш, и удалять его нельзя: у человека там мог быть свой резолвер.
setup tun-vless 120 0 1
run_purge --yes
check "чужой конфиг DoH оставлен" "yes" "$(exists "$T/etc/config/https-dns-proxy")"
check "и об этом сказано" "yes" "$(outhas 'https-dns-proxy')"

# ---- чужой срок вызова rpcd --------------------------------------------------------
# 120 ставит наш uci-defaults; другое значение поставил администратор, и снимать его —
# менять чужую настройку молча.
setup tun-vless 300
run_purge --yes
check "чужой срок вызова rpcd не тронут" "300" "$(val 'rpcd\.@rpcd\[0\]\.timeout')"

# ---- run_on_boot, которого мы не выключали -----------------------------------------
setup tun-vless 120 1
run_purge --yes
check "единицу в run_on_boot не переписываем" "0" "$(grep -c '^set zapret' "$T/uci.log")"

# ---- движка уже нет, а его таблица осталась ----------------------------------------
# Самый вероятный порядок в жизни: человек сначала снял пакеты, потом вспомнил про мусор. Вместе
# с пакетом ушёл init-скрипт движка, то есть снять его таблицу его же остановкой больше нечем —
# и до перезагрузки она метит трафик в никуда. Чистка обязана убрать её сама.
setup
mv "$T/bin/initd-steer" "$T/bin/initd-steer.off"
run_purge --yes
mv "$T/bin/initd-steer.off" "$T/bin/initd-steer"
check "таблица движка снята и без его init-скрипта" "fw4" "$(cat "$T/nft.tables")"
check "движок не звали — его нет" "0" "$(grep -c '^steer ' "$T/initd.log")"

# ---- нечего убирать ----------------------------------------------------------------
# Роутер, где следов нет: скрипт обязан сказать это и выйти успехом, а не ругаться.
setup
rm -rf "$T/etc" "$T/var"
: > "$T/uci.store"; : > "$T/nft.tables"; : > "$T/ip.rules"; : > "$T/ip.routes"
mv "$T/bin/initd-steer" "$T/bin/initd-steer.off"
run_purge --yes
mv "$T/bin/initd-steer.off" "$T/bin/initd-steer"
check "на чистом роутере успех" "0" "$rc"
check "и сказано, что убирать нечего" "yes" "$(outhas 'убирать нечего')"
check "и ничего не удалялось" "" "$(del_seq)"

# ---- неизвестный ключ --------------------------------------------------------------
# Опечатка в ключе (`--yes-please`) не должна читаться как согласие: молчаливое удаление по
# непонятому ключу — ровно та беда, от которой защищает показ по умолчанию.
setup
run_purge --yes-please
check "неизвестный ключ — отказ" "2" "$rc"
check "и ничего не удалено" "" "$(del_seq)"
check "и спека на месте" "yes" "$(exists "$T/etc/steer/spec.json")"

printf '\n%d проверок пройдено' "$pass"
if [ "$fail" -gt 0 ]; then printf ', %d ПРОВАЛЕНО\n' "$fail"; exit 1; fi
printf '\nвсе проверки прошли\n'
