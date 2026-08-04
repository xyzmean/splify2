import { useEffect, useState } from 'react'
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

const DOT: Record<string, string> = {
    good: 'bg-sp-success',
    warn: 'bg-sp-warning',
    bad: 'bg-sp-destructive',
    idle: 'bg-sp-muted-foreground',
}

export default function StatusRail({ live, onGoDiag }: { live: Live; onGoDiag: () => void }) {
    const [eng, setEng] = useState<{ present: boolean; vless: boolean; arch?: string; version?: string } | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.engine().then(setEng).catch(() => setEng(null))
    }, [])

    const v = verdict(live)
    const outputs = Object.entries(live.status?.outputs || {})
    /* Активным считаем тот выход, через который трафик идёт СЕЙЧАС, а не первый в спеке:
     * при нескольких туннелях первый может быть выключен, и назвать его активным значило бы
     * показывать не то устройство, куда уходит трафик. */
    const active = outputs.find(([, o]) => o.kind !== 'direct' && o.up)?.[1]
    const tunnelDev = active?.device
    const tunnel = tunnelDev ? live.devs?.[tunnelDev] : undefined

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
                    <Button variant="secondary" className="flex-1" onClick={onGoDiag}>
                        <Activity className="mr-1 h-4 w-4" aria-hidden="true" /> Проверить
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
                                <span className="shrink-0 text-xs text-sp-muted-foreground">
                                    {o.kind === 'direct'
                                        ? 'напрямую'
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
