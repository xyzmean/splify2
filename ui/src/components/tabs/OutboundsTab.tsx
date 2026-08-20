import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending, usePending } from '@/lib/pending'
import { EMPTY_SPEC, ON_FAIL_TEXT, type OnFail, type Output, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'
import { Hint } from '@/components/ui/hint'
import VlessPanel from '@/components/VlessPanel'
import ObfsPanel from '@/components/ObfsPanel'

// Outputs are named, and channels point at the NAME. That indirection is what lets
// several tunnels coexist: failover re-points an output's device without touching a
// single channel, and two channels can lead to two different tunnels at once.
//
// Кнопки «Сохранить и применить» здесь больше нет: правки уходят в spec_set сами
// (lib/pending.ts), применяет плавающая пилюля. Переименование — по Enter или
// расфокусу, без отдельной кнопки: черновик по-прежнему живёт отдельно от спеки,
// чтобы полунабранное имя не осиротило каналы.

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/

export default function OutboundsTab({ live }: { live: Live }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])
    const [hasVless, setHasVless] = useState<boolean | null>(null)
    /** Names being typed. Held separately so a half-typed name never lands in the spec
     *  and orphans the channels pointing at the old one. */
    const [draft, setDraft] = useState<Record<string, string>>({})
    /** Имена выходов, про которые движок уже знает, — из снимка применённого:
     *  панель vless спрашивает узлы у движка, а для непримененного выхода спрашивать
     *  нечего. Обновляется само после каждого apply (usePending перерисовывает). */
    const { applied } = usePending()
    const saved = new Set(Object.keys(applied?.outputs || {}))

    useEffect(() => {
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
        rpc.engine().then((e) => setHasVless(!!e.vless)).catch(() => setHasVless(null))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    function addInterface() {
        if (!spec) return
        /* Занятое считается по ВСЕМ кандидатам выхода, а не по активному устройству.
         * `device` ставит движок, когда failover выберет активное, — у выхода, только
         * что созданного здесь, этого поля нет вовсе, и множество занятых состояло из
         * одного `undefined`. Второе нажатие снова брало первое устройство: человек с
         * двумя туннелями получал два выхода в один и тот же, а второй туннель не
         * появлялся ни в одном правиле (splify2#12). Кандидаты в запасе тоже заняты —
         * выход, ведущий в устройство при отказе основного, владеет им не меньше. */
        const taken = new Set(Object.values(spec.outputs).flatMap((o) => devList(o)))
        const free = devices.find((d) => !taken.has(d.name))
        if (!free) {
            notify('Свободных туннельных устройств нет — поднимите туннель (wireguard, ' +
                   'amneziawg) или освободите устройство у другого выхода', 'warning')
            return
        }
        let name = free?.name?.replace(/[^A-Za-z0-9_-]/g, '') || 'tunnel'
        let n = 2
        while (spec.outputs[name]) name = `${free?.name || 'tunnel'}${n++}`
        edit({
            ...spec,
            outputs: {
                ...spec.outputs,
                [name]: { name, kind: 'interface', devices: free ? [free.name] : [], on_fail: 'drop' },
            },
        })
    }

    function addVless() {
        if (!spec) return
        let name = 'vless'
        let n = 2
        while (spec.outputs[name]) name = `vless${n++}`
        edit({
            ...spec,
            outputs: {
                ...spec.outputs,
                [name]: {
                    name, kind: 'vless', sub_file: '/etc/steer/sub.txt',
                    node: -1, on_fail: 'drop',
                },
            },
        })
    }

    function addDirect() {
        if (!spec) return
        if (spec.outputs.direct) { notify('Выход «direct» уже есть', 'warning'); return }
        edit({ ...spec, outputs: { ...spec.outputs, direct: { name: 'direct', kind: 'direct' } } })
    }

    function patch(name: string, o: Output) {
        if (!spec) return
        edit({ ...spec, outputs: { ...spec.outputs, [name]: o } })
    }

    function devList(o: Output): string[] {
        return o.devices?.length ? o.devices : o.device ? [o.device] : []
    }

    function setDevs(name: string, o: Output, next: string[]) {
        patch(name, { ...o, devices: next, device: next[0] || '' })
    }

    function moveDev(name: string, o: Output, i: number, d: number) {
        const list = devList(o).slice()
        const j = i + d
        if (j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j], list[i]]
        setDevs(name, o, list)
    }

    /** Переименование — по Enter или расфокусу. Молча возвращаем прежнее имя, если
     *  новое пустое или не изменилось; о недопустимом говорим, а не откатываем молча. */
    function rename(from: string) {
        if (!spec) return
        const to = (draft[from] ?? '').trim()
        setDraft({ ...draft, [from]: '' })
        if (!to || to === from) return
        if (!NAME_RE.test(to)) { notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning'); return }
        if (spec.outputs[to]) { notify(`Выход «${to}» уже есть`, 'warning'); return }
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

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    const names = Object.keys(spec.outputs)

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Выходы</CardTitle>
                    <CardDescription>
                        Куда правила могут вести. Несколько выходов работают одновременно — у каждого
                        своя{' '}
                        <Hint tip="Каждый выход получает метку и таблицу маршрутизации в ядре. Правило указывает на имя выхода, а не на устройство — смена туннеля правил не трогает.">
                            метка
                        </Hint>
                        . Изменения сохраняются сами.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="mb-2 flex flex-wrap gap-2">
                        <Button onClick={addInterface} variant="secondary">
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Туннель
                        </Button>
                        <Button
                            onClick={addVless}
                            variant="secondary"
                            disabled={hasVless === false}
                            title={hasVless === false
                                ? 'Нужен пакет steer-extended: в базовой сборке клиента VLESS нет'
                                : undefined}
                        >
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> VLESS
                        </Button>
                        <Button onClick={addDirect} variant="secondary">
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Напрямую
                        </Button>
                    </div>

                    {hasVless === false && (
                        <p className="text-xs text-muted-foreground">
                            Установленный движок без VLESS. Чтобы выходы VLESS стали доступны, нужен
                            пакет <code>steer-extended</code> — он заменяет <code>steer</code> и весит
                            примерно вдвое больше: ~500 КБ на флеше против ~250 КБ.
                        </p>
                    )}

                    {names.length === 0 && (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            Выходов нет. «Туннель» — трафик уходит в уже существующее устройство
                            (wireguard, amneziawg). «VLESS» — движок поднимает своё, по подписке.
                            «Напрямую» — канал забирает адреса себе и оставляет их на обычном пути;
                            так исключают список.
                        </p>
                    )}

                    {names.map((name) => {
                        const o = spec.outputs[name]
                        const s = live.status?.outputs?.[name]
                        const usedBy = spec.channels.filter((c) => c.out === name).map((c) => c.name)
                        return (
                            <div key={name} className="space-y-2 rounded-md border border-border bg-card p-3">
                                <div className="flex flex-wrap items-end gap-3">
                                    <label className="flex flex-col gap-1 text-xs">
                                        <span>
                                            Имя{' '}
                                            <span className="text-muted-foreground">
                                                · Enter или клик мимо — сохранится
                                            </span>
                                        </span>
                                        <input
                                            value={draft[name] || name}
                                            onChange={(e) => setDraft({ ...draft, [name]: e.currentTarget.value })}
                                            onBlur={() => rename(name)}
                                            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                            className="w-36 rounded-md border border-border bg-background px-2 py-1 text-sm transition-colors focus-visible:border-primary focus-visible:outline-none"
                                            aria-label={`Имя выхода ${name}`}
                                        />
                                    </label>

                                    {o.kind !== 'direct' ? (
                                        <label className="flex flex-col gap-1 text-xs">
                                            <Hint tip="Что делать с трафиком, когда ни одно устройство выхода не работает. «Остановить» безопаснее: трафик не утечёт в открытый интернет.">
                                                Если всё упало
                                            </Hint>
                                            <select
                                                value={o.on_fail || 'drop'}
                                                onChange={(e) => patch(name, { ...o, on_fail: e.currentTarget.value as OnFail })}
                                                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                                            >
                                                {(Object.keys(ON_FAIL_TEXT) as OnFail[]).map((k) => (
                                                    <option key={k} value={k}>{ON_FAIL_TEXT[k]}</option>
                                                ))}
                                            </select>
                                        </label>
                                    ) : (
                                        <Hint tip="Так исключают сервис: правило выше остальных забирает его адреса и оставляет на обычном пути, мимо туннеля.">
                                            <Badge variant="secondary">напрямую, без устройства</Badge>
                                        </Hint>
                                    )}
                                    {o.kind === 'vless' && <Badge variant="secondary">VLESS/Reality</Badge>}

                                    <div className="ml-auto">
                                        <Button variant="ghost" size="icon" aria-label={`Удалить выход ${name}`}
                                                className="hover:bg-destructive/10 hover:text-destructive"
                                                onClick={() => remove(name)}>
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </div>


                                {o.kind === 'vless' && (
                                    <VlessPanel
                                        name={name}
                                        output={o}
                                        onChange={(next) => patch(name, next)}
                                        saved={saved.has(name)}
                                    />
                                )}

                                {o.kind === 'interface' && (
                                    <ObfsPanel output={o} onChange={(next) => patch(name, next)} />
                                )}

                                {o.kind === 'interface' && (() => {
                                    const list = devList(o)
                                    const free = devices.filter((d) => !list.includes(d.name))
                                    return (
                                        <div className="rounded-md border border-border p-2">
                                            <div className="mb-1 text-xs text-muted-foreground">
                                                Устройства по приоритету — трафик пойдёт через первое
                                                работающее, и сам вернётся наверх, когда основное оживёт.
                                            </div>
                                            {list.length === 0 && (
                                                <p className="py-1 text-xs text-warning">
                                                    Устройств нет — выход никуда не ведёт.
                                                </p>
                                            )}
                                            {list.map((dev, di) => {
                                                const liveDev = devices.find((x) => x.name === dev)
                                                const active = s?.device === dev
                                                return (
                                                    <div key={dev} className="flex items-center gap-2 py-0.5 text-sm">
                                                        <span className="w-4 text-center text-xs text-muted-foreground">
                                                            {di + 1}
                                                        </span>
                                                        <span className={active ? 'font-medium text-primary' : ''}>
                                                            {dev}
                                                        </span>
                                                        {active && <Badge variant="default">активно</Badge>}
                                                        {!liveDev && (
                                                            <Badge variant="destructive">нет в системе</Badge>
                                                        )}
                                                        {liveDev && !liveDev.up && (
                                                            <Badge variant="secondary">выключено</Badge>
                                                        )}
                                                        <div className="ml-auto flex items-center gap-1">
                                                            <Button variant="ghost" size="icon" aria-label="Выше"
                                                                    disabled={di === 0}
                                                                    onClick={() => moveDev(name, o, di, -1)}>
                                                                <ArrowUp className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                            <Button variant="ghost" size="icon" aria-label="Ниже"
                                                                    disabled={di === list.length - 1}
                                                                    onClick={() => moveDev(name, o, di, 1)}>
                                                                <ArrowDown className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                            <Button variant="ghost" size="icon" aria-label={`Убрать ${dev}`}
                                                                    className="hover:bg-destructive/10 hover:text-destructive"
                                                                    onClick={() => setDevs(name, o, list.filter((x) => x !== dev))}>
                                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                            {free.length > 0 && (
                                                <select
                                                    value=""
                                                    onChange={(e) => {
                                                        const v = e.currentTarget.value
                                                        if (v) setDevs(name, o, [...list, v])
                                                    }}
                                                    className="mt-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                                                    aria-label={`Добавить устройство в ${name}`}
                                                >
                                                    <option value="">+ добавить устройство</option>
                                                    {free.map((d) => (
                                                        <option key={d.name} value={d.name}>
                                                            {d.name}{d.up ? '' : ' (выключено)'}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>
                                    )
                                })()}

                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                    {s && o.kind === 'interface' && (
                                        <>
                                            <Badge variant={s.up ? 'default' : 'destructive'}>
                                                {s.up ? 'поднят' : 'выключен'}
                                            </Badge>
                                            <Hint tip="Без NAT маршрут применяется, счётчик растёт, а сайты за туннелем висят — поэтому это видно здесь, а не спрятано.">
                                                <Badge variant={s.nat ? 'secondary' : 'destructive'}>
                                                    {s.nat ? 'NAT есть' : 'NAT не найден'}
                                                </Badge>
                                            </Hint>
                                            {o.obfs && (
                                                <Badge variant="secondary">поверх TCP</Badge>
                                            )}
                                            {s.mark && (
                                                <span className="text-muted-foreground">
                                                    метка {s.mark}, таблица {s.table}
                                                </span>
                                            )}
                                        </>
                                    )}
                                    <span className="text-muted-foreground">
                                        {usedBy.length ? `каналы: ${usedBy.join(', ')}` : 'каналов нет'}
                                    </span>
                                </div>
                            </div>
                        )
                    })}
                </CardContent>
            </Card>
        </div>
    )
}
