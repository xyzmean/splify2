import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'
import { EMPTY_SPEC, type Output, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'

/** Какие туннели роутера splify2 берёт в работу.
 *
 *  Здесь человек отвечает на один вопрос: этот туннель мой рабочий или нет. Сам туннель
 *  (WireGuard, AmneziaWG, OpenVPN, xsteer) создаётся в сети роутера — это не наше дело и
 *  делается не здесь; наше — решить, можно ли вести в него трафик.
 *
 *  ВКЛЮЧЁННЫЙ = НАЗВАН В КАКОМ-НИБУДЬ ВЫХОДЕ, и второго места, где это хранится, нет.
 *  Отдельный список «доступных» рядом со списком выходов означал бы два источника правды:
 *  устройство помечено активным, а трафика в нём нет, потому что ни один выход его не
 *  называет. Поэтому тумблер прямо заводит выход с этим устройством и прямо его убирает. */

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/

function devList(o: Output): string[] {
    return o.devices?.length ? o.devices : o.device ? [o.device] : []
}

export default function IfacesPanel({ live }: { live: Live }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])

    useEffect(() => {
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    /** Выходы, называющие это устройство. Их может быть несколько: одно и то же устройство
     *  законно стоит и в своём выходе, и запасным в пуле. */
    const usedBy = (dev: string) =>
        Object.entries(spec.outputs).filter(([, o]) => devList(o).includes(dev))

    function turnOn(dev: string) {
        let name = dev.replace(/[^A-Za-z0-9_-]/g, '')
        if (!NAME_RE.test(name)) name = 'tunnel'
        let n = 2
        while (spec!.outputs[name]) name = `${dev}${n++}`
        edit({
            ...spec!,
            outputs: {
                ...spec!.outputs,
                [name]: { name, kind: 'interface', devices: [dev], device: dev, on_fail: 'drop' },
            },
        })
    }

    function turnOff(dev: string) {
        const outputs: Record<string, Output> = {}
        for (const [n, o] of Object.entries(spec!.outputs)) {
            const rest = devList(o).filter((d) => d !== dev)
            if (devList(o).includes(dev) && rest.length === 0) {
                const used = spec!.channels.filter((c) => c.out === n).map((c) => c.name)
                if (used.length) {
                    notify(`Выход «${n}» занят правилами: ${used.join(', ')}`, 'warning')
                    return
                }
                continue
            }
            outputs[n] = devList(o).includes(dev) ? { ...o, devices: rest, device: rest[0] } : o
        }
        edit({ ...spec!, outputs })
    }

    return (
        <div className="space-y-3">
            {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Туннельных устройств нет. Туннель создаётся в настройках сети роутера.
                </p>
            ) : (
                <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-card lg:rounded-2xl">
                    {devices.map((d) => {
                        const outs = usedBy(d.name)
                        const on = outs.length > 0
                        const live_ = d.up || d.name in (live.devs || {})
                        return (
                            <li key={d.name} className="flex select-none items-center gap-3 p-3.5 lg:p-4">
                                <span
                                    className={`h-2 w-2 shrink-0 rounded-full ${
                                        live_ ? 'bg-success' : 'bg-muted-foreground'
                                    }`}
                                    aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">{d.name}</div>
                                    <div className="truncate text-xs text-subtle">
                                        {[d.kind, on ? `в выходах: ${outs.map(([n]) => n).join(', ')}` : '']
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </div>
                                </div>
                                <Switch
                                    on={on}
                                    label={d.name}
                                    onClick={() => (on ? turnOff(d.name) : turnOn(d.name))}
                                />
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
