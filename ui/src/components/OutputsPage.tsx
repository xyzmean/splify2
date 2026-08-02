import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC, type Spec, type Status } from '@/lib/model'

// Outputs are named, and channels point at the NAME. That indirection is the whole
// reason several tunnels can coexist: failover re-points an output's device without
// touching a single channel, and two channels can lead to two different tunnels at
// the same time — which splify 1 could not express at all.

export default function OutputsPage() {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [status, setStatus] = useState<Status | null>(null)
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])
    const [dirty, setDirty] = useState(false)

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
        const free = devices.find((d) => !Object.values(spec.outputs).some((o) => o.device === d.name))
        const name = free?.name || `out${Object.keys(spec.outputs).length + 1}`
        edit({
            ...spec,
            outputs: { ...spec.outputs, [name]: { name, kind: 'interface', device: free?.name || '' } },
        })
    }

    function setDevice(name: string, device: string) {
        if (!spec) return
        edit({ ...spec, outputs: { ...spec.outputs, [name]: { ...spec.outputs[name], device } } })
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
        try {
            const res = await rpc.specSet(JSON.stringify(spec))
            if (!res.ok) throw new Error(res.error || 'не удалось сохранить')
            const ap = await rpc.apply()
            setDirty(false)
            notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const names = Object.keys(spec.outputs)

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Выходы</CardTitle>
                        <CardDescription>
                            Куда каналы могут вести. Их может быть несколько одновременно — каждый получает
                            свою метку и таблицу маршрутизации.
                        </CardDescription>
                    </div>
                    <Button onClick={addInterface} variant="secondary" className="shrink-0">
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Добавить
                    </Button>
                </CardHeader>
                <CardContent className="space-y-2">
                    {names.length === 0 && (
                        <p className="py-6 text-center text-sm text-sp-muted-foreground">
                            Выходов нет. Добавьте туннель, чтобы каналам было куда вести.
                        </p>
                    )}
                    {names.map((name) => {
                        const o = spec.outputs[name]
                        const s = status?.outputs?.[name]
                        return (
                            <div
                                key={name}
                                className="flex flex-wrap items-center gap-3 rounded-md border border-sp-border bg-sp-card p-3"
                            >
                                <span className="font-medium">{name}</span>
                                {o.kind === 'direct' ? (
                                    <Badge variant="secondary">напрямую</Badge>
                                ) : (
                                    <select
                                        value={o.device || ''}
                                        onChange={(e) => setDevice(name, e.currentTarget.value)}
                                        className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                        aria-label={`Устройство выхода ${name}`}
                                    >
                                        <option value="">— выберите устройство —</option>
                                        {devices.map((d) => (
                                            <option key={d.name} value={d.name}>
                                                {d.name}
                                                {d.up ? '' : ' (выключен)'}
                                            </option>
                                        ))}
                                        {o.device && !devices.some((d) => d.name === o.device) && (
                                            <option value={o.device}>{o.device} (нет в системе)</option>
                                        )}
                                    </select>
                                )}

                                {/* Two facts that decide whether this output works at all. Without
                                    NAT the route applies, the counter rises, and every site behind
                                    it hangs — so it is shown here, not buried in diagnostics. */}
                                {s && (
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                        <Badge variant={s.up ? 'default' : 'destructive'}>
                                            {s.up ? 'поднят' : 'выключен'}
                                        </Badge>
                                        {s.kind === 'interface' && (
                                            <Badge variant={s.nat ? 'secondary' : 'destructive'}>
                                                {s.nat ? 'NAT есть' : 'NAT не найден'}
                                            </Badge>
                                        )}
                                        {s.mark && (
                                            <span className="text-sp-muted-foreground">
                                                метка {s.mark}, таблица {s.table}
                                            </span>
                                        )}
                                    </div>
                                )}

                                <div className="ml-auto">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Удалить выход ${name}`}
                                        onClick={() => remove(name)}
                                    >
                                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                                    </Button>
                                </div>
                            </div>
                        )
                    })}
                </CardContent>
            </Card>

            <Button onClick={save} disabled={!dirty}>
                Сохранить и применить
            </Button>
        </div>
    )
}
