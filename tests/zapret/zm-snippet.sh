#!/bin/sh
# Образец Zapret-Manager.sh: только то, из чего разбираются стратегии `v` и `Dv`.
# Первые две строки — ловушки: у первой нет заголовка «#vN», вторая вообще не стратегия.
strategy_v99() { printf '%s\n' "--filter-tcp=443" "--dpi-desync=fake"; }
strategy_vXX() { echo "не стратегия"; }
strategy_v1() { printf '%s\n' "#v1" "--filter-tcp=443" "--dpi-desync=split2" "--dpi-desync-split-seqovl=681"; }
strategy_v2() { printf '%s\n' "#v2" "--filter-tcp=443" "--dpi-desync=fake,multisplit" "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com"; }
# Стратегии `Dv` (discord.media) объявлены у автора переменными, а не функциями, — строки
# ниже взяты из настоящего Zapret-Manager.sh дословно. Ловушки те же по смыслу, что у `v`:
# у Dv98 тело начинается не ключом nfqws, а Dv99 объявлен не тем способом, которым автор
# объявляет стратегии, — обе строки не стратегии и в каталог попасть не должны.
Dv1=$'--filter-tcp=2053,2083,2087,2096,8443\n--hostlist-domains=discord.media\n--dpi-desync=multisplit\n--dpi-desync-split-seqovl=652\n--dpi-desync-split-pos=2\n--dpi-desync-split-seqovl-pattern=/opt/zapret/files/fake/tls_clienthello_www_google_com.bin'
Dv2=$'--filter-tcp=2053,2083,2087,2096,8443\n--hostlist-domains=discord.media\n--dpi-desync=fake,multisplit\n--dpi-desync-split-seqovl=681\n--dpi-desync-split-pos=1\n--dpi-desync-fooling=ts\n--dpi-desync-repeats=8\n--dpi-desync-split-seqovl-pattern=/opt/zapret/files/fake/tls_clienthello_www_google_com.bin\n--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com'
Dv98=$'не стратегия\n--dpi-desync=fake'
Dv99="--filter-tcp=2053,2083,2087,2096,8443"
