import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC, ON_FAIL_TEXT, type OnFail, type Output, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'
import VlessPanel from '@/components/VlessPanel'
import ObfsPanel from '@/components/ObfsPanel'

// Outputs are named, and channels point at the NAME. That indirection is what lets
// several tunnels coexist: failover re-points an output's device without touching a
// single channel, and two channels can lead to two different tunnels at once.
//
// Renaming therefore has to rewrite every channel that points at the old name — a
// dangling `out` is a spec the engine refuses, and the UI is the only place that knows
// both sides.

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/

/** Состояние берётся из ОБЩЕГО опроса, а не запрашивается здесь.
 *
 *  Свой запрос давал второе мгновение на одном экране: закреплённая колонка говорила «поднят», а
 *  строка рядом — «выключен», и оба были правдой, снятой в разные секунды. */
export default function OutboundsTab({ live }: { live: Live }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)
    /** Умеет ли установленный движок VLESS. Спрашиваем, а не предполагаем: предлагать
     *  выход, который движок отвергнет при сохранении, — это заставить человека спорить
     *  с интерфейсом вместо того, чтобы поставить нужный пакет. */
    const [hasVless, setHasVless] = useState<boolean | null>(null)
    /** Имена выходов, про которые движок уже знает. Панель vless спрашивает у него узлы,
     *  а для несохранённого выхода спрашивать нечего. */
    const [saved, setSaved] = useState<Set<string>>(new Set())
    /** Names being typed. Held separately so a half-typed name never lands in the spec
     *  and orphans the channels pointing at the old one. */
    const [draft, setDraft] = useState<Record<string, string>>({})

    useEffect(() => {
        rpc.specGet()
            .then((s) => { setSpec(s); setSaved(new Set(Object.keys(s.outputs || {}))) })
            .catch(() => setSpec(EMPTY_SPEC))
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
        rpc.engine().then((e) => setHasVless(!!e.vless)).catch(() => setHasVless(null))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    function addInterface() {
        if (!spec) return
        const taken = new Set(Object.values(spec.outputs).map((o) => o.device))
        const free = devices.find((d) => !taken.has(d.name))
        /* Без свободного устройства выход создавать нечестно: спека с пустым devices
         * отвергается движком при сохранении, и человек спорил бы с интерфейсом,
         * который сам это предложил (I-020). Ранний отказ со словами — дешевле. */
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
        // sub_file ставится сразу: движок отвергает выход vless без него, и предлагать
        // человеку сохранить заведомо неприменимую спеку значило бы упереться в ошибку
        // там, где путь известен заранее. Файл появится, когда подписку загрузят.
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
        // A `direct` output is how a list is EXCLUDED: a channel above the others that
        // claims those addresses and leaves them on the normal path.
        edit({ ...spec, outputs: { ...spec.outputs, direct: { name: 'direct', kind: 'direct' } } })
    }

    function patch(name: string, o: Output) {
        if (!spec) return
        edit({ ...spec, outputs: { ...spec.outputs, [name]: o } })
    }

    /** Устройства выхода. Порядок — приоритет, поэтому редактируется стрелками, а не
     *  списком-множеством: какой туннель основной, а какой запасной, решает именно он. */
    function devList(o: Output): string[] {
        return o.devices?.length ? o.devices : o.device ? [o.device] : []
    }

    function setDevs(name: string, o: Output, next: string[]) {
        // device остаётся первым кандидатом: движок выведет одно из другого, но спека
        // должна быть однозначной и без него до первого прохода failover.
        patch(name, { ...o, devices: next, device: next[0] || '' })
    }

    function moveDev(name: string, o: Output, i: number, d: number) {
        const list = devList(o).slice()
        const j = i + d
        if (j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j], list[i]]
        setDevs(name, o, list)
    }

    function rename(from: string) {
        if (!spec) return
        const to = (draft[from] ?? '').trim()
        setDraft({ ...draft, [from]: '' })
        if (!to || to === from) return
        if (!NAME_RE.test(to)) { notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning'); return }
        if (spec.outputs[to]) { notify(`Выход «${to}» уже есть`, 'warning'); return }
        // Rebuilt rather than mutated so the ORDER of outputs survives a rename. Marks
        // are assigned BY NAME from a persisted registry (spec.c registry_assign), not
        // by position — so a rename means the output gets a fresh mark, and the engine
        // sweeps the old name's rule on the next apply. Order still matters for which
        // free mark bit a NEW output picks up.
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
            /* Теперь движок знает про эти выходы — панель VLESS может спрашивать у него
             * узлы. До сохранения он о выходе не слышал, и вопрос был бы бессмысленным. */
            setSaved(new Set(Object.keys(spec.outputs)))
            notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
            live.refresh()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

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
                        {/* Кнопка есть всегда, но выключена без нужного пакета — и говорит,
                            какого именно. Спрятать её значило бы оставить человека без
                            объяснения, почему у него нет того, что описано в документации. */}
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
                            примерно втрое больше.
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
                                        Имя
                                        <div className="flex gap-1">
                                            <input
                                                value={draft[name] ?? name}
                                                onChange={(e) => setDraft({ ...draft, [name]: e.currentTarget.value })}
                                                onKeyDown={(e) => e.key === 'Enter' && rename(name)}
                                                className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
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

                                    {/* on_fail есть у всякого выхода С УСТРОЙСТВОМ, а не
                                        только у interface: у vless последствие поломки ровно
                                        то же, и прятать настройку значило бы оставить его на
                                        умолчании, о котором человек не знает. */}
                                    {o.kind !== 'direct' ? (
                                        <label className="flex flex-col gap-1 text-xs">
                                            Если всё упало
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
                                        <Badge variant="secondary">напрямую, без устройства</Badge>
                                    )}
                                    {o.kind === 'vless' && <Badge variant="secondary">VLESS/Reality</Badge>}

                                    <div className="ml-auto">
                                        <Button variant="ghost" size="icon" aria-label={`Удалить выход ${name}`}
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

                                {/* Обфускация транспорта — под именем и до списка устройств:
                                    сначала «чем доставляется», потом «куда». Только для
                                    interface: у vless свой транспорт внутри движка, у direct
                                    транспорта нет вовсе. */}
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
                                                const live = devices.find((x) => x.name === dev)
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
                                                        {!live && (
                                                            <Badge variant="destructive">нет в системе</Badge>
                                                        )}
                                                        {live && !live.up && (
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
                                            {/* Without NAT the route applies, the counter rises, and every
                                                site behind it hangs — so it is shown here, not buried. */}
                                            <Badge variant={s.nat ? 'secondary' : 'destructive'}>
                                                {s.nat ? 'NAT есть' : 'NAT не найден'}
                                            </Badge>
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

            <div className="flex items-center gap-2">
                <Button onClick={save} disabled={busy || !dirty}>
                    {busy ? 'Применяем…' : 'Сохранить и применить'}
                </Button>
                {dirty && <span className="text-xs text-warning">Есть несохранённые изменения</span>}
            </div>
        </div>
    )
}
