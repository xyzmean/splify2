import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toLists, EMPTY_SPEC, type Channel, type ListEntry, type Manifest, type Spec } from '@/lib/model'

// The unit of the whole system is a channel: (who, what) -> where. Shown as a RANKED
// list because the order IS the priority — first match wins — and a UI that hid that
// would hide the one thing a user has to understand.
//
// Each row opens into an editor rather than linking to a separate form: a channel is
// four short decisions, and making them on one screen is what lets someone see that
// two channels differ only in their output.

const LISTS_DIR = '/etc/steer/lists'

/** Where the engine will look for a list this UI asked the backend to download. */
function pathFor(l: ListEntry) {
    return `${LISTS_DIR}/${l.file.split('/').pop()}`
}

function selectedIds(ch: Channel, lists: ListEntry[]): string[] {
    const files = [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]
    return lists.filter((l) => files.includes(pathFor(l))).map((l) => l.id)
}

function isDomains(ch: Channel) {
    return (ch.match.domains_files?.length ?? 0) > 0
}

export default function ChannelsPage() {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [manifest, setManifest] = useState<Manifest | null>(null)
    const [open, setOpen] = useState<number | null>(null)
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)
    /** Which kind a row is being edited as. Kept outside the channel because an empty
     *  channel has no files yet and so nothing to infer the kind from. */
    const [kinds, setKinds] = useState<Record<number, 'prefixes' | 'domains'>>({})

    useEffect(() => {
        rpc.specGet().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then((m) => setManifest(toLists(m))).catch(() => setManifest(null))
    }, [])

    const lists = manifest?.lists ?? []

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    function patch(i: number, ch: Channel) {
        if (!spec) return
        edit({ ...spec, channels: spec.channels.map((c, k) => (k === i ? ch : c)) })
    }

    function move(i: number, delta: number) {
        if (!spec) return
        const j = i + delta
        if (j < 0 || j >= spec.channels.length) return
        const channels = spec.channels.slice()
        ;[channels[i], channels[j]] = [channels[j], channels[i]]
        edit({ ...spec, channels })
        setOpen(open === i ? j : open === j ? i : open)
    }

    function add() {
        if (!spec) return
        const out = Object.keys(spec.outputs)[0]
        if (!out) {
            notify('Сначала добавьте выход на вкладке «Выходы» — каналу некуда вести', 'warning')
            return
        }
        const used = new Set(spec.channels.map((c) => c.name))
        let n = spec.channels.length + 1
        while (used.has(`канал${n}`)) n++
        edit({ ...spec, channels: [...spec.channels, { name: `канал${n}`, match: {}, out }] })
        setOpen(spec.channels.length)
    }

    function setKind(i: number, kind: 'prefixes' | 'domains') {
        setKinds({ ...kinds, [i]: kind })
        if (!spec) return
        // The engine refuses a channel holding both, because addresses and domains
        // reach the set by different routes. Switching therefore clears the other side
        // rather than leaving a spec that will not compile.
        const ch = spec.channels[i]
        patch(i, {
            ...ch,
            match: kind === 'domains'
                ? { domains_files: [], mode: ch.match.mode ?? 'fakeip' }
                : { prefixes_files: [] },
        })
    }

    function toggleList(i: number, l: ListEntry) {
        if (!spec) return
        const ch = spec.channels[i]
        const kind = kinds[i] ?? (isDomains(ch) ? 'domains' : 'prefixes')
        const key = kind === 'domains' ? 'domains_files' : 'prefixes_files'
        const cur = (ch.match as Record<string, string[] | undefined>)[key] || []
        const p = pathFor(l)
        const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
        patch(i, { ...ch, match: { ...ch.match, [key]: next } })
    }

    async function save(andApply: boolean) {
        if (!spec) return
        setBusy(true)
        try {
            // Download whatever the channels point at BEFORE applying: the engine reads
            // the files at compile time and dies on a missing one, so a list picked in
            // the UI but never fetched would turn "Save" into an error the user cannot
            // act on.
            const needed = new Set<string>()
            for (const ch of spec.channels)
                for (const f of [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])])
                    needed.add(f)
            for (const l of lists)
                if (needed.has(pathFor(l))) {
                    const r = await rpc.listFetch(l.id).catch(() => ({ ok: false }) as { ok: boolean })
                    if (!r.ok) notify(`${l.name}: список не скачался — канал будет без него`, 'warning')
                }

            const res = await rpc.specSet(JSON.stringify(spec))
            if (!res.ok) throw new Error(res.error || 'не удалось сохранить')
            setDirty(false)
            if (andApply) {
                const ap = await rpc.apply()
                notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
            } else {
                notify('Сохранено. Вступит в силу после применения')
            }
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const outNames = Object.keys(spec.outputs)

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Каналы</CardTitle>
                        <CardDescription>
                            Проверяются сверху вниз, побеждает первое совпадение: адрес, попавший в два
                            канала, уйдёт в тот, что выше. Каналы с одним выходом, одними клиентами и одним
                            режимом движок объединит в один набор — на пакет это одно правило, а не два.
                        </CardDescription>
                    </div>
                    <Button onClick={add} variant="secondary" className="shrink-0">
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Добавить канал
                    </Button>
                </CardHeader>
                <CardContent>
                    {outNames.length === 0 && (
                        <p className="mb-3 rounded-md border border-sp-warning/40 bg-sp-warning/10 p-3 text-sm">
                            Выходов пока нет. Заведите их на вкладке «Выходы» — канал указывает на выход, а
                            не на устройство, поэтому переключение туннеля не трогает каналы.
                        </p>
                    )}
                    {spec.channels.length === 0 ? (
                        <p className="py-6 text-center text-sm text-sp-muted-foreground">
                            Каналов нет — весь трафик идёт напрямую.
                        </p>
                    ) : (
                        <ol className="space-y-2">
                            {spec.channels.map((ch, i) => {
                                const kind = kinds[i] ?? (isDomains(ch) ? 'domains' : 'prefixes')
                                const chosen = selectedIds(ch, lists)
                                const out = spec.outputs[ch.out]
                                const expanded = open === i
                                return (
                                    <li
                                        key={i}
                                        className="rounded-md border border-sp-border bg-sp-card"
                                    >
                                        <div className="flex items-center gap-2 p-3">
                                            <span className="w-5 text-center text-sm text-sp-muted-foreground">
                                                {i + 1}
                                            </span>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={expanded ? 'Свернуть' : 'Настроить канал'}
                                                aria-expanded={expanded}
                                                onClick={() => setOpen(expanded ? null : i)}
                                            >
                                                {expanded ? (
                                                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                                ) : (
                                                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                                                )}
                                            </Button>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="truncate font-medium">{ch.name}</span>
                                                    <Badge variant="secondary">
                                                        {kind === 'domains' ? 'домены' : 'адреса'}
                                                    </Badge>
                                                    <span className="text-xs text-sp-muted-foreground">
                                                        {chosen.length
                                                            ? `${chosen.length} ${chosen.length === 1 ? 'список' : 'списка'}`
                                                            : 'список не выбран'}
                                                    </span>
                                                </div>
                                                <div className="mt-0.5 text-xs text-sp-muted-foreground">
                                                    {ch.from?.length ? ch.from.join(', ') : 'все клиенты'} →{' '}
                                                    {out
                                                        ? out.kind === 'direct'
                                                            ? `${ch.out} (напрямую)`
                                                            : `${ch.out} → ${out.device || 'устройство не выбрано'}`
                                                        : `${ch.out} — выход не найден`}
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                <Button variant="ghost" size="icon" aria-label="Поднять приоритет"
                                                        disabled={i === 0} onClick={() => move(i, -1)}>
                                                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                                <Button variant="ghost" size="icon" aria-label="Опустить приоритет"
                                                        disabled={i === spec.channels.length - 1}
                                                        onClick={() => move(i, 1)}>
                                                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                                <Button variant="ghost" size="icon" aria-label="Удалить канал"
                                                        onClick={() => {
                                                            edit({ ...spec, channels: spec.channels.filter((_, k) => k !== i) })
                                                            setOpen(null)
                                                        }}>
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                            </div>
                                        </div>

                                        {expanded && (
                                            <div className="space-y-3 border-t border-sp-border p-3">
                                                <div className="flex flex-wrap gap-3">
                                                    <label className="flex flex-col gap-1 text-xs">
                                                        Название
                                                        <input
                                                            value={ch.name}
                                                            onChange={(e) => patch(i, { ...ch, name: e.currentTarget.value })}
                                                            className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                        />
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-xs">
                                                        Куда
                                                        <select
                                                            value={ch.out}
                                                            onChange={(e) => patch(i, { ...ch, out: e.currentTarget.value })}
                                                            className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                        >
                                                            {outNames.map((n) => (
                                                                <option key={n} value={n}>{n}</option>
                                                            ))}
                                                        </select>
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-xs">
                                                        Что сопоставляем
                                                        <select
                                                            value={kind}
                                                            onChange={(e) => setKind(i, e.currentTarget.value as 'prefixes' | 'domains')}
                                                            className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                        >
                                                            <option value="prefixes">адреса</option>
                                                            <option value="domains">домены</option>
                                                        </select>
                                                    </label>
                                                    {kind === 'domains' && (
                                                        <label className="flex flex-col gap-1 text-xs">
                                                            Режим
                                                            <select
                                                                value={ch.match.mode ?? 'fakeip'}
                                                                onChange={(e) => patch(i, { ...ch, match: { ...ch.match, mode: e.currentTarget.value as 'fakeip' | 'realip' } })}
                                                                className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                            >
                                                                <option value="fakeip">fakeip — точнее</option>
                                                                <option value="realip">realip — дешевле</option>
                                                            </select>
                                                        </label>
                                                    )}
                                                    <label className="flex flex-1 flex-col gap-1 text-xs">
                                                        Клиенты (пусто — все)
                                                        <input
                                                            value={(ch.from || []).join(', ')}
                                                            placeholder="192.168.1.50, 192.168.1.0/24"
                                                            onChange={(e) => {
                                                                const v = e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean)
                                                                patch(i, { ...ch, from: v.length ? v : undefined })
                                                            }}
                                                            className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                        />
                                                    </label>
                                                </div>

                                                {kind === 'domains' && (
                                                    <p className="text-xs text-sp-muted-foreground">
                                                        fakeip выдаёт каждому домену свой адрес — точно, но на каждый домен
                                                        нужен элемент набора и запись в карте. realip кладёт в набор
                                                        настоящие адреса из ответа: дешевле и трассировка читаемая, но два
                                                        домена за одним адресом станут одним.
                                                    </p>
                                                )}

                                                <div>
                                                    <div className="mb-1 text-xs">
                                                        Списки {kind === 'domains' ? 'доменов' : 'адресов'}
                                                    </div>
                                                    {!manifest ? (
                                                        <p className="text-xs text-sp-warning">
                                                            Манифест списков не загружен — проверьте сеть.
                                                        </p>
                                                    ) : (
                                                        <div className="max-h-56 overflow-y-auto rounded-md border border-sp-border p-2">
                                                            {lists.filter((l) => l.kind === kind).length === 0 && (
                                                                <p className="p-2 text-xs text-sp-muted-foreground">
                                                                    В манифесте нет списков этого вида.
                                                                </p>
                                                            )}
                                                            {lists.filter((l) => l.kind === kind).map((l) => (
                                                                <label key={l.id} className="flex items-center gap-2 py-0.5 text-sm">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={chosen.includes(l.id)}
                                                                        onChange={() => toggleList(i, l)}
                                                                    />
                                                                    <span className="truncate">{l.name}</span>
                                                                    {typeof l.count === 'number' && (
                                                                        <span className="text-xs text-sp-muted-foreground">
                                                                            {l.count.toLocaleString('ru-RU')}
                                                                        </span>
                                                                    )}
                                                                    {/* The same target in the other form: enabling both is
                                                                        double the memory and two channels arguing. */}
                                                                    {!!l.same_as_ip?.length && (
                                                                        <span className="text-xs text-sp-warning">
                                                                            то же адресами: {l.same_as_ip.join(', ')}
                                                                        </span>
                                                                    )}
                                                                </label>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {chosen.length > 1 && (
                                                        <p className="mt-1 text-xs text-sp-muted-foreground">
                                                            Несколько списков в одном канале — это один набор в ядре;
                                                            пересечения свернутся сами.
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                )
                            })}
                        </ol>
                    )}
                </CardContent>
            </Card>

            <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => save(true)} disabled={busy || !dirty}>
                    {busy ? 'Применяем…' : 'Сохранить и применить'}
                </Button>
                <Button variant="secondary" onClick={() => save(false)} disabled={busy || !dirty}>
                    Только сохранить
                </Button>
                {dirty && <span className="text-xs text-sp-warning">Есть несохранённые изменения</span>}
            </div>
        </div>
    )
}
