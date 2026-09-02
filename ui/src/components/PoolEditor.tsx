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
 *  ЧТО МОЖНО ВЗЯТЬ — ВСЁ И РАЗОМ, В ЛЮБОМ ПОРЯДКЕ. Две локации из одной подписки, три из другой
 *  и свой WireGuard — один выход, и строки в нём стоят так, как расставил человек: локации
 *  разных подписок могут чередоваться. Раньше редактор предлагал выбор «либо одна подписка,
 *  либо свои туннели», потом — блоки по подпискам; владелец упёрся и в то, и в другое.
 *
 *  КАК ЭТО ЛОЖИТСЯ В ДВИЖОК. Движок собирает разнородный пул давно: выход `kind: interface`, в
 *  `devices` которого названы устройства выходов `kind: vless` (контракт steer, §выходы).
 *  Редактор эту форму собирает сам: СОСЕДНИЕ строки одной подписки становятся одним служебным
 *  выходом `kind: vless` со списком `nodes` (см. `Output.part_of`), своё устройство — само
 *  собой, а выход — пулом из их устройств в том же порядке. Так «Финляндия (Riot) → Польша
 *  (VPN) → Эстония (Riot)» даёт три части, две из них на одной подписке, — и порядок человека
 *  исполняется дословно. Соседние локации одной подписки нарочно сведены в одну часть: внутри
 *  неё узлы перебирает сам клиент, за секунды; между частями — сторож движка, раз в минуту.
 *  Человек видит одно: список того, что взял, по порядку.
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

/** Строка состава: одна локация подписки, «любая рабочая» локация подписки либо одно своё
 *  устройство. Порядок строк — порядок предпочтения, каким его расставил человек. */
type Row =
    | { kind: 'node'; sub: string; idx: number }
    | { kind: 'any'; sub: string }
    | { kind: 'dev'; dev: string }

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/
/** Имя выхода `kind: vless` становится именем устройства TUN, а у него предел IFNAMSIZ:
 *  движок молча берёт первые пятнадцать символов (spec.c). Два длинных имени с общим началом
 *  дали бы одно устройство на два выхода — поэтому предел проверяется здесь, до записи. */
const DEV_NAME_MAX = 15

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

/** Служебные части пула по имени пула. */
function partsOf(spec: Spec, pool: string | undefined): [string, Output][] {
    if (!pool) return []
    return Object.entries(spec.outputs).filter(([, o]) => o.part_of === pool)
}

/** Строки из выхода kind=vless (обычного или служебной части). */
function rowsOfVless(o: Output): Row[] {
    const sub = o.sub_file || ''
    const nodes = o.nodes?.length
        ? o.nodes
        : typeof o.node === 'number' && o.node >= 0
          ? [o.node]
          : []
    return nodes.length ? nodes.map((idx): Row => ({ kind: 'node', sub, idx })) : [{ kind: 'any', sub }]
}

/** Разложить существующий выход на строки состава. Обратная операция к сборке в save(). */
function rowsOf(spec: Spec, name: string | undefined): Row[] {
    const o = name ? spec.outputs[name] : undefined
    if (!o) return []
    if (o.kind === 'vless') return rowsOfVless(o)
    if (o.kind !== 'interface') return []
    const parts = partsOf(spec, name)
    return devList(o).flatMap((d): Row[] => {
        const part = parts.find(([n, p]) => n === d || devList(p).includes(d))
        return part ? rowsOfVless(part[1]) : [{ kind: 'dev', dev: d }]
    })
}

/** Ключ строки — чтобы React не терял состояние при перестановке. */
function rowKey(r: Row): string {
    return r.kind === 'node' ? `n:${r.sub}:${r.idx}` : r.kind === 'any' ? `a:${r.sub}` : `d:${r.dev}`
}

function sameRow(a: Row, b: Row): boolean {
    return rowKey(a) === rowKey(b)
}

/** Группы соседних строк одной подписки — то, что станет частями пула. */
type Group = { kind: 'sub'; sub: string; nodes: number[] } | { kind: 'dev'; dev: string }
function groupsOf(rows: Row[]): Group[] {
    const out: Group[] = []
    for (const r of rows) {
        if (r.kind === 'dev') { out.push({ kind: 'dev', dev: r.dev }); continue }
        const last = out[out.length - 1]
        /* «Любая рабочая» — всегда своя часть: пустой список узлов значит «все», и склеивать
         * его с выбранными номерами значило бы потерять либо то, либо другое. */
        if (r.kind === 'node' && last && last.kind === 'sub' && last.sub === r.sub && last.nodes.length) {
            last.nodes.push(r.idx)
            continue
        }
        out.push({ kind: 'sub', sub: r.sub, nodes: r.kind === 'node' ? [r.idx] : [] })
    }
    return out
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
    const [rows, setRows] = useState<Row[]>(() => rowsOf(spec, name))
    const [onFail, setOnFail] = useState<OnFail>(existing?.on_fail || 'drop')
    const [tunnels, setTunnels] = useState<{ name: string; up: boolean; kind: string }[]>([])
    /* Перечень подписок начинается с запомненного: пока `sub_list` идёт, список говорил
     * «подписок нет» — утверждение, а не ожидание, и человек успевал ему поверить. */
    const [subs, setSubs] = useState<Sub[]>(() => subsRemembered() ?? [])
    /** Узлы каждой подписки глазами движка. `undefined` — ещё не спрашивали, `null` — спросить
     *  не удалось (подписка не скачана или бэкенд постарше без выхода на ней). */
    const [nodesBySub, setNodesBySub] = useState<Record<string, VlessNode[] | null>>({})
    /** Какая строка сейчас тащится мышью — индекс в `rows`. */
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
    const nodeOf = (sub: string, idx: number) => (nodesBySub[sub] || []).find((x) => x.index === idx)

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

    const has = (r: Row) => rows.some((x) => sameRow(x, r))

    /** Движок без пула: одна подписка с одним узлом ЛИБО свои туннели. Взять второе, когда
     *  есть первое, значит записать то, что он молча исполнит не так. */
    function refuseOnOldEngine(next: Row[]): boolean {
        if (pools) return false
        const g = groupsOf(next)
        const subsN = g.filter((x) => x.kind === 'sub').length
        const devsN = g.length - subsN
        if (subsN > 1 || (subsN && devsN)) {
            notify('Движок этой версии не умеет смешанный пул: либо одна подписка, либо свои туннели. Обновите движок в разделе «Система».', 'warning')
            return true
        }
        return false
    }

    function commit(next: Row[]) {
        if (refuseOnOldEngine(next)) return
        setRows(next)
    }

    /** Отметить или снять локацию. Новая строка встаёт в конец: порядок — дело правой колонки. */
    function toggleNode(sub: string, idx: number) {
        const r: Row = { kind: 'node', sub, idx }
        if (has(r)) { commit(rows.filter((x) => !sameRow(x, r))); return }
        /* «Любая рабочая» этой подписки и выбранный номер вместе не значат ничего: выбор
         * номера заменяет «любую». */
        const base = rows.filter((x) => !(x.kind === 'any' && x.sub === sub))
        /* Без пула локация одна: вторая отметка переезжает, а не добавляется. */
        commit(pools ? [...base, r] : [...base.filter((x) => x.kind !== 'node'), r])
    }

    /** «Любая рабочая»: подписка взята целиком, выбор узла делает проверка при подъёме.
     *  Повторное нажатие ничего не меняет — убирается строка крестиком в порядке справа,
     *  как и всё остальное; два способа убрать одно и то же путали бы. */
    function anyOf(sub: string) {
        const r: Row = { kind: 'any', sub }
        if (has(r)) return
        commit([...rows.filter((x) => !(x.kind === 'node' && x.sub === sub)), r])
    }

    function toggleDev(dev: string) {
        const r: Row = { kind: 'dev', dev }
        commit(has(r) ? rows.filter((x) => !sameRow(x, r)) : [...rows, r])
    }

    function move(i: number, j: number) {
        if (j < 0 || j >= rows.length || i === j) return
        const next = rows.slice()
        const [r] = next.splice(i, 1)
        next.splice(j, 0, r)
        setRows(next)
    }

    /** Форма выхода kind=vless из группы строк подписки. ОДНА форма из двух: спеку с `node` и
     *  `nodes` разом движок отвергает целиком. Список — только там, где движок его понимает. */
    function vlessOut(n: string, g: Extract<Group, { kind: 'sub' }>, fail: OnFail, partOf?: string): Output {
        return {
            name: n,
            kind: 'vless',
            sub_file: g.sub,
            ...(pools && g.nodes.length > 1
                ? { nodes: g.nodes }
                : { node: g.nodes.length ? g.nodes[0] : -1 }),
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
        if (rows.length === 0) {
            notify('Выберите, через что выходить', 'warning')
            return
        }
        if (refuseOnOldEngine(rows)) return

        const groups = groupsOf(rows)
        const subGroups = groups.filter((g): g is Extract<Group, { kind: 'sub' }> => g.kind === 'sub')
        const outputs: Record<string, Output> = {}
        for (const [k, v] of Object.entries(spec.outputs)) if (!mine.has(k)) outputs[k] = v

        if (groups.length === 1 && subGroups.length === 1) {
            /* Одна подписка — обычный выход kind=vless, как и раньше: служебные части здесь
             * ни к чему, а имя выхода станет именем устройства. */
            if (n.length > DEV_NAME_MAX) {
                notify(`Имя выхода подписки — не длиннее ${DEV_NAME_MAX} символов: оно становится именем устройства`, 'warning')
                return
            }
            outputs[n] = vlessOut(n, subGroups[0], onFail)
        } else if (subGroups.length === 0) {
            const devices = groups.map((g) => (g as Extract<Group, { kind: 'dev' }>).dev)
            outputs[n] = { name: n, kind: 'interface', devices, device: devices[0], on_fail: onFail }
        } else {
            /* Пул. Каждая группа соседних локаций одной подписки — своим служебным выходом; имя
             * части ≤ 15 символов (предел имени устройства) и по возможности прежнее: части с
             * той же подпиской и теми же узлами оставляется её имя, иначе перестановка строк
             * переименовывала бы устройства и перезапускала живые туннели. */
            const oldParts = partsOf(spec, name)
            const used = new Set(Object.keys(outputs))
            const devices: string[] = []
            const keyOf = (o: Output) => `${o.sub_file}|${(o.nodes?.length ? o.nodes : typeof o.node === 'number' && o.node >= 0 ? [o.node] : []).join(',')}`
            for (const g of groups) {
                if (g.kind === 'dev') { devices.push(g.dev); continue }
                const want = `${g.sub}|${g.nodes.join(',')}`
                let pn = oldParts.find(([k, p]) => !used.has(k) && keyOf(p) === want)?.[0]
                    ?? oldParts.find(([k, p]) => !used.has(k) && p.sub_file === g.sub)?.[0]
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
                outputs[pn] = vlessOut(pn, g, 'drop', n)
                devices.push(pn)
            }
            if (devices.length > 8) {
                notify('В пуле не больше восьми частей — таков предел движка; соседние локации одной подписки считаются одной частью', 'warning')
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

    const subsInRows = new Set(rows.filter((r) => r.kind !== 'dev').map((r) => (r as { sub: string }).sub))

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
                            const nodes = nodesBySub[s.path]
                            const any = has({ kind: 'any', sub: s.path })
                            /* Что показывать из локаций: при поиске — совпавшие; иначе выбранные
                               и первые FOLD, пока подписку не развернули целиком. */
                            const q = query.trim().toLowerCase()
                            const all = nodes || []
                            const hit = (nd: VlessNode) => {
                                const cc = ccFromName(nd.name)
                                return `${plainName(nd.name)} ${country(cc)} ${cc || ''}`.toLowerCase().includes(q)
                            }
                            const picked = new Set(
                                rows.filter((r) => r.kind === 'node' && r.sub === s.path).map((r) => (r as { idx: number }).idx),
                            )
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
                                                {picked.size ? ` · взято: ${picked.size}` : any ? ' · взята любая' : ''}
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
                                            const on = picked.has(nd.index)
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
                                    const on = has({ kind: 'dev', dev: t.name })
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
                            {rows.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    ничего не выбрано — отметьте локации или туннели в списке «Что можно взять»
                                </p>
                            ) : (
                                <ol className="space-y-1" aria-label="порядок предпочтения">
                                    {rows.map((r, i) => {
                                        const nd = r.kind === 'node' ? nodeOf(r.sub, r.idx) : undefined
                                        const cc = r.kind === 'node' ? ccFromName(nd?.name) : undefined
                                        const label =
                                            r.kind === 'dev'
                                                ? r.dev
                                                : r.kind === 'any'
                                                  ? 'любая рабочая'
                                                  : plainName(nd?.name) || `узел ${r.idx + 1}`
                                        const hint = r.kind === 'dev' ? undefined : subTitle(r.sub)
                                        /* Соседние локации одной подписки — одна часть пула, и это
                                           видно: строки слиты в один блок без зазора. Граница блока
                                           показывает, где кончается переключение внутри клиента
                                           и начинается сторож движка. */
                                        const prev = rows[i - 1]
                                        const joined = !!prev && prev.kind === 'node' && r.kind === 'node' && prev.sub === r.sub
                                        return (
                                            <li
                                                key={rowKey(r)}
                                                draggable={pools}
                                                onDragStart={(e) => {
                                                    setDrag(i)
                                                    e.dataTransfer?.setData('text/plain', String(i))
                                                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                                                }}
                                                onDragOver={(e) => { e.preventDefault(); if (over !== i) setOver(i) }}
                                                onDragLeave={() => { if (over === i) setOver(null) }}
                                                onDrop={(e) => {
                                                    e.preventDefault()
                                                    if (drag !== null) move(drag, i)
                                                    setDrag(null)
                                                    setOver(null)
                                                }}
                                                onDragEnd={() => { setDrag(null); setOver(null) }}
                                                className={[
                                                    'flex items-center gap-2 rounded-xl border p-2 transition-colors',
                                                    over === i && drag !== null && drag !== i
                                                        ? 'border-primary bg-primary/10'
                                                        : r.kind === 'dev'
                                                          ? 'border-border'
                                                          : 'border-primary/40 bg-primary/5',
                                                    joined ? '-mt-1 rounded-t-none border-t-0' : '',
                                                    drag === i ? 'opacity-50' : '',
                                                ].join(' ')}
                                            >
                                                {pools ? (
                                                    <GripVertical
                                                        className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                )}
                                                <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                                                    {i + 1}
                                                </span>
                                                {r.kind === 'node' && <Flag cc={cc} />}
                                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
                                                {hint && (
                                                    <span className="hidden max-w-[9rem] shrink-0 truncate text-[11px] text-muted-foreground sm:inline">
                                                        {hint}
                                                    </span>
                                                )}
                                                {pools && (
                                                    <>
                                                        <IconBtn label={`строка ${i + 1} выше`} onClick={() => move(i, i - 1)} disabled={i === 0}>
                                                            <ArrowUp className="h-4 w-4" />
                                                        </IconBtn>
                                                        <IconBtn label={`строка ${i + 1} ниже`} onClick={() => move(i, i + 1)} disabled={i === rows.length - 1}>
                                                            <ArrowDown className="h-4 w-4" />
                                                        </IconBtn>
                                                    </>
                                                )}
                                                <IconBtn label={`убрать строку ${i + 1}`} onClick={() => setRows(rows.filter((_, k) => k !== i))} danger>
                                                    <X className="h-4 w-4" />
                                                </IconBtn>
                                            </li>
                                        )
                                    })}
                                </ol>
                            )}
                            <p className="text-xs text-muted-foreground">
                                Первая живая строка забирает трафик; когда верхняя оживает, трафик
                                возвращается к ней сам.
                                {pools && (
                                    <>
                                        {' '}Строки можно тащить мышью или переставлять стрелками, локации
                                        разных подписок — в любом порядке.
                                    </>
                                )}
                                {subsInRows.size > 0 && rows.length > 1 && pools && (
                                    <>
                                        {' '}Соседние локации одной подписки обслуживает один клиент и
                                        переключается между ними за секунды; между остальными строками
                                        переключает сторож движка, раз в минуту.
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
            {/* Подсказка справа на узком экране прячется: она отъедала место у названия, и
                «любая рабочая» обрезалось до «любая р…». */}
            {hint && <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{hint}</span>}
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
