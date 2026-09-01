import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, GripVertical, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { notify } from '@/lib/notify'
import { rpc, type VlessNodesReply } from '@/lib/rpc'
import { subsRemember, subsRemembered } from '@/lib/subs'
import Flag from '@/components/Flag'
import { country } from '@/lib/geo'
import { ccFromName, plainName } from '@/lib/nodename'
import { poolsSupported } from '@/lib/engine'
import {
    devList, isPart, ON_FAIL_TEXT, type OnFail, type Output, type Spec, type VlessNode,
} from '@/lib/model'
import { type Live } from '@/lib/live'

/** Состав выхода: из чего он собран и в каком порядке.
 *
 *  ЧТО ТАКОЕ ВЫХОД. Это то, во что ведёт правило, — не устройство и не узел. Внутри у него
 *  список кандидатов по предпочтению: первый живой забирает трафик, и возврат наверх
 *  происходит сам, когда верхний оживает.
 *
 *  ЧТО МОЖНО ВЗЯТЬ — ВСЁ И РАЗОМ. Две локации из одной подписки, три из другой и свой
 *  WireGuard — один выход. Раньше редактор предлагал выбор «либо одна подписка, либо свои
 *  туннели», и владелец упёрся в него ровно на этом наборе. Ограничение было не движка, а
 *  формы: движок собирает разнородный пул давно — выход `kind: interface`, в `devices`
 *  которого названы устройства выходов `kind: vless` (контракт steer, §выходы). Редактор
 *  теперь эту форму СОБИРАЕТ САМ: локации одной подписки становятся служебным выходом
 *  `kind: vless` (см. `Output.part_of`), а сам выход — пулом из их устройств и своих
 *  туннелей. Человек видит одно: список того, что взял, по порядку.
 *
 *  ПОЧЕМУ ЛОКАЦИИ ОДНОЙ ПОДПИСКИ ИДУТ БЛОКОМ, а не вперемешку с чужими. У подписки внутри пула
 *  одно устройство и один клиент, который перебирает её узлы сам; между блоками перебирает
 *  сторож движка. Порядок «Германия №3 → wg0 → Германия №4» движок выразить не может — и
 *  нарисовать его значило бы пообещать то, чего не будет. Блок и есть правда о том, как это
 *  работает: локации внутри блока — по порядку, блоки — по порядку.
 *
 *  ДВИЖОК ПОСТАРШЕ (без умения `pool`) собирать пул не умеет и промолчал бы: незнакомая форма
 *  для него законна, а живая локация в ней объявляется мёртвой. Поэтому на таком движке
 *  редактор ограничивает выбор одной подпиской с одним узлом либо своими туннелями и говорит
 *  об этом словами, а не молча режет выбор. */

interface Sub {
    name: string
    title?: string
    path: string
    present: boolean
}

/** Строка состава: локации ОДНОЙ подписки (в порядке предпочтения; пусто — «любая рабочая»)
 *  либо одно своё устройство. */
type Block =
    | { kind: 'sub'; sub: string; nodes: number[] }
    | { kind: 'dev'; dev: string }

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/
/** Имя выхода `kind: vless` становится именем устройства TUN, а у него предел IFNAMSIZ:
 *  движок молча берёт первые пятнадцать символов (spec.c). Два длинных имени с общим началом
 *  дали бы одно устройство на два выхода — поэтому предел проверяется здесь, до записи. */
const DEV_NAME_MAX = 15

/** Служебные части пула по имени пула. */
function partsOf(spec: Spec, pool: string | undefined): [string, Output][] {
    if (!pool) return []
    return Object.entries(spec.outputs).filter(([, o]) => o.part_of === pool)
}

/** Разложить существующий выход на строки состава. Обратная операция к `compile`. */
function blocksOf(spec: Spec, name: string | undefined): Block[] {
    const o = name ? spec.outputs[name] : undefined
    if (!o) return []
    if (o.kind === 'vless') {
        const nodes = o.nodes?.length
            ? o.nodes
            : typeof o.node === 'number' && o.node >= 0
              ? [o.node]
              : []
        return [{ kind: 'sub', sub: o.sub_file || '', nodes }]
    }
    if (o.kind !== 'interface') return []
    const parts = partsOf(spec, name)
    return devList(o).map((d): Block => {
        const part = parts.find(([n, p]) => n === d || devList(p).includes(d))
        if (!part) return { kind: 'dev', dev: d }
        const p = part[1]
        const nodes = p.nodes?.length
            ? p.nodes
            : typeof p.node === 'number' && p.node >= 0
              ? [p.node]
              : []
        return { kind: 'sub', sub: p.sub_file || '', nodes }
    })
}

/** Имя нового выхода по умолчанию: `vpn`, занято — `vpn2`, `vpn3`… Пустое поле заставляло
 *  придумывать имя до того, как человек вообще понял, что здесь собирает; имя можно поменять. */
function freeName(spec: Spec): string {
    if (!spec.outputs.vpn) return 'vpn'
    let n = 2
    while (spec.outputs[`vpn${n}`]) n++
    return `vpn${n}`
}

/** Сколько локаций подписки показывать свёрнуто: выбранные — всегда, остальных — до этого
 *  числа. Две подписки по тридцать локаций разворачивались в столб на три экрана, в котором
 *  порядок предпочтения справа терялся, а на телефоне уезжал в самый низ. */
const FOLD = 6

/** Ключ строки — чтобы React не терял состояние при перестановке. */
function blockKey(b: Block): string {
    return b.kind === 'sub' ? `s:${b.sub}` : `d:${b.dev}`
}

export default function PoolEditor({
    spec, name, live, onSave, onCancel,
}: {
    spec: Spec
    /** Имя правимого выхода; пусто — заводим новый. */
    name?: string
    live?: Live
    onSave: (next: Spec) => void
    onCancel: () => void
}) {
    /** Умеет ли движок список локаций и смешанный пул. Спрашивается у состояния, а не у
     *  версии: см. lib/engine.ts. */
    const pools = poolsSupported(live?.status ?? null)
    const existing = name ? spec.outputs[name] : undefined
    const [title, setTitle] = useState(name || freeName(spec))
    /** Поиск по локациям: страна или слово из названия, по всем подпискам разом. */
    const [query, setQuery] = useState('')
    /** Подписки, развёрнутые целиком (по нажатию «показать все»). */
    const [openSubs, setOpenSubs] = useState<Record<string, boolean>>({})
    const [blocks, setBlocks] = useState<Block[]>(() => blocksOf(spec, name))
    const [onFail, setOnFail] = useState<OnFail>(existing?.on_fail || 'drop')
    const [tunnels, setTunnels] = useState<{ name: string; up: boolean; kind: string }[]>([])
    /* Перечень подписок начинается с запомненного: пока `sub_list` идёт, список говорил
     * «подписок нет» — утверждение, а не ожидание, и человек успевал ему поверить. */
    const [subs, setSubs] = useState<Sub[]>(() => subsRemembered() ?? [])
    /** Узлы каждой подписки глазами движка. `undefined` — ещё не спрашивали, `null` — спросить
     *  не удалось (подписка не скачана или бэкенд постарше без выхода на ней). */
    const [nodesBySub, setNodesBySub] = useState<Record<string, VlessNode[] | null>>({})
    /** Какая строка сейчас тащится мышью — индекс в `blocks`. */
    const [drag, setDrag] = useState<number | null>(null)
    const [over, setOver] = useState<number | null>(null)

    useEffect(() => {
        rpc.devices().then((d) => setTunnels(d.devices || [])).catch(() => setTunnels([]))
        rpc.subList()
            .then((r) => { setSubs(r.subs || []); subsRemember(r.subs) })
            /* Старый бэкенд про несколько подписок не знает — тогда единственная известная
             * подписка та, что лежит на своём месте. */
            .catch(() => setSubs([{ name: 'main', path: '/etc/steer/sub.txt', present: true }]))
    }, [])

    /* Узлы спрашиваются у КАЖДОЙ подписки, а не только у выбранной: человек выбирает из того,
     * что видит, и подписка без списка локаций для него — подписка без локаций. Первый путь —
     * у самой подписки (её файлом); бэкенд постарше так не умеет, и тогда узлы просим у любого
     * выхода, который уже стоит на этой подписке: движок читает их из того же файла. */
    const subKeys = subs.map((s) => `${s.path}${s.present ? '' : '!'}`).join(',')
    useEffect(() => {
        let stop = false
        for (const s of subs) {
            if (!s.present) { setNodesBySub((m) => ({ ...m, [s.path]: null })); continue }
            const asker = Object.entries(spec.outputs).find(
                ([, o]) => o.kind === 'vless' && o.sub_file === s.path,
            )?.[0]
            const take = (r: VlessNodesReply) => {
                if (!stop) setNodesBySub((m) => ({ ...m, [s.path]: r.nodes || [] }))
            }
            rpc.vlessNodesOfSub(s.path)
                .then(take)
                .catch(() => {
                    if (!asker) { if (!stop) setNodesBySub((m) => ({ ...m, [s.path]: null })); return }
                    rpc.vlessNodes(asker)
                        .then(take)
                        .catch(() => { if (!stop) setNodesBySub((m) => ({ ...m, [s.path]: null })) })
                })
        }
        return () => { stop = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subKeys])

    const subOf = (path: string) => subs.find((s) => s.path === path)
    const subTitle = (path: string) => {
        const s = subOf(path)
        return s?.title || s?.name || path.replace(/^.*\//, '').replace(/\.txt$/, '')
    }

    /** Устройства, занятые ДРУГИМИ выходами: одно устройство в двух выходах kind=interface —
     *  это две таблицы маршрутизации на один туннель, и вторая молча не работает.
     *
     *  Устройство выхода vless/xsteer сюда НЕ идёт, когда движок понимает смешанный пул: оно
     *  и есть локация, которую в пул кладут. Проба здоровья и masquerade решаются по владельцу
     *  устройства, а не по виду выхода, который его назвал (контракт steer T-015). */
    const taken = useMemo(
        () =>
            new Set(
                Object.entries(spec.outputs)
                    .filter(([n, o]) => n !== name && o.part_of !== name && (o.kind === 'interface' || !pools))
                    .flatMap(([, o]) => devList(o)),
            ),
        [spec, name, pools],
    )

    /** Устройства служебных частей — любых пулов. Человеку они не предлагаются: это не его
     *  туннели, а способ, которым редактор записал чужие локации. */
    const partDevs = useMemo(
        () =>
            new Set(
                Object.entries(spec.outputs)
                    .filter(([, o]) => isPart(o))
                    .flatMap(([n, o]) => [n, ...devList(o)]),
            ),
        [spec],
    )
    const offered = tunnels.filter((t) => !partDevs.has(t.name))

    const subBlock = (path: string) =>
        blocks.find((b): b is Extract<Block, { kind: 'sub' }> => b.kind === 'sub' && b.sub === path)
    const hasDev = (dev: string) => blocks.some((b) => b.kind === 'dev' && b.dev === dev)

    /** Движок без пула: одна подписка с одним узлом ЛИБО свои туннели. Взять второе, когда
     *  есть первое, значит записать то, что он молча исполнит не так. */
    function refuseOnOldEngine(next: Block[]): boolean {
        if (pools) return false
        const subsN = next.filter((b) => b.kind === 'sub').length
        const devsN = next.length - subsN
        if (subsN > 1 || (subsN && devsN)) {
            notify('Движок этой версии не умеет смешанный пул: либо одна подписка, либо свои туннели. Обновите движок в разделе «Система».', 'warning')
            return true
        }
        return false
    }

    function toggleNode(path: string, idx: number) {
        const b = subBlock(path)
        let next: Block[]
        if (!b) next = [...blocks, { kind: 'sub', sub: path, nodes: [idx] }]
        else if (b.nodes.includes(idx)) {
            const nodes = b.nodes.filter((x) => x !== idx)
            next = nodes.length
                ? blocks.map((x) => (x === b ? { ...b, nodes } : x))
                : blocks.filter((x) => x !== b)
        } else {
            /* Без пула локация одна: вторая отметка переезжает, а не добавляется. */
            const nodes = pools ? [...b.nodes, idx] : [idx]
            next = blocks.map((x) => (x === b ? { ...b, nodes } : x))
        }
        if (refuseOnOldEngine(next)) return
        setBlocks(next)
    }

    /** «Любая рабочая»: подписка взята целиком, выбор узла делает проверка при подъёме.
     *  Повторное нажатие ничего не меняет — убирается подписка крестиком в порядке справа,
     *  как и всё остальное; два способа убрать одно и то же путали бы. */
    function anyOf(path: string) {
        const b = subBlock(path)
        if (b && b.nodes.length === 0) return
        const next: Block[] = b
            ? blocks.map((x) => (x === b ? { ...b, nodes: [] } : x))
            : [...blocks, { kind: 'sub', sub: path, nodes: [] }]
        if (refuseOnOldEngine(next)) return
        setBlocks(next)
    }

    function toggleDev(dev: string) {
        const next = hasDev(dev)
            ? blocks.filter((b) => !(b.kind === 'dev' && b.dev === dev))
            : [...blocks, { kind: 'dev' as const, dev }]
        if (refuseOnOldEngine(next)) return
        setBlocks(next)
    }

    function moveBlock(i: number, j: number) {
        if (j < 0 || j >= blocks.length || i === j) return
        const next = blocks.slice()
        const [b] = next.splice(i, 1)
        next.splice(j, 0, b)
        setBlocks(next)
    }

    function moveNode(path: string, i: number, d: number) {
        const b = subBlock(path)
        if (!b) return
        const j = i + d
        if (j < 0 || j >= b.nodes.length) return
        const nodes = b.nodes.slice()
        ;[nodes[i], nodes[j]] = [nodes[j], nodes[i]]
        setBlocks(blocks.map((x) => (x === b ? { ...b, nodes } : x)))
    }

    function removeBlock(i: number) {
        setBlocks(blocks.filter((_, k) => k !== i))
    }

    /** Форма выхода kind=vless из строки подписки. ОДНА форма из двух: спеку с `node` и `nodes`
     *  разом движок отвергает целиком. Список — только там, где движок его понимает. */
    function vlessOut(n: string, b: Extract<Block, { kind: 'sub' }>, fail: OnFail, partOf?: string): Output {
        return {
            name: n,
            kind: 'vless',
            sub_file: b.sub,
            ...(pools && b.nodes.length > 1
                ? { nodes: b.nodes }
                : { node: b.nodes.length ? b.nodes[0] : -1 }),
            on_fail: fail,
            ...(partOf ? { part_of: partOf } : {}),
        }
    }

    function save() {
        const n = title.trim()
        if (!NAME_RE.test(n)) {
            notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning')
            return
        }
        const mine = new Set([name, ...partsOf(spec, name).map(([k]) => k)].filter(Boolean))
        if (!mine.has(n) && spec.outputs[n]) {
            notify(`Выход «${n}» уже есть`, 'warning')
            return
        }
        if (blocks.length === 0) {
            notify('Выберите, через что выходить', 'warning')
            return
        }
        if (refuseOnOldEngine(blocks)) return

        const subBlocks = blocks.filter((b): b is Extract<Block, { kind: 'sub' }> => b.kind === 'sub')
        const outputs: Record<string, Output> = {}
        for (const [k, v] of Object.entries(spec.outputs)) if (!mine.has(k)) outputs[k] = v

        if (blocks.length === 1 && subBlocks.length === 1) {
            /* Одна подписка — обычный выход kind=vless, как и раньше: служебные части здесь
             * ни к чему, а имя выхода станет именем устройства. */
            if (n.length > DEV_NAME_MAX) {
                notify(`Имя выхода подписки — не длиннее ${DEV_NAME_MAX} символов: оно становится именем устройства`, 'warning')
                return
            }
            outputs[n] = vlessOut(n, subBlocks[0], onFail)
        } else if (subBlocks.length === 0) {
            const devices = blocks.map((b) => (b as Extract<Block, { kind: 'dev' }>).dev)
            outputs[n] = { name: n, kind: 'interface', devices, device: devices[0], on_fail: onFail }
        } else {
            /* Пул. Локации каждой подписки — своим служебным выходом; имя части ≤ 15 символов
             * (предел имени устройства) и устойчиво: у подписки, которая уже была в пуле, часть
             * остаётся прежней — иначе перестановка блоков переименовывала бы устройства и
             * перезапускала живые туннели. */
            const oldParts = partsOf(spec, name)
            const used = new Set(Object.keys(outputs))
            const devices: string[] = []
            for (const b of blocks) {
                if (b.kind === 'dev') { devices.push(b.dev); continue }
                let pn = oldParts.find(([, p]) => p.sub_file === b.sub)?.[0]
                if (!pn || used.has(pn)) {
                    const stem = n.slice(0, DEV_NAME_MAX - 2)
                    let k = 1
                    while (used.has(`${stem}-${k}`) && k < 9) k++
                    pn = `${stem}-${k}`
                }
                used.add(pn)
                /* Отказ части — всегда «остановить»: за судьбу трафика при отказе ВСЕГО пула
                 * отвечает сам пул, а часть, пустившая трафик напрямую, пробила бы его обещание
                 * раньше, чем сторож перешёл к следующей строке. */
                outputs[pn] = vlessOut(pn, b, 'drop', n)
                devices.push(pn)
            }
            if (devices.length > 8) {
                notify('В пуле не больше восьми строк — таков предел движка', 'warning')
                return
            }
            outputs[n] = { name: n, kind: 'interface', devices, device: devices[0], on_fail: onFail }
        }
        /* Переименование уводит за собой правила: канал ведёт в ИМЯ выхода, и оставить их
         * указывать на прежнее значит осиротить каждое. */
        const channels =
            name && n !== name
                ? spec.channels.map((c) => (c.out === name ? { ...c, out: n } : c))
                : spec.channels
        onSave({ ...spec, outputs, channels })
    }

    function remove() {
        if (!name) return
        const mine = new Set([name, ...partsOf(spec, name).map(([k]) => k)])
        const used = spec.channels.filter((c) => mine.has(c.out)).map((c) => c.name)
        if (used.length) {
            notify(`Выход «${name}» занят правилами: ${used.join(', ')}`, 'warning')
            return
        }
        const outputs: Record<string, Output> = {}
        for (const [k, v] of Object.entries(spec.outputs)) if (!mine.has(k)) outputs[k] = v
        onSave({ ...spec, outputs })
    }

    /* Выход kind=zapret правится НЕ ЗДЕСЬ, и открывать для него общий редактор нельзя: тот
     * знает подписки и устройства и на «Сохранить» переписал бы его как выход без единого
     * устройства. То есть один клик по строке в списке молча превращал бы работающий обход в
     * выход, который никуда не ведёт.
     *
     * Показываем то немногое, что здесь и правится (режим отказа и удаление), а за стратегией
     * отправляем во вкладку Zapret — там она и живёт. */
    if (existing?.kind === 'zapret') {
        return (
            <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="sp-title">{name}</div>
                    <div className="flex gap-2">
                        <Button variant="destructive" onClick={remove}>
                            <Trash2 className="h-4 w-4" aria-hidden="true" /> Удалить
                        </Button>
                        <Button variant="secondary" onClick={onCancel}>
                            <X className="h-4 w-4" aria-hidden="true" /> Закрыть
                        </Button>
                        <Button
                            onClick={() => {
                                const outputs = { ...spec.outputs, [name!]: { ...existing, on_fail: onFail } }
                                onSave({ ...spec, outputs })
                            }}
                        >
                            <Check className="h-4 w-4" aria-hidden="true" /> Сохранить выход
                        </Button>
                    </div>
                </div>
                <Card>
                    <CardHeader>
                        <CardTitle>Обход DPI</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="text-muted-foreground">
                            Устройства у этого выхода нет: трафик уходит обычным маршрутом, а по
                            дороге его разбирает свой обработчик со своей стратегией. Стратегия
                            выбирается во вкладке Zapret.
                        </div>
                        <div className="space-y-1.5">
                            <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                Если обход не работает
                            </div>
                            {(['drop', 'direct'] as OnFail[]).map((v) => (
                                <Radio key={v} on={onFail === v} onClick={() => setOnFail(v)}>
                                    {ON_FAIL_TEXT[v]}
                                </Radio>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        )
    }

    const subsN = blocks.filter((b) => b.kind === 'sub').length

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <input
                    value={title}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                    placeholder="имя выхода"
                    aria-label="имя выхода"
                    className="h-[38px] min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm sm:max-w-[16rem]"
                />
                <div className="flex flex-wrap gap-2">
                    {name && (
                        <Button variant="destructive" onClick={remove}>
                            <Trash2 className="h-4 w-4" aria-hidden="true" /> Удалить
                        </Button>
                    )}
                    <Button variant="secondary" onClick={onCancel}>
                        <X className="h-4 w-4" aria-hidden="true" /> Отмена
                    </Button>
                    <Button onClick={save}>
                        <Check className="h-4 w-4" aria-hidden="true" /> Сохранить выход
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
                {/* ---- слева: что можно взять ------------------------------------------ */}
                <Card>
                    <CardHeader className="space-y-3">
                        <CardTitle>Что можно взять</CardTitle>
                        <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3">
                            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.currentTarget.value)}
                                placeholder="найти локацию: страна или слово из названия"
                                aria-label="найти локацию"
                                className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
                            />
                            {query && (
                                <button type="button" onClick={() => setQuery('')} aria-label="очистить поиск" className="sp-row bg-transparent p-0 text-muted-foreground hover:text-foreground">
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </label>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {subs.length === 0 && (
                            <div>
                                <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                    Подписки
                                </div>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    подписок нет — добавьте в подпункте VLESS
                                </p>
                            </div>
                        )}
                        {subs.map((s) => {
                            const b = subBlock(s.path)
                            const nodes = nodesBySub[s.path]
                            const any = !!b && b.nodes.length === 0
                            /* Что показывать из локаций: при поиске — совпавшие; иначе выбранные
                               и первые FOLD, пока подписку не развернули целиком. */
                            const q = query.trim().toLowerCase()
                            const all = nodes || []
                            const hit = (nd: VlessNode) => {
                                const cc = ccFromName(nd.name)
                                return `${plainName(nd.name)} ${country(cc)} ${cc || ''}`.toLowerCase().includes(q)
                            }
                            const picked = new Set(b?.nodes || [])
                            const shown = q
                                ? all.filter(hit)
                                : openSubs[s.path]
                                  ? all
                                  : [
                                        ...all.filter((nd) => picked.has(nd.index)),
                                        ...all.filter((nd) => !picked.has(nd.index)).slice(0, Math.max(0, FOLD - picked.size)),
                                    ]
                            const folded = !q && !openSubs[s.path] && shown.length < all.length
                            if (q && !shown.length && !all.length) return null
                            return (
                                <div key={s.path}>
                                    <div className="flex items-baseline justify-between gap-2">
                                        <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                            {subTitle(s.path)}
                                        </div>
                                        {!s.present && (
                                            <span className="text-[11px] text-warning-fg">не скачана</span>
                                        )}
                                        {s.present && nodes && (
                                            <span className="text-[11px] text-muted-foreground">
                                                локаций: {nodes.length}
                                                {b && b.nodes.length ? ` · взято: ${b.nodes.length}` : ''}
                                            </span>
                                        )}
                                    </div>
                                    <ul className="mt-2 space-y-0.5">
                                        <li>
                                            <Choice
                                                on={any}
                                                round
                                                onClick={() => anyOf(s.path)}
                                                disabled={!s.present}
                                                title="любая рабочая"
                                                hint="выбор делает проверка при подъёме"
                                            />
                                        </li>
                                        {nodes === undefined && s.present && (
                                            <li className="px-2.5 py-1 text-xs text-muted-foreground">узлы читаются…</li>
                                        )}
                                        {nodes === null && s.present && (
                                            <li className="px-2.5 py-1 text-xs text-muted-foreground">
                                                локации появятся после «Применить»
                                            </li>
                                        )}
                                        {q && nodes && !shown.length && (
                                            <li className="px-2.5 py-1 text-xs text-muted-foreground">ничего не нашлось</li>
                                        )}
                                        {shown.map((nd) => {
                                            const cc = ccFromName(nd.name);
                                            const on = !!b && b.nodes.includes(nd.index)
                                            /* Страна справа — только когда её нет в самом названии:
                                               «Германия №2 … Германия» повторяло слово дважды. */
                                            const cName = country(cc)
                                            const hint = cName && !plainName(nd.name).toLowerCase().includes(cName.toLowerCase()) ? cName : undefined
                                            return (
                                                <li key={nd.index}>
                                                    <Choice
                                                        on={on}
                                                        /* Квадрат — набор, круг — одно из. Движок
                                                           без пула берёт одну локацию, и вторая
                                                           отметка на нём переезжает, а не
                                                           добавляется; форма отметки говорит об
                                                           этом сама (см. pool-one-location). */
                                                        round={!pools}
                                                        onClick={() => toggleNode(s.path, nd.index)}
                                                        flag={cc}
                                                        title={plainName(nd.name) || `узел ${nd.index + 1}`}
                                                        hint={hint}
                                                    />
                                                </li>
                                            )
                                        })}
                                        {(folded || (!q && openSubs[s.path] && all.length > FOLD)) && (
                                            <li>
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenSubs((m) => ({ ...m, [s.path]: !m[s.path] }))}
                                                    className="w-full rounded-lg bg-transparent px-2.5 py-1.5 text-left text-xs text-primary hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                                >
                                                    {folded ? `показать все ${all.length} локаций` : 'свернуть'}
                                                </button>
                                            </li>
                                        )}
                                    </ul>
                                </div>
                            )
                        })}

                        <div>
                            <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                Свои туннели
                            </div>
                            <ul className="mt-2 space-y-0.5">
                                {offered.length === 0 && (
                                    <li className="text-xs text-muted-foreground">
                                        туннельных устройств нет
                                    </li>
                                )}
                                {offered.map((t) => {
                                    const on = hasDev(t.name)
                                    const busy = taken.has(t.name)
                                    /* Чьё это устройство: у локации подписки его создаёт сам
                                     * движок, и человеку оно известно именем выхода. */
                                    const owner = Object.entries(spec.outputs).find(
                                        ([n, o]) =>
                                            n !== name &&
                                            o.kind !== 'interface' &&
                                            (o.device === t.name || o.devices?.includes(t.name)),
                                    )?.[0]
                                    return (
                                        <li key={t.name}>
                                            <Choice
                                                on={on}
                                                disabled={busy && !on}
                                                onClick={() => toggleDev(t.name)}
                                                dot={t.up}
                                                title={t.name}
                                                hint={busy && !on ? 'занято другим выходом' : owner ? `выход ${owner}` : t.kind}
                                            />
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    </CardContent>
                </Card>

                {/* ---- справа: порядок и отказ -------------------------------------------
                    На широком экране колонка липнет к верху и остаётся на виду, пока человек
                    листает локации; на узком идёт ПЕРВОЙ — выбранное важнее перечня, из которого
                    выбирают, а перечень на телефоне длиной в несколько экранов. */}
                <div className="order-first space-y-4 xl:order-none xl:sticky xl:top-4 xl:self-start">
                    <Card>
                        <CardHeader>
                            <CardTitle>Порядок предпочтения</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {blocks.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    ничего не выбрано — отметьте локации или туннели в списке «Что можно взять»
                                </p>
                            ) : (
                                <ol className="space-y-1.5" aria-label="порядок предпочтения">
                                    {blocks.map((b, i) => (
                                        <li
                                            key={blockKey(b)}
                                            draggable
                                            onDragStart={(e) => {
                                                setDrag(i)
                                                e.dataTransfer?.setData('text/plain', String(i))
                                                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                                            }}
                                            onDragOver={(e) => { e.preventDefault(); if (over !== i) setOver(i) }}
                                            onDragLeave={() => { if (over === i) setOver(null) }}
                                            onDrop={(e) => {
                                                e.preventDefault()
                                                if (drag !== null) moveBlock(drag, i)
                                                setDrag(null)
                                                setOver(null)
                                            }}
                                            onDragEnd={() => { setDrag(null); setOver(null) }}
                                            className={[
                                                'rounded-xl border p-2 transition-colors',
                                                over === i && drag !== null && drag !== i
                                                    ? 'border-primary bg-primary/10'
                                                    : b.kind === 'sub'
                                                      ? 'border-primary/40 bg-primary/5'
                                                      : 'border-border',
                                                drag === i ? 'opacity-50' : '',
                                            ].join(' ')}
                                        >
                                            <div className="flex items-center gap-2">
                                                <GripVertical
                                                    className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground"
                                                    aria-hidden="true"
                                                />
                                                <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                                                    {i + 1}
                                                </span>
                                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                                    {b.kind === 'sub' ? subTitle(b.sub) : b.dev}
                                                </span>
                                                {b.kind === 'sub' && b.nodes.length === 0 && (
                                                    <span className="shrink-0 text-[11px] text-muted-foreground">
                                                        любая рабочая
                                                    </span>
                                                )}
                                                {/* Движок без пула берёт одну локацию, и порядка
                                                    предпочтения у неё нет — обещать его нечем;
                                                    локация названа тут же, в строке. */}
                                                {b.kind === 'sub' && !pools && b.nodes.length > 0 && (
                                                    <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
                                                        {plainName((nodesBySub[b.sub] || []).find((x) => x.index === b.nodes[0])?.name) || `узел ${b.nodes[0] + 1}`}
                                                    </span>
                                                )}
                                                <IconBtn label={`строка ${i + 1} выше`} onClick={() => moveBlock(i, i - 1)} disabled={i === 0}>
                                                    <ArrowUp className="h-4 w-4" />
                                                </IconBtn>
                                                <IconBtn label={`строка ${i + 1} ниже`} onClick={() => moveBlock(i, i + 1)} disabled={i === blocks.length - 1}>
                                                    <ArrowDown className="h-4 w-4" />
                                                </IconBtn>
                                                <IconBtn label={`убрать строку ${i + 1}`} onClick={() => removeBlock(i)} danger>
                                                    <X className="h-4 w-4" />
                                                </IconBtn>
                                            </div>
                                            {b.kind === 'sub' && pools && b.nodes.length > 0 && (
                                                <ol className="mt-1.5 space-y-0.5 pl-6">
                                                    {b.nodes.map((idx, k) => {
                                                        const nd = (nodesBySub[b.sub] || []).find((x) => x.index === idx)
                                                        const cc = ccFromName(nd?.name)
                                                        return (
                                                            <li key={idx} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px]">
                                                                <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                                                                    {k + 1}
                                                                </span>
                                                                <Flag cc={cc} />
                                                                <span className="min-w-0 flex-1 truncate">
                                                                    {plainName(nd?.name) || `узел ${idx + 1}`}
                                                                </span>
                                                                <IconBtn label={`локация ${k + 1} выше`} onClick={() => moveNode(b.sub, k, -1)} disabled={k === 0}>
                                                                    <ArrowUp className="h-3.5 w-3.5" />
                                                                </IconBtn>
                                                                <IconBtn label={`локация ${k + 1} ниже`} onClick={() => moveNode(b.sub, k, 1)} disabled={k === b.nodes.length - 1}>
                                                                    <ArrowDown className="h-3.5 w-3.5" />
                                                                </IconBtn>
                                                                <IconBtn label={`убрать локацию ${k + 1}`} onClick={() => toggleNode(b.sub, idx)} danger>
                                                                    <X className="h-3.5 w-3.5" />
                                                                </IconBtn>
                                                            </li>
                                                        )
                                                    })}
                                                </ol>
                                            )}
                                        </li>
                                    ))}
                                </ol>
                            )}
                            <p className="text-xs text-muted-foreground">
                                Первая живая строка забирает трафик; когда верхняя оживает, трафик
                                возвращается к ней сам. Строки можно тащить мышью или переставлять
                                стрелками.
                                {subsN > 0 && blocks.length > 1 && (
                                    <>
                                        {' '}Локации одной подписки идут одним туннелем: внутри строки их
                                        перебирает клиент подписки, между строками — сторож движка.
                                    </>
                                )}
                            </p>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Если всё упало</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-1">
                            {(['drop', 'direct', 'zapret'] as OnFail[]).map((v) => (
                                <Radio key={v} on={onFail === v} onClick={() => setOnFail(v)}>
                                    {ON_FAIL_TEXT[v]}
                                </Radio>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}

/** Строка выбора: квадратная отметка — набор, круглая (`round`) — одно из нескольких. */
function Choice({
    on, onClick, disabled, title, hint, flag, dot, round,
}: {
    on: boolean
    onClick: () => void
    disabled?: boolean
    title: string
    hint?: string
    flag?: string
    /** Точка состояния устройства: поднято или нет. */
    dot?: boolean
    round?: boolean
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-1.5 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${
                on ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
            }`}
        >
            {round ? (
                <span
                    className={`h-4 w-4 shrink-0 rounded-full border ${
                        on ? 'border-[5px] border-primary' : 'border-input'
                    }`}
                    aria-hidden="true"
                />
            ) : (
                <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                    }`}
                    aria-hidden="true"
                >
                    {on && <Check className="h-3 w-3" />}
                </span>
            )}
            {flag !== undefined && <Flag cc={flag} />}
            {dot !== undefined && (
                <span
                    className={`h-2 w-2 shrink-0 rounded-full ${dot ? 'bg-success' : 'bg-muted-foreground'}`}
                    aria-hidden="true"
                />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            {hint && <span className="shrink-0 text-[11px] text-muted-foreground">{hint}</span>}
        </button>
    )
}

/** Строка выбора с круглой отметкой: одно из нескольких. */
function Radio({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary ${
                on ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
            }`}
        >
            <span
                className={`h-4 w-4 shrink-0 rounded-full border ${on ? 'border-[5px] border-primary' : 'border-input'}`}
                aria-hidden="true"
            />
            <span className="min-w-0 flex-1">{children}</span>
        </button>
    )
}

function IconBtn({
    label, onClick, disabled, danger, children,
}: {
    label: string
    onClick: () => void
    disabled?: boolean
    danger?: boolean
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={`sp-row shrink-0 bg-transparent p-0 text-muted-foreground disabled:opacity-30 ${
                danger ? 'hover:text-destructive' : 'hover:text-foreground'
            }`}
        >
            {children}
        </button>
    )
}
