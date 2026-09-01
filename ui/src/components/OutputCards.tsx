import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Infinity as InfinityIcon, LoaderCircle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { deadline, rpc, type SubQuota } from '@/lib/rpc'
import { human } from '@/lib/live'
import type { OutputStatus } from '@/lib/model'
import { cacheGet, cacheSet } from '@/lib/cache'
import { country } from '@/lib/geo'
import { ccFromName, plainName } from '@/lib/nodename'
import Flag from '@/components/Flag'
import { daysText, readQuota, resetText } from '@/lib/quota'

/** Правая колонка главной: по блоку на подписку и по блоку на выходной интерфейс.
 *
 *  РАЗНЫЕ БЛОКИ, ПОТОМУ ЧТО РАЗНЫЕ ВОПРОСЫ. У подписки спрашивают «сколько осталось и откуда
 *  я сейчас выхожу», и остаток там существует: его называет панель продавца заголовком
 *  `subscription-userinfo`. У своего туннеля (WireGuard, AmneziaWG, xsteer) остатка нет ни у
 *  кого — ни у роутера, ни у той стороны, — поэтому в его блоке нет трафика вовсе: локация,
 *  отклик и знак бесконечности. Прежняя общая карточка выбирала форму сама по тому, какой
 *  выход нашла первым, и на роутере с двумя туннелями показывала один, умалчивая о втором.
 *
 *  ЛОКАЦИЯ МЕРЯЕТСЯ, а не читается из подписки: имя узла («🇩🇪 Германия №2») пишет продавец,
 *  это подпись, а не факт, узел мог переехать, а у WireGuard и xsteer имени нет вовсе.
 *  Измерение и отклик приходят СНАРУЖИ, одним заходом на всю страницу (Home): два блока,
 *  спрашивающих порознь, показали бы два разных мгновения об одном роутере. */

export interface Facts {
    geo?: { cc?: string; ip?: string }
    /** Отклик выхода: миллисекунды и словами, как ответил бэкенд. −1 — не ответил. */
    ping?: { ms: number; state: string }
}

/** Один выход правой колонки: имя из спеки и то, что о нём знает движок. */
export interface OutRef {
    name: string
    st?: OutputStatus
    facts?: Facts
}

/** Что блок показывал в прошлый раз. Рисуется сразу при открытии — до первого ответа ubus.
 *  Подробности про кеш — в lib/cache.ts. */
type Snapshot = { kind?: 'url' | 'links' | 'none'; quota?: SubQuota; node?: Record<string, string> }

/** Отклик строкой. −1 значит «не ответил», и это не то же, что «не мерили»: первое надо
 *  сказать, второе — промолчать. */
function Ping({ p }: { p?: { ms: number; state: string } }) {
    if (!p) return null
    return (
        <span className={`shrink-0 text-[12px] ${p.ms < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {p.ms < 0 ? p.state || 'нет ответа' : `${p.ms} мс`}
        </span>
    )
}

/** Блок подписки: сколько трафика осталось по счёту панели.
 *
 *  ТОЛЬКО ОСТАТОК. Локации у подписки свои блоки (LocationBlock), по блоку на каждую: у
 *  локации своё состояние, свой отклик и свой адрес, и сложенные в блок подписки три локации
 *  читаются как одно целое, которым они не являются.
 *
 *  Остаток спрашивается у панели ПРИ КАЖДОМ открытии: запомненное рисуется сразу, свежее
 *  приезжает следом. Порог в четверть часа экономил обращение наружу ценой того, ради чего
 *  страницу и открывают. */
export function SubBlock({ outs = [], sub }: {
    /** Локации этой подписки: строкой на каждую — флаг со страной, отклик и адрес под глазом.
     *  Строкой, а не своим блоком: «сколько осталось» и «откуда я выхожу» — один вопрос про
     *  одну подписку, и разносить их по экрану значит заставлять сводить их глазами. */
    outs?: OutRef[]
    /** Какая это подписка. Нет — единственная, та, что лежит на своём месте: так отвечает
     *  бэкенд постарше, который про несколько подписок не знает. */
    sub?: { name: string; title?: string; kind?: string; quota?: SubQuota }
}) {
    /** Ключ памяти У КАЖДОЙ ПОДПИСКИ СВОЙ.
     *
     *  Общий ключ означал две беды разом: во втором блоке рисовались числа первой (лимит
     *  соседки на безлимитной подписке), а свои числа второй не запоминались вовсе — на
     *  каждом открытии он стоял пустым, пока не ответит панель. Имя подписки в ключе
     *  разводит их окончательно; «card» без имени остаётся у единственной подписки, чтобы
     *  запомненное прежними версиями не пропало. */
    const cacheKey = sub ? `card:${sub.name}` : 'card'
    const seen = useRef<Snapshot>(cacheGet<Snapshot>(cacheKey) || {})
    const remember = useCallback(
        (p: Snapshot) => {
            seen.current = { ...seen.current, ...p }
            cacheSet(cacheKey, seen.current)
        },
        [cacheKey],
    )

    /* Запомненный снимок — ТОЛЬКО у единственной подписки. Он один на страницу, и подставить
     * его во второй блок значило бы показать там числа первой: ровно это и было видно на
     * роутере — безлимитная подписка отрисовалась с чужим лимитом 800 ГБ. У названной
     * подписки числа приходят перечнем (sub_list) и спрашиваются по её имени. */
    const [kind, setKind] = useState<'url' | 'links' | 'none' | null>(
        (sub?.kind as 'url' | 'links' | 'none') ?? seen.current.kind ?? null,
    )
    /** Числа прошлого открытия — свои у этой подписки: они рисуются сразу, до ответа
     *  роутера, а свежие приезжают следом. */
    const [quota, setQuota] = useState<SubQuota | undefined>(sub?.quota ?? seen.current.quota)
    /** null — ещё не знаем; строка — панель молчит, и вот почему. */
    const [why, setWhy] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    /** Опрос панели делается ОДИН раз за жизнь блока: без этого признака он повторялся бы на
     *  каждом приходе ответа, потому что ответ меняет состояние. */
    const asked = useRef(false)
    const alive = useRef(true)
    /* Признак ставится ЗАНОВО при каждом заходе эффекта, а не только снимается при уходе.
     * В StrictMode React вызывает эффект дважды — монтирование, уборка, монтирование, — и
     * снятый один раз признак больше никогда не поднимался: ответ панели приходил в блок,
     * который считал себя мёртвым, и «спрашиваем…» висело вечно. */
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    const refresh = useCallback(async () => {
        setBusy(true)
        try {
            const r = await deadline(rpc.subQuota(sub?.name), 30000, 'панель не ответила')
            if (!alive.current) return
            setQuota(r.quota)
            setWhy(r.quota ? null : r.why || 'панель не сообщила остаток')
            if (r.kind) setKind(r.kind)
            remember({ quota: r.quota, kind: r.kind })
        } catch (e) {
            if (!alive.current) return
            /* Отказ метода — не то же, что молчание панели: первое чинится обновлением
             * splify2, второе не чинится вовсе. Причина показывается дословно. */
            setWhy(String(e instanceof Error ? e.message : e))
        } finally {
            if (alive.current) setBusy(false)
        }
    }, [remember, sub?.name])

    useEffect(() => {
        /* Про НАЗВАННУЮ подписку всё уже сказано перечнем (sub_list): второй вопрос о том же
         * означал бы два ответа об одной подписке в одном экране. */
        if (sub) {
            setKind((sub.kind as 'url' | 'links' | 'none') ?? 'none')
            if (sub.quota) { setQuota(sub.quota); remember({ quota: sub.quota, kind: sub.kind as never }) }
            else setWhy('')
            return
        }
        let stop = false
        rpc.subInfo()
            .then((r) => {
                if (stop) return
                setKind(r.kind ?? 'none')
                setQuota(r.quota)
                if (!r.quota) setWhy('')
                remember({ kind: r.kind ?? 'none', quota: r.quota })
            })
            .catch(() => { if (!stop) setKind('none') })
        return () => { stop = true }
    }, [remember, sub])

    /* Отдельным заходом в очередь: LuCI складывает вызовы одного такта в ОДИН запрос к ubus
     * и выполняет их подряд, поэтому поход к панели через интернет задержал бы всю страницу.
     * Замерено на роутере: пакет занимал 5,6 с при 150-250 мс на каждый вызов порознь. */
    useEffect(() => {
        if (asked.current || kind !== 'url') return
        asked.current = true
        const t = setTimeout(() => void refresh(), 0)
        return () => clearTimeout(t)
    }, [kind, refresh])

    const v = kind === 'url' && quota ? readQuota(quota) : null

    return (
        <Card>
            {/* Строка переносится: «обновлено 12 мин назад» плюс кнопка не влезают рядом с
                заголовком в 390 пикселях, и кнопка уезжала за край карточки. */}
            <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-x-2 gap-y-1 space-y-0">
                <CardTitle>{sub?.title || (sub && sub.name !== 'main' ? sub.name : 'Подписка')}</CardTitle>
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    {v?.age && <span>обновлено {v.age}</span>}
                    {/* Кнопка есть и когда числа свежие: «обновлено 3 мин назад» — это повод
                        не ходить наружу самим, а не запрет человеку спросить. У вставленных
                        ссылок vless:// кнопки нет — обновлять там нечего. */}
                    {kind === 'url' && (
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={busy}
                            className="flex items-center gap-1 text-primary underline decoration-dotted disabled:opacity-60"
                        >
                            {busy ? (
                                <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                            ) : (
                                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                            )}
                            {busy ? 'спрашиваем…' : 'обновить'}
                        </button>
                    )}
                </div>
            </CardHeader>
            <CardContent>
                {v && v.total !== null && v.left !== null ? (
                    <>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-[30px] font-semibold leading-none" aria-live="polite">
                                {human(v.left)}
                            </span>
                            <span className="text-[13px] text-muted-foreground">
                                из {human(v.total)} осталось
                            </span>
                        </div>
                        {/* Полоса — доля ИЗРАСХОДОВАННОГО, и цвет у неё один. Красить её в
                            «мало осталось» значило бы завести четвёртое состояние поверх трёх:
                            подписка на исходе — это не поломка роутера, и тревожный цвет здесь
                            учил бы не верить тревожному цвету в диагностике. */}
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-full rounded-full bg-primary transition-[width] duration-500"
                                style={{ width: `${Math.round((v.part ?? 0) * 100)}%` }}
                            />
                        </div>
                        <div className="mt-2 flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
                            <span>израсходовано {human(v.used)}</span>
                            {v.expire !== null && <span>сброс {resetText(v.expire)}</span>}
                        </div>
                        <dl className="mt-3 space-y-1 text-[13px]">
                            {v.daysLeft !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">до конца периода</dt>
                                    <dd className="font-medium">{daysText(v.daysLeft)}</dd>
                                </div>
                            )}
                            {/* Темпа может не быть, и это штатно: он МЕРЯЕТСЯ по двум
                                обращениям к панели, а не выводится из длины периода, которую
                                панель не сообщает. Пока измерять нечего — строки нет. */}
                            {v.perDay !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">в среднем в сутки</dt>
                                    <dd className="font-medium">{human(v.perDay)}</dd>
                                </div>
                            )}
                            {/* Запаса хватает дольше периода — знак бесконечности вместо числа
                                суток. «На 20 000 дней» — не срок, а способ сказать «не
                                кончится», и число такой длины человек всё равно не читает. */}
                            {v.forecastDays !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">хватит при таком темпе</dt>
                                    <dd className={`font-medium ${v.tight ? 'text-warning-fg' : ''}`}>
                                        {v.outlasts ? (
                                            <span aria-label="до конца периода с запасом">∞</span>
                                        ) : (
                                            `на ${daysText(v.forecastDays)}`
                                        )}
                                    </dd>
                                </div>
                            )}
                        </dl>
                        {v.tight && (
                            <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-2 text-xs">
                                При нынешнем темпе трафик кончится раньше сброса. Когда он
                                кончится, узел перестанет подниматься: выход упадёт, а правила
                                останутся на месте — трафик пойдёт туда, куда велит{' '}
                                <span className="font-medium">если всё упало</span> у этого
                                выхода.
                            </p>
                        )}
                    </>
                ) : v && (v.expire !== null || v.used > 0) ? (
                    /* Объёма нет (панель не назвала его вовсе или назвала нулём — так панели
                       обозначают безлимит), а срок или расход есть. «Осталось 0 из 0» было бы
                       выдумкой интерфейса, поэтому здесь знак бесконечности. */
                    <Unlimited
                        used={v.used}
                        note={[
                            'объём не ограничен',
                            v.used > 0 ? 'по счёту панели' : '',
                            v.expire !== null ? `сброс ${resetText(v.expire)}` : '',
                        ].filter(Boolean).join(' · ')}
                    />
                ) : kind === 'url' ? (
                    <>
                        <div className="text-[15px]">Панель не сообщает остаток</div>
                        {/* Причина показывается только когда она НЕ «панель промолчала»:
                            пустая строка означает ровно это, и повторять её словами незачем. */}
                        {why && <p className="mt-1 text-xs text-muted-foreground">{why}</p>}
                    </>
                ) : null}


                {/* Локации — ниже остатка и всегда. */}
                <ul className={`space-y-2.5 ${v || kind === 'url' ? 'mt-3 border-t border-border pt-3' : ''}`}>
                    {outs.map((o) => (
                        <li key={o.name}>
                            <Location name={o.name} st={o.st} facts={o.facts} />
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    )
}

/** Строка локации внутри блока подписки: имя выхода, страна с флагом, отклик и адрес.
 *
 *  СВОИМ БЛОКОМ, а не строкой внутри подписки. Локация — это то, чем человек выходит в
 *  интернет прямо сейчас: у неё своё состояние (поднята ли), свой отклик и свой адрес, и
 *  сложенные в один блок три локации читаются как одно целое, которым они не являются. */
function Location({ name, st, facts }: OutRef) {
    /** Имя узла, выбранного движком, — ЗАПАСНАЯ подпись локации: пока измерение не пришло
     *  (или устарело), из него берётся хотя бы страна, которую назвал продавец. */
    const [node, setNode] = useState<string | null>(null)
    useEffect(() => {
        let stop = false
        rpc.vlessNodes(name)
            .then((r) => {
                const n = (r.nodes || []).find((x) => x.index === r.node)
                if (!stop && n?.name) setNode(n.name)
            })
            .catch(() => {})
        return () => { stop = true }
    }, [name, st?.device])

    return <Where name={name} st={st} facts={facts} fallback={node} showIp />
}

/** Блок своего туннеля: WireGuard, AmneziaWG, xsteer.
 *
 *  БЕЗ ТРАФИКА ВОВСЕ. Объём здесь не считает никто: у той стороны панели нет, а счётчик
 *  устройства на роутере отвечает на другой вопрос — «сколько прошло с перезагрузки», — и
 *  рядом с остатком подписки читался бы как остаток. Знак бесконечности говорит ровно то,
 *  что есть: ограничения нет. */
export function TunnelBlock({ name, st, facts }: OutRef) {
    return (
        <Card>
            <CardHeader className="flex-row items-baseline justify-between gap-x-2 space-y-0">
                <CardTitle>{name}</CardTitle>
                <span
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    title="объём не ограничен"
                >
                    <InfinityIcon className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">объём не ограничен</span>
                </span>
            </CardHeader>
            <CardContent>
                <Where name={name} st={st} facts={facts} fallback={st?.device || null} />
            </CardContent>
        </Card>
    )
}

/** Где выход сейчас: локация, отклик и — у подписки — внешний адрес.
 *
 *  Пока выход не поднят, локации нет и выдумывать её нечем: показывается беда. Прошлое
 *  измерение рядом со сломанным туннелем читалось бы как «всё в порядке». */
function Where({
    name, st, facts, fallback, showIp,
}: {
    name: string
    st?: OutputStatus
    facts?: Facts
    fallback: string | null
    showIp?: boolean
}) {
    const up = st?.up === true
    if (st && !up) return <Trouble st={st} name={name} />
    /* Страна — измеренная, а если её нет, та, что назвал продавец в имени узла. Измерения не
     * бывает не только на сломанном выходе: бэкенд помнит ответ пятнадцать минут, и пустой
     * ответ он помнит так же — до следующей проверки страны не будет вовсе. Подпись продавца
     * в этот промежуток лучше пустого места: она хотя бы говорит, куда человек целился.
     *
     * Имя выхода — последнее, что остаётся: оно есть всегда. */
    const cc = facts?.geo?.cc || ccFromName(fallback)
    const place = country(cc) || plainName(fallback) || name
    return (
        <>
            <div className="flex items-baseline gap-2">
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <Flag cc={cc} />
                    <span className="min-w-0 truncate text-[13px] font-medium">{place}</span>

                </span>
                <Ping p={facts?.ping} />
            </div>
            {showIp && <Address ip={facts?.geo?.ip} />}
        </>
    )
}

/** Бесконечность вместо числа. Знак, а не слово: он занимает то же место, что и остаток, и
 *  читается с той же строки — человек сравнивает «сколько осталось» глазами, не читая. */
function Unlimited({ used, note }: { used?: number; note: string }) {
    return (
        <>
            <div className="flex flex-wrap items-baseline gap-x-2">
                {used ? (
                    <>
                        <span className="text-[30px] font-semibold leading-none">{human(used)}</span>
                        <span className="text-[13px] text-muted-foreground">из ∞ израсходовано</span>
                    </>
                ) : (
                    <span className="text-[30px] font-semibold leading-none" aria-label="без ограничения">
                        ∞
                    </span>
                )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        </>
    )
}

/** Внешний адрес — тот, которым роутер виден снаружи через этот выход.
 *
 *  ЗАКРЫТ ПО УМОЛЧАНИЮ, как номер карты в банковском приложении. Главную открывают при людях,
 *  показывают с телефона, снимают с экрана видео — а адрес выхода это то, чем роутер виден
 *  снаружи: по нему находят и узел, и того, кто за ним. Смотреть на него постоянно незачем,
 *  он нужен раз в месяц и на секунду.
 *
 *  Размыт, а не заменён точками: длина и форма адреса остаются на месте, и строка не
 *  прыгает, когда её открывают. Открытое состояние никуда не запоминается — закрытое обязано
 *  быть тем, что человек видит, открыв страницу. */
function Address({ ip }: { ip?: string }) {
    const [shown, setShown] = useState(false)
    if (!ip) return null
    return (
        <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-subtle">внешний адрес</span>
            <span className="flex min-w-0 items-center justify-end gap-1.5 text-right">
                <span
                    className="min-w-0 truncate font-mono text-[12px] font-medium"
                    /* Размытие — стилем, а не классом: оно обязано работать и там, где
                       утилита не попала в сборку. Выделять закрытый адрес мышью нельзя —
                       иначе он копируется из-под размытия. */
                    style={shown ? undefined : { filter: 'blur(4px)', userSelect: 'none' }}
                    aria-hidden={!shown}
                >
                    {ip}
                </span>
                <button
                    type="button"
                    onClick={() => setShown((s) => !s)}
                    aria-label={shown ? 'скрыть внешний адрес' : 'показать внешний адрес'}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                    {shown ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                </button>
            </span>
        </div>
    )
}

/** Беда вместо локации.
 *
 *  Перебор узлов — отдельное состояние, а не отказ: движок обходит узлы подписки по восемь
 *  секунд на узел, и «нет соединения» в этот момент было бы неправдой (I-100). */
function Trouble({ st, name }: { st?: OutputStatus; name: string }) {
    if (st?.probe?.state === 'probing') {
        const n = st?.probe?.node
        const total = st?.probe?.total
        return (
            <>
                <div className="text-[13px] font-medium text-warning-fg">Подключается…</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    {n && total ? `проверяем узлы подписки: ${n} из ${total}` : `поднимаем выход ${name}`}
                </p>
            </>
        )
    }
    /* Номер узла вне подписки — СВОЯ строка, и это не оттенок формулировки.
     *
     *  Пока движок писал здесь `failed` с `total: 0`, тут стояло «в подписке нет пригодных
     *  узлов» — на подписке из двадцати девяти живых узлов, где человек написал номер 31.
     *  По такому объяснению идут перекачивать подписку и менять поставщика, а поправить надо
     *  одно число, и оно у нас есть. Снято с живого роутера. */
    if (st?.probe?.state === 'no_such_node') {
        const n = st.probe.node
        const total = st.probe.total
        return (
            <>
                <div className="text-[13px] font-medium text-destructive">Узла нет в подписке</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {n !== undefined && total !== undefined
                        ? `выбран узел ${n}, а пригодных в подписке ${total}`
                        : 'выбранного узла в подписке нет'}
                    . Подписка обновилась и узлов стало меньше — выберите локацию заново или
                    поставьте «первый рабочий».
                </p>
            </>
        )
    }
    const failed = st?.probe?.state === 'failed'
    return (
        <>
            <div className="text-[13px] font-medium text-destructive">Нет соединения</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {failed
                    ? st?.probe?.total === 0
                        ? 'в подписке нет пригодных узлов'
                        : 'ни один узел подписки не ответил'
                    : `выход ${name} не поднят: устройства нет`}
                . Пока его нет, трафик этого выхода никуда не идёт.
            </p>
        </>
    )
}
