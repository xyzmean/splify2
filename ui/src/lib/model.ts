// The shapes this UI edits and displays. They mirror steer's spec and status
// one-to-one on purpose: the dashboard is an editor for the engine's config, and
// every extra layer of its own vocabulary would be one more place for the two to
// drift apart. See steer/docs/contract-v1.md.

/** Where a channel's traffic goes.
 *
 *  `interface` is an existing device; `direct` claims the packet and leaves it on the
 *  normal path; `vless` is a VLESS/Reality client inside the engine that raises its own
 *  TUN — so as far as marks, tables and failover go it IS a device, and the only reason
 *  it is a separate kind is that the device has to be created and kept alive by a
 *  process. Needs the steer-extended package.
 *
 *  `zapret` — выход БЕЗ устройства и БЕЗ своей таблицы маршрутизации: трафик уходит обычным
 *  маршрутом, а по дороге его разбирает отдельный экземпляр nfqws со своей стратегией обхода
 *  DPI. Первый вид, у которого «нужна метка» и «есть устройство» разошлись, — и единственный,
 *  который заводится не здесь, а во вкладке Zapret: выход без стратегии не значит ничего, а
 *  стратегии живут там. */
export type OutputKind = 'interface' | 'direct' | 'vless' | 'zapret'

/** Что делать с трафиком выхода, когда ни одно устройство не отвечает.
 *
 *  drop по умолчанию: канал заводят ровно для того, чтобы трафик НЕ шёл напрямую, и
 *  молча вернуть его на открытый путь в момент поломки — это нарушить обещание
 *  выхода тогда, когда это опаснее всего, причём незаметно. */
export type OnFail = 'drop' | 'direct' | 'zapret'

export interface Output {
    name: string
    kind: OutputKind
    /** Активное устройство: то, через которое трафик идёт сейчас. Failover меняет
     *  его, не трогая ни настройку, ни каналы. */
    device?: string
    /** Кандидаты в порядке предпочтения — первое здоровое побеждает. Поэтому возврат
     *  наверх происходит сам, как только основной туннель оживает. */
    devices?: string[]
    on_fail?: OnFail
    /** kind=vless: файл подписки. Путь, а не ссылка — скачивание делает бэкенд, движок
     *  читает то, что ему положили. */
    sub_file?: string
    /** kind=vless: какой узел подписки использовать. −1 (или поле опущено) означает
     *  «первый рабочий», и тогда выбор делает проверка при подъёме, а не человек,
     *  угадывающий номер. Зашитый номер молча ломается при обновлении подписки. */
    node?: number
    /** kind=vless: НЕСКОЛЬКО узлов подписки, по предпочтению. Первый ответивший забирает
     *  трафик — то же понятие, что `devices` у выхода kind=interface.
     *
     *  ЛИБО `nodes`, ЛИБО `node`, НИКОГДА ОБА: спеку с двумя формами движок отвергает целиком,
     *  как `lan_device` вместе с `lan_devices` (контракт steer, T-015). `node: N` — сокращение
     *  для `nodes: [N]`, `node: -1` — для пустого списка.
     *
     *  Пустой список и отсутствие поля значат одно: «первый рабочий среди ВСЕХ пригодных». Это
     *  умолчание, и оставлять его умолчанием стоит: номер узла меняется при обновлении
     *  подписки. Не больше восьми номеров; повтор и отрицательный номер — отказ загрузки. */
    nodes?: number[]
    /** kind=interface: нести транспорт туннеля внутри поддельного TCP («WireGuard
     *  поверх TCP»). Нужно там, где UDP режут или пропускают по белому списку
     *  протоколов: маршрутизация при этом исправна, а туннель не поднимается вовсе.
     *  Не отдельный вид выхода — свойство существующего, потому что маршрутизация,
     *  метки и failover от этого не меняются. */
    obfs?: Obfs
    /** kind=zapret: файл с ключами nfqws. ПУТЬ, а не сама стратегия: спека печатается целиком
     *  в status, в diag и в резервную копию, а стратегия — это два десятка строк с путями к
     *  файлам-подделкам. Поле необязательно и обычно опущено: движок выводит путь из имени
     *  выхода, и два имени, которым позволено разойтись, пользы не приносят. */
    opts_file?: string
}

export interface Obfs {
    /** Сегодня единственный. Поле есть, чтобы второй режим не потребовал менять форму. */
    mode?: 'wg-over-tcp'
    /** Сервер обфускации: «адрес:порт». Адрес, а не имя — движок его не резолвит, потому
     *  что резолвить пришлось бы через DNS, который сам может идти в этот туннель. */
    server: string
    /** Локальные адрес и порт обфускатора. Обязаны совпадать с `Endpoint` пира в
     *  /etc/config/network: это единственное место, где две настройки знают друг о
     *  друге, и расхождение молчаливо — WireGuard шлёт в никуда. */
    listen: string
}

/** Узел подписки, как его видит движок. Индекс — среди ПРИГОДНЫХ узлов, и это же
 *  значение понимает поле `node` спеки: одно значение слова «номер узла» на весь
 *  проект, иначе человек выбрал бы пятый, а поднялся бы другой. */
export interface VlessNode {
    index: number
    name: string
    host: string
    port: number
    type: string
    security: string
    vision: boolean
    mode?: string
}

/** Почему часть узлов подписки не попала в список — сгруппированно по причине.
 *  Группирует движок, а не интерфейс: подписка целиком из tls-узлов дала бы 26
 *  одинаковых строк, и гонять их по ubus ради того, чтобы свернуть на экране, незачем.
 *  Текст причины принадлежит движку и здесь НЕ разбирается — как и строки журнала. */
export interface VlessSkip {
    reason: string
    count: number
    /** Имя первого узла с этой причиной (или host:port). Может быть пустым: у ссылки
     *  без '#' имени нет вовсе. */
    example: string
}

/** Результат проверки узла. Два времени, потому что они про разное: рукопожатие — цена
 *  подключения, платится один раз; ttfb — задержка, которая чувствуется на каждом
 *  запросе. Это время ответа через туннель, а не пинг: ICMP через TUN не ходит вовсе. */
export interface VlessProbe {
    index: number
    name: string
    type: string
    ok: boolean
    handshake_ms: number
    ttfb_ms: number
    why: string
}

/** Observed facts the engine reports per output. `nat`/`in_firewall` matter because
 *  an interface output silently swallows traffic without them — the route applies,
 *  the counter rises, and every site behind it hangs. */
export interface OutputStatus extends Output {
    up?: boolean
    /** kind=vless: выбранные локации, как их видит движок. ПРИЗНАК ПОКОЛЕНИЯ ДВИЖКА: поле
     *  печатается ВСЕГДА, в том числе пустым; движок постарше не печатает его вовсе.
     *
     *  Проверять поколение обязан интерфейс, и вот почему: незнакомый ключ спеки движок
     *  пропускает МОЛЧА. Список `nodes`, записанный в движок постарше, даст применённую спеку
     *  и трафик через узел, которого человек не выбирал, без единой жалобы; смешанный пул на
     *  таком движке дословно совпадает с законной старой спекой, и живая локация в нём будет
     *  объявлена мёртвой. Громкого отказа не будет ни в одном из двух случаев.
     *
     *  По номеру версии это НЕ проверяется: VERSION в дереве steer переписывает релизный
     *  workflow, и на сборке из ветки номер ни о чём не говорит. */
    nodes?: number[]
    mark?: string
    table?: number
    in_firewall?: boolean
    nat?: boolean
    /** Ход подъёма выхода kind=vless. Приходит ТОЛЬКО когда `up` ложно и только когда движку
     *  есть что сказать.
     *
     *  Устройство туннеля vless создаётся не сразу: при `node: -1` клиент перебирает узлы
     *  подписки с таймаутом восемь секунд на узел, и устройство появляется после выбора. Пока
     *  перебор идёт, `up` ложно — то же значение, что при настоящем отказе, и раньше интерфейс
     *  показывал «нет устройства» в обоих случаях (I-100).
     *
     *  Поля НЕТ — «не знаем»: движок старее интерфейса, состояние устарело или писавший
     *  процесс мёртв. Тогда прежний вид, а не догадка. */
    probe?: {
        /** `no_such_node` — выбранный НОМЕР узла за пределами подписки: узлы в ней есть, а
         *  такого номера нет. Отдельное состояние, а не разновидность `failed`, и различать
         *  их обязательно: лечение у них противоположное. У первого — «поправьте номер» (а
         *  лучше «первый рабочий»), у второго — «проверьте ссылку и поставщика».
         *
         *  Пока движок писал здесь `failed` с `total: 0`, интерфейс говорил «в подписке нет
         *  пригодных узлов» на подписке из двадцати девяти живых узлов, где стояло
         *  `node: 31`. Снято с живого роутера. */
        state: 'probing' | 'failed' | 'no_such_node'
        /** Номер узла: у `probing` — проверяемый (с единицы), у `no_such_node` — тот, что
         *  выбрал человек (как написан в спеке). */
        node?: number
        /** Сколько пригодных узлов нашлось. 0 у `failed` значит «в подписке их нет вовсе»;
         *  у `no_such_node` это настоящее число узлов подписки, и вместе с `node` оно и
         *  объясняет причину. */
        total?: number
    }
}

export const ON_FAIL_TEXT: Record<OnFail, string> = {
    drop: 'остановить трафик',
    direct: 'пустить напрямую',
    zapret: 'напрямую через zapret',
}

/** fake-IP is precise per domain; real-IP keeps traceroute hops legible and loses
 *  precision only where two domains share one address. Not cosmetic — see the
 *  contract. Prefix channels ignore it. */
export type DomainMode = 'fakeip' | 'realip'

export interface Channel {
    name: string
    /** Выключенное правило лежит в спеке, но в правила ядра не превращается — движок его
     *  пропускает. Поля нет — значит включено: спека, написанная до него, обязана значить то же.
     *
     *  Прежде интерфейс обходился без этого поля: вынимал канал из спеки и держал у себя. Работало,
     *  но канал становился невидим движку — ни status, ни explain о нём не знали, и «почему сайт не
     *  идёт» приходилось объяснять тем, чего в спеке нет. */
    enabled?: boolean
    /** Who: subnets or addresses. Empty means the spec's from_default. */
    from?: string[]
    /** Arrays, like the engine: several lists feeding one channel is the normal case,
     *  and the compiler merges channels that agree on output/clients/mode into ONE set
     *  and ONE rule — so a dozen enabled lists cost two rules per packet, not a dozen. */
    match: {
        prefixes_files?: string[]
        domains_files?: string[]
        mode?: DomainMode
        any?: boolean
    }
    /** Output name, not a device: the device is the output's business. */
    out: string
}

export interface Spec {
    schema: 1
    /** Подсети клиентов для каналов без `from`. Способ описать тех же клиентов АДРЕСОМ
     *  вместо устройства — и способ их ОГРАНИЧИТЬ: гостевая подсеть на том же мосту
     *  нарочно остаётся вне списка. Вместе с несколькими `lan_devices` движок такую спеку
     *  отвергает, и это не придирка: правило «кто» в nft одно, и взять оба сразу значило бы
     *  молча расширить давно написанное ограничение. */
    from_default?: string[]
    /** Устройства, с которых движок забирает трафик клиентов (splify2#16). Списком, потому
     *  что роутер бывает выходной точкой не только для своего моста: хостам из Tailscale и
     *  ZeroTier полагаются те же правила, что домашним.
     *
     *  Именем, а не подсетью: у `tailscale0` адрес на роутере обычно /32, то есть подсеть
     *  пиров из него не выводится вовсе, а у клиентов за вторым роутером в LAN адреса чужой
     *  подсети при том же интерфейсе. Поля нет — движок берёт `br-lan`. */
    lan_devices?: string[]
    /** Сокращённая запись `lan_devices` из одного элемента — та же пара, что `device` и
     *  `devices` у выхода. Интерфейс сводит её к множественной форме на входе (normalizeSpec):
     *  задать обе сразу движок не даёт, и потребителю ниже по течению не нужно знать, что
     *  форм две. */
    lan_device?: string
    traceroute_hops?: boolean
    outputs: Record<string, Output>
    /** ORDERED: first match wins, and the order is the priority. Reordering this
     *  array is a behaviour change, which is why the UI shows it as a ranked list
     *  rather than a set of independent toggles. */
    channels: Channel[]
}

/** Сеть клиентов: устройство роутера, через которое приходят те, кого маршрутизируем, и
 *  подсети, выведенные из его адресов (splify2#16).
 *
 *  Подсети считает бэкенд тем же правилом, каким их выводит движок из адреса `lan_device`.
 *  Считать их здесь ещё раз значило бы завести второе место, где живёт то же правило, и
 *  расхождение между экраном и маршрутизацией не показалось бы ни в одном сообщении.
 *
 *  Пустой `subnets` — устройство есть, адреса у него ещё нет. Это не то же самое, что
 *  отсутствие устройства: выбрать его законно, сеть появится вместе с адресом. */
export interface ClientNet {
    name: string
    up: boolean
    /** Внешний интерфейс по данным uci. Не спрятан, а помечен: выкинутое из перечня
     *  устройство человек ищет глазами и решает, что перечень сломан. */
    wan: boolean
    subnets?: string[]
}

export interface ChannelStatus {
    name: string
    out: string
    live: boolean
    /** Наружу: счётчик правила, ставящего метку. Имя без приставки — историческое, в этом
     *  значении оно разошлось по установленным версиям. */
    packets?: number
    bytes?: number
    /** Внутрь: встречная цепочка, считающая ответные пакеты. Отсутствует, когда движок
     *  старее этой цепочки — тогда показывать «0 скачано» было бы неправдой, и интерфейс
     *  не показывает ничего. */
    down_packets?: number
    down_bytes?: number
    /** Имена правил, сведённых движком в ЭТОТ набор. Счётчик у них общий: правила,
     *  совпадающие по выходу, виду списка и клиентам, компилируются в одно правило ядра, и
     *  разделить их трафик нечем. Без этого поля экран, показывающий трафик ПО ПРАВИЛАМ, не
     *  находил бы счётчик у правила, чьё имя досталось не набору, — и печатал бы прочерк там,
     *  где трафик есть. Поля нет — движок старее перечня участников. */
    channels?: string[]
    /** Сколько списков питает набор и каких они видов. Приходит от движка вместе с набором. */
    lists?: number
    kind?: 'domains' | 'prefixes'
}

export interface Status {
    schema: 1
    /** Что движок УМЕЕТ — перечнем имён (контракт steer, §status). Появилось в steer 1.3.0;
     *  поля нет вовсе — движок старше, и тогда поколение приходится выводить по косвенным
     *  признакам (наличие `lan_devices`, поле `nodes` у выхода kind=vless).
     *
     *  Спрашивать надо ИМЕНЕМ УМЕНИЯ, а не номером версии: версию в дерево движка проставляет
     *  релизный workflow, а не коммит, поэтому сборка из main через два коммита после релиза
     *  называет то же число, что и релиз. Незнакомые имена терпим и не требуем ни одного
     *  конкретного: набор может и расти, и сокращаться. */
    features?: string[]
    /** Устройства, с которых движок ЗАБИРАЕТ трафик сейчас — списком и всегда, какой бы
     *  формой они ни были записаны в спеке. Поля нет вовсе — движок старее перечня
     *  устройств (splify2#16), и выбор человека до него не доедет: незнакомый ключ спеки
     *  разбор пропускает молча. Сказать об этом важнее, чем показать: молчание здесь
     *  выглядит как «отметил интерфейс и ничего не изменилось». */
    lan_devices?: string[]
    outputs: Record<string, OutputStatus>
    channels: ChannelStatus[]
    warnings?: { code: string; text: string; channel?: string }[]
    /** Когда движок собрал этот ответ, unix-время. Появилось вместе со снимком состояния
     *  (умение `status_cache`); поля нет вовсе — движок старее, и тогда возраст ответа
     *  неизвестен, а не нулевой. */
    at?: number
    /** Ответ ЗАПОМНЕННЫЙ, а не измеренный: движок отдал свой последний полный ответ, не
     *  пересчитывая (`steer status --fast`). Поля нет вовсе — ответ живой.
     *
     *  Нужно ровно затем, чтобы не рисовать память живой. Открытие окна иначе показывало бы
     *  «Работает» по данным пятиминутной давности — на туннеле, который к этому моменту уже
     *  упал. Тот же довод, по которому у самого интерфейса есть `stale` для снимка из
     *  памяти браузера: ступень ниже честна по тем же правилам. */
    cached?: true
}

/** A list a channel can point at. The two kinds are not interchangeable: an IP list
 *  fills its set from the file, a domain list is filled by the resolver at query
 *  time. One manifest carries both so the picker can offer either. */
export type ListKind = 'prefixes' | 'domains'

export interface ListEntry {
    id: string
    kind: ListKind
    /** Russian display name from the manifest. */
    name: string
    description?: string
    /** Prefixes or domains, as counted by whoever published the manifest. */
    count?: number
    /** Sensible default per the publisher — not a promise this router can hold it. */
    default_on?: boolean
    file: string
    /** Where the list came from, so the UI can say why two lists disagree. */
    source?: string
    /** Address categories covering the same target. Shown as a warning, not hidden:
     *  the choice between forms is real (domains are more precise, addresses cheaper),
     *  but enabling both is never what someone means. */
    same_as_ip?: string[]
}

/** Признак источника доменного списка. Форма одна на оба случая, а имя ключа в манифесте
 *  разное: `upstream` — список зеркалится из чужого репозитория и перезаписывается целиком,
 *  `maintained_here` — список ведёт сам издатель, и домен предлагают ему.
 *
 *  Поле необязательное: манифест на уже установленных роутерах его не несёт, и его
 *  отсутствие значит «не знаем», а не «список наш». */
export interface ListOrigin {
    /** `owner/repo`, где список ведётся, — то, что показывается человеку. */
    repo?: string
    folder?: string
    file?: string
    url?: string
    /** Куда предлагать домен. Единственная ссылка, по которой человеку есть что сделать. */
    suggest_url?: string
    /** Переживёт ли обновление дописанное в этот список. У зеркала false: файл
     *  перезаписывается целиком, и правка исчезнет при следующей синхронизации. */
    editable_locally?: boolean
}

/** Exactly what the publisher ships. Address categories and domain lists live under
 *  separate keys because they have different shapes and different purposes — and
 *  keeping them separate means an older consumer does not break on the new one. */
export interface RawManifest {
    version: string
    base_url: string
    categories?: {
        id: string
        name_ru: string
        description_ru?: string
        file: string
        count?: number
        default_on?: boolean
        is_geoblock?: boolean
        /** Категории, чей файл адресов совпадает с этим ПОБАЙТОВО (общая автономная
         *  система: meta = whatsapp, google = youtube). Издатель не склеивает файлы —
         *  на их имена ссылаются уже настроенные роутеры, — а говорит правду полем. */
        same_prefixes_as?: string[]
        /** Причина совпадения человеческим языком, как её написал издатель. Интерфейс её
         *  показывает и НЕ разбирает: своей формулировки у него быть не должно. */
        same_prefixes_reason_ru?: string
    }[]
    domain_lists?: {
        id: string
        kind: 'domains'
        name_ru: string
        file: string
        count?: number
        default_on?: boolean
        source?: string
        /** Address categories built from the SAME source file — the same target in
         *  another form. Enabling both is the likeliest misconfiguration there is:
         *  double the memory, and two channels arguing over one destination. */
        same_as_ip?: string[]
        overlaps?: { with: string; domains: number; percent: number }[]
        upstream?: ListOrigin
        /** Список ведёт сам издатель: `editable_locally: true`, ссылки в его репозиторий.
         *  Признак у списка ровно один — он либо зеркалится, либо ведётся там. */
        maintained_here?: ListOrigin
        /** Зеркальные списки, которые дополняет этот (стоит у СВОЕГО списка), и свои
         *  списки, дополняющие этот (стоит у ЗЕРКАЛЬНОГО). Издатель называет связь с обеих
         *  сторон — интерфейс её только читает, а не выводит по именам файлов. */
        complements?: string[]
        complemented_by?: string[]
        /** Место в каталоге: id записи, СРАЗУ ЗА которой встаёт этот список. Издатель
         *  ставит его тем спискам, которые ищут наравне с сервисами: доменный GitHub
         *  человеку нужен рядом с Telegram, а не в хвосте за двумя десятками CDN, куда
         *  его отправляет порядок манифеста (сначала адресные категории, потом доменные). */
        after?: string
    }[]
}

export interface Manifest {
    version: string
    base_url: string
    lists: ListEntry[]
}

/** Одна запись каталога — ОДИН СЕРВИС, а не один вид списка.
 *
 *  Издатель шлёт два ключа: `categories` (адреса) и `domain_lists` (домены). Раньше интерфейс
 *  просто складывал их в один список, и человек выбирал «YouTube адресами» либо «YouTube
 *  доменами» — то есть выбирал ВИД СПИСКА, хотя думал про сервис. Оба про одно и то же, и
 *  включать их приходилось двумя правилами.
 *
 *  Теперь записи, описывающие один сервис, показываются одной строкой. Связь берётся из
 *  `same_as_ip` — издатель сам говорит, какая адресная категория собрана из того же источника.
 *  Связь бывает не только парная: два доменных списка Google смотрят в одну категорию, а
 *  доменный список Meta — сразу в две (Meta и WhatsApp). Поэтому объединяем СВЯЗНЫМИ ГРУППАМИ,
 *  а не парами: иначе часть записей осталась бы разделённой по виду именно там, где сервис один.
 *
 *  Где есть только адреса — остаются только адреса, где только домены — только домены. Ничего
 *  не выдумывается: движок принимает правило с обоими видами сразу, но лишь если они есть. */
export interface ServiceEntry {
    /** Устойчив между запусками: собран из id участников по порядку. */
    id: string
    name: string
    description?: string
    /** Пути у издателя, отдельно по видам: движку их надо класть в разные поля правила. */
    prefixes: string[]
    domains: string[]
    /** Сколько записей обещает издатель — суммой по участникам. */
    count: number
    /** Составные части, чтобы каталог мог сказать, из чего сервис собран. */
    parts: { id: string; kind: ListKind; name: string; file: string; count?: number }[]
    /** Адресный список этой записи совпадает с чужим — так говорит издатель.
     *
     *  `names` — человеческие названия категорий-двойников, `reason` — причина издателя.
     *  `within` различает два разных сообщения: false — двойник лежит в ДРУГОЙ записи
     *  каталога (google и youtube: человек видит две строки и думает, что одна узкая),
     *  true — двойники оказались частями этой же записи (meta и whatsapp: их связал один
     *  доменный список, и второй адресный файл в правиле не добавляет ни одного адреса).
     *  Двойники вне записи важнее, поэтому при обоих видах сразу называются они. */
    same_prefixes?: { names: string[]; reason?: string; within: boolean }
    /** Доменная часть записи — зеркало чужого репозитория, дописать домен на нашей стороне
     *  нельзя. Берётся у первой доменной части с таким признаком: у издателя все они
     *  приходят из одного репозитория, а разойдись это — правдой останется адрес репозитория,
     *  а не наша догадка о нём. */
    upstream?: ListOrigin
    /** Доменная часть записи — список самого издателя: недостающий домен есть куда
     *  предложить, и предложенное переживёт обновление. Обратная сторона `upstream`,
     *  берётся так же — у первой доменной части, объявившей признак. */
    maintained?: ListOrigin
    /** Связь «зеркало + дополняющий его свой список», как её назвал издатель.
     *
     *  `names` — человеческие названия записей на другом конце связи, `ours` различает
     *  два разных сообщения: true — ЭТА запись и есть дополнение (она названа в
     *  `complements`), false — эту запись дополняет чужая строка каталога. Смысл в обоих
     *  случаях один: включать надо обе, потому что дополнение не заменяет зеркало. */
    complement?: { names: string[]; ours: boolean }
}

export interface Catalog {
    version: string
    base_url: string
    services: ServiceEntry[]
}

export function toCatalog(m: RawManifest): Catalog {
    const cats = m.categories || []
    const doms = m.domain_lists || []

    /* Система непересекающихся множеств по ключам «c:<id>» и «d:<id>». Проще графа: нам нужны
     * только связные группы, а не пути в них. */
    const parent = new Map<string, string>()
    const find = (x: string): string => {
        const p = parent.get(x)
        if (!p || p === x) { parent.set(x, x); return x }
        const r = find(p)
        parent.set(x, r)
        return r
    }
    const union = (a: string, b: string) => { parent.set(find(a), find(b)) }

    for (const c of cats) find('c:' + c.id)
    for (const d of doms) {
        find('d:' + d.id)
        for (const cid of d.same_as_ip || [])
            if (cats.some((c) => c.id === cid)) union('d:' + d.id, 'c:' + cid)
    }

    const groups = new Map<string, ServiceEntry>()
    const put = (key: string, part: ServiceEntry['parts'][0], file: string) => {
        const root = find(key)
        let g = groups.get(root)
        if (!g) {
            g = { id: root, name: '', prefixes: [], domains: [], count: 0, parts: [] }
            groups.set(root, g)
        }
        g.parts.push(part)
        if (part.kind === 'domains') g.domains.push(file)
        else g.prefixes.push(file)
        g.count += part.count || 0
    }

    for (const c of cats)
        put('c:' + c.id, { id: c.id, kind: 'prefixes', name: c.name_ru, file: c.file, count: c.count }, c.file)
    for (const d of doms)
        put('d:' + d.id, { id: d.id, kind: 'domains', name: d.name_ru, file: d.file, count: d.count }, d.file)

    const catName = new Map(cats.map((c) => [c.id, c.name_ru]))
    const domName = new Map(doms.map((d) => [d.id, d.name_ru]))

    /** Двойники по адресам — то, что заявил издатель, ничего не вычисляя.
     *
     *  Считать совпадение самим здесь нечем: интерфейс видит только `count`, а равные
     *  счётчики — не равные файлы. Поэтому источник один: `same_prefixes_as` издателя,
     *  и неизвестная категория в нём молча пропускается. */
    const twinsOf = (g: ServiceEntry) => {
        const mine = new Set(g.parts.filter((p) => p.kind === 'prefixes').map((p) => p.id))
        const twins = new Map<string, string | undefined>()
        for (const id of mine) {
            const c = cats.find((x) => x.id === id)
            for (const other of c?.same_prefixes_as || [])
                if (catName.has(other) && other !== id) twins.set(other, c?.same_prefixes_reason_ru)
        }
        const outside = [...twins.keys()].filter((id) => !mine.has(id))
        const picked = outside.length ? outside : [...twins.keys()]
        if (!picked.length) return undefined
        return {
            names: picked.map((id) => catName.get(id) as string),
            reason: twins.get(picked[0]),
            within: outside.length === 0,
        }
    }

    /** Признак источника доменных частей записи — тот, что назвал издатель, и ничего сверх.
     *
     *  `mine` выбирает, о чём спрашиваем: о своём списке издателя (`maintained_here`) или
     *  о зеркале (`upstream`). `editable_locally` здесь не украшение, а сама суть признака,
     *  поэтому запись, спорящая со своим же ключом (зеркало с `true`, свой список с
     *  `false`), пропускается молча — врать про судьбу дописанного домена хуже, чем
     *  промолчать. Берётся у ПЕРВОЙ подходящей части: у издателя все они приходят из
     *  одного репозитория, а разойдись это — правдой останется адрес репозитория, а не
     *  наша догадка о нём. */
    const originOf = (g: ServiceEntry, mine: boolean) => {
        const part = doms.find((d) => {
            const o = mine ? d.maintained_here : d.upstream
            if (!o) return false
            if (mine ? o.editable_locally === false : o.editable_locally === true) return false
            return g.parts.some((p) => p.kind === 'domains' && p.id === d.id)
        })
        return mine ? part?.maintained_here : part?.upstream
    }

    /** Свой список издателя и зеркало, которое он дополняет: `complements` у своего,
     *  `complemented_by` у зеркального.
     *
     *  Связь названа с обеих сторон, поэтому и читается с обеих: без пометки на СТРОКЕ
     *  ЗЕРКАЛА человек включает только его и снова не получает домена, которого там нет
     *  (splify2#7) — дополнение лежит отдельной строкой каталога, и догадаться о нём
     *  неоткуда. Записи, которых в этом манифесте нет, и части этой же записи
     *  пропускаются: связывать строку с самой собой нечем. */
    const complementOf = (g: ServiceEntry) => {
        const mine = new Set(g.parts.filter((p) => p.kind === 'domains').map((p) => p.id))
        for (const key of ['complements', 'complemented_by'] as const) {
            const ids = new Set(
                [...mine]
                    .flatMap((id) => doms.find((d) => d.id === id)?.[key] || [])
                    .filter((other) => domName.has(other) && !mine.has(other)),
            )
            if (ids.size)
                return {
                    names: [...ids].map((id) => domName.get(id) as string),
                    ours: key === 'complements',
                }
        }
        return undefined
    }

    /* Место записи в каталоге. По умолчанию — порядок издателя: сначала адресные
     * категории в порядке манифеста, потом доменные списки. Издатель может назвать соседа
     * (`after`), и тогда список встаёт сразу за ним — половинкой шага, чтобы не спорить с
     * тем, кто уже занимает следующее место. */
    const posOf = new Map<string, number>()
    cats.forEach((c, i) => posOf.set('c:' + c.id, i))
    doms.forEach((d, i) => posOf.set('d:' + d.id, cats.length + i))
    for (const d of doms) {
        if (!d.after) continue
        const anchor = posOf.get('c:' + d.after) ?? posOf.get('d:' + d.after)
        if (anchor !== undefined) posOf.set('d:' + d.id, anchor + 0.5)
    }
    /* Группа встаёт по САМОЙ ранней своей части: сервис, у которого адреса стоят вторыми,
     * а домены в хвосте, человек ищет там, где стоят адреса. */
    const posOfGroup = (g: ServiceEntry) =>
        Math.min(
            ...g.parts.map(
                (p) =>
                    posOf.get((p.kind === 'domains' ? 'd:' : 'c:') + p.id) ??
                    Number.MAX_SAFE_INTEGER,
            ),
        )

    const services = [...groups.values()]
        .sort((a, b) => posOfGroup(a) - posOfGroup(b))
        .map((g) => {
            /* Имя обычно берём у АДРЕСНЫХ частей: у издателя они названы полнее — «Google
             * (Meet/Play/AI)» против «Google Play».
             *
             * Но когда адресных категорий несколько, а доменный список один, имя берём у него:
             * именно он их и связал. Иначе выходило «WhatsApp · Meta (Facebook/Instagram)» —
             * перечисление вместо названия сервиса, причём в порядке, который человеку ни о чём не
             * говорит. */
            const ipNames = [...new Set(g.parts.filter((p) => p.kind === 'prefixes').map((p) => p.name))]
            const domNames = [...new Set(g.parts.filter((p) => p.kind === 'domains').map((p) => p.name))]
            const names = !ipNames.length
                ? domNames
                : ipNames.length > 1 && domNames.length === 1
                  ? domNames
                  : ipNames
            return {
                ...g,
                id: g.parts.map((p) => p.id).sort().join('+'),
                name: [...new Set(names)].join(' · '),
                description: cats.find((c) => c.id === g.parts[0].id)?.description_ru,
                same_prefixes: twinsOf(g),
                upstream: originOf(g, false),
                maintained: originOf(g, true),
                complement: complementOf(g),
            }
        })
    /* Порядок как у издателя: он ставит вперёд то, что включают чаще, а алфавит перемешал бы
     * это с инфраструктурой. Своё место записи получают выше, в posOf. */
    return { version: m.version, base_url: m.base_url, services }
}

/** What a fresh install starts from: nothing routed anywhere. An empty channel list
 *  is a valid spec, and it beats guessing which lists someone wants. */
export const EMPTY_SPEC: Spec = {
    schema: 1,
    outputs: {},
    channels: [],
}

/** Оба написания списочных полей `match` — как их публикует контракт v1
 *  (steer/docs/contract-v1.md:43-44): единственная форма есть сокращение для списка из
 *  одного элемента, и движок реализует обе (spec.c:271-281). */
const FILE_FORMS = [
    ['prefixes_file', 'prefixes_files'],
    ['domains_file', 'domains_files'],
] as const

/** Привести `match` каждого канала к множественной форме — один раз, на входе.
 *
 *  Зачем. Интерфейс читал только множественную форму во ВСЕХ четырёх местах, где смотрит
 *  на `match` (selectedIds, pick, RulesTab, CatalogTab), поэтому правило, написанное по
 *  документированной короткой форме, было для него правилом без списков. Хуже того, оно
 *  таким не оставалось: спред `{...ch.match}` в `pick()` уносил короткий ключ обратно в
 *  файл рядом с длинным, и дальше маршрут списка решался порядком ключей в документе
 *  (I-041).
 *
 *  Почему здесь, а не в каждом потребителе: потребителей четыре, и пятый забыли бы. Цена
 *  выбрана осознанно и владельцем (splicicd#7, вариант «б») — ниже по течению единственной
 *  формы больше нет, а значит контрольная плоскость переписывает написание в файле
 *  владельца при первом же сохранении. Обратная сторона того же свойства: спека после
 *  round-trip несёт ОДНО написание вместо двух, то есть перестаёт зависеть от порядка
 *  ключей.
 *
 *  Кто побеждает при обоих написаниях сразу — решается так же, как у движка: разбор
 *  последовательный, поэтому берёт верх ключ, стоящий в документе ПОЗЖЕ. Правило
 *  «множественная форма всегда сильнее» разошлось бы с движком ровно на тех спеках, где
 *  этот вопрос вообще возникает. */
export function normalizeSpec(spec: Spec): Spec {
    if (!spec || !Array.isArray(spec.channels)) return spec
    return foldLanForms({ ...spec, channels: spec.channels.map(foldFileForms) })
}

/** `lan_device` -> `lan_devices`, по тому же доводу, что и у путей списков выше: форм записи
 *  две (движок реализует обе как `device`/`devices` у выхода), а потребителей у поля будет
 *  больше одного — и пятый забыл бы про короткую.
 *
 *  Полная форма побеждает короткую, а не складывается с ней. Движок спеку с обоими полями
 *  отвергает, но прочитать её интерфейс обязан: она могла приехать архивом настроек с чужого
 *  роутера, и показать в этом случае пустоту значило бы спрятать причину будущего отказа.
 *
 *  Поля нет вовсе — так и остаётся: молчание означает «умолчание движка», и подставлять сюда
 *  `br-lan` значило бы записать в файл человека решение, которого он не принимал. */
function foldLanForms(spec: Spec): Spec {
    if (!('lan_device' in spec)) return spec
    const { lan_device, ...rest } = spec
    if (rest.lan_devices?.length) return rest as Spec
    return typeof lan_device === 'string' && lan_device
        ? ({ ...rest, lan_devices: [lan_device] } as Spec)
        : (rest as Spec)
}

function foldFileForms(ch: Channel): Channel {
    const raw = ch?.match as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') return ch
    const keys = Object.keys(raw)
    if (!FILE_FORMS.some(([one]) => keys.includes(one))) return ch
    const match: Record<string, unknown> = { ...raw }
    for (const [one, many] of FILE_FORMS) {
        if (!(one in match)) continue
        const single = match[one]
        delete match[one]
        /* Не строка — не путь: движок такое значение тоже не примет, js_str откажет
         * (spec.c:58) и поле останется незаполненным. */
        if (typeof single !== 'string') continue
        if (keys.lastIndexOf(one) > keys.lastIndexOf(many)) match[many] = [single]
    }
    return { ...ch, match: match as Channel['match'] }
}

/** Свои списки как записи каталога.
 *
 *  Зачем это здесь, а рядом с toCatalog. Каталог рисуется из манифеста издателя, поэтому
 *  свой .lst, лежащий на роутере, был виден local_lists — и не предлагался ни одному
 *  правилу: редактор выбирает из ServiceEntry[], а собственного файла среди них нет.
 *  Дешевле всего оказалось не менять редактор, а дать ему записи того же вида.
 *
 *  Вид списка читается из ПУТИ, как и у издателя: `custom/domains/x.lst` — доменный,
 *  `custom/x.lst` — адресный. По имени файла их не различить, а класть их надо в разные
 *  поля правила.
 *
 *  Префикс `custom:` в id — чтобы свой список с именем издательской категории не выдавал
 *  себя за неё в selectedIds. */
export function customServices(
    local: Record<string, { count: number; mtime: number }>,
): ServiceEntry[] {
    const out: ServiceEntry[] = []
    for (const [file, info] of Object.entries(local)) {
        if (!file.startsWith('custom/')) continue
        const domains = file.startsWith('custom/domains/')
        const name = file.replace(/^custom\/(domains\/)?/, '').replace(/\.lst$/, '')
        if (!name) continue
        out.push({
            id: `custom:${domains ? 'domains' : 'prefixes'}:${name}`,
            name,
            description: domains ? 'свой список доменов' : 'свой список подсетей',
            prefixes: domains ? [] : [file],
            domains: domains ? [file] : [],
            count: info.count,
            parts: [{ id: name, kind: domains ? 'domains' : 'prefixes', name, file, count: info.count }],
        })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
