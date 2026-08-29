#!/usr/bin/env python3
"""Собрать files/etc/steer/lists/zm-github.lst — адреса GitHub для фикса Zapret Manager.

ПОЧЕМУ АДРЕСА, А НЕ ДОМЕНЫ. Доменное правило работает через резолвер движка, а тот запускается
службой steer по ПОЛЬЗОВАТЕЛЬСКОЙ спеке (/etc/steer/spec.json прошит в её init-скрипте). Наш
канал живёт в производной спеке и в ту проверку не попадает: резолвер не поднимется, и
доменное правило будет тихо ничем. Адресный канал резолвера не требует вовсе — набор в ядре
статический и работает сразу после применения.

Источник — сам GitHub: https://api.github.com/meta, разделы web/api/git/pages/packages. Это
то, куда ходит Zapret Manager: сайт и релизы (web), api.github.com, codeload (git), Pages и
raw/objects через Fastly. IPv6 не берём: наборы движка — ipv4_addr.

Запуск: python3 tools/github-ranges.py (нужен доступ в сеть).
"""
import ipaddress
import json
import sys
import urllib.request

KEYS = ("web", "api", "git", "pages", "packages")
OUT = "files/etc/steer/lists/zm-github.lst"

HEAD = """# Адреса GitHub для фикса Zapret Manager: сам менеджер, его аддоны и всё, что он тянет при
# установке. Список едет В ПАКЕТЕ, а не скачивается: он нужен ровно тогда, когда до GitHub не
# дойти, — качать его оттуда же было бы замкнутым кругом.
#
# Адреса, а не домены, и это не вкус: доменное правило работает через резолвер движка, а тот
# поднимается по пользовательской спеке, куда наш канал намеренно не попадает. Набор адресов
# резолвера не требует и действует сразу после применения.
#
# Собран из https://api.github.com/meta (web, api, git, pages, packages) скриптом
# tools/github-ranges.py — правки руками затрёт следующий запуск.
"""


def main() -> None:
    raw = urllib.request.urlopen("https://api.github.com/meta", timeout=30).read()
    meta = json.loads(raw)
    nets = set()
    for key in KEYS:
        for cidr in meta.get(key, []):
            if ":" in cidr:
                continue
            nets.add(ipaddress.ip_network(cidr, strict=False))
    if not nets:
        sys.exit("api.github.com/meta не отдал ни одной сети IPv4")
    # Схлопываем вложенные: у GitHub рядом с /20 лежат десятки /32 из него же, и движок всё
    # равно сведёт их в наборе — пусть файл сразу говорит то же самое.
    merged = sorted(
        ipaddress.collapse_addresses(nets),
        key=lambda n: (int(n.network_address), n.prefixlen),
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(HEAD)
        for n in merged:
            f.write(f"{n}\n")
    print(f"сетей: {len(merged)} (из {len(nets)} до схлопывания) → {OUT}")


if __name__ == "__main__":
    main()
