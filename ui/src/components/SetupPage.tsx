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
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, которое делает это безопасным: мастер трогает РОВНО свои записи
// (выходы MINE_OUT и каналы MINE_CH) и не касается ничего другого. Кто настроил что-то руками
// во вкладках, не потеряет это, открыв мастер, — иначе «простой режим» стал бы способом
// молча снести чужую работу.

/** Сколько направлений мастер разрешает.
 *
 *  Одного не хватило по живой причине: «пустить ютуб через Нидерланды, а телеграм через свой
 *  wireguard» — это не сложная настройка, а обычное желание, и упиралось оно в то, что мастер
 *  умел один выход. Три, а не сколько угодно: четвёртое направление уже требует объяснять
 *  порядок каналов, а это ровно то понятие, от которого мастер и избавляет. */
const MAX_DEST = 3

/** Имена, которые мастер создаёт и признаёт своими. Первое — без номера, чтобы настройки,
 *  сделанные прежней однонаправленной версией, читались как есть, а не терялись. */
function outName(i: number) { return i === 0 ? 'vpn' : `vpn${i + 1}` }
function chName(i: number) { return i === 0 ? 'сервисы' : `сервисы ${i + 1}` }
/** Обратное преобразование: по имени канала — номер направления. Явные шаблоны, а не
 *  «всё, что не чужое»: чужой канал с похожим именем не должен молча попасть под мастер. */
function destOfChannel(name: string): number | null {
    if (name === chName(0)) return 0
    for (let i = 1; i < MAX_DEST; i++) if (name === chName(i)) return i
    return null
}
const MINE_OUTS = Array.from({ length: MAX_DEST }, (_, i) => outName(i))

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

/** Одно направление: куда именно ведёт трафик.
 *
 *  `node` есть только у подписки и означает то же, что в спеке: −1 — «первый рабочий».
 *  Второе направление на ту же подписку осмысленно ровно из-за него: один узел на ютуб,
 *  другой на телеграм — это одна подписка и два разных выхода. */
interface Dest {
    via: 'sub' | 'device'
    device?: string
    node?: number
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
    /** Направления. Одно по умолчанию — экран для того, у кого ещё ничего нет. */
    const [dests, setDests] = useState<Dest[]>([{ via: 'sub', node: -1 }])
    /** Куда назначается нажатие на плитку. При одном направлении не показывается вовсе. */
    const [active, setActive] = useState(0)
    const [devices, setDevices] = useState<{ name: string; up: boolean }[] | null>(null)
    /** Файл списка -> номер направления. Файл, а не идентификатор: в спеку идут пути, и
     *  хранить то же, что сохраняем, значит не иметь второго представления, которое может
     *  разойтись с первым. */
    const [picked, setPicked] = useState<Map<string, number>>(new Map())
    const [busy, setBusy] = useState('')
    const [node, setNode] = useState<{ name: string; ms: number } | null>(null)
    const [showInfra, setShowInfra] = useState(false)
    /** Узлы подписки для выбора вручную. Доступны только после первого применения: движок
     *  читает их по ИМЕНИ ВЫХОДА из спеки, а до применения выхода в спеке нет. */
    const [nodes, setNodes] = useState<VlessNode[] | null>(null)

    useEffect(() => {
        rpc.specGet().then((s) => { setSpec(s); seed(s) }).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then(setRaw).catch(() => setRaw(null))
        rpc.status().then(setStatus).catch(() => setStatus(null))
        rpc.engine().then(setEngine).catch(() => setEngine(null))
        rpc.subInfo().then((s) => { setSub(s); setUrl(s.url || '') }).catch(() => setSub(null))
        rpc.devices()
            .then((r) => {
                // Свои же выходы из списка убираем: выход, указывающий сам на себя, —
                // конфигурация, которая молча никуда не ведёт.
                const list = (r.devices || []).filter((d) => !MINE_OUTS.includes(d.name))
                setDevices(list)
            })
            .catch(() => setDevices([]))
        rpc.vlessNodes(outName(0)).then((r) => setNodes(r.nodes || null)).catch(() => setNodes(null))
    }, [])

    /** Прочитать из спеки то, что мастер сам туда и положил. Без этого повторный вход
     *  показывал бы всё выключенным при работающем туннеле. */
    function seed(s: Spec) {
        const map = new Map<string, number>()
        for (const ch of s.channels) {
            const d = destOfChannel(ch.name)
            if (d === null) continue
            for (const f of ch.match.domains_files || []) map.set(f, d)
        }
        setPicked(map)

        // Чем выходы были настроены раньше, тем и показываем: иначе повторный вход
        // предлагал бы подписку тому, у кого выход и так ведёт в его wireguard.
        const found: Dest[] = []
        for (let i = 0; i < MAX_DEST; i++) {
            const out = s.outputs?.[outName(i)]
            if (!out) continue
            found[i] = out.kind === 'interface'
                ? { via: 'device', device: out.device || out.devices?.[0] || '' }
                : { via: 'sub', node: out.node ?? -1 }
        }
        // Дырки в нумерации возможны, если во вкладках выход удалили руками. Схлопываем,
        // сохраняя привязку списков: иначе плитки указывали бы на исчезнувшее направление.
        const compact: Dest[] = []
        const shift = new Map<number, number>()
        for (let i = 0; i < MAX_DEST; i++) if (found[i]) { shift.set(i, compact.length); compact.push(found[i]) }
        if (compact.length) {
            setDests(compact)
            if (shift.size !== compact.length || [...shift].some(([a, b]) => a !== b)) {
                const remap = new Map<string, number>()
                for (const [f, d] of map) { const n = shift.get(d); if (n !== undefined) remap.set(f, n) }
                setPicked(remap)
            }
        }
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

    /** Каналы, которых мастер не касается. Показываются строкой: человек должен знать, что
     *  здесь не вся настройка, — иначе «Применить» выглядит так, будто он задаёт её целиком. */
    const foreign = (spec?.channels || []).filter((c) => destOfChannel(c.name) === null)

    const on = MINE_OUTS.some((n) => status?.outputs?.[n]?.up === true)
    const configured = (spec?.channels || []).some((c) => destOfChannel(c.name) !== null)
    const needSub = dests.some((d) => d.via === 'sub')

    /** Как называется направление на экране. Не «vpn2», а то, куда оно ведёт: имя выхода —
     *  это внутреннее понятие движка, и показывать его здесь значит вернуть то самое слово,
     *  от которого мастер избавляет. */
    function destLabel(d: Dest, i: number) {
        if (d.via === 'device') return d.device || t('туннель не выбран')
        const byNode = d.node !== undefined && d.node >= 0 ? nodes?.find((n) => n.index === d.node) : null
        if (byNode) return byNode.name
        return dests.filter((x) => x.via === 'sub').length > 1 ? `${t('подписка')} ${i + 1}` : t('подписка')
    }

    function setDest(i: number, patch: Partial<Dest>) {
        setDests(dests.map((d, k) => (k === i ? { ...d, ...patch } : d)))
    }

    function addDest() {
        if (dests.length >= MAX_DEST) return
        // Второе направление по умолчанию — устройство, если оно есть: две подписки на один
        // и тот же файл различаются только узлом, и это тонкость, а не умолчание.
        const free = (devices || []).find((x) => !dests.some((d) => d.device === x.name))
        const next: Dest = free ? { via: 'device', device: free.name } : { via: 'sub', node: -1 }
        setDests([...dests, next])
        setActive(dests.length)
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
        setBusy('check')
        try {
            const r = await rpc.vlessProbe(outName(0), -1)
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
            // Узлы перечитываем сразу: без этого выбор узла во втором направлении показывал
            // бы прежний список, то есть предлагал выбрать то, чего в файле уже нет.
            rpc.vlessNodes(outName(0)).then((x) => setNodes(x.nodes || null)).catch(() => {})
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

        // Проверяем ТОЛЬКО те направления, в которые действительно что-то назначено: пустое
        // направление — это незакрытая мысль человека, а не ошибка, и мешать применению
        // остального оно не должно.
        const used = new Set(picked.values())
        for (const i of used) {
            const d = dests[i]
            if (!d) continue
            if (d.via === 'sub' && !sub?.present) { notify(t('Сначала подключите подписку или вставьте vless://'), 'warning'); return }
            if (d.via === 'device' && !d.device) { notify(t('Выберите туннель для направления') + ` ${i + 1}`, 'warning'); return }
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
            for (let i = 0; i < dests.length; i++) {
                const files = [...picked].filter(([, d]) => d === i).map(([f]) => f)
                if (!files.length) continue                 // выход без канала только зря поднимал бы туннель
                const d = dests[i]
                mine.push({
                    name: chName(i),
                    // fakeip: точность по домену. Именно она и делает «пустить ютуб» работающим
                    // независимо от того, какой адрес выдал DNS в эту минуту.
                    match: { domains_files: files, mode: 'fakeip' },
                    out: outName(i),
                })
                // on_fail: drop во всех случаях. Туннель заводят ровно чтобы трафик НЕ шёл
                // напрямую, и вернуть его на открытый путь при поломке — нарушить это
                // обещание тогда, когда это опаснее всего, причём незаметно.
                outs[outName(i)] = d.via === 'device'
                    ? {
                        // Готовое устройство: wireguard, amneziawg, что угодно уже работающее.
                        // Движку здесь достаточно базовой сборки — VLESS он поднимать не будет.
                        name: outName(i), kind: 'interface',
                        device: d.device, devices: [d.device!], on_fail: 'drop',
                      }
                    : {
                        // node: −1 — «первый рабочий». Зашитый номер молча перестаёт быть тем
                        // узлом при обновлении подписки, а проверка находит живой сама. Номер
                        // ставится только если человек выбрал узел сам и осознанно.
                        name: outName(i), kind: 'vless', sub_file: SUB_FILE,
                        node: d.node ?? -1, on_fail: 'drop',
                      }
            }

            // Свои выходы, оставшиеся без канала, убираем — но НЕ те, на которые ссылается
            // что-то настроенное руками: удалить выход из-под чужого канала значит сломать
            // чужую работу молча, а именно этого мастер и не делает.
            const keep: Record<string, Output> = {}
            for (const [name, o] of Object.entries(spec.outputs || {})) {
                if (!MINE_OUTS.includes(name)) { keep[name] = o; continue }
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
            const a = await rpc.apply()
            if (!a.ok) throw new Error(a.output || t('не применилось'))
            notify(t('Готово'))
            setSpec(next)
            setStatus(await rpc.status().catch(() => null))
            rpc.vlessNodes(outName(0)).then((x) => setNodes(x.nodes || null)).catch(() => {})
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
     *  При двух и более направлениях плитка показывает, КУДА она назначена. Без этого выбор
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

    /** Одно направление в шаге 1. */
    function DestRow({ d, i }: { d: Dest; i: number }) {
        const subDests = dests.filter((x) => x.via === 'sub').length
        return (
            <div className="space-y-2 rounded-lg border border-sp-border p-3">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-sp-muted-foreground">
                        {dests.length > 1 ? `${t('направление')} ${i + 1}` : t('куда')}
                    </span>
                    <span className="mr-auto text-sm">{destLabel(d, i)}</span>
                    {dests.length > 1 && (
                        <button
                            type="button"
                            onClick={() => removeDest(i)}
                            aria-label={t('Убрать направление')}
                            className="rounded p-1 text-sp-muted-foreground hover:text-sp-destructive"
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
                                disabled={o.id === 'device' && devices?.length === 0}
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
                    ) : devices.length === 0 ? (
                        <p className="text-sm text-sp-muted-foreground">
                            {t('Туннельных устройств на роутере нет. Поднимите wireguard или amneziawg — или выберите подписку.')}
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
                    /* Узел выбирается только когда направлений на подписку больше одного:
                       иначе «первый рабочий» — единственный разумный ответ, и лишний список
                       здесь был бы вопросом без причины. */
                    subDests > 1 && (
                        <select
                            value={String(d.node ?? -1)}
                            onChange={(e) => setDest(i, { node: Number(e.target.value) })}
                            aria-label={t('Узел')}
                            className="w-full rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                        >
                            <option value="-1">{t('первый рабочий')}</option>
                            {(nodes || []).map((n) => (
                                <option key={n.index} value={String(n.index)}>
                                    {n.name} — {n.type}
                                    {n.vision ? ' +vision' : ''}
                                </option>
                            ))}
                        </select>
                    )
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
                            {t('Ещё направление')}
                        </Button>
                    )}

                    {/* Источник узлов — один на роутер, поэтому поле общее, а не в каждом
                        направлении: файл подписки один, различаются направления узлом. */}
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

                    {/* При двух и более направлениях нажатие на плитку должно означать
                        что-то определённое. Выбираем сначала направление, потом сервисы —
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
