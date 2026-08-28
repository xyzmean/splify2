import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending, usePending } from '@/lib/pending'
import { EMPTY_SPEC, ON_FAIL_TEXT, type OnFail, type Output, type Spec } from '@/lib/model'
import { human, type Live } from '@/lib/live'
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
    /** Какие выходы раскрыты. Выход целиком — это подписка, узлы, обфускация и список
     *  устройств; развёрнутыми все они занимали экран целиком, и найти нужный можно было
     *  только прокруткой. Свёрнутый выход отвечает на вопрос «работает ли и куда ведёт»
     *  одной строкой, а настройка открывается по нажатию.
     *
     *  Единственный выход раскрыт сам: сворачивать то, что и так одно, значит требовать
     *  нажатие ни за что. Только что созданный — тоже: его для того и создали. */
    const [open, setOpen] = useState<Record<string, boolean>>({})
    /** Отклик по выходам. Спрашивается ПО ОДНОМУ и не по кругу: каждая проверка упирается в
     *  таймаут до шести секунд, и опрос десятка выходов каждые пять секунд держал бы роутер
     *  занятым проверками вместо работы. Один проход при открытии раздела, дальше — по кнопке.
     *
     *  Здесь, а не отдельной карточкой сверху: карточка «Сейчас работает» повторяла имя,
     *  состояние и устройство каждого выхода прямо над его же настройкой — два места об одном
     *  и том же, которые расходятся на глазах. Теперь это одна строка: шапка спойлера. */
    const [pings, setPings] = useState<Record<string, { ms: number; state: string }>>({})
    const [pinging, setPinging] = useState(false)
    const asked = useRef(false)

    useEffect(() => {
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
        rpc.engine().then((e) => setHasVless(!!e.vless)).catch(() => setHasVless(null))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    /** Создать выход и сразу его раскрыть: настройка — это то, зачем его создали. */
    function add(name: string, o: Output, cur: Spec) {
        edit({ ...cur, outputs: { ...cur.outputs, [name]: o } })
        setOpen((s2) => ({ ...s2, [name]: true }))
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
        add(name, { name, kind: 'interface', devices: free ? [free.name] : [], on_fail: 'drop' }, spec)
    }

    function addVless() {
        if (!spec) return
        let name = 'vless'
        let n = 2
        while (spec.outputs[name]) name = `vless${n++}`
        add(name, { name, kind: 'vless', sub_file: '/etc/steer/sub.txt', node: -1, on_fail: 'drop' }, spec)
    }

    function addDirect() {
        if (!spec) return
        if (spec.outputs.direct) { notify('Выход «direct» уже есть', 'warning'); return }
        add('direct', { name: 'direct', kind: 'direct' }, spec)
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


    /** Отклик по всем выходам, по одному за раз. */
    async function probeAll(list: string[], kinds: Record<string, string>) {
        setPinging(true)
        /* Прежние значения гасим СРАЗУ: пока идёт проверка, старое число неотличимо от
         * свежего, и кнопка выглядела так, будто ничего не делает. */
        setPings({})
        let failed: string | null = null
        try {
            for (const n of list) {
                if (kinds[n] === 'direct') continue
                try {
                    const r = await rpc.outboundProbe(n)
                    setPings((p) => ({ ...p, [n]: { ms: r.ms, state: r.state } }))
                } catch (e) {
                    /* Отказ метода — не то же, что «узел не ответил», и путать их нельзя:
                     * первое чинится обновлением splify2, второе — сменой узла. */
                    failed = String(e instanceof Error ? e.message : e)
                    setPings((p) => ({ ...p, [n]: { ms: -1, state: 'не спросить' } }))
                }
            }
            if (failed) notify(`Проверка недоступна: ${failed}`, 'error')
        } finally {
            setPinging(false)
        }
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    const names = Object.keys(spec.outputs)
    const kinds = Object.fromEntries(names.map((n) => [n, spec.outputs[n].kind]))

    /* Один раз, когда выходы стали известны. Не на каждый их приход: спека перерисовывается
     * на каждую правку, и проверка запускалась бы заново после каждого нажатия. */
    if (!asked.current && names.length > 0) {
        asked.current = true
        void probeAll(names, kinds)
    }

    return (
        /* Карточки вокруг раздела больше нет: имя «Выходы» печатает оболочка, и заголовок
           карточки повторял его слово в слово прямо под ним. Заодно на телефоне пропала
           коробка в коробке — от неё оставалось меньше трёхсот пикселей на содержимое. */
        <div className="space-y-3">
            <div className="space-y-3">
                {/* Пояснение и действие в одной строке на широком экране и в две на узком:
                    пока строка не переносилась, кнопка справа сжимала текст до колонки в одно
                    слово шириной — на снимке телефона это была стена из переносов. */}
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <p className="min-w-[14rem] flex-1 text-xs leading-relaxed text-muted-foreground">
                        Куда правила могут вести. Несколько выходов работают одновременно — у
                        каждого своя{' '}
                        <Hint tip="Каждый выход получает метку и таблицу маршрутизации в ядре. Правило указывает на имя выхода, а не на устройство — смена туннеля правил не трогает.">
                            метка
                        </Hint>
                        . Изменения сохраняются сами.
                    </p>
                    {names.length > 0 && (
                        <Button
                            variant="secondary"
                            size="sm"
                            className="shrink-0"
                            onClick={() => probeAll(names, kinds)}
                            disabled={pinging}
                        >
                            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                            {pinging ? 'проверяем…' : 'проверить отклик'}
                        </Button>
                    )}
                </div>
                <div className="space-y-2">
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
                        const isOpen = open[name] ?? names.length === 1
                        const dev = s?.device
                        const stat = dev ? live.devs?.[dev] : undefined
                        const p = pings[name]
                        /* Расшифровка выхода в одну строку: правило указывает на ИМЯ, и без
                         * второй половины строки имя ничего не значит для того, кто настраивал
                         * роутер месяц назад. */
                        const what =
                            o.kind === 'direct'
                                ? 'напрямую, мимо туннеля'
                                : o.kind === 'vless'
                                  ? `VLESS/Reality${dev ? ` · ${dev}` : ''}`
                                  : dev
                                    ? `свой туннель · ${dev}`
                                    : 'устройство не назначено'
                        return (
                            <div key={name} className="overflow-hidden rounded-xl border border-border bg-card">
                                {/* Шапка — она же строка состояния: точка, имя, расшифровка, объём
                                    и отклик. Свёрнутый выход отвечает на «работает ли и куда
                                    ведёт» без единого нажатия. */}
                                <button
                                    type="button"
                                    aria-expanded={isOpen}
                                    onClick={() => setOpen({ ...open, [name]: !isOpen })}
                                    className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 p-3 text-left text-[13px] transition-colors hover:bg-accent"
                                >
                                    <ChevronRight
                                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                                            isOpen ? 'rotate-90' : ''
                                        }`}
                                        aria-hidden="true"
                                    />
                                    <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                            o.kind === 'direct'
                                                ? 'bg-muted-foreground'
                                                : s?.up
                                                  ? 'bg-success'
                                                  : 'bg-destructive'
                                        }`}
                                        aria-hidden="true"
                                    />
                                    <span className="font-medium">{name}</span>
                                    <span className="min-w-0 truncate text-muted-foreground">{what}</span>
                                    {o.obfs && <Badge variant="secondary">поверх TCP</Badge>}
                                    <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px]">
                                        {stat && (
                                            <span className="hidden text-muted-foreground sm:inline">
                                                ↓ {human(Number(stat.rx))} · ↑ {human(Number(stat.tx))}
                                            </span>
                                        )}
                                        <span
                                            className={
                                                p && p.ms < 0
                                                    ? 'text-destructive'
                                                    : p
                                                      ? 'text-success'
                                                      : 'text-muted-foreground'
                                            }
                                        >
                                            {/* Пока идёт проверка — «…» вместо ПРЕЖНЕГО числа:
                                                старое число выглядит свежим, и понять, ответил ли
                                                узел только что, нельзя.

                                                У `direct` здесь пусто: «напрямую» уже сказано
                                                расшифровкой слева, и на узком экране второе такое
                                                же слово переносилось на свою строку. */}
                                            {o.kind === 'direct'
                                                ? ''
                                                : p
                                                  ? p.ms < 0
                                                      ? p.state
                                                      : `${p.ms} мс`
                                                  : pinging
                                                    ? '…'
                                                    : s?.up
                                                      ? 'поднят'
                                                      : 'нет устройства'}
                                        </span>
                                    </span>
                                </button>

                                {isOpen && (
                                <div className="space-y-2 border-t border-border p-3">
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
                                            className="w-36 rounded-lg border border-border bg-background px-2 py-1 text-sm transition-colors focus-visible:border-primary focus-visible:outline-none"
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
                                                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
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
                                        <div className="rounded-xl border border-border p-2">
                                            <div className="mb-1 text-xs text-muted-foreground">
                                                Устройства по приоритету — трафик пойдёт через первое
                                                работающее, и сам вернётся наверх, когда основное оживёт.
                                            </div>
                                            {list.length === 0 && (
                                                <p className="py-1 text-xs text-warning">
                                                    Устройств нет — выход никуда не ведёт.
                                                </p>
                                            )}
                                            {list.map((d2, di) => {
                                                const liveDev = devices.find((x) => x.name === d2)
                                                const active = s?.device === d2
                                                return (
                                                    <div key={d2} className="flex items-center gap-2 py-0.5 text-sm">
                                                        <span className="w-4 text-center text-xs text-muted-foreground">
                                                            {di + 1}
                                                        </span>
                                                        <span className={active ? 'font-medium text-primary' : ''}>
                                                            {d2}
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
                                                            <Button variant="ghost" size="icon" aria-label={`Убрать ${d2}`}
                                                                    className="hover:bg-destructive/10 hover:text-destructive"
                                                                    onClick={() => setDevs(name, o, list.filter((x) => x !== d2))}>
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
                                                    className="mt-1 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                                                    aria-label={`Добавить устройство в ${name}`}
                                                >
                                                    <option value="">+ добавить устройство</option>
                                                    {free.map((d3) => (
                                                        <option key={d3.name} value={d3.name}>
                                                            {d3.name}{d3.up ? '' : ' (выключено)'}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>
                                    )
                                })()}

                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                    {s && o.kind === 'interface' && (
                                        <Hint tip="Без NAT маршрут применяется, счётчик растёт, а сайты за туннелем висят — поэтому это видно здесь, а не спрятано.">
                                            <Badge variant={s.nat ? 'secondary' : 'destructive'}>
                                                {s.nat ? 'NAT есть' : 'NAT не найден'}
                                            </Badge>
                                        </Hint>
                                    )}
                                    {s?.mark && (
                                        <span className="text-muted-foreground">
                                            метка {s.mark}, таблица {s.table}
                                        </span>
                                    )}
                                    <span className="text-muted-foreground">
                                        {usedBy.length ? `каналы: ${usedBy.join(', ')}` : 'каналов нет'}
                                    </span>
                                </div>
                                </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
