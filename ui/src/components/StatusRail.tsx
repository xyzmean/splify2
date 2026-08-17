import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Activity, Cpu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { useConfirm } from '@/components/ui/confirm'
import { engineAction } from '@/lib/engine'
import { human, type Live } from '@/lib/live'
import { Hint } from '@/components/ui/hint'

/** Закреплённое состояние: то, что верно независимо от того, что человек делает справа.
 *
 *  Кнопки «Применить» здесь больше нет: применение живёт в одной плавающей пилюле
 *  (ApplyPill), которая появляется только когда есть что применять. Две кнопки об одной
 *  операции — это два места, которые человек должен был сверять между собой.
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
    if (live.diag?.warn)
        return { text: 'Работает', tone: 'warn' as const, why: `есть о чём знать: ${live.diag.warn}` }
    if (!live.status) return { text: 'Загрузка…', tone: 'idle' as const, why: '' }
    /* Советы (note) сюда не приходят и цвет не меняют: они верны всегда, и красить ими
     * состояние значило бы держать роутер вечно нездоровым. Их видно на вкладке диагностики. */
    const notes = (live.diag?.checks || []).filter((c) => c.verdict === 'note').length
    return { text: 'Работает', tone: 'good' as const, why: notes ? `советов: ${notes}` : '' }
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
    good: 'bg-success',
    warn: 'bg-warning',
    bad: 'bg-destructive',
    idle: 'bg-muted-foreground',
}

export default function StatusRail({ live, onGoDiag }: { live: Live; onGoDiag: () => void }) {
    const [toggling, setToggling] = useState(false)
    const [ask, confirmDialog] = useConfirm()
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
    /* Активными считаем ВСЕ выходы, поднятые сейчас, а не первый в спеке: туннелей у человека
     * обычно несколько (vless рядом с wg), выключенный первый значил бы показ не того
     * устройства, а один показанный из трёх — впечатление, что остальные не работают.
     *
     * Имя берётся ИЗ КЛЮЧА, а не из o.name, и это не вкус: `steer status` не повторяет имя
     * внутри объекта выхода — там оно ключ. Тип OutputStatus наследует `name` от описания
     * выхода в спеке (в спеке поле есть), поэтому tsc молчал, а в браузере выходило undefined
     * и строка показывала «—» при трёх работающих туннелях. */
    const activeEntries = outputs.filter(([, o]) => o.kind !== 'direct' && o.up)
    const activeNames = activeEntries.map(([name]) => name)
    /* Счётчики и «Сейчас» показываются по первому из активных: устройство у каждого своё, а
     * складывать их в одну строку значило бы придумать число, которого нет ни у одного. */
    const primary = activeEntries[0]
    const tunnelDev = primary?.[1].device
    const tunnel = tunnelDev ? live.devs?.[tunnelDev] : undefined

    async function probeAll() {
        setPinging(true)
        /* Прежние значения гасим СРАЗУ: пока идёт проверка, старое число неотличимо от
         * свежего, и кнопка выглядела так, будто ничего не делает. Теперь отклики гаснут в
         * «…» и возвращаются по одному. */
        setPings({})
        let failed: string | null = null
        try {
            for (const [name, o] of outputs) {
                if (o.kind === 'direct') continue
                try {
                    const r = await rpc.outboundProbe(name)
                    setPings((p) => ({ ...p, [name]: { ms: r.ms, state: r.state } }))
                } catch (e) {
                    /* Отказ метода — не то же, что «узел не ответил», и путать их нельзя:
                     * первое чинится обновлением splify2, второе — сменой узла. Прежде оба
                     * молчали одинаково, и кнопка выглядела неработающей. */
                    failed = String(e instanceof Error ? e.message : e)
                    setPings((p) => ({ ...p, [name]: { ms: -1, state: 'не спросить' } }))
                }
            }
            if (failed) notify(`Проверка недоступна: ${failed}`, 'error')
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

    /** Остановить всё или вернуть обратно.
     *
     *  Подтверждение обязательно и только на остановке: она снимает маршрутизацию у всех, кто
     *  сейчас в сети, и вдобавок автозапуск, то есть перезагрузкой не чинится. Запуск ничего
     *  не ломает и спрашивать не о чем. */
    async function toggleEngine() {
        const stopping = eng?.enabled !== false
        if (stopping) {
            const ok = await ask({
                title: 'Остановить всё?',
                body:
                    'Маршрутизация снимется целиком: движок остановится, правила из ядра уйдут. ' +
                    'Автозапуск тоже снимется, поэтому перезагрузка роутера ничего не вернёт — ' +
                    'включать придётся этой же кнопкой.',
                confirmLabel: 'Остановить',
            })
            if (!ok) return
        }
        setToggling(true)
        try {
            const r = stopping ? await rpc.engineStop() : await rpc.engineStart()
            notify(stopping ? 'Движок остановлен' : r.running ? 'Движок запущен' : 'Движок включён, но не поднялся',
                   stopping || r.running ? 'info' : 'warning')
            live.refresh()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setToggling(false)
        }
    }

    return (
        <aside className="space-y-3">
            {confirmDialog}
            <div className="rounded-md border border-border bg-card p-4 shadow-card">
                <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[v.tone]}`} aria-hidden="true" />
                    <h2 className="text-lg font-semibold">{v.text}</h2>
                </div>
                {v.why && <p className="mt-1 text-xs text-muted-foreground">{v.why}</p>}
                {/* Время работы — движка, а не роутера: применение настройки туннель не
                    перезапускает, и человек спрашивает именно про процесс. */}
                {live.net && uptimeText(live.net.uptime) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                        время работы {uptimeText(live.net.uptime)}
                        {live.net.active_clients > 0 && (
                            <> · устройств в сети {live.net.active_clients}</>
                        )}
                    </p>
                )}

                {eng && (
                    <div className="mt-3 flex items-start gap-2 rounded-md border border-border p-2">
                        <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            {eng.present ? (
                                <>
                                    <div className="truncate text-sm">
                                        <span className="text-primary">steer {eng.version || '—'}</span>
                                        {' · '}
                                        {eng.vless ? 'extended' : 'basic'}
                                    </div>
                                    {/* Вторая строка мелким кеглем — она и объясняет слово выше.
                                        Сами имена вариантов сборки не переводим: они стоят в
                                        названии пакета, и перевод развёл бы их с тем, что человек
                                        ищет в apk. */}
                                    <div className="truncate font-mono text-xs text-muted-foreground">
                                        {eng.arch || 'архитектура неизвестна'}
                                    </div>
                                </>
                            ) : (
                                <div className="text-sm">
                                    Движок не установлен
                                    <div className="text-xs text-muted-foreground">
                                        без него интерфейс ничего не может применить
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={onGoDiag}
                            className="shrink-0 text-xs text-primary underline decoration-dotted"
                        >
                            {/* Подпись считает engineAction, а не эта строка: то же самое
                                действие названо ещё и в карточке движка, и пока слово
                                выбиралось здесь, два места об одной операции расходились. */}
                            {engineAction(eng, live.releases).label}
                        </button>
                    </div>
                )}

                <dl className="mt-3 space-y-1.5 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">
                            <Hint tip="Туннелей может работать сразу несколько. Какой трафик пойдёт в какой — решают правила: выход выбирается для канала, а не для всего роутера.">
                                Активные туннели
                            </Hint>
                        </dt>
                        <dd className="truncate font-medium">{activeNames.join(', ') || '—'}</dd>
                    </div>
                    {primary && (pinging || pings[primary[0]]) && (
                        <div className="flex items-baseline justify-between gap-2">
                            <dt className="text-muted-foreground">
                                {/* Имя туннеля в подписи, когда их несколько: иначе «Отклик»
                                    без указания, чей он, читается как отклик всего роутера. */}
                                {activeNames.length > 1 ? `Отклик · ${primary[0]}` : 'Отклик'}
                            </dt>
                            <dd
                                className={`font-medium transition-colors duration-200 ${
                                    !pings[primary[0]]
                                        ? 'text-muted-foreground'
                                        : pings[primary[0]].ms < 0
                                          ? 'text-destructive'
                                          : 'text-success'
                                }`}
                            >
                                {!pings[primary[0]]
                                    ? '…'
                                    : pings[primary[0]].ms < 0
                                      ? pings[primary[0]].state
                                      : `${pings[primary[0]].ms} мс`}
                            </dd>
                        </div>
                    )}
                    <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">Через туннель</dt>
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
                            <dt className="text-muted-foreground">Сейчас</dt>
                            <dd className="font-medium">
                                {live.speed.dev[tunnelDev].rx && <>↓ {live.speed.dev[tunnelDev].rx}</>}
                                {live.speed.dev[tunnelDev].rx && live.speed.dev[tunnelDev].tx && ' · '}
                                {live.speed.dev[tunnelDev].tx && <>↑ {live.speed.dev[tunnelDev].tx}</>}
                            </dd>
                        </div>
                    )}
                </dl>

                {/* «Применить» отсюда ушло в плавающую пилюлю: одна операция — одна кнопка,
                    и она появляется только тогда, когда есть что применять. */}
                <div className="mt-3">
                    <Button variant="secondary" className="w-full" onClick={probeAll} disabled={pinging}>
                        <Activity className="mr-1 h-4 w-4" aria-hidden="true" />
                        {pinging ? 'Проверяем…' : 'Проверить соединение'}
                    </Button>
                </div>

                {/* Тумблер «остановить всё». Просьба из публичного теста была дословно про
                    одну кнопку, поэтому она здесь, рядом с состоянием, а не спрятана во
                    вкладке настроек: её ищут тогда же, когда смотрят «работает ли».

                    Показывается только при установленном движке — останавливать нечего,
                    пока его нет, а кнопка в никуда хуже отсутствующей. */}
                {eng?.present && (
                    <div className="mt-2">
                        <Button
                            variant={eng.enabled === false ? 'secondary' : 'destructive'}
                            className="w-full"
                            onClick={toggleEngine}
                            disabled={toggling}
                        >
                            {toggling ? 'Секунду…' : eng.enabled === false ? 'Запустить' : 'Остановить всё'}
                        </Button>
                        {eng.enabled === false && (
                            <p className="mt-1 text-xs text-muted-foreground">
                                автозапуск снят: перезагрузка движок не вернёт
                            </p>
                        )}
                    </div>
                )}
            </div>

            {outputs.length > 0 && (
                <div className="rounded-md border border-border bg-card p-4 shadow-card">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Outbounds
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-sm">
                        {outputs.map(([name, o]) => (
                            <li key={name} className="flex items-center gap-2">
                                <span
                                    className={`h-2 w-2 shrink-0 rounded-full ${
                                        o.kind === 'direct'
                                            ? 'bg-muted-foreground'
                                            : o.up
                                              ? 'bg-success'
                                              : 'bg-destructive'
                                    }`}
                                    aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">{name}</span>
                                <span
                                    className={`shrink-0 text-xs transition-colors duration-200 ${
                                        pings[name] && pings[name].ms < 0
                                            ? 'text-destructive'
                                            : pings[name]
                                              ? 'text-success'
                                              : 'text-muted-foreground'
                                    }`}
                                >
                                    {/* Пока идёт проверка — «…» вместо ПРЕЖНЕГО числа. Старое
                                        число во время проверки хуже, чем ничего: оно выглядит
                                        свежим, и понять, ответил ли узел ТОЛЬКО ЧТО,
                                        невозможно. Значения возвращаются по одному, в том
                                        порядке, в каком отвечают выходы. */}
                                    {o.kind === 'direct'
                                        ? 'напрямую'
                                        : pings[name]
                                          ? pings[name].ms < 0
                                              ? pings[name].state
                                              : `${pings[name].ms} мс`
                                          : pinging
                                            ? '…'
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
                <div className="rounded-md border border-warning/40 bg-warning/10 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-warning">
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
