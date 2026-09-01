#!/bin/sh
# Образец Zapret-Manager.sh: только то, из чего разбираются стратегии `v`.
# Первые две строки — ловушки: у первой нет заголовка «#vN», вторая вообще не стратегия.
strategy_v99() { printf '%s\n' "--filter-tcp=443" "--dpi-desync=fake"; }
strategy_vXX() { echo "не стратегия"; }
strategy_v1() { printf '%s\n' "#v1" "--filter-tcp=443" "--dpi-desync=split2" "--dpi-desync-split-seqovl=681"; }
strategy_v2() { printf '%s\n' "#v2" "--filter-tcp=443" "--dpi-desync=fake,multisplit" "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com"; }
