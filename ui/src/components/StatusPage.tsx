import { useEffect, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { type Status } from '@/lib/model'

// Everything here comes from `steer status` verbatim. The dashboard does not compute
// its own opinion of what is live: the engine knows things the UI cannot see, and two
// answers to "is it working" is one answer too many.

/** Байты человеческим размером. Точность до десятой доли: «223,4 МБ» отвечает на вопрос,
 *  а «234085837» требует считать разряды глазами. Полное число остаётся в подсказке. */
function human(n: number) {
    if (!isFinite(n) || n <= 0) return '0 Б'
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
    let i = 0
    let v = n
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${i === 0 ? v : v.toFixed(1).replace('.', ',')} ${u[i]}`
}

export default function StatusPage() {
    const [status, setStatus] = useState<Status | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [answer, setAnswer] = useState<string | null>(null)
    /** Счётчики устройств. Отдельным запросом, а не из `status`: тот приходит от движка
     *  дословно, и дописывать в него своё значило бы иметь два источника одной правды. */
    const [devs, setDevs] = useState<Record<string, { rx: string; tx: string }> | null>(null)
    /** Состояние экземпляров движка. Нужно, чтобы «выход настроен» и «туннель работает» не
     *  выглядели одинаково: у vless устройство создаёт сам процесс, и когда он падает,
     *  видно было только пропавшее устройство, но не причину. */
    const [engine, setEngine] = useState<{
        instances: Record<string, { running: boolean; pid: number }>
        log: string[]
    } | null>(null)
    const [showLog, setShowLog] = useState(false)

    useEffect(() => {
        const load = () => {
            rpc
                .status()
                .then((s) => { setStatus(s); setError(null) })
                .catch((e) => setError(String(e instanceof Error ? e.message : e)))
            rpc.devStats().then((r) => setDevs(r.devices || {})).catch(() => {})
            rpc.engineState().then((r) => setEngine(r)).catch(() => {})
        }
        load()
        const id = setInterval(load, 5000)
        return () => clearInterval(id)
    }, [])

    async function explain() {
        const address = q.trim()
        if (!address) return
        try {
            const r = await rpc.explain(address)
            setAnswer(r.text)
        } catch (e) {
            setAnswer(String(e instanceof Error ? e.message : e))
        }
    }

    if (error) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Движок не отвечает</CardTitle>
                    <CardDescription>{error}</CardDescription>
                </CardHeader>
            </Card>
        )
    }
    if (!status) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const outputs = Object.entries(status.outputs || {})

    return (
        <div className="space-y-4">
            {(status.warnings?.length ?? 0) > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sp-warning">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Предупреждения движка
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {status.warnings!.map((w, i) => (
                            <p key={i} className="text-sm">
                                {w.channel && <span className="font-medium">{w.channel}: </span>}
                                {w.text}
                            </p>
                        ))}
                    </CardContent>
                </Card>
            )}

            {/* The one answer raw nft cannot give: which channel claims an address and
                where it leaves. Asked of the kernel, so it also covers a set that
                failed to load. */}
            <Card>
                <CardHeader>
                    <CardTitle>Куда пойдёт адрес</CardTitle>
                    <CardDescription>
                        Ответ даёт движок по живому состоянию ядра, а не по конфигурации.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2">
                        <input
                            value={q}
                            onChange={(e) => setQ(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === 'Enter' && explain()}
                            placeholder="216.58.198.206"
                            aria-label="Адрес для проверки"
                            className="min-w-48 flex-1 rounded-md border border-sp-border bg-sp-background px-3 py-1.5 text-sm"
                        />
                        <Button onClick={explain}>
                            <Search className="mr-1 h-4 w-4" aria-hidden="true" /> Проверить
                        </Button>
                    </div>
                    {answer && (
                        <pre className="mt-3 overflow-x-auto rounded-md bg-sp-muted p-3 text-xs">{answer}</pre>
                    )}
                </CardContent>
            </Card>

            {/* Один ответ на вопрос "работает ли" вместо россыпи фактов, из которых
                его надо собирать самому. Считается по тем же полям, но вывод делает
                интерфейс, а не человек. */}
            <Card>
                <CardHeader>
                    <CardTitle>Что происходит</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {(() => {
                        const bad: string[] = []
                        const note: string[] = []
                        for (const [name, o] of outputs) {
                            if (o.kind !== 'interface') continue
                            const list = o.devices || []
                            if (!o.device) {
                                // Сторож не нашёл ни одного живого: что дальше — решает on_fail,
                                // и это ровно тот момент, когда человеку надо сказать прямо.
                                bad.push(
                                    o.on_fail === 'drop'
                                        ? `${name}: ни одно устройство не отвечает — трафик остановлен, чтобы не уйти мимо туннеля`
                                        : `${name}: ни одно устройство не отвечает — трафик идёт НАПРЯМУЮ, без туннеля`
                                )
                            } else if (!o.up) {
                                bad.push(`${name}: устройство ${o.device} выключено — трафик этого выхода никуда не идёт`)
                            } else if (!o.nat) {
                                bad.push(`${name}: нет NAT на ${o.device} — пакеты уходят и не возвращаются, сайты будут молчать`)
                            } else if (list.length > 1 && list[0] !== o.device) {
                                // Работает, но не через основное устройство. Не поломка, но
                                // молчать нельзя: иначе «почему медленно» останется загадкой.
                                note.push(`${name}: работает через запасное ${o.device}, основное ${list[0]} не отвечает`)
                            }
                        }
                        const dead = (status.channels || []).filter((c) => !c.live)
                        for (const c of dead) bad.push(`${c.name}: правила нет в ядре — примените настройки`)
                        const silent = (status.channels || []).filter((c) => c.live && !(c.packets ?? 0))
                        if (!bad.length) {
                            return (
                                <>
                                    <p className="text-sm text-sp-success">
                                        Всё на месте: выходы подняты, NAT есть, правила в ядре.
                                    </p>
                                    {note.map((t, i) => (
                                        <p key={i} className="text-sm text-sp-warning">{t}</p>
                                    ))}
                                    {silent.length > 0 && (
                                        <p className="text-xs text-sp-muted-foreground">
                                            Пока не совпадал ни разу: {silent.map((c) => c.name).join(', ')}. Это
                                            нормально, если по этим спискам ещё никто не ходил.
                                        </p>
                                    )}
                                </>
                            )
                        }
                        return (
                            <>
                                {bad.map((t, i) => (
                                    <p key={i} className="text-sm text-sp-destructive">{t}</p>
                                ))}
                                {note.map((t, i) => (
                                    <p key={i} className="text-sm text-sp-warning">{t}</p>
                                ))}
                            </>
                        )
                    })()}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Выходы</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {outputs.map(([name, o]) => (
                        <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{name}</span>
                            <span className="text-sp-muted-foreground">
                                {o.kind === 'direct' ? 'напрямую' : o.device || 'нет живого устройства'}
                            </span>
                            {/* Скачано и отдано — по устройству выхода. Именно эти два числа
                                человек и ищет, глядя на счётчик: тот, что в таблице каналов
                                ниже, считает только путь наружу и потому всегда мал. */}
                            {o.device && devs?.[o.device] && (
                                <span
                                    className="text-xs text-sp-muted-foreground"
                                    title={`вниз ${Number(devs[o.device].rx).toLocaleString('ru-RU')} Б, вверх ${Number(devs[o.device].tx).toLocaleString('ru-RU')} Б`}
                                >
                                    ↓ {human(Number(devs[o.device].rx))} · ↑ {human(Number(devs[o.device].tx))}
                                </span>
                            )}
                            {/* Для vless устройство создаёт САМ процесс туннеля, поэтому
                                «устройства нет» и «процесс мёртв» — одно и то же событие,
                                а вот причина видна только у procd. Показываем её здесь,
                                чтобы за ней не приходилось идти в logread. */}
                            {o.kind === 'vless' && engine && (() => {
                                const inst = engine.instances[`vless_${name}`]
                                if (!inst) {
                                    return (
                                        <Badge variant="destructive">
                                            движок не запущен
                                        </Badge>
                                    )
                                }
                                return (
                                    <Badge variant={inst.running ? 'default' : 'destructive'}>
                                        {inst.running ? `работает, pid ${inst.pid}` : 'перезапускается'}
                                    </Badge>
                                )
                            })()}
                            {o.kind === 'interface' && (
                                <>
                                    <Badge variant={o.up ? 'default' : 'destructive'}>
                                        {o.up ? 'поднят' : 'выключен'}
                                    </Badge>
                                    <Badge variant={o.nat ? 'secondary' : 'destructive'}>
                                        {o.nat ? 'NAT есть' : 'NAT не найден'}
                                    </Badge>
                                    {(o.devices?.length ?? 0) > 1 && (
                                        <span className="text-xs text-sp-muted-foreground">
                                            резерв: {o.devices!.filter((d) => d !== o.device).join(', ')}
                                        </span>
                                    )}
                                </>
                            )}
                        </div>
                    ))}
                    {/* Последние слова движка. Свёрнуты: когда всё работает, они не нужны,
                        а когда туннель падает — это первое, что просят показать. Текст
                        отдаётся дословно, разбирать его интерфейс не берётся. */}
                    {engine && engine.log.length > 0 && (
                        <div className="pt-1">
                            <button
                                type="button"
                                onClick={() => setShowLog((v) => !v)}
                                className="text-xs text-sp-muted-foreground underline"
                            >
                                {showLog ? 'скрыть журнал движка' : 'журнал движка'}
                            </button>
                            {showLog && (
                                <pre className="mt-2 max-h-56 overflow-auto rounded border border-sp-border bg-sp-muted p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                                    {engine.log.join('\n')}
                                </pre>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Каналы</CardTitle>
                    <CardDescription>
                        Счётчик считает <b>только путь наружу</b>: он стоит на правиле, которое ставит метку, а
                        метка ставится на пути из локальной сети в интернет. Скачанное сюда не попадает — оно
                        приходит с туннельного устройства. Поэтому здесь нормально видеть мегабайты там, где
                        скачаны гигабайты: 60–80 байт на пакет означает, что это подтверждения и запросы. Объём
                        в обе стороны — у выходов выше (↓ и ↑). Точное число байт — в подсказке
                        к значению.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-sp-muted-foreground">
                                <th className="pb-2">Канал</th>
                                <th className="pb-2">Выход</th>
                                <th className="pb-2 text-right">Пакетов</th>
                                {/* «Вверх», а не «Байт»: счётчик стоит на пути наружу, то
                                    есть это tx и только он. Названный байтами, он звал
                                    сравнивать себя со скачанным, чего сравнивать нельзя. */}
                                <th className="pb-2 text-right">Вверх</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(status.channels || []).map((c) => (
                                <tr key={c.name} className="border-t border-sp-border">
                                    <td className="py-1.5">
                                        {c.name}
                                        {!c.live && (
                                            <Badge variant="destructive" className="ml-2">
                                                нет в ядре
                                            </Badge>
                                        )}
                                    </td>
                                    <td className="py-1.5 text-sp-muted-foreground">{c.out}</td>
                                    <td className="py-1.5 text-right">
                                        {(c.packets ?? 0).toLocaleString('ru-RU')}
                                    </td>
                                    <td
                                        className="py-1.5 text-right"
                                        title={`${(c.bytes ?? 0).toLocaleString('ru-RU')} Б`}
                                    >
                                        {human(c.bytes ?? 0)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </CardContent>
            </Card>
        </div>
    )
}
