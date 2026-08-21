#!/usr/bin/env python3
"""Разбор конфигурации xsteer на странице протокола: те же случаи, что у движка.

ЗАЧЕМ ЭТОТ СТЕНД. На странице protocol/xsteer.js есть кнопка «Загрузка конфигурации…»: человек
вставляет конфигурацию, которую напечатал установщик хаба, и поля заполняются сами. Разбор при
этом ВТОРОЙ — первый живёт в движке (src/ext/xsconf.c). Два разбора одного формата неизбежно
расходятся, если их не сверять, и расхождение здесь особенно неприятно: страница молча примет
то, что движок потом отвергнет, — или наоборот, откажет в том, что работает.

Поэтому проверяются ровно те решения, которые движок принимает так же: ключи, которых steer не
делает, отвергаются с называнием ключа; пиров ровно один; Endpoint только литералом IPv4;
приватный ключ 44 символа base64; концы строк любые.

ПОЧЕМУ ЭТО НЕ ТЕСТ ИНТЕРФЕЙСА (ui-harness). Тот проверяет React-бандл и требует node с
vitest. Здесь нужен только разбор — чистая функция без DOM, поэтому она гоняется в quickjs, а
не в браузере. Нет quickjs — стенд пропускается ВСЛУХ: молчаливый пропуск читается как
«прошло», и ровно так стенд однажды и превращается в фикцию.

    python3 tests/protomatch.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, "luci/htdocs/luci-static/resources/protocol/xsteer.js")

GOOD = """[Interface]
PrivateKey = 8BT4UvilnYyF0j+Gt5uy/oMUqH9NYOg3TrKQ/NS59lw=
Address = 10.77.0.2/24
SNI = www.microsoft.com

[Peer]
PublicKey = pvlciAMuJnL06ZXI5X0LgBaeA5Zty5OsqNaE7ikzaUg=
Endpoint = 203.0.113.7:4443
AllowedIPs = 10.77.0.0/24
PersistentKeepalive = 25
"""

# (имя, текст, ожидание): ожидание None — принять, строка — отказ, содержащий эту подстроку.
CASES = [
    ("конфигурация от установщика хаба", GOOD, None),
    ("комментарий # в начале", "# пир testrouter\n" + GOOD, None),
    ("комментарий ; в начале", "; пир\n" + GOOD, None),
    ("комментарий в конце строки", GOOD.replace("Address = 10.77.0.2/24", "Address = 10.77.0.2/24  # адрес"), None),
    # Концы строк: файл приносят из Windows, из буфера обмена и перетаскиванием, и все три
    # дают разное. Одинокий \r уже ломал разбор: точка в JS его не пересекает, и якорь `$`
    # приводил к тому, что комментарий не отбрасывался вовсе.
    ("концы строк CRLF", GOOD.replace("\n", "\r\n"), None),
    ("одинокий \\r", GOOD.replace("\n", "\r"), None),
    ("MTU задан вручную", GOOD.replace("SNI = www", "MTU = 1380\nSNI = www"), None),
    ("AllowedIPs списком", GOOD.replace("= 10.77.0.0/24", "= 10.77.0.0/24, 192.168.5.0/24"), None),
    ("регистр ключей", GOOD.replace("PrivateKey", "privatekey").replace("AllowedIPs", "ALLOWEDIPS"), None),
    # Ключи wg, поведение которых steer не реализует: отвергаются с называнием ключа, а не
    # отбрасываются молча.
    ("ключ Table", GOOD.replace("SNI = www.microsoft.com", "Table = off"), "Table"),
    ("ключ FwMark", GOOD.replace("SNI = www.microsoft.com", "FwMark = 0x1000"), "FwMark"),
    ("ключ PostUp", GOOD.replace("SNI = www.microsoft.com", "PostUp = rm -rf /"), "PostUp"),
    ("ключ PresharedKey", GOOD + "PresharedKey = 8BT4UvilnYyF0j+Gt5uy/oMUqH9NYOg3TrKQ/NS59lw=\n", "PresharedKey"),
    ("ключ ListenPort (только у хаба)", GOOD.replace("SNI = www.microsoft.com", "ListenPort = 443"), "ListenPort"),
    # Топология: у пира ровно одна секция [Peer] — хаб. Две означали бы, что часть трафика идёт
    # мимо звезды, ноль — что соединяться не с кем.
    ("два пира", GOOD + "\n[Peer]\nPublicKey = pvlciAMuJnL06ZXI5X0LgBaeA5Zty5OsqNaE7ikzaUg=\nEndpoint = 203.0.113.8:443\nAllowedIPs = 10.0.0.0/8\n", "ровно одна"),
    ("ни одного пира", GOOD.split("[Peer]")[0], "ровно одна"),
    # Endpoint только адресом: разрешение имени пошло бы через DNS, который сам может быть
    # направлен в этот же туннель — тогда туннель не поднимется никогда.
    ("Endpoint именем", GOOD.replace("203.0.113.7:4443", "hub.example.com:443"), "IPv4"),
    ("Endpoint без порта", GOOD.replace("203.0.113.7:4443", "203.0.113.7"), "IPv4"),
    ("порт вне диапазона", GOOD.replace(":4443", ":70000"), "диапазона"),
    ("приватный ключ не base64", GOOD.replace("8BT4UvilnYyF0j+Gt5uy/oMUqH9NYOg3TrKQ/NS59lw=", "коротко"), "PrivateKey"),
    ("публичный ключ не base64", GOOD.replace("pvlciAMuJnL06ZXI5X0LgBaeA5Zty5OsqNaE7ikzaUg=", "нет"), "PublicKey"),
    ("нет Address", GOOD.replace("Address = 10.77.0.2/24\n", ""), "Address"),
    ("нет AllowedIPs", GOOD.replace("AllowedIPs = 10.77.0.0/24\n", ""), "AllowedIPs"),
    ("неизвестная секция", GOOD.replace("[Peer]", "[Server]"), "секция"),
    ("строка до всякой секции", "PrivateKey = x\n" + GOOD, "до всякой секции"),
    ("мусор вместо конфигурации", "просто текст", "не разбирается"),
]

# Ключи, которые ПРИНИМАЮТСЯ, но поведения за ними на роутере нет: файл годен, а сказать о них
# надо. Отдельный список, потому что проверяется другое утверждение — не «отказ с называнием
# ключа», а «принято И предупреждение содержит вот это слово».
#
# ЗАЧЕМ ВООБЩЕ ПРИНИМАТЬ. Конфигурация носится между роутером и десктопом, а десктопный клиент
# DNS применяет. Файл, принятый одной стороной и отвергнутый другой, означает, что «настроено»
# зависит от того, куда его положили; ровно поэтому движок этот ключ теперь принимает (см.
# src/ext/xsconf.c), и страница обязана вести себя так же.
WARN_CASES = [
    ("ключ DNS принят и назван", GOOD.replace("SNI = www.microsoft.com", "DNS = 1.1.1.1"), "DNS"),
    ("ключ DNS списком", GOOD.replace("SNI = www.microsoft.com", "DNS = 1.1.1.1, 8.8.8.8"), "DNS"),
]


# Устройство формы импорта — не косметика, а то, из-за чего страница однажды зависла насмерть.
# Настройки интерфейса в LuCI сами живут в модальном окне, а окно у LuCI РОВНО ОДНО: showModal,
# вызванный изнутри, не открывает второе, а заменяет содержимое первого через dom.content() —
# то есть уничтожает разметку формы интерфейса. После этого первое же обращение к полю
# (s.formvalue → getUIElement → findClassInstance) падает на undefined, обработчик кнопки
# завёрнут в ui.createHandlerFn и ждёт обещание, исключение его отклоняет — и значок ожидания с
# кнопки уже не снимается. Снаружи это выглядело как «применение висит вечно», и по коду это
# было не видно вовсе: и showModal, и formvalue сами по себе законны.
#
# Поэтому проверяется контракт, а не текст: страница не открывает модальных окон, поле импорта
# живёт в самой форме и не пишется в uci, а section_id берётся у LuCI, а не угадывается.
STRUCTURE = [
    ("модальных окон страница не открывает", r"ui\.showModal\s*\(", False),
    ("и не закрывает (значит и не открывала)", r"ui\.hideModal", False),
    ("поле импорта — на своей вкладке", r"s\.tab\('import'", True),
    ("поле импорта — текстовое поле формы", r"form\.TextValue,\s*'_paste'", True),
    ("поле импорта не пишется в uci", r"o\.write = function\(\) \{\};", True),
    ("и не читается из uci", r"o\.cfgvalue = function\(\) \{ return ''; \};", True),
    ("section_id берётся у LuCI", r"o\.onclick = function\(ev, section_id\)", True),
    ("родитель renderWidget берётся из прототипа, а не через super()",
     r"form\.TextValue\.prototype\.renderWidget", True),
]


def check_structure(src):
    """Проверки устройства страницы: то, что в quickjs без DOM не проверить."""
    bad = 0
    for name, pattern, want in STRUCTURE:
        found = re.search(pattern, src) is not None
        if found != want:
            print("ПРОВАЛ %-34s %s" % (name, "найдено, а не должно" if found else "не найдено"))
            bad += 1
    return bad


def load_parser():
    """Вырезать из страницы только разбор и подготовить его к запуску без браузера."""
    src = open(PAGE, encoding="utf-8").read()
    start = src.index("var REFUSED")
    end = src.index("network.registerPatternVirtual")
    # Заглушки того, что даёт LuCI: перевод строк и String.prototype.format.
    stub = (
        "var _ = function(s){ return s; };"
        "String.prototype.format = function(){"
        "  var a = arguments, i = 0;"
        "  return this.replace(/%[sd]/g, function(){ return a[i++]; });"
        "};"
    )
    runner = (
        "\nvar run = function(t){"
        "  var r = parseXsteerConfig(t);"
        "  return JSON.stringify(typeof r == 'string' ? {err: r} : r);"
        "};"
    )
    import quickjs

    ctx = quickjs.Context()
    ctx.eval(stub + src[start:end] + runner)
    return ctx.get("run")


def main():
    if not os.path.exists(PAGE):
        print("нет страницы протокола: %s" % PAGE)
        return 2
    try:
        run = load_parser()
    except ImportError:
        print("ПРОПУЩЕН: не установлен quickjs (pip install quickjs)")
        print("Стенд проверяет разбор конфигурации на странице протокола xsteer.")
        return 0

    fails = 0
    fails += check_structure(open(PAGE, encoding="utf-8").read())
    for name, text, want in CASES:
        out = json.loads(run(text))
        got_err = out.get("err")
        if want is None:
            if got_err:
                print("ПРОВАЛ %-34s принять, а отказ: %s" % (name, got_err))
                fails += 1
        else:
            if not got_err:
                print("ПРОВАЛ %-34s ждали отказ про «%s», а принято" % (name, want))
                fails += 1
            elif want.lower() not in got_err.lower():
                print("ПРОВАЛ %-34s отказ не про «%s»: %s" % (name, want, got_err))
                fails += 1

    # Принято, но с предупреждением: проверяется и то, что файл годен, и то, что о ключе
    # сказано. Пропустить второе значило бы вернуться к молчаливому проглатыванию, от которого
    # и уходили.
    for name, text, want in WARN_CASES:
        out = json.loads(run(text))
        if out.get("err"):
            print("ПРОВАЛ %-34s принять, а отказ: %s" % (name, out["err"]))
            fails += 1
            continue
        warns = " ".join(out.get("warnings") or [])
        if want.lower() not in warns.lower():
            print("ПРОВАЛ %-34s ждали предупреждение про «%s», а есть: %r"
                  % (name, want, warns))
            fails += 1

    # У конфигурации без таких ключей предупреждений быть не должно: предупреждение «на всякий
    # случай» перестают читать первым же.
    if json.loads(run(GOOD)).get("warnings"):
        print("ПРОВАЛ обычная конфигурация не должна ничего предупреждать")
        fails += 1

    # Отдельно: у принятой конфигурации разобранные значения должны быть ИМЕННО те. Проверка
    # «принято» без этого ничего не стоит — принять можно и с потерянными полями.
    d = json.loads(run(GOOD))
    expect = {
        "private_key": "8BT4UvilnYyF0j+Gt5uy/oMUqH9NYOg3TrKQ/NS59lw=",
        "addresses": ["10.77.0.2/24"],
        "sni": "www.microsoft.com",
        "mtu": "",
        "public_key": "pvlciAMuJnL06ZXI5X0LgBaeA5Zty5OsqNaE7ikzaUg=",
        "endpoint_host": "203.0.113.7",
        "endpoint_port": "4443",
        "allowed_ips": ["10.77.0.0/24"],
        "persistent_keepalive": "25",
    }
    for key, val in expect.items():
        if d.get(key) != val:
            print("ПРОВАЛ поле %-22s ждали %r, получено %r" % (key, val, d.get(key)))
            fails += 1
    # MTU пустой означает «согласуй сам»: подставленное число запретило бы движку поднимать
    # предел, то есть тихо ухудшило бы туннель. Поэтому пустота здесь — требование.
    if d.get("mtu") != "":
        print("ПРОВАЛ MTU без строки в файле обязан остаться пустым")
        fails += 1

    print()
    if fails:
        print("ЕСТЬ ПРОВАЛЫ: %d" % fails)
        return 1
    print("все %d проверок прошли" % (len(CASES) + len(WARN_CASES) + len(expect) + len(STRUCTURE) + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
