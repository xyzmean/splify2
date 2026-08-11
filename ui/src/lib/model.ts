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
 *  process. Needs the steer-extended package. */
export type OutputKind = 'interface' | 'direct' | 'vless'

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
    mark?: string
    table?: number
    in_firewall?: boolean
    nat?: boolean
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
    from_default?: string[]
    lan_device?: string
    traceroute_hops?: boolean
    outputs: Record<string, Output>
    /** ORDERED: first match wins, and the order is the priority. Reordering this
     *  array is a behaviour change, which is why the UI shows it as a ranked list
     *  rather than a set of independent toggles. */
    channels: Channel[]
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
}

export interface Status {
    schema: 1
    outputs: Record<string, OutputStatus>
    channels: ChannelStatus[]
    warnings?: { code: string; text: string; channel?: string }[]
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

    const services = [...groups.values()].map((g) => {
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
        }
    })
    /* Порядок как у издателя: сначала адресные категории, потом чисто доменные. Алфавит здесь
     * хуже — издатель ставит вперёд то, что включают чаще. */
    return { version: m.version, base_url: m.base_url, services }
}

/** What a fresh install starts from: nothing routed anywhere. An empty channel list
 *  is a valid spec, and it beats guessing which lists someone wants. */
export const EMPTY_SPEC: Spec = {
    schema: 1,
    outputs: {},
    channels: [],
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
