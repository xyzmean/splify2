#!/usr/bin/env python3
"""Собрать ui/public/flags.svg — спрайт флагов тех стран, которые интерфейс называет.

Зачем картинками, а не эмодзи: флаг-эмодзи рисует шрифт, а в Windows шрифта с флагами нет —
там вместо флага видны две мелкие буквы. Проверено на экране владельца.

Источник — flag-icons (MIT, github.com/lipis/flag-icons), формат 4x3. Берётся ровно тот
список стран, который перечислен в ui/src/lib/geo.ts: список названий и список флагов обязаны
совпадать, иначе где-то из двух будет пусто.

Два флага заменены полями без герба: Сербия (182 КБ) и Испания (90 КБ) весили больше всей
сборки интерфейса, а на шестнадцати пикселях ширины герб — это несколько точек.

Спрайт лежит отдельным файлом, а не в бандле: 55 КБ внутри бандла удорожали бы каждое
открытие страницы ради картинки, которой на неподнятом туннеле и не будет.

Запуск: python3 tools/flags.py (нужен доступ в сеть).
"""
import json
import re
import sys
import urllib.request

SRC = "https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/{}.svg"

# Поля без герба — см. шапку.
PLAIN = {
    "rs": ('<path fill="#c6363c" d="M0 0h640v160H0z"/>'
           '<path fill="#0c4076" d="M0 160h640v160H0z"/>'
           '<path fill="#fff" d="M0 320h640v160H0z"/>'),
    "es": ('<path fill="#c60b1e" d="M0 0h640v480H0z"/>'
           '<path fill="#ffc400" d="M0 120h640v240H0z"/>'),
}


def codes() -> list[str]:
    geo = open("ui/src/lib/geo.ts", encoding="utf-8").read()
    return sorted({c.lower() for c in re.findall(r"([A-Z]{2}): '", geo)})


def symbol(cc: str) -> str:
    if cc in PLAIN:
        return f'<symbol id="fl-{cc}" viewBox="0 0 640 480">{PLAIN[cc]}</symbol>'
    raw = urllib.request.urlopen(SRC.format(cc), timeout=30).read().decode("utf-8")
    m = re.search(r'<svg[^>]*viewBox="([^"]+)"[^>]*>(.*)</svg>', raw, re.S)
    if not m:
        sys.exit(f"{cc}: не разобрался ответ flag-icons")
    inner = re.sub(r"<!--.*?-->", "", re.sub(r"\s+", " ", m.group(2).strip()))
    return f'<symbol id="fl-{cc}" viewBox="{m.group(1)}">{inner}</symbol>'


def main() -> None:
    cc = codes()
    sprite = "".join(symbol(c) for c in cc)
    open("ui/public/flags.svg", "w", encoding="utf-8").write(
        '<svg xmlns="http://www.w3.org/2000/svg">' + sprite + "</svg>\n"
    )
    print(f"флагов: {len(cc)}, спрайт: {len(sprite)} байт")


if __name__ == "__main__":
    main()
