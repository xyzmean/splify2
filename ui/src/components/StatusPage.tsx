import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Search, TriangleAlert, XCircle } from 'lucide-react'
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

/** Скорость из разницы двух опросов. Именно её человек и высматривает, глядя на счётчики:
 *  «сколько всего» отвечает на другой вопрос, а «идёт ли прямо сейчас» — на этот. */
function rate(bytes: number, ms: number) {
    if (!(ms > 0) || !(bytes > 0)) return null
    const bits = (bytes * 8 * 1000) / ms
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1).replace('.', ',')} Мбит/с`
    if (bits >= 1e3) return `${Math.round(bits / 1e3)} кбит/с`
    return `${Math.round(bits)} бит/с`
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
    /** Проверки состояния от движка. Отдельно от status: тот отвечает «что применено», а этот
     *  — «работает ли», и это разные вопросы с разными ответами. */
    const [diag, setDiag] = useState<{
        checks: { id: string; verdict: 'ok' | 'warn' | 'fail'; what: string; why: string }[]
        warn: number
        fail: number
    } | null>(null)
    const [diagOld, setDiagOld] = useState(false)
    const [showOk, setShowOk] = useState(false)
    /** Прошлый снимок счётчиков — из него берётся скорость. Снимок ОДИН на все источники:
     *  считать разницу по значениям, снятым в разные моменты, значит делить на неверное время
     *  и показывать скорость, которой не было. */
    const prev = useRef<{
        t: number
        ch: Record<string, { up: number; down: number }>
        dev: Record<string, { rx: number; tx: number }>
    } | null>(null)
    const [speed, setSpeed] = useState<{
        ch: Record<string, { up: string | null; down: string | null }>
        dev: Record<string, { rx: string | null; tx: string | null }>
    }>({ ch: {}, dev: {} })

    useEffect(() => {
        let stop = false
        const load = async () => {
            /* allSettled, а не all: отказ одного источника не должен уносить остальные —
             * diag отсутствует на старом движке, и это не повод гасить всю страницу. */
            const [s, d, e, g] = await Promise.allSettled([
                rpc.status(), rpc.devStats(), rpc.engineState(), rpc.diag(),
            ])
            if (stop) return
            if (s.status === 'fulfilled') { setStatus(s.value); setError(null) }
            else setError(String(s.reason instanceof Error ? s.reason.message : s.reason))
            const devices = d.status === 'fulfilled' ? d.value.devices || {} : null
            if (devices) setDevs(devices)
            if (e.status === 'fulfilled') setEngine(e.value)
            if (g.status === 'fulfilled') { setDiag(g.value); setDiagOld(false) }
            else setDiagOld(true)

            /* Скорость — по разнице с прошлым снимком. Отрицательная разница значит, что
             * счётчики начались заново (перезагрузка): показывать её нельзя, и rate() на
             * такой разнице молчит. */
            const now = Date.now()
            const ch: Record<string, { up: number; down: number }> = {}
            if (s.status === 'fulfilled')
                for (const c of s.value.channels || [])
                    ch[c.name] = { up: c.bytes ?? 0, down: c.down_bytes ?? 0 }
            const dev: Record<string, { rx: number; tx: number }> = {}
            if (devices)
                for (const [n, v] of Object.entries(devices))
                    dev[n] = { rx: Number(v.rx), tx: Number(v.tx) }
            const p = prev.current
            if (p) {
                const ms = now - p.t
                const chs: Record<string, { up: string | null; down: string | null }> = {}
                for (const [n, v] of Object.entries(ch))
                    chs[n] = {
                        up: p.ch[n] ? rate(v.up - p.ch[n].up, ms) : null,
                        down: p.ch[n] ? rate(v.down - p.ch[n].down, ms) : null,
                    }
                const devs2: Record<string, { rx: string | null; tx: string | null }> = {}
                for (const [n, v] of Object.entries(dev))
                    devs2[n] = {
                        rx: p.dev[n] ? rate(v.rx - p.dev[n].rx, ms) : null,
                        tx: p.dev[n] ? rate(v.tx - p.dev[n].tx, ms) : null,
                    }
                setSpeed({ ch: chs, dev: devs2 })
            }
            prev.current = { t: now, ch, dev }
        }
        void load()
        const id = setInterval(() => void load(), 5000)
        return () => { stop = true; clearInterval(id) }
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

    /* Плохое — наверх: если что-то сломано, человек пришёл именно за этим. Исправное
     * сворачивается, потому что «двенадцать зелёных галочек» прячут одну красную. */
    const bad = (diag?.checks || []).filter((c) => c.verdict !== 'ok')
    const good = (diag?.checks || []).filter((c) => c.verdict === 'ok')

    return (
        <div className="space-y-4">
            {(diag || diagOld) && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            {diagOld ? (
                                <>Проверка состояния недоступна</>
                            ) : diag!.fail ? (
                                <><XCircle className="h-4 w-4 text-sp-destructive" aria-hidden="true" />
                                Есть поломки: {diag!.fail}</>
                            ) : diag!.warn ? (
                                <><TriangleAlert className="h-4 w-4 text-sp-warning" aria-hidden="true" />
                                Работает, но есть о чём знать: {diag!.warn}</>
                            ) : (
                                <><Check className="h-4 w-4 text-sp-success" aria-hidden="true" />
                                Всё в порядке</>
                            )}
                        </CardTitle>
                        <CardDescription>
                            {diagOld
                                ? 'Движок этой версии не умеет проверки состояния — обновите steer.'
                                : 'Движок спрашивает ядро и живые процессы, а не свою же настройку: ' +
                                  'совпадение с настройкой ничего не доказывает.'}
                        </CardDescription>
                    </CardHeader>
                    {!diagOld && (
                        <CardContent className="space-y-2">
                            {bad.map((c, i) => (
                                <div key={`${c.id}-${i}`} className="flex gap-2 text-sm">
                                    {c.verdict === 'fail' ? (
                                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-sp-destructive" aria-hidden="true" />
                                    ) : (
                                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-sp-warning" aria-hidden="true" />
                                    )}
                                    <div>
                                        <div>{c.what}</div>
                                        {c.why && (
                                            <div className="text-xs text-sp-muted-foreground">{c.why}</div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {good.length > 0 && (
                                <div>
                                    <button
                                        type="button"
                                        onClick={() => setShowOk((v) => !v)}
                                        className="text-xs text-sp-muted-foreground underline"
                                    >
                                        {showOk
                                            ? 'скрыть исправное'
                                            : `исправно: ${good.length} — показать`}
                                    </button>
                                    {showOk && (
                                        <div className="mt-2 space-y-1">
                                            {good.map((c, i) => (
                                                <div key={`${c.id}-ok-${i}`} className="flex gap-2 text-sm">
                                                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-sp-success" aria-hidden="true" />
                                                    <span className="text-sp-muted-foreground">{c.what}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    )}
                </Card>
            )}
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
                            {/* Скорость прямо сейчас — то, за чем и смотрят на счётчики.
                                Появляется со второго опроса: из одного замера её взять
                                неоткуда, а показать нуль значило бы соврать. */}
                            {o.device && (speed.dev[o.device]?.rx || speed.dev[o.device]?.tx) && (
                                <span className="text-xs text-sp-foreground">
                                    {speed.dev[o.device].rx && <>↓ {speed.dev[o.device].rx}</>}
                                    {speed.dev[o.device].rx && speed.dev[o.device].tx && ' · '}
                                    {speed.dev[o.device].tx && <>↑ {speed.dev[o.device].tx}</>}
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
                        <b>↑</b> — правило, ставящее метку: путь из локальной сети наружу. <b>↓</b> — встречная
                        цепочка, считающая ответные пакеты. Поэтому нормально видеть вверху мегабайты там, где
                        внизу гигабайты: 60–80 байт на пакет вверх означает, что это подтверждения и запросы.
                        Точное число байт и пакетов — в подсказке к значению. Прочерк вместо <b>↓</b> значит,
                        что движок старее встречной цепочки: нуль там был бы неправдой. Объёмы считаются с
                        загрузки роутера и <b>переживают применение настройки</b> — раньше их обнуляло любое
                        обновление списков, то есть каждую ночь.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-sp-muted-foreground">
                                <th className="pb-2">Канал</th>
                                <th className="pb-2">Выход</th>
                                {/* Стрелками, а не «Байт»: счётчики стоят на двух разных
                                    путях, и одно имя на оба звало их сравнивать, чего
                                    делать нельзя. Отдельного столбца «Пакетов» больше нет:
                                    он показывал пакеты ТОЛЬКО наружу, стоя рядом с двумя
                                    столбцами объёма, и читался как общий. Теперь пакеты в
                                    подсказке того направления, к которому относятся. */}
                                <th className="pb-2 text-right">↑ наружу</th>
                                <th className="pb-2 text-right">↓ внутрь</th>
                                <th className="pb-2 text-right">сейчас</th>
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
                                    <td
                                        className="py-1.5 text-right"
                                        title={`${(c.bytes ?? 0).toLocaleString('ru-RU')} Б, пакетов ${(c.packets ?? 0).toLocaleString('ru-RU')}`}
                                    >
                                        {human(c.bytes ?? 0)}
                                    </td>
                                    {/* Прочерк, а не нуль: движок старее встречной цепочки
                                        поля не пришлёт, и нуль соврал бы, что не скачано
                                        ничего. */}
                                    <td
                                        className="py-1.5 text-right"
                                        title={
                                            c.down_bytes === undefined
                                                ? 'движок не считает встречный путь'
                                                : `${c.down_bytes.toLocaleString('ru-RU')} Б, пакетов ${(c.down_packets ?? 0).toLocaleString('ru-RU')}`
                                        }
                                    >
                                        {c.down_bytes === undefined ? '—' : human(c.down_bytes)}
                                    </td>
                                    {/* Скорость по каналу. Пусто до второго опроса и когда
                                        трафика нет: прочерк здесь честнее нуля, которого мы
                                        не измеряли. */}
                                    <td className="py-1.5 text-right whitespace-nowrap">
                                        {speed.ch[c.name]?.down || speed.ch[c.name]?.up ? (
                                            <span className="text-xs">
                                                {speed.ch[c.name].down && <>↓ {speed.ch[c.name].down}</>}
                                                {speed.ch[c.name].down && speed.ch[c.name].up && <br />}
                                                {speed.ch[c.name].up && <>↑ {speed.ch[c.name].up}</>}
                                            </span>
                                        ) : (
                                            <span className="text-sp-muted-foreground">—</span>
                                        )}
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
