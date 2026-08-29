import { useEffect, useState } from 'react'
import { ArrowRight, LoaderCircle, Plus, Search, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import SubscriptionCard from '@/components/SubscriptionCard'
import { rpc } from '@/lib/rpc'
import { human, type DiagCheck, type Live } from '@/lib/live'
import { Hint } from '@/components/ui/hint'
import { type SectionId } from '@/lib/sections'

/** Обзор: ответ на «работает ли» и «куда идёт трафик» — и больше ничего.
 *
 *  Один факт — одно место. Трафик только здесь, тексты проверок только в диагностике, узлы и
 *  обфускация только в выходах. Прежняя закреплённая колонка держала рядом вердикт, список
 *  выходов, отклик, счётчики туннеля и движок — то есть повторяла половину каждой вкладки, и
 *  два числа об одном и том же расходились на глазах.
 *
 *  Здесь нет ни одного своего мнения о работоспособности: всё, что показано, приходит от
 *  движка. Два ответа на «работает ли» — это на один ответ больше, чем нужно. */

interface Verdict {
    text: string
    tone: 'good' | 'warn' | 'bad' | 'idle'
    why: string
    /** Сами советы, а не только их число: строку «советов: N» человек прочитал как вопрос
     *  («что за совет?» — splify2#4, I-039), потому что содержания в ней не было. Возвращаются
     *  при любом вердикте, чтобы у поля был один смысл на все ветки, но печатаются только там,
     *  где счётчик и показывался. */
    notes: DiagCheck[]
}

/** Итог по всему: сначала поломки движка, потом предупреждения, потом «работает».
 *
 *  Порядок именно такой, потому что зелёная надпись сверху при красной проверке ниже учит не
 *  верить надписи.
 *
 *  Строк ровно четыре, и это тоже решение дизайна 26.9: заголовок состояния не пересказывает
 *  находки, у него нет ни пятого случая, ни оттенков. Что именно нашлось — читается в
 *  диагностике, дословно словами движка. */
function verdict(live: Live): Verdict {
    /* Советы (note) в цвет не идут: они верны всегда, и красить ими состояние значило бы
     * держать роутер вечно нездоровым. Полный перечень остаётся в диагностике. */
    const notes = (live.diag?.checks || []).filter((c) => c.verdict === 'note')
    if (live.error) return { text: 'Движок не отвечает', tone: 'bad', why: live.error, notes }
    if (live.diag?.fail)
        return { text: 'Есть поломки', tone: 'bad', why: `проверок с отказом: ${live.diag.fail}`, notes }
    if (live.diag?.warn)
        return {
            text: 'Маршрутизация работает',
            tone: 'warn',
            why: `проверок с предупреждением: ${live.diag.warn}`,
            notes,
        }
    if (!live.status) return { text: 'Загрузка…', tone: 'idle', why: '', notes }
    return {
        text: 'Маршрутизация работает',
        tone: 'good',
        why: notes.length ? `советов: ${notes.length}` : '',
        notes,
    }
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

export default function Overview({
    live, onSection,
}: {
    live: Live
    onSection: (s: SectionId) => void
}) {
    const v = verdict(live)
    const outputs = Object.entries(live.status?.outputs || {})

    /* R-064: «движок стоит, а туннеля нет». Состояние, при котором интерфейс работает, правила
     * на месте, счётчики идут — а наружу не уходит ничего, потому что выхода нет ни одного
     * (splify2#5). До этой строки такая настройка выглядела исправной, и человеку оставалось
     * догадываться, что именно не настроено.
     *
     * Выходом считается всё, кроме `direct`: `direct` не уводит трафик, он оставляет пакет на
     * обычном пути, и роутер с одним таким выходом ровно так же никуда не маршрутизирует. */
    const routed = outputs.filter(([, o]) => o.kind !== 'direct')
    /* Устройство проверяется ТОЛЬКО у kind=interface: устройство vless-выхода создаёт сам
     * движок при подъёме, и его отсутствие значит «движок не поднялся» — про это говорят
     * предупреждения steer и проверки состояния, а не эта строка. */
    const named = outputs
        .filter(([, o]) => o.kind === 'interface')
        .map(([name, o]) => ({ name, want: o.devices?.length ? o.devices : o.device ? [o.device] : [] }))
    /* Список туннельных устройств системы. Спрашивается не по кругу, а когда меняется САМ
     * вопрос — набор устройств, названных выходами: ответ читается из /sys/class/net, и гонять
     * его каждые пять секунд ради неменяющегося списка незачем. */
    const wantKey = named.map((n) => `${n.name}:${n.want.join('|')}`).join(',')
    const [sysDevs, setSysDevs] = useState<Set<string> | null>(null)
    useEffect(() => {
        if (!wantKey) return
        let stop = false
        rpc.devices()
            .then((r) => { if (!stop) setSysDevs(new Set((r.devices || []).map((d) => d.name))) })
            /* Не знаем — молчим: предупреждение по неполученному ответу было бы тревогой на
             * исправном роутере, а это ровно то, чего в R-064 велено не делать. */
            .catch(() => { if (!stop) setSysDevs(null) })
        return () => { stop = true }
    }, [wantKey])
    /* Двумя источниками, и это не перестраховка. `rpc.devices()` отбирает ТУННЕЛЬНЫЕ устройства
     * (ARPHRD_NONE/TUNNEL), поэтому по нему одному мост или физический порт выглядел бы
     * «отсутствующим в системе» — а он в системе есть, и сказать так значило бы соврать.
     * `live.devs` — полный список интерфейсов из общего опроса, он же и снимает устаревание:
     * туннель, поднявшийся после запроса, виден в нём через пять секунд, и предупреждение
     * гаснет само, без перезагрузки страницы. */
    const inSystem = (d: string) => (sysDevs?.has(d) ?? false) || d in (live.devs || {})
    /* Молчим, пока систему знаем не целиком, и пока состояние не пришло: пустой `outputs` до
     * первого ответа движка — это «ещё не знаем», а не «выходов нет». */
    const known = live.status !== null && !live.error
    const dead =
        known && sysDevs !== null && live.devs !== null
            ? named.filter((n) => n.want.length > 0 && n.want.every((d) => !inSystem(d)))
            : []
    /* Выход есть, а устройства ему не назначено вовсе — тот же результат и без списка
     * устройств: маршрутизировать нечем. */
    const noDevice = known ? named.filter((n) => n.want.length === 0) : []
    const nowhere = known && routed.length === 0

    return (
        <div className="space-y-4">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    {/* `stale` — на экране снимок прошлого открытия: роутер ещё не ответил.
                        Показываем его приглушённым и говорим об этом вслух. Молча выдать
                        вчерашнее «Работает» за сегодняшнее нельзя — это уже не задержка, а
                        неправда; но и держать «Загрузка…» три секунды, когда прошлое
                        состояние известно, незачем: человек открывает страницу, чтобы
                        увидеть состояние, а не крутилку. */}
                    <div className={`flex items-center gap-2.5 ${live.stale ? 'opacity-60' : ''}`}>
                        <span
                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[v.tone]}`}
                            aria-hidden="true"
                        />
                        <h1 className="sp-verdict">{v.text}</h1>
                        {live.stale && (
                            <span className="shrink-0 text-xs font-normal text-muted-foreground">
                                по прошлому опросу, обновляется…
                            </span>
                        )}
                    </div>
                    {/* Счётчики написаны подписью, двоеточием и числом — тогда не нужны
                        склонения после числительного, а перевод сводится к переводу подписи. */}
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        {live.net && (
                            <>
                                устройств в сети: {live.net.active_clients}
                                {uptimeText(live.net.uptime) && (
                                    <> · время работы {uptimeText(live.net.uptime)}</>
                                )}
                            </>
                        )}
                    </p>
                </div>
                <Button onClick={() => onSection('rules')} className="w-full shrink-0 sm:w-auto">
                    <Plus className="h-4 w-4" aria-hidden="true" /> Новое правило
                </Button>
            </div>

            {/* Находка — одной строкой и с дорогой к ней. Текст находки здесь НЕ печатается:
                он принадлежит движку и живёт в диагностике целиком, а строка отвечает на
                вопрос «есть ли о чём знать» и уводит туда, где написано что именно. */}
            {/* `> 0`, а не просто `&&`: нуль в JSX печатается как «0», и на исправном роутере
                под вердиктом висела одинокая цифра — поймано на снимке живого роутера. */}
            {((live.diag?.fail ?? 0) > 0 || (live.diag?.warn ?? 0) > 0) && (
                <button
                    type="button"
                    onClick={() => onSection('diag')}
                    className={[
                        'flex w-full items-center gap-2 rounded-xl border p-3 text-left text-[13px] transition-colors',
                        live.diag?.fail
                            ? 'border-destructive/40 bg-destructive/10'
                            : 'border-warning/40 bg-warning/10',
                    ].join(' ')}
                >
                    <TriangleAlert
                        className={`h-4 w-4 shrink-0 ${live.diag?.fail ? 'text-destructive' : 'text-warning-fg'}`}
                        aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">{v.why}</span>
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        диагностика <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                </button>
            )}

            {/* R-030/I-039: «советов: N» было счётчиком без содержания и без дороги к нему.
                Строка называет первый совет и ведёт туда, где лежат остальные. */}
            {v.tone === 'good' && v.notes.length > 0 && (
                <button
                    type="button"
                    onClick={() => onSection('diag')}
                    className="block w-full text-left text-xs text-muted-foreground underline decoration-dotted"
                >
                    {v.notes.length > 1 ? `${v.why}: ` : 'совет: '}
                    {v.notes[0].what}
                </button>
            )}

            {/* Движок не отвечает — причина названа заголовком выше, второй раз не пишем. */}
            {v.tone === 'bad' && live.error && (
                <p className="text-[13px] text-destructive">{live.error}</p>
            )}

            {/* «Трафику некуда идти» — R-064. Условие узкое нарочно: либо выходов нет вовсе,
                либо устройство, названное выходом, отсутствует в системе (проверено по списку
                устройств, а не по «выглядит не так»). Постоянного значка из этого не
                получается — на роутере с поднятым туннелем ни одна из веток не срабатывает. */}
            {(nowhere || noDevice.length > 0 || dead.length > 0) && (
                <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
                    <h2 className="sp-sub flex items-center gap-2 text-warning-fg">
                        <TriangleAlert className="h-4 w-4" aria-hidden="true" /> Трафику некуда идти
                    </h2>
                    {nowhere ? (
                        <p className="mt-2 text-xs">
                            Выходов нет: ни один туннель не заведён, поэтому правилам некуда вести
                            трафик — он идёт напрямую, как будто ничего не настроено. Выход
                            создаётся в разделе{' '}
                            <button
                                type="button"
                                onClick={() => onSection('outputs')}
                                className="underline decoration-dotted"
                            >
                                Выходы
                            </button>
                            , а само туннельное устройство — в настройках сети роутера.
                        </p>
                    ) : (
                        <ul className="mt-2 space-y-2 text-xs">
                            {noDevice.map((n) => (
                                <li key={n.name}>
                                    Выход <span className="font-medium">{n.name}</span> не поднят:
                                    устройство ему не назначено, маршрутизировать нечем.
                                </li>
                            ))}
                            {dead.map((n) => (
                                <li key={n.name}>
                                    Выход <span className="font-medium">{n.name}</span> не поднят:{' '}
                                    {n.want.length > 1 ? 'устройств' : 'устройства'}{' '}
                                    <span className="font-mono">{n.want.join(', ')}</span> нет в
                                    системе. Туннель создаётся в настройках сети роутера — пока
                                    устройства нет, трафик этого выхода не уходит никуда.
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Предупреждения движка — дословно и с последствием. Это единственное место, где
                текст приходит от steer как есть: сокращать его нельзя, там названа причина. */}
            {(live.status?.warnings?.length ?? 0) > 0 && (
                <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
                    <h2 className="sp-sub flex items-center gap-2 text-warning-fg">
                        <TriangleAlert className="h-4 w-4" aria-hidden="true" /> Предупреждения steer
                    </h2>
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

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <div className="min-w-0 space-y-4">
                    <TrafficCard live={live} />
                    <ExplainCard />
                </div>
                <div className="min-w-0">
                    {/* Выходы — чтобы карточка знала, чем человек выходит: у подписки она
                        считает остаток и называет узел, у WireGuard остатка не существует. */}
                    <SubscriptionCard outputs={live.status?.outputs} />
                </div>
            </div>
        </div>
    )
}

/** Куда идёт трафик. Считает ядро по наборам выхода, поэтому строка — это набор, а не
 *  правило: правила, совпадающие по выходу, виду списка и клиентам, движок сводит в один
 *  набор, и счётчик у них общий. Так на пакет приходится одно правило вместо десятка — на
 *  роутере с 64 МБ это разница между «работает» и «не влезло». */
function TrafficCard({ live }: { live: Live }) {
    const channels = live.status?.channels || []
    /* Одна подготовка чисел на две раскладки: таблицу на широком экране и строки на узком.
     * Считать их дважды значило бы завести два места, которые разойдутся. */
    const rows = channels.map((c) => {
        const sp = live.speed.ch[c.name]
        return {
            name: c.name,
            out: c.out,
            inKernel: c.live,
            down: c.down_bytes === undefined ? '—' : human(c.down_bytes),
            downTitle:
                c.down_bytes === undefined
                    ? 'движок не считает встречный путь'
                    : `${c.down_bytes.toLocaleString('ru-RU')} Б, пакетов ${(c.down_packets ?? 0).toLocaleString('ru-RU')}`,
            up: human(c.bytes ?? 0),
            upTitle: `${(c.bytes ?? 0).toLocaleString('ru-RU')} Б, пакетов ${(c.packets ?? 0).toLocaleString('ru-RU')}`,
            rateDown: sp?.down || null,
            rateUp: sp?.up || null,
        }
    })
    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-x-2 gap-y-1 space-y-0">
                <CardTitle>Куда идёт трафик</CardTitle>
                <span className="shrink-0 text-xs text-muted-foreground">с загрузки роутера</span>
            </CardHeader>
            <CardContent className="overflow-x-auto">
                {rows.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                        Правил нет — весь трафик идёт напрямую.
                    </p>
                ) : (
                    <>
                    {/* Узкий экран: строки, а не таблица. Четыре столбца в 390 пикселях не
                        помещаются, и последние два уезжали за край — прокрутка внутри карточки
                        на телефоне читается как «карточка обрезалась», а не как приглашение
                        прокрутить. */}
                    <ul className="divide-y divide-border md:hidden">
                        {rows.map((r) => (
                            <li key={r.name} className="py-2">
                                <div className="flex flex-wrap items-baseline gap-x-1.5">
                                    <span>{r.name}</span>
                                    <span className="text-muted-foreground">→ {r.out}</span>
                                    {!r.inKernel && (
                                        <span className="text-[11px] text-destructive">нет в ядре</span>
                                    )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                                    <span title={r.downTitle}>↓ {r.down}</span>
                                    <span title={r.upTitle}>↑ {r.up}</span>
                                    {(r.rateDown || r.rateUp) && (
                                        <span className="text-foreground">
                                            сейчас {r.rateDown && <>↓ {r.rateDown}</>}
                                            {r.rateDown && r.rateUp && ' · '}
                                            {r.rateUp && <>↑ {r.rateUp}</>}
                                        </span>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                    <table className="hidden w-full min-w-[26rem] text-[13px] md:table">
                        <thead>
                            <tr className="text-left text-[11px] text-muted-foreground">
                                <th className="pb-2 font-normal">набор → выход</th>
                                <th className="pb-2 text-right font-normal">↓ внутрь</th>
                                <th className="pb-2 text-right font-normal">↑ наружу</th>
                                <th className="pb-2 text-right font-normal">сейчас</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.name} className="border-t border-border">
                                    <td className="py-1.5">
                                        {r.name}
                                        <span className="text-muted-foreground"> → {r.out}</span>
                                        {!r.inKernel && (
                                            <span className="ml-2 text-[11px] text-destructive">
                                                нет в ядре
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-1.5 text-right" title={r.downTitle}>{r.down}</td>
                                    <td className="py-1.5 text-right" title={r.upTitle}>{r.up}</td>
                                    <td className="py-1.5 whitespace-nowrap text-right text-[11px]">
                                        {r.rateDown || r.rateUp ? (
                                            <>
                                                {r.rateDown && <>↓ {r.rateDown}</>}
                                                {r.rateDown && r.rateUp && <br />}
                                                {r.rateUp && <>↑ {r.rateUp}</>}
                                            </>
                                        ) : (
                                            <span className="text-muted-foreground">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </>
                )}
            </CardContent>
        </Card>
    )
}

/** «Куда пойдёт запрос» — единственный вопрос, который человек задаёт посреди работы, и
 *  отвечает на него ЖИВОЕ ядро, а не настройка. Поэтому поле здесь, на обзоре, а не в
 *  диагностике: спрашивают его до того, как решат, что что-то сломано. */
function ExplainCard() {
    const [q, setQ] = useState('')
    const [answer, setAnswer] = useState<string | null>(null)
    const [asking, setAsking] = useState(false)

    async function ask() {
        const address = q.trim()
        if (!address) return
        setAsking(true)
        try {
            const r = await rpc.explain(address)
            setAnswer(r.text)
        } catch (e) {
            setAnswer(String(e instanceof Error ? e.message : e))
        } finally {
            setAsking(false)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Куда пойдёт запрос</CardTitle>
                {/* Одна фраза, остальное — в подсказку. Дизайн 26.9: объяснять только то, без
                    чего можно сделать неверное действие. Абзац про fake-IP и проверку резолвера
                    верен и полезен, но действия он не меняет, а на телефоне занимал экран. */}
                <CardDescription>
                    Отвечает{' '}
                    <Hint tip="Имя движок сначала спрашивает у своего резолвера и показывает, во что оно превратилось: у доменного правила это fake-IP, и с настоящим адресом сайта он не совпадает вовсе — по системному ответу понять, попадёт ли имя в набор, нельзя. Заодно это проверка самого резолвера: не ответил — значит и клиентам не отвечает.">
                        по живому ядру
                    </Hint>
                    , а не по настройке.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="flex flex-wrap gap-2">
                    <input
                        value={q}
                        onChange={(e) => setQ(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === 'Enter' && ask()}
                        placeholder="youtube.com — куда пойдёт трафик?"
                        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-[13px]"
                    />
                    <Button onClick={ask} disabled={asking || !q.trim()}>
                        {asking ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                            <Search className="h-4 w-4" aria-hidden="true" />
                        )}
                        {asking ? 'Спрашиваем…' : 'Проверить'}
                    </Button>
                </div>
                {answer && (
                    <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
                        {answer}
                    </pre>
                )}
            </CardContent>
        </Card>
    )
}
