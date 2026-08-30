import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import Flag from '@/components/Flag'
import PoolEditor from '@/components/PoolEditor'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'
import { country } from '@/lib/geo'
import { EMPTY_SPEC, ON_FAIL_TEXT, type Output, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'

/** Выходы: во что правила ведут трафик.
 *
 *  Строка выхода читается как в дизайн-паке — «имя · через что идёт сейчас», а под ней состав
 *  и запас. Прежний вид (спойлер на каждый выход со своей настройкой внутри) отвечал на другой
 *  вопрос: он показывал, КАК выход устроен, тогда как со списка спрашивают, КУДА он ведёт и
 *  работает ли. Настройка открывается по нажатию, целым экраном. */

function devList(o: Output): string[] {
    return o.devices?.length ? o.devices : o.device ? [o.device] : []
}

export default function PoolList({ live }: { live: Live }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    /** Что правим: имя выхода, пустая строка — новый, null — список. */
    const [editing, setEditing] = useState<string | null>(null)
    const [geo, setGeo] = useState<Record<string, { cc?: string; ms?: number }>>({})

    useEffect(() => {
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
    }, [])

    const names = Object.keys(live.status?.outputs || {}).join(',')
    useEffect(() => {
        if (!names) return
        let stop = false
        /* Запомненное измерение: страна и время ответа приезжают ОДНИМ вызовом через
         * устройство выхода, и без обращения наружу — бэкенд отдаёт то, что помнит. */
        for (const n of names.split(',')) {
            rpc.outboundGeo(n, false)
                .then((g) => {
                    if (stop || (!g.cc && !g.ms)) return
                    setGeo((s) => ({ ...s, [n]: { cc: g.cc, ms: g.ms } }))
                })
                .catch(() => {})
        }
        return () => { stop = true }
    }, [names])

    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    function remove(name: string) {
        if (!spec) return
        const used = spec.channels.filter((c) => c.out === name).map((c) => c.name)
        if (used.length) {
            notify(`Выход «${name}» занят правилами: ${used.join(', ')}`, 'warning')
            return
        }
        const outputs = { ...spec.outputs }
        delete outputs[name]
        edit({ ...spec, outputs })
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    if (editing !== null) {
        return (
            <PoolEditor
                spec={spec}
                name={editing || undefined}
                live={live}
                onCancel={() => setEditing(null)}
                onSave={(next) => {
                    edit(next)
                    setEditing(null)
                }}
            />
        )
    }

    const rows = Object.entries(spec.outputs)

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Button onClick={() => setEditing('')}>
                    <Plus className="h-4 w-4" aria-hidden="true" /> Добавить выход
                </Button>
            </div>

            {rows.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Выходов нет</CardTitle>
                    </CardHeader>
                </Card>
            ) : (
                <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-card lg:rounded-2xl">
                    {rows.map(([name, o]) => {
                        const st = live.status?.outputs?.[name]
                        const g = geo[name]
                        const devs = devList(o)
                        const active = st?.device || devs[0]
                        const spare = devs.filter((d) => d !== active)
                        const rules = spec.channels.filter((c) => c.out === name).length
                        return (
                            <li
                                key={name}
                                className="flex items-start gap-3 rounded-xl p-3.5 focus-within:ring-2 focus-within:ring-primary lg:p-4"
                            >
                                <span
                                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                        o.kind === 'direct'
                                            ? 'bg-muted-foreground'
                                            : st?.up
                                              ? 'bg-success'
                                              : 'bg-destructive'
                                    }`}
                                    aria-hidden="true"
                                />
                                <button
                                    type="button"
                                    onClick={() => setEditing(name)}
                                    className="min-w-0 flex-1 bg-transparent p-0 text-left focus:outline-none focus:shadow-none"
                                >
                                    <span className="flex flex-wrap items-baseline gap-x-2">
                                        <span className="text-sm font-medium">{name}</span>
                                        {o.kind !== 'direct' && (
                                            <span className="flex items-baseline gap-1.5 text-xs text-subtle">
                                                <Flag cc={g?.cc} />
                                                {[country(g?.cc), g?.ms ? `${g.ms} мс` : '']
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </span>
                                        )}
                                        {rules > 0 && (
                                            <span className="text-[11px] text-muted-foreground">
                                                правил: {rules}
                                            </span>
                                        )}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                        {o.kind === 'direct'
                                            ? 'напрямую, мимо туннеля'
                                            : o.kind === 'vless'
                                              ? [
                                                    'подписка',
                                                    active || '',
                                                    spare.length ? `запас: ${spare.join(', ')}` : '',
                                                ]
                                                    .filter(Boolean)
                                                    .join(' · ')
                                              : [
                                                    devs.join(' → ') || 'устройство не выбрано',
                                                    `если всё упало: ${ON_FAIL_TEXT[o.on_fail || 'drop']}`,
                                                ].join(' · ')}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => remove(name)}
                                    aria-label={`удалить ${name}`}
                                    className="shrink-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-destructive focus:outline-none focus:shadow-none"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
