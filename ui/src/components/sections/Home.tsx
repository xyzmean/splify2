import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, Plus, Search, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SubBlock, TunnelBlock, type Facts } from '@/components/OutputCards'
import { deadline, rpc, type SubQuota } from '@/lib/rpc'
import { subsRemember, subsRemembered } from '@/lib/subs'
import { human, type DiagCheck, type Live } from '@/lib/live'
import { usePending } from '@/lib/pending'
import { ON_FAIL_TEXT, type Channel, type ChannelStatus, type OutputStatus } from '@/lib/model'
import { country } from '@/lib/geo'
import Flag from '@/components/Flag'
import { type SectionId } from '@/lib/sections'

/** Главная: работает ли, куда идут правила и чем роутер выходит наружу.
 *
 *  ДВА СТОЛБЦА, И ЭТО ДВА РАЗНЫХ ВОПРОСА. Слева правила: что куда ведёт, сколько через него
 *  прошло и куда оно перейдёт, если нынешний выход упадёт. Справа выходы: по блоку на
 *  подписку и по блоку на свой туннель. Раньше на обзоре стояла таблица «куда идёт трафик»
 *  наборами ядра и одна карточка подписки, выбранная из выходов наугад: набор — это не
 *  правило, а «одна карточка» — это молчание про второй туннель.
 *
 *  Здесь нет ни одного своего мнения о работоспособности: всё, что показано, приходит от
 *  движка. Два ответа на «работает ли» — это на один ответ больше, чем нужно. */

interface Verdict {
    text: string
    tone: 'good' | 'warn' | 'bad' | 'idle'
    why: string
    /** Сами советы, а не только их число: строку «советов: N» человек прочитал как вопрос
     *  («что за совет?» — splify2#4, I-039), потому что содержания в ней не было. */
    notes: DiagCheck[]
}

/** Итог по всему: сначала поломки движка, потом предупреждения, потом «работает».
 *
 *  Порядок именно такой, потому что зелёная надпись сверху при красной проверке ниже учит не
 *  верить надписи. Строк ровно четыре: заголовок состояния не пересказывает находки, что
 *  именно нашлось — читается в диагностике, дословно словами движка. */
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

/** Вердикт с поправкой на то, что показанное — ещё не сегодняшнее.
 *
 *  На экране прошлое, и у него два источника: снимок прошлого открытия из памяти браузера и
 *  запомненный ответ САМОГО ДВИЖКА — тот, что приходит на первом, быстром круге опроса
 *  (`steer status --fast`). Утверждать по любому из них «Маршрутизация работает» нельзя: это
 *  уже не задержка, а неправда — туннель мог упасть между сборкой снимка и открытием окна.
 *
 *  Поэтому заголовок говорит «Обновление…» жёлтой точкой — «подожди секунду», — а всё
 *  найденное в прошлый раз остаётся под ним. Свежий круг выпускается сразу за быстрым, так
 *  что слово стоит доли секунды, а не пять. */
function verdictNow(live: Live): Verdict {
    const v = verdict(live)
    return live.stale ? { ...v, text: 'Обновление…', tone: 'warn' } : v
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

/** Что известно про выходы СНАРУЖИ: страна, внешний адрес и отклик.
 *
 *  ОДИН ЗАХОД НА ВСЮ СТРАНИЦУ, а не по запросу из каждого блока: колонка выходов и колонка
 *  правил называют одну и ту же локацию, и два опроса показали бы два разных мгновения.
 *
 *  НЕ ПО КРУГУ. Проверка отклика упирается в таймаут до шести секунд на выход, а измерение
 *  страны уходит наружу; гонять их каждые пять секунд значило бы держать роутер занятым
 *  проверками вместо работы. Один проход, когда выходы стали известны, дальше — по кнопке. */
function useFacts(live: Live) {
    const [facts, setFacts] = useState<Record<string, Facts>>({})
    const [busy, setBusy] = useState(false)
    const done = useRef('')
    /* Состояние читается через ссылку, а не из замыкания: проход по выходам живёт секунды —
     * шесть секунд таймаута на выход, — и за это время успевает приехать новый снимок. Взяв
     * `live` замыканием, проверка «этот выход сейчас перебирает узлы» смотрела бы на снимок
     * той минуты, когда её завели. */
    const now = useRef(live)
    now.current = live
    const outputs = live.status?.outputs || {}
    /* direct не меряется: он не уводит трафик никуда, отклик и страна у него — это отклик и
     * страна самого роутера, и ответ на другой вопрос. */
    const names = Object.keys(outputs).filter((n) => outputs[n].kind !== 'direct')
    /* В ключ входит УСТРОЙСТВО выхода, а не его состояние. При смене узла движок пересоздаёт
     * устройство туннеля, и прежнее измерение относится уже к другому месту — значит спросить
     * надо заново (с живого экрана: выбрали польский узел, а на экране осталась Эстония).
     *
     * А вот на «упал и поднялся» перемеривать нельзя: мигающий выход менял бы ключ каждые пять
     * секунд, и проверка запускалась бы по кругу — на экране «меряем…» не гасло вовсе. */
    const key = names.map((n) => `${n}:${outputs[n].device || ''}`).join(',')

    const measure = useCallback(async (list: string[], fresh: boolean) => {
        setBusy(true)
        try {
            /* Выход, который прямо сейчас перебирает узлы, не спрашиваем: устройства ещё нет,
             * мерить нечего. Неподнятый — тоже, и по другой причине: запрос уйдёт МИМО
             * туннеля и вернёт страну самого роутера, то есть неправду. */
            const alive = list.filter((n) => {
                const st = now.current.status?.outputs?.[n]
                return st?.probe?.state !== 'probing' && st?.up !== false
            })
            /* ОДИН вызов на выход, и он же приносит отклик: запрос идёт через устройство
             * выхода, а значит его собственное время ответа и есть задержка этого выхода.
             * Отдельная проверка отклика поднимала соединение второй раз, через движок, и
             * стоила на роутере девятнадцати секунд на выход — на четырёх выходах это минута
             * с надписью «меряем…» и пустыми строками. */
            await Promise.all(
                alive.map(async (n) => {
                    try {
                        const g = await deadline(rpc.outboundGeo(n, fresh), 25000)
                        setFacts((f) => ({
                            ...f,
                            [n]: {
                                geo: g.cc || g.ip ? { cc: g.cc, ip: g.ip } : f[n]?.geo,
                                ping: g.ms ? { ms: g.ms, state: 'ok' } : f[n]?.ping,
                            },
                        }))
                    } catch { /* не знаем — молчим: выдуманная страна хуже пустой строки */ }
                }),
            )
        } finally {
            setBusy(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!key || done.current === key) return
        done.current = key
        void measure(names, false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, measure])

    return { facts, busy, refresh: () => void measure(names, true) }
}

export default function Home({
    live, onSection, onAddRule,
}: {
    live: Live
    onSection: (s: SectionId, at?: string) => void
    /** «Добавить правило» именно ЗАВОДИТ правило и открывает его — см. Console. */
    onAddRule?: () => void
}) {
    const v = verdictNow(live)
    const { spec } = usePending()
    const { facts, busy, refresh } = useFacts(live)
    const outputs = Object.entries(live.status?.outputs || {})

    /* R-064: «движок стоит, а туннеля нет». Состояние, при котором интерфейс работает, правила
     * на месте, счётчики идут — а наружу не уходит ничего, потому что выхода нет ни одного
     * (splify2#5). До этой строки такая настройка выглядела исправной.
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
     * вопрос — набор устройств, названных выходами. */
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
     * «отсутствующим в системе» — а он в системе есть. `live.devs` — полный список интерфейсов
     * из общего опроса, он же и снимает устаревание. */
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
                    <div className="flex items-center gap-2.5">
                        <span
                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[v.tone]}`}
                            aria-hidden="true"
                        />
                        <h1 className="sp-verdict">{v.text}</h1>
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
                <Button onClick={() => onAddRule?.()} className="w-full shrink-0 sm:w-auto">
                    <Plus className="h-4 w-4" aria-hidden="true" /> Добавить правило
                </Button>
            </div>

            {/* Находка — одной строкой и с дорогой к ней. Текст находки здесь НЕ печатается:
                он принадлежит движку и живёт в диагностике целиком. */}
            {/* `> 0`, а не просто `&&`: нуль в JSX печатается как «0», и на исправном роутере
                под вердиктом висела одинокая цифра — поймано на снимке живого роутера. */}
            {((live.diag?.fail ?? 0) > 0 || (live.diag?.warn ?? 0) > 0) && (
                <button
                    type="button"
                    onClick={() => onSection('settings', 'diag')}
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
                    onClick={() => onSection('settings', 'diag')}
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
                либо устройство, названное выходом, отсутствует в системе. */}
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
                                onClick={() => onSection('vpn')}
                                className="underline decoration-dotted"
                            >
                                VPN
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
                    <RulesBoard
                        live={live}
                        channels={spec?.channels}
                        facts={facts}
                        onSection={onSection}
                    />
                    <ExplainCard />
                </div>
                <div className="min-w-0">
                    <OutputsColumn live={live} facts={facts} busy={busy} onRefresh={refresh} />
                </div>
            </div>
        </div>
    )
}

/** Правила: имя, нынешний выход, потраченный трафик и запас.
 *
 *  ПОРЯДОК — ЭТО ПРИОРИТЕТ, поэтому строки идут номерами и в том же порядке, что в спеке:
 *  адрес достаётся верхнему совпавшему правилу, и экран, который спрятал бы порядок, спрятал
 *  бы единственное, что человеку обязательно понимать.
 *
 *  СЧЁТЧИК ПРИНАДЛЕЖИТ НАБОРУ, А НЕ ПРАВИЛУ. Правила, совпадающие по выходу, виду списка и
 *  клиентам, движок сводит в ОДИН набор и одно правило ядра — на роутере с 64 МБ это разница
 *  между «работает» и «не влезло». Разделить их трафик нечем, и там, где счётчик общий, это
 *  сказано словом, а не поделено поровну выдумкой. */
function RulesBoard({
    live, channels, facts, onSection,
}: {
    live: Live
    channels?: Channel[]
    facts: Record<string, Facts>
    onSection: (s: SectionId, at?: string) => void
}) {
    const sets = live.status?.channels || []
    /* Набор по имени правила: сначала тот, что назвал правило участником, иначе одноимённый —
     * движок старее перечня участников поля `channels` не печатает. */
    const setOf = (name: string): ChannelStatus | undefined =>
        sets.find((s) => (s.channels || []).includes(name)) || sets.find((s) => s.name === name)

    /* Строки берутся из СПЕКИ: в ней лежит порядок (он же приоритет) и выключенные правила,
     * которых движок не компилирует вовсе. Пока её нет — а её может не быть и потому, что
     * файл не прочитался, — показываем наборы движка: работающие правила важнее, чем ожидание
     * файла настройки. Пустая спека при живых наборах — это тот же случай, а не «правил нет»:
     * ядро маршрутизирует, и промолчать об этом значило бы соврать. */
    const rows: { name: string; out: string; enabled: boolean }[] = channels?.length
        ? channels.map((c) => ({ name: c.name, out: c.out, enabled: c.enabled !== false }))
        : sets.map((s) => ({ name: s.name, out: s.out, enabled: true }))

    /* РАЗДЕЛ, А НЕ КАРТОЧКА, и это не вкусовщина.
     *
     *  Правила и выходы на обзоре — две половины одного вопроса «куда идёт трафик», и стоят
     *  они рядом в двух столбцах. Но оформлены были по-разному: у выходов заголовок раздела
     *  над карточками (и ссылка «проверить» справа от него), а у правил — заголовок ВНУТРИ
     *  карточки. Из-за этого их первые строки не совпадали по высоте (заголовок карточки
     *  ниже на её отступ), и два соседних столбца читались как два разных вида вещей.
     *
     *  Теперь у обоих одно и то же: строка заголовка раздела с подписью справа, под ней
     *  содержимое. Карточка у правил осталась — но уже без своей шапки, поэтому у её
     *  содержимого возвращён верхний отступ (CardContent по построению рассчитан на шапку
     *  над собой и сверху его не имеет). */
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <h2 className="sp-sub">Правила</h2>
                <span className="shrink-0 text-xs text-muted-foreground">с загрузки роутера</span>
            </div>
            <Card>
                <CardContent className="pt-3.5 lg:pt-4">
                    {rows.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            Правил нет — весь трафик идёт напрямую.
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {rows.map((r, i) => (
                                <RuleRow
                                    key={`${r.name}-${i}`}
                                    n={i + 1}
                                    row={r}
                                    set={setOf(r.name)}
                                    st={live.status?.outputs?.[r.out]}
                                    facts={facts[r.out]}
                                    onSection={onSection}
                                />
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

function RuleRow({
    n, row, set, st, facts, onSection,
}: {
    n: number
    row: { name: string; out: string; enabled: boolean }
    set?: ChannelStatus
    st?: OutputStatus
    facts?: Facts
    onSection: (s: SectionId, at?: string) => void
}) {
    /* Кандидаты выхода в порядке предпочтения: первый здоровый побеждает, поэтому нынешний —
     * это `device`, поставленный движком, а не первый в списке. */
    const cands = st?.devices?.length ? st.devices : st?.device ? [st.device] : []
    const active = st?.device || (st?.kind === 'vless' ? undefined : cands[0])
    const spare = cands.filter((d) => d !== active)
    const place = country(facts?.geo?.cc)
    /* Выход читается слева направо: имя выхода → через что он идёт сейчас. Устройство
     * повторяет имя выхода чаще, чем нет (его так и заводят), и строка «vless vless» —
     * это одно и то же слово дважды. Показываем устройство, только когда оно другое. */
    const via = place || (active && active !== row.out ? active : '')

    const down = set?.down_bytes === undefined ? null : human(set.down_bytes)
    const up = set?.bytes === undefined ? null : human(set.bytes)
    const shared = (set?.channels?.length ?? 0) > 1

    return (
        <li className={`py-2.5 ${row.enabled ? '' : 'opacity-60'}`}>
            {/* Строка читается как предложение: правило → куда оно ведёт СЕЙЧАС. Ниже, мельче,
                то, что спрашивают вторым: сколько через него прошло и что стоит в запасе. */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="w-4 shrink-0 text-[11px] tabular-nums text-muted-foreground">{n}</span>
                <span className="min-w-0 max-w-full truncate text-[13px] font-medium">{row.name}</span>
                {!row.enabled && (
                    <span className="text-[11px] text-muted-foreground">выключено</span>
                )}
                {row.enabled && set && !set.live && (
                    <span className="text-[11px] text-destructive">нет в ядре</span>
                )}
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <button
                    type="button"
                    onClick={() => onSection('vpn')}
                    className="flex min-w-0 items-baseline gap-1.5 text-left"
                >
                    <Flag cc={facts?.geo?.cc} />
                    <span className="min-w-0 truncate text-[13px] font-medium">{row.out}</span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {st?.kind === 'direct'
                            ? 'напрямую'
                            : [via, facts?.ping && facts.ping.ms >= 0 ? `${facts.ping.ms} мс` : null]
                                  .filter(Boolean)
                                  .join(' · ') || 'не поднят'}
                    </span>
                </button>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 pl-6 text-[11px] text-muted-foreground">
                {/* Счётчик принадлежит НАБОРУ. Там, где движок свёл несколько правил в один
                    набор, это сказано словом, а не поделено поровну выдумкой. */}
                <span>↓ {down ?? '—'}</span>
                <span>↑ {up ?? '—'}</span>
                {shared && (
                    <span title={`общий счётчик: ${set!.channels!.join(', ')}`}>
                        счётчик общий
                    </span>
                )}
                {/* Запас — не украшение: пока он есть, падение туннеля не останавливает
                    трафик, а когда его нет, решает «если всё упало». */}
                <span className="text-subtle">
                    {spare.length
                        ? `запас: ${spare.join(', ')}`
                        : st && st.kind !== 'direct'
                          ? `если всё упало: ${ON_FAIL_TEXT[st.on_fail || 'drop']}`
                          : ''}
                </span>
            </div>
        </li>
    )
}

/** Столбец выходов: по блоку на подписку и по блоку на свой туннель.
 *
 *  Порядок постоянный — подписка, затем туннели по имени: блоки, переставляющиеся местами при
 *  каждом опросе, человек перечитывает заново каждый раз. */
function OutputsColumn({
    live, facts, busy, onRefresh,
}: {
    live: Live
    facts: Record<string, Facts>
    busy: boolean
    onRefresh: () => void
}) {
    /* Какой выход к какой подписке относится — знает СПЕКА, а не состояние: `steer status`
     * поля `sub_file` не печатает вовсе. Пока группировка шла по состоянию, ни одна локация
     * не попадала ни в один блок — на экране оставался голый остаток. */
    const { spec } = usePending()
    const outputs = Object.entries(live.status?.outputs || {})
    const vless = outputs.filter(([, o]) => o.kind === 'vless')
    const tunnels = outputs.filter(([, o]) => o.kind === 'interface')

    /** Подписки роутера. Их бывает несколько, и блок полагается КАЖДОЙ: остаток, срок и
     *  локации у них свои, а один блок на все смешал бы числа двух панелей.
     *
     *  null — бэкенд постарше, который про перечень не знает: тогда подписка одна и блок
     *  один, как было. */
    /* Начинается перечень С ЗАПОМНЕННОГО. Вызов `sub_list` уходит после того, как загрузятся
     * LuCI, загрузчик и бандл, и до его ответа блоков подписок нет вовсе — а появившись, они
     * разъезжают всё, что под ними, тем заметнее, чем подписок больше. Запомнены только
     * имена и пути; числа каждая подписка помнит сама (см. lib/subs.ts). */
    const [subs, setSubs] = useState<
        { name: string; title?: string; kind?: string; path: string; quota?: SubQuota }[] | null
    >(() => subsRemembered())
    useEffect(() => {
        let stop = false
        rpc.subList()
            .then((r) => {
                if (stop) return
                setSubs(r.subs || [])
                subsRemember(r.subs)
            })
            /* Бэкенд постарше перечня не знает — подписка одна, и блок ей рисуется прежним
             * способом. Запомненное при этом снимается: иначе страница рисовала бы блоки
             * подписок, о которых этот роутер рассказать уже не может. */
            .catch(() => { if (!stop) { setSubs(null); subsRemember([]) } })
        return () => { stop = true }
    }, [])

    /* Ни подписки, ни туннеля — столбца нет вовсе. Пустой столбец с заголовком «Выходы»
     * занимал бы место ради строки «ничего нет», а про отсутствие выходов уже сказано над
     * столбцами, и сказано с последствием («трафику некуда идти»). */
    if (vless.length === 0 && tunnels.length === 0 && !subs?.length) return null

    return (
        <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
                <h2 className="sp-sub">Выходы</h2>
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={busy}
                    className="flex items-center gap-1 text-xs text-primary underline decoration-dotted disabled:opacity-60"
                >
                    {busy ? (
                        <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    {busy ? 'меряем…' : 'проверить'}
                </button>
            </div>

            {/* По блоку на КАЖДУЮ ПОДПИСКУ: остаток и сроки у них свои, и один блок на две
                панели смешал бы их числа. Локации — строками внутри своей подписки. */}
            {subs === null
                ? vless.length > 0 && (
                      <SubBlock outs={vless.map(([name, st]) => ({ name, st, facts: facts[name] }))} />
                  )
                : subs.map((s) => (
                      <SubBlock
                          key={s.name}
                          sub={s}
                          outs={vless
                              .filter(([n, o]) => (spec?.outputs?.[n]?.sub_file || o.sub_file || '') === s.path)
                              .map(([name, st]) => ({ name, st, facts: facts[name] }))}
                      />
                  ))}
            {tunnels.map(([name, st]) => (
                <TunnelBlock key={name} name={name} st={st} facts={facts[name]} />
            ))}

        </div>
    )
}

/** «Куда пойдёт запрос» — единственный вопрос, который человек задаёт посреди работы, и
 *  отвечает на него ЖИВОЕ ядро, а не настройка. Поэтому поле здесь, на главной, а не в
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
