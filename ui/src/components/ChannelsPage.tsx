import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC, type Channel, type Manifest, type Spec } from '@/lib/model'

// The central page, because a channel is the unit of the whole system: (who, what)
// -> where. Rendered as a RANKED list rather than a set of switches — the order is
// the priority, first match wins, and a UI that hid that would make the one thing a
// user must understand invisible.

function describe(ch: Channel, lists: Manifest | null): string {
    if (ch.match.any) return 'весь трафик'
    const file = ch.match.prefixes_file || ch.match.domains_file || ''
    const known = lists?.lists.find((l) => l.file === file || file.endsWith('/' + l.file))
    const base = known ? known.name : file.split('/').pop() || 'список не выбран'
    if (ch.match.domains_file) {
        return `домены: ${base}${ch.match.mode === 'realip' ? ' (realip)' : ''}`
    }
    return `адреса: ${base}`
}

export default function ChannelsPage() {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [lists, setLists] = useState<Manifest | null>(null)
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.specGet().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.lists().then(setLists).catch(() => setLists(null))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    function move(i: number, delta: number) {
        if (!spec) return
        const j = i + delta
        if (j < 0 || j >= spec.channels.length) return
        const channels = spec.channels.slice()
        const tmp = channels[i]
        channels[i] = channels[j]
        channels[j] = tmp
        edit({ ...spec, channels })
    }

    function remove(i: number) {
        if (!spec) return
        edit({ ...spec, channels: spec.channels.filter((_, k) => k !== i) })
    }

    function add() {
        if (!spec) return
        const out = Object.keys(spec.outputs)[0]
        if (!out) {
            notify('Сначала добавьте выход — каналу некуда вести', 'warning')
            return
        }
        const name = `channel${spec.channels.length + 1}`
        edit({ ...spec, channels: [...spec.channels, { name, match: {}, out }] })
    }

    async function save(andApply: boolean) {
        if (!spec) return
        setBusy(true)
        try {
            const res = await rpc.specSet(JSON.stringify(spec))
            if (!res.ok) throw new Error(res.error || 'не удалось сохранить')
            setDirty(false)
            if (andApply) {
                const ap = await rpc.apply()
                // The engine's own words, warnings included: it knows things the UI
                // cannot, such as a tunnel with no NAT that will swallow traffic.
                notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
            } else {
                notify('Сохранено. Изменения вступят в силу после применения')
            }
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (!spec) {
        return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>
    }

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Каналы</CardTitle>
                        <CardDescription>
                            Проверяются сверху вниз, побеждает первое совпадение. Порядок — это приоритет:
                            адрес, попавший в два канала, уйдёт в тот, что выше.
                        </CardDescription>
                    </div>
                    <Button onClick={add} variant="secondary" className="shrink-0">
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Добавить
                    </Button>
                </CardHeader>
                <CardContent>
                    {spec.channels.length === 0 ? (
                        <p className="py-6 text-center text-sm text-sp-muted-foreground">
                            Каналов нет — весь трафик идёт напрямую.
                        </p>
                    ) : (
                        <ol className="space-y-2">
                            {spec.channels.map((ch, i) => {
                                const out = spec.outputs[ch.out]
                                return (
                                    <li
                                        key={`${ch.name}-${i}`}
                                        className="flex items-center gap-3 rounded-md border border-sp-border bg-sp-card p-3"
                                    >
                                        <span className="w-6 text-center text-sm text-sp-muted-foreground">
                                            {i + 1}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="truncate font-medium">{ch.name}</span>
                                                <Badge variant="secondary">{describe(ch, lists)}</Badge>
                                            </div>
                                            <div className="mt-1 text-xs text-sp-muted-foreground">
                                                {ch.from?.length ? ch.from.join(', ') : 'все клиенты'}
                                                {' → '}
                                                {out
                                                    ? out.kind === 'direct'
                                                        ? `${ch.out} (напрямую)`
                                                        : `${ch.out} → ${out.device}`
                                                    : `${ch.out} — выход не найден`}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Поднять приоритет"
                                                disabled={i === 0}
                                                onClick={() => move(i, -1)}
                                            >
                                                <ArrowUp className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Опустить приоритет"
                                                disabled={i === spec.channels.length - 1}
                                                onClick={() => move(i, 1)}
                                            >
                                                <ArrowDown className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Удалить канал"
                                                onClick={() => remove(i)}
                                            >
                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </li>
                                )
                            })}
                        </ol>
                    )}
                </CardContent>
            </Card>

            <div className="flex items-center gap-2">
                <Button onClick={() => save(true)} disabled={busy || !dirty}>
                    Сохранить и применить
                </Button>
                <Button variant="secondary" onClick={() => save(false)} disabled={busy || !dirty}>
                    Только сохранить
                </Button>
                {dirty && (
                    <span className="text-xs text-sp-warning">Есть несохранённые изменения</span>
                )}
            </div>
        </div>
    )
}
