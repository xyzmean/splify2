import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC, type Output, type Spec, type Status } from '@/lib/model'

// Outputs are named, and channels point at the NAME. That indirection is what lets
// several tunnels coexist: failover re-points an output's device without touching a
// single channel, and two channels can lead to two different tunnels at once.
//
// Renaming therefore has to rewrite every channel that points at the old name — a
// dangling `out` is a spec the engine refuses, and the UI is the only place that knows
// both sides.

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/

export default function OutputsPage() {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [status, setStatus] = useState<Status | null>(null)
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)
    /** Names being typed. Held separately so a half-typed name never lands in the spec
     *  and orphans the channels pointing at the old one. */
    const [draft, setDraft] = useState<Record<string, string>>({})

    useEffect(() => {
        rpc.specGet().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.status().then(setStatus).catch(() => setStatus(null))
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    function addInterface() {
        if (!spec) return
        const taken = new Set(Object.values(spec.outputs).map((o) => o.device))
        const free = devices.find((d) => !taken.has(d.name))
        let name = free?.name?.replace(/[^A-Za-z0-9_-]/g, '') || 'tunnel'
        let n = 2
        while (spec.outputs[name]) name = `${free?.name || 'tunnel'}${n++}`
        edit({
            ...spec,
            outputs: { ...spec.outputs, [name]: { name, kind: 'interface', device: free?.name || '' } },
        })
    }

    function addDirect() {
        if (!spec) return
        if (spec.outputs.direct) { notify('Выход «direct» уже есть', 'warning'); return }
        // A `direct` output is how a list is EXCLUDED: a channel above the others that
        // claims those addresses and leaves them on the normal path.
        edit({ ...spec, outputs: { ...spec.outputs, direct: { name: 'direct', kind: 'direct' } } })
    }

    function patch(name: string, o: Output) {
        if (!spec) return
        edit({ ...spec, outputs: { ...spec.outputs, [name]: o } })
    }

    function rename(from: string) {
        if (!spec) return
        const to = (draft[from] ?? '').trim()
        setDraft({ ...draft, [from]: '' })
        if (!to || to === from) return
        if (!NAME_RE.test(to)) { notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning'); return }
        if (spec.outputs[to]) { notify(`Выход «${to}» уже есть`, 'warning'); return }
        // Rebuilt rather than mutated so the ORDER of outputs survives a rename — the
        // engine assigns marks by first appearance, and a reshuffle would hand existing
        // tunnels different marks.
        const outputs: Record<string, Output> = {}
        for (const [k, v] of Object.entries(spec.outputs))
            if (k === from) outputs[to] = { ...v, name: to }
            else outputs[k] = v
        edit({
            ...spec,
            outputs,
            channels: spec.channels.map((c) => (c.out === from ? { ...c, out: to } : c)),
        })
        notify(`Переименован в «${to}»; каналы переключены`)
    }

    function remove(name: string) {
        if (!spec) return
        const used = spec.channels.filter((c) => c.out === name)
        if (used.length) {
            notify(`Выход занят каналами: ${used.map((c) => c.name).join(', ')}`, 'warning')
            return
        }
        const outputs = { ...spec.outputs }
        delete outputs[name]
        edit({ ...spec, outputs })
    }

    async function save() {
        if (!spec) return
        setBusy(true)
        try {
            const res = await rpc.specSet(JSON.stringify(spec))
            if (!res.ok) throw new Error(res.error || 'не удалось сохранить')
            const ap = await rpc.apply()
            setDirty(false)
            notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
            rpc.status().then(setStatus).catch(() => {})
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const names = Object.keys(spec.outputs)

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Выходы</CardTitle>
                    <CardDescription>
                        Куда каналы могут вести. Канал указывает на имя выхода, а не на устройство, поэтому
                        смена туннеля не трогает каналы. Каждый выход получает свою метку и таблицу
                        маршрутизации, так что несколько работают одновременно.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="mb-2 flex flex-wrap gap-2">
                        <Button onClick={addInterface} variant="secondary">
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Туннель
                        </Button>
                        <Button onClick={addDirect} variant="secondary">
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Напрямую
                        </Button>
                    </div>

                    {names.length === 0 && (
                        <p className="py-6 text-center text-sm text-sp-muted-foreground">
                            Выходов нет. «Туннель» — трафик уходит в указанное устройство. «Напрямую» —
                            канал забирает адреса себе и оставляет их на обычном пути; так исключают список.
                        </p>
                    )}

                    {names.map((name) => {
                        const o = spec.outputs[name]
                        const s = status?.outputs?.[name]
                        const usedBy = spec.channels.filter((c) => c.out === name).map((c) => c.name)
                        return (
                            <div key={name} className="space-y-2 rounded-md border border-sp-border bg-sp-card p-3">
                                <div className="flex flex-wrap items-end gap-3">
                                    <label className="flex flex-col gap-1 text-xs">
                                        Имя
                                        <div className="flex gap-1">
                                            <input
                                                value={draft[name] ?? name}
                                                onChange={(e) => setDraft({ ...draft, [name]: e.currentTarget.value })}
                                                onKeyDown={(e) => e.key === 'Enter' && rename(name)}
                                                className="w-32 rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                                aria-label={`Имя выхода ${name}`}
                                            />
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={!draft[name] || draft[name] === name}
                                                onClick={() => rename(name)}
                                            >
                                                Переименовать
                                            </Button>
                                        </div>
                                    </label>

                                    {o.kind === 'interface' ? (
                                        <label className="flex flex-col gap-1 text-xs">
                                            Устройство
                                            <select
                                                value={o.device || ''}
                                                onChange={(e) => patch(name, { ...o, device: e.currentTarget.value })}
                                                className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                            >
                                                <option value="">— выберите —</option>
                                                {devices.map((d) => (
                                                    <option key={d.name} value={d.name}>
                                                        {d.name}{d.up ? '' : ' (выключен)'}
                                                    </option>
                                                ))}
                                                {o.device && !devices.some((d) => d.name === o.device) && (
                                                    <option value={o.device}>{o.device} (нет в системе)</option>
                                                )}
                                            </select>
                                        </label>
                                    ) : (
                                        <Badge variant="secondary">напрямую, без устройства</Badge>
                                    )}

                                    <div className="ml-auto">
                                        <Button variant="ghost" size="icon" aria-label={`Удалить выход ${name}`}
                                                onClick={() => remove(name)}>
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                    {s && o.kind === 'interface' && (
                                        <>
                                            <Badge variant={s.up ? 'default' : 'destructive'}>
                                                {s.up ? 'поднят' : 'выключен'}
                                            </Badge>
                                            {/* Without NAT the route applies, the counter rises, and every
                                                site behind it hangs — so it is shown here, not buried. */}
                                            <Badge variant={s.nat ? 'secondary' : 'destructive'}>
                                                {s.nat ? 'NAT есть' : 'NAT не найден'}
                                            </Badge>
                                            {s.mark && (
                                                <span className="text-sp-muted-foreground">
                                                    метка {s.mark}, таблица {s.table}
                                                </span>
                                            )}
                                        </>
                                    )}
                                    <span className="text-sp-muted-foreground">
                                        {usedBy.length ? `каналы: ${usedBy.join(', ')}` : 'каналов нет'}
                                    </span>
                                </div>
                            </div>
                        )
                    })}
                </CardContent>
            </Card>

            <div className="flex items-center gap-2">
                <Button onClick={save} disabled={busy || !dirty}>
                    {busy ? 'Применяем…' : 'Сохранить и применить'}
                </Button>
                {dirty && <span className="text-xs text-sp-warning">Есть несохранённые изменения</span>}
            </div>
        </div>
    )
}
