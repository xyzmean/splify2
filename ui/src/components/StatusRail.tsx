import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Activity, Cpu, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { human, type Live } from '@/lib/live'

/** Закреплённое состояние: то, что верно независимо от того, что человек делает справа.
 *
 *  Отдельной колонкой, а не карточкой сверху, по одной причине: вопрос «работает ли» человек
 *  задаёт ПОСРЕДИ работы — редактируя правило, выбирая узел, глядя на каталог. Прежде для
 *  ответа надо было уйти на другую вкладку и вернуться, то есть потерять то, что набрал.
 *
 *  Здесь нет ни одного своего мнения о работоспособности: всё, что показано, приходит от
 *  движка. Два ответа на «работает ли» — это на один ответ больше, чем нужно. */

/** Итог по всему: сначала поломки движка, потом предупреждения, потом «работает».
 *
 *  Порядок именно такой, потому что зелёная надпись сверху при красной проверке ниже учит не
 *  верить надписи. */
function verdict(live: Live) {
    if (live.error) return { text: 'Движок не отвечает', tone: 'bad' as const, why: live.error }
    if (live.diag?.fail) return { text: 'Есть поломки', tone: 'bad' as const, why: `проверок с отказом: ${live.diag.fail}` }
    if (live.diag?.warn) return { text: 'Работает', tone: 'warn' as const, why: `есть о чём знать: ${live.diag.warn}` }
    if (!live.status) return { text: 'Загрузка…', tone: 'idle' as const, why: '' }
    return { text: 'Работает', tone: 'good' as const, why: '' }
}

/** «4 ч 12 мин» — то, как об этом говорят. Секунды показываем только первую минуту: дальше они
 *  ничего не добавляют, а строку удлиняют. */
function uptimeText(sec: number) {
    if (!(sec > 0)) return null
    if (sec < 60) return `${sec} с`
    const m = Math.floor(sec / 60) % 60
    const h = Math.floor(sec / 3600) % 24
    const d = Math.floor(sec / 86400)
    if (d) return `${d} д ${h} ч`
    if (h) return `${h} ч ${m} мин`
    return `${m} мин`
}

const DOT: Record<string, string> = {
    good: 'bg-sp-success',
    warn: 'bg-sp-warning',
    bad: 'bg-sp-destructive',
    idle: 'bg-sp-muted-foreground',
}

export default function StatusRail({ live, onGoDiag }: { live: Live; onGoDiag: () => void }) {
    const [busy, setBusy] = useState(false)
    /* Сведения о сборке — из общего опроса: свой запрос здесь запускал бы движок ещё раз, и на
     * роутере с 64 МБ это процесс ради неменяющегося числа. */
    const eng = live.build

    const v = verdict(live)
    const outputs = Object.entries(live.status?.outputs || {})
    /* Отклик спрашивается ПО ОДНОМУ выходу за раз и не по кругу: каждая проверка упирается в
     * таймаут до шести секунд, и опрос десятка выходов каждые пять секунд держал бы роутер
     * занятым проверками вместо работы. Поэтому один проход по списку при открытии страницы, а
     * дальше — только по кнопке. */
    const [pings, setPings] = useState<Record<string, { ms: number; state: string }>>({})
    const [pinging, setPinging] = useState(false)
    const asked = useRef(false)
    /* Активным считаем тот выход, через который трафик идёт СЕЙЧАС, а не первый в спеке:
     * при нескольких туннелях первый может быть выключен, и назвать его активным значило бы
     * показывать не то устройство, куда уходит трафик. */
    const active = outputs.find(([, o]) => o.kind !== 'direct' && o.up)?.[1]
    const tunnelDev = active?.device
    const tunnel = tunnelDev ? live.devs?.[tunnelDev] : undefined

    async function probeAll() {
        setPinging(true)
        try {
            for (const [name, o] of outputs) {
                if (o.kind === 'direct') continue
                const r = await rpc.outboundProbe(name).catch(() => null)
                if (r) setPings((p) => ({ ...p, [name]: { ms: r.ms, state: r.state } }))
            }
        } finally {
            setPinging(false)
        }
    }

    /* Один раз, когда список выходов стал известен. Не в useEffect на каждый их приход: список
     * обновляется каждые пять секунд вместе с состоянием, и проверка запускалась бы заново. */
    useEffect(() => {
        if (asked.current || outputs.length === 0) return
        asked.current = true
        void probeAll()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [outputs.length])

    async function restart() {
        setBusy(true)
        try {
            const r = await rpc.apply()
            notify(r.output?.trim() || 'Применено', r.ok ? 'info' : 'error')
            live.refresh()
        } finally {
            setBusy(false)
        }
    }

    return (
        <aside className="space-y-3">
            <div className="rounded-md border border-sp-border bg-sp-card p-4 shadow-card">
                <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[v.tone]}`} aria-hidden="true" />
                    <h2 className="text-lg font-semibold">{v.text}</h2>
                </div>
                {v.why && <p className="mt-1 text-xs text-sp-muted-foreground">{v.why}</p>}
                {/* Время работы — движка, а не роутера: применение настройки туннель не
                    перезапускает, и человек спрашивает именно про процесс. */}
                {live.net && uptimeText(live.net.uptime) && (
                    <p className="mt-1 text-xs text-sp-muted-foreground">
                        время работы {uptimeText(live.net.uptime)}
                        {live.net.active_clients > 0 && (
                            <> · устройств в сети {live.net.active_clients}</>
                        )}
                    </p>
                )}

                {eng && (
                    <div className="mt-3 flex items-start gap-2 rounded-md border border-sp-border p-2">
                        <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-sp-primary" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            {eng.present ? (
                                <>
                                    <div className="truncate text-sm">
                                        <span className="text-sp-primary">steer {eng.version || '—'}</span>
                                        {' · '}
                                        {eng.vless ? 'extended' : 'basic'}
                                    </div>
                                    {/* Вторая строка мелким кеглем — она и объясняет слово выше.
                                        Сами имена вариантов сборки не переводим: они стоят в
                                        названии пакета, и перевод развёл бы их с тем, что человек
                                        ищет в apk. */}
                                    <div className="truncate font-mono text-xs text-sp-muted-foreground">
                                        {eng.arch || 'архитектура неизвестна'}
                                    </div>
                                </>
                            ) : (
                                <div className="text-sm">
                                    Движок не установлен
                                    <div className="text-xs text-sp-muted-foreground">
                                        без него интерфейс ничего не может применить
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={onGoDiag}
                            className="shrink-0 text-xs text-sp-primary underline decoration-dotted"
                        >
                            {eng.present ? 'Обновить' : 'Установить'}
                        </button>
                    </div>
                )}

                <dl className="mt-3 space-y-1.5 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-sp-muted-foreground">Активный outbound</dt>
                        <dd className="truncate font-medium">{active?.name || '—'}</dd>
                    </div>
                    {active && pings[active.name] && (
                        <div className="flex items-baseline justify-between gap-2">
                            <dt className="text-sp-muted-foreground">Отклик</dt>
                            <dd
                                className={`font-medium ${
                                    pings[active.name].ms < 0 ? 'text-sp-destructive' : 'text-sp-success'
                                }`}
                            >
                                {pings[active.name].ms < 0
                                    ? pings[active.name].state
                                    : `${pings[active.name].ms} мс`}
                            </dd>
                        </div>
                    )}
                    {/* Задержка и внешний IP появятся, когда в бэкенде будет чем их взять:
                        показывать прочерк с обещанием честнее, чем рисовать поле, которое
                        всегда пусто. */}
                    <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-sp-muted-foreground">Через туннель</dt>
                        <dd className="font-medium">
                            {tunnel ? (
                                <>
                                    ↓ {human(Number(tunnel.rx))} · ↑ {human(Number(tunnel.tx))}
                                </>
                            ) : (
                                '—'
                            )}
                        </dd>
                    </div>
                    {tunnelDev && (live.speed.dev[tunnelDev]?.rx || live.speed.dev[tunnelDev]?.tx) && (
                        <div className="flex items-baseline justify-between gap-2">
                            <dt className="text-sp-muted-foreground">Сейчас</dt>
                            <dd className="font-medium">
                                {live.speed.dev[tunnelDev].rx && <>↓ {live.speed.dev[tunnelDev].rx}</>}
                                {live.speed.dev[tunnelDev].rx && live.speed.dev[tunnelDev].tx && ' · '}
                                {live.speed.dev[tunnelDev].tx && <>↑ {live.speed.dev[tunnelDev].tx}</>}
                            </dd>
                        </div>
                    )}
                </dl>

                <div className="mt-3 flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={probeAll} disabled={pinging}>
                        <Activity className="mr-1 h-4 w-4" aria-hidden="true" />
                        {pinging ? 'Проверяем…' : 'Проверить'}
                    </Button>
                    <Button variant="secondary" className="flex-1" onClick={restart} disabled={busy}>
                        <RotateCw className="mr-1 h-4 w-4" aria-hidden="true" />
                        {busy ? 'Применяем…' : 'Применить'}
                    </Button>
                </div>
            </div>

            {outputs.length > 0 && (
                <div className="rounded-md border border-sp-border bg-sp-card p-4 shadow-card">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-sp-muted-foreground">
                        Outbounds
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-sm">
                        {outputs.map(([name, o]) => (
                            <li key={name} className="flex items-center gap-2">
                                <span
                                    className={`h-2 w-2 shrink-0 rounded-full ${
                                        o.kind === 'direct'
                                            ? 'bg-sp-muted-foreground'
                                            : o.up
                                              ? 'bg-sp-success'
                                              : 'bg-sp-destructive'
                                    }`}
                                    aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">{name}</span>
                                <span
                                    className={`shrink-0 text-xs ${
                                        pings[name] && pings[name].ms < 0
                                            ? 'text-sp-destructive'
                                            : pings[name]
                                              ? 'text-sp-success'
                                              : 'text-sp-muted-foreground'
                                    }`}
                                >
                                    {o.kind === 'direct'
                                        ? 'напрямую'
                                        : pings[name]
                                          ? pings[name].ms < 0
                                              ? pings[name].state
                                              : `${pings[name].ms} мс`
                                          : o.up
                                            ? o.device
                                            : 'нет устройства'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Предупреждения движка — дословно и с последствием. Это единственное место, где
                текст приходит от steer как есть: сокращать его нельзя, там названа причина. */}
            {(live.status?.warnings?.length ?? 0) > 0 && (
                <div className="rounded-md border border-sp-warning/40 bg-sp-warning/10 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-sp-warning">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Предупреждения steer
                    </h3>
                    <ul className="mt-2 space-y-2 text-xs">
                        {live.status!.warnings!.map((w, i) => (
                            <li key={i}>
                                {w.channel && <span className="font-medium">{w.channel}: </span>}
                                {w.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </aside>
    )
}
