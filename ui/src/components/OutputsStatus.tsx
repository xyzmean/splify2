import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { human, type Live } from '@/lib/live'

/** Живое состояние выходов: поднят ли, через какое устройство, каков отклик и сколько через
 *  него прошло.
 *
 *  Здесь, в разделе выходов, а не в закреплённой колонке на всех экранах. Колонка повторяла
 *  этот список рядом с настройкой выходов, и два места об одном и том же расходились на
 *  глазах: список слева обновлялся общим опросом, редактор справа — правкой.
 *
 *  Отклик спрашивается ПО ОДНОМУ выходу за раз и не по кругу: каждая проверка упирается в
 *  таймаут до шести секунд, и опрос десятка выходов каждые пять секунд держал бы роутер
 *  занятым проверками вместо работы. Поэтому один проход при открытии раздела, дальше — только
 *  по кнопке. */

export default function OutputsStatus({ live }: { live: Live }) {
    const outputs = Object.entries(live.status?.outputs || {})
    const [pings, setPings] = useState<Record<string, { ms: number; state: string }>>({})
    const [pinging, setPinging] = useState(false)
    const asked = useRef(false)

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

    /* Один раз, когда список выходов стал известен. Не на каждый их приход: список обновляется
     * каждые пять секунд вместе с состоянием, и проверка запускалась бы заново. */
    useEffect(() => {
        if (asked.current || outputs.length === 0) return
        asked.current = true
        void probeAll()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [outputs.length])

    if (outputs.length === 0) return null

    return (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="sp-sub">Сейчас работает</h2>
                <Button variant="secondary" size="sm" onClick={probeAll} disabled={pinging}>
                    <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                    {pinging ? 'проверяем…' : 'проверить отклик'}
                </Button>
            </div>
            <ul className="mt-2 divide-y divide-border">
                {outputs.map(([name, o]) => {
                    const dev = o.device
                    const stat = dev ? live.devs?.[dev] : undefined
                    const p = pings[name]
                    return (
                        <li key={name} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[13px]">
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
                            <span className="font-medium">{name}</span>
                            {/* Расшифровка выхода: правило указывает на ИМЯ, и без второй
                                половины строки имя ничего не значит для того, кто настраивал
                                роутер месяц назад. */}
                            <span className="text-muted-foreground">
                                {o.kind === 'direct'
                                    ? 'напрямую, мимо туннеля'
                                    : o.kind === 'vless'
                                      ? `VLESS/Reality${dev ? ` · ${dev}` : ''}`
                                      : dev
                                        ? `свой туннель · ${dev}`
                                        : 'устройство не назначено'}
                                {o.mark && o.table !== undefined && (
                                    <> · метка {o.mark}, таблица {o.table}</>
                                )}
                            </span>
                            <span className="ml-auto flex shrink-0 items-center gap-3">
                                {stat && (
                                    <span className="text-[11px] text-muted-foreground">
                                        ↓ {human(Number(stat.rx))} · ↑ {human(Number(stat.tx))}
                                    </span>
                                )}
                                <span
                                    className={`text-[11px] transition-colors duration-200 ${
                                        p && p.ms < 0
                                            ? 'text-destructive'
                                            : p
                                              ? 'text-success'
                                              : 'text-muted-foreground'
                                    }`}
                                >
                                    {/* Пока идёт проверка — «…» вместо ПРЕЖНЕГО числа. Старое
                                        число во время проверки хуже, чем ничего: оно выглядит
                                        свежим, и понять, ответил ли узел ТОЛЬКО ЧТО, нельзя. */}
                                    {o.kind === 'direct'
                                        ? 'напрямую'
                                        : p
                                          ? p.ms < 0
                                              ? p.state
                                              : `${p.ms} мс`
                                          : pinging
                                            ? '…'
                                            : o.up
                                              ? 'поднят'
                                              : 'нет устройства'}
                                </span>
                            </span>
                        </li>
                    )
                })}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
                Отклик — время до первого байта через выход, не пинг: ICMP через туннель не ходит
                вовсе, и <span className="font-mono">ping</span> показал бы «мертво» у исправного
                туннеля.
            </p>
        </div>
    )
}
