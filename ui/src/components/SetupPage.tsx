import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2, Wrench } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { t } from '@/lib/i18n'
import EngineCard from '@/components/EngineCard'
import { EMPTY_SPEC, type Channel, type Output, type RawManifest, type Spec, type Status, type VlessNode } from '@/lib/model'

// Простая настройка: один экран от «ничего не настроено» до работающего туннеля.
//
// Зачем отдельный экран, если есть вкладки каналов, выходов и списков. Те вкладки — точный
// редактор модели движка, и для того, кто её понимает, это правильно. Но чтобы получить
// работающий VPN, человеку сейчас надо выучить четыре понятия («выход», «канал», режим
// отказа, адресный список против доменного), пройти три вкладки в верном порядке и знать,
// что каналы проверяются сверху вниз, а побеждает первый. Для «хочу ютуб через VPN» это
// непроходимо.
//
// Здесь того же результата добиваются двумя решениями: куда подключаться и что через это
// пустить. Слов «канал» и «выход» на экране нет вовсе — они появляются в спеке, но их
// составляет код, а не человек.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, которое делает это безопасным: мастер трогает РОВНО свои записи и не
// касается ничего другого. Кто настроил что-то руками во вкладках, не потеряет это, открыв
// мастер, — иначе «простой режим» стал бы способом молча снести чужую работу.
//
// «Свои» он узнаёт по ПАМЯТИ (ui_get/ui_set), а не по зашитым именам. Прежде искались канал
// «сервисы» и выход «vpn», и на живом роутере это провалилось с первой попытки: там канал
// звался funny, выход vless, всё настроено руками. Мастер не увидел ничего, показал «ещё не
// настроено» и предложил создать рядом второй туннель — то есть тихо развёл одну настройку
// на две. Угадывать по именам нельзя: имена принадлежат человеку.

/** Сколько outbound'ов мастер разрешает.
 *
 *  Одного не хватило по живой причине: «пустить ютуб через Нидерланды, а телеграм через свой
 *  wireguard» — это не сложная настройка, а обычное желание, и упиралось оно в то, что мастер
 *  умел один выход. Три, а не сколько угодно: четвёртый уже требует объяснять порядок каналов,
 *  а это ровно то понятие, от которого мастер и избавляет. */
const MAX_DEST = 3

/** Имя выхода в спеке для нового outbound'а. Внутреннее и ASCII: из имени выхода движок
 *  выводит имена наборов nft (`vpn_dom`), а туда кириллица и пробелы не годятся. Человеку это
 *  имя не показывается — он видит своё, из `label`. */
function autoOut(i: number) { return i === 0 ? 'vpn' : `vpn${i + 1}` }
/** Имя по умолчанию, которое видит человек. Заменяется его собственным. */
function autoLabel(i: number) { return `Outbound ${i + 1}` }

const SUB_FILE = '/etc/steer/sub.txt'
const LISTS_DIR = '/etc/steer/lists'

/** Хостинги и CDN. Не сервисы, а инфраструктура под чужими сервисами.
 *
 *  Раньше они были просто СПРЯТАНЫ из мастера, и это оказалось неправильно: человек видел
 *  строчку «в расширенных настройках» и справедливо не понимал, почему ему нельзя. Нельзя
 *  было не потому, что сложно, а потому что дорого: `hodca` — это 250 доменов половины
 *  интернета, а Cloudflare стоит за миллионами сайтов, и включённые наугад они уводят в
 *  туннель куда больше, чем человек имел в виду.
 *
 *  Теперь они здесь же, отдельным разделом, закрытым одним нажатием и с ценой, названной
 *  вслух. Спрятать — значит не объяснить; показать с предупреждением — значит объяснить. */
const INFRA = new Set(['hodca', 'svc_cloudflare', 'svc_cloudfront', 'svc_digitalocean', 'svc_hetzner', 'svc_ovh'])

/** Путь ПОВТОРЯЕТ путь у издателя — то же правило, что в ChannelsPage и в бэкенде.
 *  Иначе адресный `hodca.lst` и доменный `domains/hodca.lst` становятся одним локальным
 *  файлом и затирают друг друга, а nft отвергает набор целиком. */
function pathFor(file: string) {
    return `${LISTS_DIR}/${file.replace(/^\/+/, '')}`
}

interface Item {
    id: string
    name: string
    file: string
    count?: number
}

/** Один outbound: куда именно ведёт трафик.
 *
 *  `out` — имя выхода в спеке, `label` — имя, которое дал человек. Два поля, а не одно, потому
 *  что из имени выхода движок делает имена наборов nft: «Ютуб через Польшу» там не пройдёт, а
 *  запрещать пробелы и кириллицу в том, что человек сам себе называет, — значит выдать ему
 *  ограничение движка за правило жизни.
 *
 *  `node` есть только у подписки и означает то же, что в спеке: −1 — «первый рабочий». Второй
 *  outbound на ту же подписку осмысленен ровно из-за него: один узел на ютуб, другой на
 *  телеграм — это одна подписка и два разных выхода. */
interface Dest {
    out: string
    label: string
    via: 'sub' | 'device'
    device?: string
    node?: number
}

/** Что мастер помнит о себе между заходами. Версия — чтобы будущее изменение формата не
 *  читалось как испорченные данные и не сносило настройку молча. */
interface Memo {
    v: 1
    dests: Dest[]
}

export default function SetupPage({ onExpert }: { onExpert: () => void }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [raw, setRaw] = useState<RawManifest | null>(null)
    const [status, setStatus] = useState<Status | null>(null)
    /** Движок целиком, а не только «умеет ли VLESS»: карточке установки нужны и версия,
     *  и архитектура, и сам факт наличия — три разных случая, которые нельзя путать. */
    const [engine, setEngine] = useState<{ present: boolean; vless: boolean; arch?: string; version?: string } | null>(null)
    const [sub, setSub] = useState<{ url?: string; kind?: string; present: boolean } | null>(null)
    const [url, setUrl] = useState('')
    /** Outbound'ы. Один по умолчанию — экран для того, у кого ещё ничего нет. */
    const [dests, setDests] = useState<Dest[]>([{ out: autoOut(0), label: autoLabel(0), via: 'sub', node: -1 }])
    /** Куда назначается нажатие на плитку. При одном outbound'е не показывается вовсе. */
    const [active, setActive] = useState(0)
    const [devices, setDevices] = useState<{ name: string; up: boolean }[] | null>(null)
    /** Файл списка -> номер outbound'а. Файл, а не идентификатор: в спеку идут пути, и
     *  хранить то же, что сохраняем, значит не иметь второго представления, которое может
     *  разойтись с первым. */
    const [picked, setPicked] = useState<Map<string, number>>(new Map())
    const [busy, setBusy] = useState('')
    const [node, setNode] = useState<{ name: string; ms: number } | null>(null)
    const [showInfra, setShowInfra] = useState(false)
    /** Узлы подписки для выбора вручную. Доступны только после первого применения: движок
     *  читает их по ИМЕНИ ВЫХОДА из спеки, а до применения выхода в спеке нет. */
    const [nodes, setNodes] = useState<VlessNode[] | null>(null)
    /** Выход, чьи узлы прочитаны. Нужен, чтобы не спрашивать движок про выход, которого в
     *  спеке ещё нет, — он честно ответит ошибкой, и в интерфейс поедет пустой список. */
    const [nodeSrc, setNodeSrc] = useState<string | null>(null)

    useEffect(() => {
        // Спека и память мастера читаются ВМЕСТЕ: без памяти мастер не знает, какие записи
        // в спеке его, а без спеки — что в них лежит. Порознь получалось «настроено с нуля»
        // при работающем туннеле.
        Promise.all([rpc.specGet().catch(() => EMPTY_SPEC), rpc.uiGet().catch(() => ({ state: '' }))])
            .then(([s, m]) => { setSpec(s); seed(s, m.state) })
            .catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then(setRaw).catch(() => setRaw(null))
        rpc.status().then(setStatus).catch(() => setStatus(null))
        rpc.engine().then(setEngine).catch(() => setEngine(null))
        rpc.subInfo().then((s) => { setSub(s); setUrl(s.url || '') }).catch(() => setSub(null))
    }, [])

    /** Устройства, годные как «свой туннель».
     *
     *  Отсюда убираются туннели, которые поднял САМ движок по выходам вида vless: устройство
     *  существует, его видно в системе, но указать на него как на «свой туннель» — это выход,
     *  ведущий в другой выход того же движка. На роутере это выглядело особенно глупо: в списке
     *  было ровно одно устройство, и это был туннель steer, поднятый строкой ниже. */
    useEffect(() => {
        if (!spec) return
        const own = new Set<string>()
        for (const [name, o] of Object.entries(spec.outputs || {})) {
            if (o.kind !== 'vless') continue
            own.add(name)                                  // движок называет устройство по выходу
            if (o.device) own.add(o.device)
        }
        rpc.devices()
            .then((r) => setDevices((r.devices || []).filter((d) => !own.has(d.name))))
            .catch(() => setDevices([]))
    }, [spec])

    /** Узлы подписки — по первому выходу на подписке, который уже есть в спеке. */
    useEffect(() => {
        if (!spec) return
        const src = dests.find((d) => d.via === 'sub' && spec.outputs?.[d.out]?.kind === 'vless')?.out
        if (!src || src === nodeSrc) return
        setNodeSrc(src)
        rpc.vlessNodes(src).then((r) => setNodes(r.nodes || null)).catch(() => setNodes(null))
    }, [spec, dests, nodeSrc])

    /** Прочитать из спеки то, что мастер сам туда и положил.
     *
     *  Свои записи узнаются по ПАМЯТИ, а не по именам. Прежде мастер искал канал «сервисы» и
     *  выход «vpn», и на живом роутере не нашёл ничего: там канал звался funny, выход vless, всё
     *  настроено руками. Он показал «ещё не настроено» и предложил создать рядом второй туннель —
     *  то есть тихо развёл одну настройку на две. Память об этом не даёт соврать.
     *
     *  Первый заход после обновления памяти не имеет. Тогда — и только тогда — пробуем прежние
     *  зашитые имена: иначе настройка, сделанная предыдущей версией мастера, потерялась бы. */
    function seed(s: Spec, memo?: string) {
        let dd: Dest[] = []
        try {
            const m = memo ? (JSON.parse(memo) as Memo) : null
            if (m?.v === 1 && Array.isArray(m.dests)) dd = m.dests.filter((d) => d && d.out)
        } catch { /* испорченная память — то же, что её отсутствие */ }

        if (!dd.length) {
            for (let i = 0; i < MAX_DEST; i++) {
                const legacyCh = i === 0 ? 'сервисы' : `сервисы ${i + 1}`
                const ch = s.channels.find((c) => c.name === legacyCh)
                const out = ch?.out || autoOut(i)
                const o = s.outputs?.[out]
                if (!ch || !o) continue
                dd.push(o.kind === 'interface'
                    ? { out, label: autoLabel(i), via: 'device', device: o.device || o.devices?.[0] || '' }
                    : { out, label: autoLabel(i), via: 'sub', node: o.node ?? -1 })
            }
        }

        // Выходы, исчезнувшие из спеки (удалили во вкладках), из памяти выбрасываем: держать
        // outbound, за которым ничего нет, значит предлагать применить настройку в пустоту.
        dd = dd.filter((d) => s.outputs?.[d.out])
        // Достраиваем то, чего в старой памяти могло не быть.
        dd = dd.map((d, i) => ({ ...d, label: d.label || autoLabel(i), via: d.via || 'sub' }))
        if (dd.length) setDests(dd)

        const map = new Map<string, number>()
        const byOut = new Map(dd.map((d, i) => [d.out, i]))
        for (const ch of s.channels) {
            const i = byOut.get(ch.out)
            if (i === undefined) continue
            // Только доменные каналы: адресный канал на том же выходе — чужая работа (её и
            // нашли на роутере), и мастер её не присваивает и не перезаписывает.
            if (ch.match.prefixes_files?.length) continue
            for (const f of ch.match.domains_files || []) map.set(f, i)
        }
        setPicked(map)
    }

    const all: Item[] = useMemo(
        () => (raw?.domain_lists || []).map((d) => ({ id: d.id, name: d.name_ru, file: d.file, count: d.count })),
        [raw],
    )
    /** Узнаваемые сервисы: их человек ищет по имени и понимает без объяснений. */
    const services = useMemo(() => all.filter((i) => i.id.startsWith('svc_') && !INFRA.has(i.id)), [all])
    /** Широкие категории. Отдельно и с числом доменов, потому что «Не пускают из РФ» — это
     *  465 доменов, а YouTube — 18: разница в порядке, и она должна быть видна до включения. */
    const categories = useMemo(() => all.filter((i) => !i.id.startsWith('svc_') && !INFRA.has(i.id)), [all])
    const infra = useMemo(() => all.filter((i) => INFRA.has(i.id)), [all])

    /** Мои каналы — те, что ведут в мои выходы И собраны из доменов. Адресный канал на том же
     *  выходе остаётся чужим: именно такой и нашёлся на живом роутере, настроенный руками. */
    const myOuts = useMemo(() => new Set(dests.map((d) => d.out)), [dests])
    const isMine = (c: Channel) => myOuts.has(c.out) && !c.match.prefixes_files?.length
    /** Каналы, которых мастер не касается. Показываются строкой: человек должен знать, что
     *  здесь не вся настройка, — иначе «Применить» выглядит так, будто он задаёт её целиком. */
    const foreign = (spec?.channels || []).filter((c) => !isMine(c))

    const on = dests.some((d) => status?.outputs?.[d.out]?.up === true)
    const configured = (spec?.channels || []).some(isMine)
    const needSub = dests.some((d) => d.via === 'sub')

    /** Как называется outbound на экране: имя, которое дал человек. Если он его не давал —
     *  подсказка по существу: имя узла, имя устройства. Имя выхода в спеке («vpn2») здесь не
     *  показывается никогда: это внутреннее понятие движка, и вернуть его на экран значило бы
     *  вернуть ровно то слово, от которого мастер избавляет. */
    function destLabel(d: Dest, i: number) {
        if (d.label && d.label !== autoLabel(i)) return d.label
        if (d.via === 'device') return d.device || t('туннель не выбран')
        const byNode = d.node !== undefined && d.node >= 0 ? nodes?.find((n) => n.index === d.node) : null
        return byNode ? byNode.name : d.label || autoLabel(i)
    }

    function setDest(i: number, patch: Partial<Dest>) {
        setDests(dests.map((d, k) => (k === i ? { ...d, ...patch } : d)))
    }

    function addDest() {
        if (dests.length >= MAX_DEST) return
        // Имя выхода — первое свободное из vpn, vpn2, vpn3: занятое чужой настройкой брать
        // нельзя, иначе мастер перезапишет её при применении.
        const taken = new Set([...Object.keys(spec?.outputs || {}), ...dests.map((d) => d.out)])
        let out = ''
        for (let k = 0; k < MAX_DEST + 3 && !out; k++) if (!taken.has(autoOut(k))) out = autoOut(k)
        if (!out) { notify(t('Некуда добавить: имена выходов заняты'), 'warning'); return }
        // По умолчанию — устройство, если есть свободное: два outbound'а на одну подписку
        // различаются только узлом, и это тонкость, а не умолчание.
        const free = (devices || []).find((x) => !dests.some((d) => d.device === x.name))
        const i = dests.length
        setDests([...dests, free
            ? { out, label: autoLabel(i), via: 'device', device: free.name }
            : { out, label: autoLabel(i), via: 'sub', node: -1 }])
        setActive(i)
    }

    function removeDest(i: number) {
        if (dests.length <= 1) return
        const remap = new Map<string, number>()
        for (const [f, d] of picked) {
            if (d === i) continue                       // назначенное сюда снимается
            remap.set(f, d > i ? d - 1 : d)
        }
        setPicked(remap)
        setDests(dests.filter((_, k) => k !== i))
        setActive((a) => (a >= dests.length - 1 ? Math.max(0, dests.length - 2) : a > i ? a - 1 : a))
    }

    function toggle(i: Item) {
        const p = pathFor(i.file)
        const next = new Map(picked)
        if (next.get(p) === active) next.delete(p)
        else next.set(p, active)
        setPicked(next)
    }

    async function check() {
        const src = dests.find((d) => d.via === 'sub' && spec?.outputs?.[d.out]?.kind === 'vless')?.out
        if (!src) { notify(t('Сначала примените настройку'), 'warning'); return }
        setBusy('check')
        try {
            const r = await rpc.vlessProbe(src, -1)
            if (r.error) throw new Error(r.error)
            const good = (r.results || []).find((x) => x.ok)
            if (!good) { notify(t('Ни один узел подписки не отвечает'), 'error'); setNode(null); return }
            setNode({ name: good.name, ms: good.ttfb_ms })
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    /** Подключить источник узлов: ссылку на подписку ЛИБО ссылки vless://.
     *
     *  Одно поле на оба случая, и различает их не человек, а схема в тексте. Так и правильно:
     *  «у меня подписка» и «у меня ссылка от знакомого» — это не два режима работы, а один и
     *  тот же вопрос «откуда узлы», просто ответ приходит в двух видах. Отдельный переключатель
     *  заставил бы выбирать до того, как человек понял, что выбирает. */
    async function connect() {
        const v = url.trim()
        if (!v) { notify(t('Вставьте ссылку на подписку или vless://'), 'warning'); return }
        if (!/^(https?:\/\/|vless:\/\/)/i.test(v)) {
            notify(t('Ссылка должна начинаться с https:// (подписка) или vless://'), 'warning')
            return
        }
        setBusy('sub')
        try {
            const r = await rpc.subSet(v)
            if (!r.ok) throw new Error(r.error || t('не скачалось'))
            notify(r.kind === 'links' ? t('Ссылки приняты') : t('Подписка загружена'))
            setSub(await rpc.subInfo())
            // Узлы перечитываем сразу: без этого список профилей показывал бы прежний состав,
            // то есть предлагал выбрать то, чего в файле уже нет.
            if (nodeSrc) rpc.vlessNodes(nodeSrc).then((x) => setNodes(x.nodes || null)).catch(() => {})
            else setNodeSrc(null)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    /** Собрать спеку из выбранного и применить.
     *
     *  Списки скачиваются ДО применения: движок читает файлы в момент сборки правил и падает
     *  на отсутствующем, то есть выбранный, но не скачанный список превратил бы «Применить» в
     *  ошибку, с которой человеку нечего делать. */
    async function apply() {
        if (!spec) return
        if (!picked.size) { notify(t('Выберите хотя бы один сервис'), 'warning'); return }

        // Проверяем ТОЛЬКО те outbound'ы, в которые действительно что-то назначено: пустой
        // outbound — это незакрытая мысль человека, а не ошибка, и мешать применению
        // остального он не должен.
        const used = new Set(picked.values())
        for (const i of used) {
            const d = dests[i]
            if (!d) continue
            if (d.via === 'sub' && !sub?.present) { notify(t('Сначала подключите подписку или вставьте vless://'), 'warning'); return }
            if (d.via === 'device' && !d.device) { notify(`${destLabel(d, i)}: ${t('выберите туннель')}`, 'warning'); return }
        }

        setBusy('apply')
        try {
            const chosen = all.filter((i) => picked.has(pathFor(i.file)))
            for (const i of chosen) {
                const r = await rpc.listFetch(i.id, 'domains').catch(() => ({ ok: false }))
                if (!r.ok) notify(`${i.name}: ${t('список не скачался')}`, 'warning')
            }

            const mine: Channel[] = []
            const outs: Record<string, Output> = {}
            // Имена каналов должны быть различны: движок различает каналы по имени, и два
            // одинаковых — это либо отказ, либо один вместо двух. Имя канала человек видит во
            // вкладках, поэтому берётся его собственное, а не «сервисы 2».
            const usedNames = new Set(foreign.map((c) => c.name))
            for (let i = 0; i < dests.length; i++) {
                const files = [...picked].filter(([, d]) => d === i).map(([f]) => f)
                if (!files.length) continue                 // выход без канала только зря поднимал бы туннель
                const d = dests[i]
                let nm = (d.label || autoLabel(i)).trim() || autoLabel(i)
                for (let k = 2; usedNames.has(nm); k++) nm = `${d.label || autoLabel(i)} ${k}`
                usedNames.add(nm)
                mine.push({
                    name: nm,
                    // fakeip: точность по домену. Именно она и делает «пустить ютуб» работающим
                    // независимо от того, какой адрес выдал DNS в эту минуту.
                    match: { domains_files: files, mode: 'fakeip' },
                    out: d.out,
                })
                // on_fail: drop во всех случаях. Туннель заводят ровно чтобы трафик НЕ шёл
                // напрямую, и вернуть его на открытый путь при поломке — нарушить это
                // обещание тогда, когда это опаснее всего, причём незаметно.
                outs[d.out] = d.via === 'device'
                    ? {
                        // Готовое устройство: wireguard, amneziawg, что угодно уже работающее.
                        // Движку здесь достаточно базовой сборки — VLESS он поднимать не будет.
                        name: d.out, kind: 'interface',
                        device: d.device, devices: [d.device!], on_fail: 'drop',
                      }
                    : {
                        // node: −1 — «первый рабочий». Зашитый номер молча перестаёт быть тем
                        // узлом при обновлении подписки, а проверка находит живой сама. Номер
                        // ставится только если человек выбрал профиль сам и осознанно.
                        name: d.out, kind: 'vless', sub_file: SUB_FILE,
                        node: d.node ?? -1, on_fail: 'drop',
                      }
            }

            // Свои выходы, оставшиеся без канала, убираем — но НЕ те, на которые ссылается
            // что-то настроенное руками: удалить выход из-под чужого канала значит сломать
            // чужую работу молча, а именно этого мастер и не делает.
            const keep: Record<string, Output> = {}
            for (const [name, o] of Object.entries(spec.outputs || {})) {
                if (!myOuts.has(name)) { keep[name] = o; continue }
                if (outs[name]) continue                          // перезапишется ниже
                if (foreign.some((c) => c.out === name)) keep[name] = o
            }

            const next: Spec = {
                ...spec,
                outputs: { ...keep, ...outs },
                // Свои каналы первыми: каналы проверяются сверху вниз, и сервисы должны
                // побеждать более широкие правила, настроенные вручную.
                channels: [...mine, ...foreign],
            }

            const w = await rpc.specSet(next)
            if (!w.ok) throw new Error(w.error || t('настройка не сохранилась'))
            // Память записывается ДО применения правил: если apply упадёт, спека уже своя, и
            // мастер обязан узнать её при следующем заходе — иначе он предложит создать всё
            // заново рядом, то есть развести настройку на две от одной неудачи.
            await rpc.uiSet(JSON.stringify({ v: 1, dests } satisfies Memo)).catch(() => {})
            const a = await rpc.apply()
            if (!a.ok) throw new Error(a.output || t('не применилось'))
            notify(t('Готово'))
            setSpec(next)
            setStatus(await rpc.status().catch(() => null))
            if (nodeSrc) rpc.vlessNodes(nodeSrc).then((x) => setNodes(x.nodes || null)).catch(() => {})
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">{t('Загрузка…')}</div>

    /** Плитка выбора. Не браузерный чекбокс: у того съезжает базовая линия (это правили
     *  дважды), а крупная цель нажатия здесь ещё и уместнее — страницу открывают с телефона.
     *
     *  При двух и более outbound'ах плитка показывает, КУДА она назначена. Без этого выбор
     *  «ютуб туда, телеграм сюда» пришлось бы держать в голове. */
    function Tile({ i, wide }: { i: Item; wide?: boolean }) {
        const p = pathFor(i.file)
        const at = picked.get(p)
        const mineHere = at === active
        const elsewhere = at !== undefined && at !== active
        return (
            <button
                type="button"
                aria-pressed={at !== undefined}
                onClick={() => toggle(i)}
                className={[
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring',
                    wide ? 'w-full' : '',
                    mineHere
                        ? 'border-sp-primary bg-sp-primary/10 text-sp-foreground'
                        : elsewhere
                          ? 'border-sp-border bg-sp-muted/40 text-sp-foreground'
                          : 'border-sp-border text-sp-muted-foreground hover:text-sp-foreground',
                ].join(' ')}
            >
                <span
                    className={[
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        mineHere
                            ? 'border-sp-primary bg-sp-primary text-sp-primary-foreground'
                            : elsewhere
                              ? 'border-sp-muted-foreground text-sp-muted-foreground'
                              : 'border-sp-border',
                    ].join(' ')}
                    aria-hidden="true"
                >
                    {mineHere && <Check className="h-3 w-3" />}
                    {elsewhere && <span className="text-[10px] leading-none">{at! + 1}</span>}
                </span>
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                {dests.length > 1 && at !== undefined && (
                    <span className="shrink-0 text-xs text-sp-muted-foreground">{destLabel(dests[at], at)}</span>
                )}
                {i.count !== undefined && dests.length === 1 ? (
                    <span className="shrink-0 text-xs text-sp-muted-foreground">
                        {i.count} {t('домен.')}
                    </span>
                ) : null}
            </button>
        )
    }

    /** Один outbound в шаге 1. */
    function DestRow({ d, i }: { d: Dest; i: number }) {
        const noDevices = devices !== null && devices.length === 0
        return (
            <div className="space-y-2 rounded-lg border border-sp-border p-3">
                {/* Имя — поле ввода, а не подпись. Оно же становится именем канала в спеке,
                    поэтому «Ютуб через Польшу» видно и во вкладках. Это единственное место, где
                    человек называет свою настройку своими словами, и отсутствие такой
                    возможности было первым, обо что он споткнулся. */}
                <div className="flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-sp-muted-foreground">
                        outbound {i + 1}
                    </span>
                    <input
                        type="text"
                        value={d.label}
                        onChange={(e) => setDest(i, { label: e.target.value })}
                        placeholder={autoLabel(i)}
                        aria-label={t('Название outbound')}
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm hover:border-sp-border focus-visible:border-sp-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                    />
                    {dests.length > 1 && (
                        <button
                            type="button"
                            onClick={() => removeDest(i)}
                            aria-label={t('Убрать outbound')}
                            className="shrink-0 rounded p-1 text-sp-muted-foreground hover:text-sp-destructive"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    )}
                </div>

                {/* Выбор источника. Выбранное отличается ЯВНО — рамкой в два пикселя, фоном и
                    галочкой. Прежде разница была в одном оттенке рамки, и на тёмной теме её
                    просто не было видно: человек не понимал, что вообще выбрано. */}
                <div className="flex flex-wrap gap-2">
                    {[
                        { id: 'sub' as const, name: t('Подписка или ссылка'), why: t('https:// или vless://') },
                        { id: 'device' as const, name: t('Свой туннель'), why: t('wireguard, amneziawg') },
                    ].map((o) => {
                        const sel = d.via === o.id
                        return (
                            <button
                                key={o.id}
                                type="button"
                                aria-pressed={sel}
                                onClick={() => setDest(i, { via: o.id, node: o.id === 'sub' ? (d.node ?? -1) : undefined })}
                                /* НЕ disabled, даже когда устройств нет. Серая кнопка без
                                   объяснения — это и был тот случай, когда человек спрашивает
                                   «а почему я не могу выбрать свой туннель»: нажать нельзя,
                                   причина нигде. Нажимается всегда, причина пишется внизу. */
                                className={[
                                    'relative flex-1 rounded-lg border-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-50',
                                    sel
                                        ? 'border-sp-primary bg-sp-primary/15'
                                        : 'border-sp-border hover:border-sp-muted-foreground',
                                ].join(' ')}
                            >
                                {sel && (
                                    <span
                                        className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-sp-primary text-sp-primary-foreground"
                                        aria-hidden="true"
                                    >
                                        <Check className="h-3 w-3" />
                                    </span>
                                )}
                                <span className={sel ? 'font-medium text-sp-foreground' : 'font-medium'}>{o.name}</span>
                                <span className="block text-xs text-sp-muted-foreground">{o.why}</span>
                            </button>
                        )
                    })}
                </div>

                {d.via === 'device' ? (
                    devices === null ? (
                        <p className="text-sm text-sp-muted-foreground">{t('Загрузка…')}</p>
                    ) : noDevices ? (
                        <p className="text-sm text-sp-muted-foreground">
                            {t('Готовых туннельных устройств на роутере нет — ни wireguard, ни amneziawg. Свои туннели steer в списке не показываются: выход, ведущий в другой выход того же движка, никуда не ведёт. Поднимите туннель в «Сеть → Интерфейсы» и вернитесь, либо выберите подписку.')}
                        </p>
                    ) : (
                        <select
                            value={d.device || ''}
                            onChange={(e) => setDest(i, { device: e.target.value })}
                            aria-label={t('Туннель')}
                            className="w-full rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                        >
                            <option value="">{t('выберите устройство')}</option>
                            {devices.map((x) => (
                                <option key={x.name} value={x.name}>
                                    {x.name}
                                    {x.up ? '' : ` — ${t('не поднят')}`}
                                </option>
                            ))}
                        </select>
                    )
                ) : (
                    /* Профиль из подписки выбирается ВСЕГДА, а не только когда outbound'ов
                       несколько. «Первый рабочий» — хорошее умолчание, но не единственный
                       разумный ответ: человек может хотеть именно Нидерланды, и не иметь такой
                       возможности в простом режиме — это не простота, а лишение выбора. */
                    <div className="space-y-1">
                        <select
                            value={String(d.node ?? -1)}
                            onChange={(e) => setDest(i, { node: Number(e.target.value) })}
                            aria-label={t('Профиль подписки')}
                            className="w-full rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                        >
                            <option value="-1">{t('первый рабочий (проверит сам)')}</option>
                            {(nodes || []).map((n) => (
                                <option key={n.index} value={String(n.index)}>
                                    {n.name} — {n.type}
                                    {n.vision ? ' +vision' : ''}
                                </option>
                            ))}
                        </select>
                        <p className="text-xs text-sp-muted-foreground">
                            {nodes === null || nodes.length === 0
                                ? sub?.present
                                    ? t('Список профилей появится после «Применить» — движок читает их по имени выхода, а до применения выхода в настройке нет.')
                                    : t('Подключите подписку или вставьте vless://, и здесь появятся профили.')
                                : d.node !== undefined && d.node >= 0
                                  ? t('Выбран один профиль. Если он ляжет, трафик остановится: замену ищет только режим «первый рабочий».')
                                  : `${t('Профилей в подписке')}: ${nodes.length}. ${t('Проверка выберет первый отвечающий и сама вернётся наверх, когда оживёт предпочтительный.')}`}
                        </p>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="mx-auto max-w-3xl space-y-4">
            {/* Состояние одной строкой и человеческими словами. «up=true» и «канал жив» — это
                про устройство и счётчики, а человек спрашивает одно: работает ли. */}
            <Card>
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    {on ? (
                        <ShieldCheck className="h-6 w-6 text-sp-primary" aria-hidden="true" />
                    ) : (
                        <ShieldAlert className="h-6 w-6 text-sp-muted-foreground" aria-hidden="true" />
                    )}
                    <div className="mr-auto">
                        <div className="font-medium">
                            {on ? t('Работает') : configured ? t('Настроено, но туннель не поднялся') : t('Ещё не настроено')}
                        </div>
                        {node && (
                            <div className="text-xs text-sp-muted-foreground">
                                {node.name} · {node.ms} {t('мс')}
                            </div>
                        )}
                    </div>
                    {needSub && sub?.present && (
                        <Button variant="outline" size="sm" onClick={check} disabled={busy !== ''}>
                            {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" />}
                            {t('Проверить')}
                        </Button>
                    )}
                </CardContent>
            </Card>

            {/* Движка нет или он базовый — это не ошибка настройки, а другой пакет, и ставится
                он ЗДЕСЬ ЖЕ. Раньше здесь была строчка «нужен пакет steer-extended», после
                которой человеку оставалось идти в консоль: верное сообщение, из которого
                ничего не следует. */}
            {engine !== null && !engine.present && (
                <EngineCard engine={engine} onInstalled={() => {
                    rpc.engine().then(setEngine).catch(() => {})
                }} />
            )}
            {/* Расширенная сборка нужна ТОЛЬКО для подписки. Тому, кто ведёт трафик в свой
                wireguard, базового движка достаточно, и предлагать ему обновление значит
                гнать за лишним пакетом ни за чем. */}
            {engine?.present && !engine.vless && needSub && (
                <EngineCard engine={engine} onInstalled={() => {
                    rpc.engine().then(setEngine).catch(() => {})
                }} />
            )}

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">1. {t('Куда пускать')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    {dests.map((d, i) => <DestRow key={i} d={d} i={i} />)}

                    {dests.length < MAX_DEST && (
                        <Button variant="outline" size="sm" onClick={addDest}>
                            <Plus className="h-4 w-4" />
                            {t('Ещё outbound')}
                        </Button>
                    )}

                    {/* Источник узлов — один на роутер, поэтому поле общее, а не в каждом
                        outbound'е: файл подписки один, различаются outbound'ы профилем. */}
                    {needSub && (
                        <div className="space-y-2 border-t border-sp-border pt-3">
                            <div className="flex flex-wrap gap-2">
                                <input
                                    type="text"
                                    inputMode="url"
                                    spellCheck={false}
                                    autoCapitalize="none"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    placeholder="https://…  или  vless://…"
                                    aria-label={t('Ссылка на подписку или vless://')}
                                    className="min-w-0 flex-1 rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                                />
                                <Button onClick={connect} disabled={busy !== '' || engine?.vless === false}>
                                    {busy === 'sub' && <Loader2 className="h-4 w-4 animate-spin" />}
                                    {t('Подключить')}
                                </Button>
                            </div>
                            <p className="text-xs text-sp-muted-foreground">
                                {sub?.present
                                    ? sub.kind === 'links'
                                        ? t('На роутере — вставленные ссылки vless://. Вставьте другие, чтобы заменить.')
                                        : t('Подписка на роутере. Вставьте другую ссылку, чтобы заменить.')
                                    : t('Подойдёт и ссылка на подписку от продавца, и одна ссылка vless:// — например, от знакомого со своим сервером. Несколько vless:// можно вставить через пробел.')}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">2. {t('Что пустить через VPN')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {!all.length && (
                        <p className="text-sm text-sp-muted-foreground">
                            {t('Список сервисов не загрузился — проверьте интернет на роутере.')}
                        </p>
                    )}

                    {/* При двух и более outbound'ах нажатие на плитку должно означать
                        что-то определённое. Выбираем сначала outbound, потом сервисы —
                        так «ютуб туда, телеграм сюда» делается двумя движениями, а не
                        выпадающим списком на каждой плитке. */}
                    {dests.length > 1 && (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-sp-muted-foreground">{t('Отмечаю в')}:</span>
                            {dests.map((d, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    aria-pressed={active === i}
                                    onClick={() => setActive(i)}
                                    className={[
                                        'rounded-full border px-3 py-1 text-xs transition-colors',
                                        active === i
                                            ? 'border-sp-primary bg-sp-primary text-sp-primary-foreground'
                                            : 'border-sp-border text-sp-muted-foreground hover:text-sp-foreground',
                                    ].join(' ')}
                                >
                                    {i + 1}. {destLabel(d, i)}
                                </button>
                            ))}
                        </div>
                    )}

                    {services.length > 0 && (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {services.map((i) => <Tile key={i.id} i={i} />)}
                        </div>
                    )}

                    {categories.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-sp-muted-foreground">
                                {t('Целиком')}
                            </div>
                            <div className="space-y-2">
                                {categories.map((i) => <Tile key={i.id} i={i} wide />)}
                            </div>
                        </div>
                    )}

                    {/* Хостинги и CDN — здесь же, а не «в расширенных настройках».
                        Закрыто одним нажатием и с ценой, названной вслух: прятать значит не
                        объяснить, а человек, которому это нужно, всё равно найдёт. */}
                    {infra.length > 0 && (
                        <div className="space-y-2 border-t border-sp-border pt-3">
                            <button
                                type="button"
                                onClick={() => setShowInfra(!showInfra)}
                                className="flex w-full items-center gap-2 text-left text-xs font-medium uppercase tracking-wide text-sp-muted-foreground hover:text-sp-foreground"
                            >
                                <ChevronDown
                                    className={`h-4 w-4 transition-transform ${showInfra ? '' : '-rotate-90'}`}
                                    aria-hidden="true"
                                />
                                {t('Хостинги и CDN')}
                                <span className="ml-auto normal-case tracking-normal">
                                    {infra.filter((i) => picked.has(pathFor(i.file))).length || ''}
                                </span>
                            </button>
                            {showInfra && (
                                <>
                                    <p className="text-xs text-sp-muted-foreground">
                                        {t('Это не сервисы, а инфраструктура под чужими сервисами: за одним Cloudflare стоят миллионы сайтов. Включайте, когда нужный сервис не заработал от своей плитки, — и по одному, а не все сразу: каждая уводит в туннель заметно больше, чем видно по названию.')}
                                    </p>
                                    <div className="space-y-2">
                                        {infra.map((i) => <Tile key={i.id} i={i} wide />)}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" onClick={apply} disabled={busy !== ''}>
                    {busy === 'apply' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('Применить')}
                </Button>
                {foreign.length > 0 && (
                    <span className="text-xs text-sp-muted-foreground">
                        {t('Настроенное вручную сохранится, каналов:')} {foreign.length}
                    </span>
                )}
            </div>

            {/* Выход в расширенное — ссылкой, не вкладкой: это дверь для того, кто уже знает,
                что за ней, а не пятый равноправный раздел. */}
            <button
                type="button"
                onClick={onExpert}
                className="flex items-center gap-2 pt-2 text-sm text-sp-muted-foreground hover:text-sp-foreground"
            >
                <Wrench className="h-4 w-4" aria-hidden="true" />
                {t('Расширенные настройки')}
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>

            {/* Движок под интерфейсом называется прямо. Не украшение: когда человек ищет,
                почему трафик пошёл не туда, ему нужно знать, ЧТО читать и где спрашивать, —
                а вся маршрутизация здесь чужая работа, и она названа. */}
            <div className="pt-2 text-xs text-sp-muted-foreground">
                powered by{' '}
                <a
                    href="https://github.com/xyzmean/steer"
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted hover:text-sp-foreground"
                >
                    steer
                </a>
            </div>

            {status?.warnings?.length ? (
                <div className="space-y-1 pt-2">
                    {status.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-sp-muted-foreground">
                            <Badge variant="secondary">{t('внимание')}</Badge>
                            <span>{w.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
