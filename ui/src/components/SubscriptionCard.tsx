import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc, type SubQuota } from '@/lib/rpc'
import { human } from '@/lib/live'
import type { OutputStatus, Status } from '@/lib/model'
import { cacheGet, cacheSet } from '@/lib/cache'
import { country } from '@/lib/geo'
import Flag from '@/components/Flag'
import { daysText, readQuota, resetText } from '@/lib/quota'

/** Сколько трафика осталось и через какую точку он выходит. Один факт — одно место: только
 *  здесь, только на обзоре.
 *
 *  ОСТАТОК СЧИТАЕТСЯ ТОЛЬКО У ПОДПИСКИ, и это не оптимизация. Числа принадлежат панели
 *  продавца и приезжают заголовком ответа на запрос подписки (`subscription-userinfo`), а не
 *  телом. У вставленных руками ссылок `vless://` такого ответа нет вовсе, у WireGuard нет и
 *  самого понятия: считать нечего, и спрашивать не у кого. Обращается бэкенд (`sub_quota`), а
 *  карточка решает, когда пора: при открытии, если запомненному больше четверти часа, и по
 *  нажатию.
 *
 *  ТУННЕЛЬ БЕЗ ПОДПИСКИ показывает бесконечность вместо числа. Это не «много осталось», а
 *  «ограничения нет»: у WireGuard объём не считает никто, и подставить сюда ноль или прочерк
 *  значило бы соврать в обе стороны.
 *
 *  ЛОКАЦИЯ — здесь же, а не отдельной карточкой: «сколько осталось» и «откуда я сейчас
 *  выхожу» — один вопрос про один туннель, и разносить их по экрану значит заставлять
 *  человека сводить их глазами. */

/** Что карточка показывала в прошлый раз. Хранится в памяти браузера и рисуется сразу при
 *  открытии — до того, как придёт первый ответ ubus. Подробности про кеш — в lib/cache.ts. */
type Snapshot = {
    kind?: 'url' | 'links' | 'none'
    quota?: SubQuota
    /** Через что шёл трафик: у выхода поверх WireGuard остатка не бывает, и форма карточки
     *  другая. Без этого признака первая отрисовка выбрала бы форму наугад. */
    wg?: boolean
    geo?: { cc?: string; ip?: string }
    node?: string
}

export default function SubscriptionCard({
    outputs,
    devs,
}: {
    outputs?: Status['outputs']
    /** Счётчики устройств роутера (`dev_stats`). Нужны там, где считать объём больше некому:
     *  у WireGuard панели нет вовсе, а безлимитная подписка обычно отдаёт нули вместо
     *  расхода. Знак бесконечности без числа отвечает только на половину вопроса — «сколько
     *  можно», — а спрашивают ещё и «сколько уже прошло». */
    devs?: Record<string, { rx: string; tx: string }> | null
}) {
    const seen = useRef<Snapshot>(cacheGet<Snapshot>('card') || {})
    const remember = useCallback((p: Snapshot) => {
        seen.current = { ...seen.current, ...p }
        cacheSet('card', seen.current)
    }, [])

    const [kind, setKind] = useState<'url' | 'links' | 'none' | null>(seen.current.kind ?? null)
    const [quota, setQuota] = useState<SubQuota | undefined>(seen.current.quota)
    /** null — ещё не знаем; строка — панель молчит, и вот почему. */
    const [why, setWhy] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    /** Опрос при открытии делается ОДИН раз за жизнь карточки: без этого признака он
     *  повторялся бы на каждом приходе ответа, потому что ответ меняет состояние. */
    const asked = useRef(false)
    const alive = useRef(true)
    useEffect(() => () => { alive.current = false }, [])

    /* Через что сейчас выходит трафик. Из состояния движка, а не из спеки: спека говорит,
     * чего человек хотел, а вопрос здесь — что работает прямо сейчас. */
    /* `undefined` — состояние движка ещё не пришло, `{}` — пришло и выходов нет. Разница
     * принципиальна: в первом случае форму карточки подсказывает запомненное, во втором
     * запомненному верить нельзя — туннеля больше нет. */
    const known = outputs !== undefined
    const entries = Object.entries(outputs ?? {})
    const vlessOut = entries.find(([, o]) => o.kind === 'vless')?.[0]
    const wgOut = entries.find(([, o]) => o.kind === 'interface')
    /* ЛОКАЦИЯ МЕРЯЕТСЯ, а не читается из подписки. Имя узла («🇩🇪 Германия №2») пишет
     * продавец: это подпись, а не факт, узел мог переехать, а у выходов поверх WireGuard и
     * xsteer имени нет вовсе. Бэкенд спрашивает внешнюю сторону ЧЕРЕЗ САМ ВЫХОД, поэтому
     * ответ один и тот же по смыслу для любого вида туннеля.
     *
     * Имя узла остаётся ЗАПАСНЫМ вариантом: пока измерение не пришло (или выход не поднят и
     * мерить нечем), подпись продавца лучше пустоты. */
    const tunnelOut = vlessOut || wgOut?.[0]
    /* Состояние туннеля решает, о чём вообще эта карточка. Пока соединения нет, остаток
     * трафика — не ответ на вопрос человека: у него не работает, а мы показываем, сколько
     * гигабайт не потрачено. Поэтому сначала беда, и только у поднятого выхода — числа. */
    const st = tunnelOut ? (outputs || {})[tunnelOut] : undefined
    const up = st?.up === true
    /* Сколько прошло через устройство туннеля по счёту РОУТЕРА: rx — принятое, tx — отданное.
     * Счёт идёт с последней перезагрузки, и об этом сказано подписью под числом: выдать его
     * за расход периода значило бы соврать в меньшую сторону после каждой перезагрузки.
     * Нуль — считать нечем: устройства ещё нет, или счётчики не приехали. */
    const devStat = st?.device ? devs?.[st.device] : undefined
    const flow = devStat ? (Number(devStat.rx) || 0) + (Number(devStat.tx) || 0) : 0
    const probing = st?.probe?.state === 'probing'
    const [geo, setGeo] = useState<{ cc?: string; ip?: string } | null>(seen.current.geo ?? null)
    const [node, setNode] = useState<string | null>(seen.current.node ?? null)
    /** Какой узел выбран сейчас. Меняется — значит выходим в другом месте. */
    const [nodeIdx, setNodeIdx] = useState<number | null>(null)
    /* Спрашиваем заново, когда выход перезапустился или сменился узел: при смене профиля
     * подписки движок пересоздаёт туннель, и прежняя страна перестаёт быть правдой. Сам
     * бэкенд к тому же не отдаёт измерение, снятое с другого устройства. */
    useEffect(() => {
        if (!tunnelOut) return
        let stop = false
        rpc.outboundGeo(tunnelOut, false)
            .then((r) => {
                if (stop || !r.cc && !r.ip) return
                const g = { cc: r.cc, ip: r.ip }
                setGeo(g)
                remember({ geo: g })
            })
            .catch(() => {})
        return () => { stop = true }
    }, [tunnelOut, up, nodeIdx, remember])

    useEffect(() => {
        if (!vlessOut) return
        let stop = false
        rpc.vlessNodes(vlessOut)
            .then((r) => {
                if (stop) return
                setNodeIdx(r.node)
                const n = (r.nodes || []).find((x) => x.index === r.node)
                if (n?.name) { setNode(n.name); remember({ node: n.name }) }
            })
            .catch(() => {})
        return () => { stop = true }
    }, [vlessOut, up, remember])

    /* Панель спрашивается ПРИ КАЖДОМ открытии, а не только когда запомненное устарело.
     * Прежний порог в четверть часа экономил обращение наружу ценой того, ради чего страницу
     * и открывают: человек видел числа позавчерашней давности и не знал, что они не
     * сегодняшние. Теперь запомненное рисуется сразу — оно уже на экране к этому моменту, —
     * а свежее приезжает следом и заменяет его на глазах, с анимацией, чтобы подмену было
     * видно.
     *
     * Не спрашиваем, когда трафик идёт через WireGuard: остаток подписки, которой сейчас
     * никто не пользуется, — обращение наружу впустую. Один раз за жизнь карточки: без
     * признака опрос повторялся бы на каждом приходе ответа, потому что ответ меняет
     * состояние. */
    const refresh = useCallback(async () => {
        setBusy(true)
        try {
            const r = await rpc.subQuota()
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
    }, [remember])

    useEffect(() => {
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
    }, [remember])


    /* Пока состояние движка не пришло, форму карточки подсказывает запомненное: иначе первая
     * отрисовка выбрала бы её наугад и через секунду перестроилась на глазах. */
    const wg = known ? !vlessOut && !!wgOut : !!seen.current.wg
    useEffect(() => {
        if (known) remember({ wg })
    }, [known, wg, remember])

    /* Опрос панели ждёт двух вещей.
     *
     * Во-первых, пока станет известно, чем роутер выходит: спрашивать остаток подписки при
     * работающем WireGuard незачем.
     *
     * Во-вторых — отдельным заходом в очередь. LuCI складывает вызовы, выпущенные в одном
     * такте, в ОДИН запрос к ubus и выполняет их подряд, поэтому медленный вызов задерживает
     * все остальные. Обращение к панели идёт через интернет и стоит секунд — попав в тот же
     * пакет, что и состояние движка, оно заставляло обзор писать «Загрузка…» всё это время.
     * Замерено на роутере: пакет занимал 5,6 с при 150-250 мс на каждый вызов по отдельности.
     * `setTimeout` уводит его в следующий пакет, и страница успевает нарисоваться. */
    useEffect(() => {
        if (asked.current || kind !== 'url' || wg) return
        asked.current = true
        const t = setTimeout(() => void refresh(), 0)
        return () => clearTimeout(t)
    }, [kind, wg, refresh])

    /* Остаток — ТОЛЬКО у подписки. У вставленных ссылок и у WireGuard его не существует, и
     * прежние запомненные числа рядом с ними были бы числами от другой настройки.
     *
     * Решает АКТИВНЫЙ туннель, а не то, что осталось в настройках: ссылка подписки может
     * лежать в uci с прошлой попытки, а трафик идти через WireGuard — и остаток подписки,
     * которой сейчас никто не пользуется, был бы числом не про этот роутер. */
    const v = !wg && kind === 'url' && quota ? readQuota(quota) : null
    const sub = !wg && (kind === 'url' || kind === 'links')
    /* Число едет к новому значению, а не подменяется мгновенно. Хук зовётся ДО всякого
     * возврата: число хуков на каждом проходе обязано совпадать. */
    const shownLeft = useTween(v && v.left !== null ? v.left : null)

    /* Считать нечего и показывать нечего: ни подписки, ни туннеля. Пустая карточка на
     * обзоре занимала бы место ради строки «ничего нет». */
    if ((kind === null || kind === 'none') && !wg) return null

    return (
        <Card>
            {/* Строка переносится: «обновлено 12 мин назад» плюс кнопка не влезают рядом с
                заголовком в 390 пикселях, и кнопка уезжала за край карточки. */}
            <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-x-2 gap-y-1 space-y-0">
                {/* Без подписки блок называется по тому, о чём он: у WireGuard подписки
                    нет, а туннель есть — и остаток у него не «неизвестен», а не существует. */}
                <CardTitle>{sub ? 'Подписка' : 'Туннель'}</CardTitle>
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    {v?.age && <span>обновлено {v.age}</span>}
                    {/* Кнопка есть и когда числа свежие: «обновлено 3 мин назад» — это повод
                        не ходить наружу самим, а не запрет человеку спросить. У вставленных
                        ссылок vless:// кнопки нет — обновлять там нечего, и у работающего
                        WireGuard тоже: остаток подписки, которой никто не пользуется, эта
                        кнопка спросила бы у панели впустую. */}
                    {!wg && kind === 'url' && (
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
                {known && tunnelOut && !up ? (
                    /* Соединения нет. Ни остатка, ни бесконечности: и то и другое отвечало бы
                       на вопрос, которого сейчас не задают. */
                    <Trouble st={st} name={tunnelOut} probing={probing} />
                ) : wg ? (
                    /* WireGuard: объёма не считает никто — ни роутер, ни та сторона. Это не
                       «неизвестно», а «ограничения нет», поэтому знак бесконечности, а не
                       прочерк. */
                    <>
                        <Unlimited
                            used={flow}
                            note={
                                flow > 0
                                    ? 'объём не ограничен · сосчитал роутер, с перезагрузки'
                                    : 'объём не ограничен: у туннеля нет счётчика'
                            }
                        />
                        <dl className="mt-3 space-y-1 text-[13px]">
                            <Location cc={geo?.cc} name={country(geo?.cc) || node} />
                            <Address ip={geo?.ip} />
                        </dl>
                    </>
                ) : v && v.total !== null && v.left !== null ? (
                    <>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                            {/* aria-live: озвучивается итог, а не каждый кадр анимации. */}
                            <span
                                className="text-[30px] font-semibold leading-none"
                                aria-live="polite"
                            >
                                {human(shownLeft ?? v.left)}
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
                                кончится», и число такой длины человек всё равно не читает: он
                                видит много цифр и идёт дальше. */}
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
                            <Location cc={geo?.cc} name={country(geo?.cc) || node} />
                            <Address ip={geo?.ip} />
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
                ) : v && (v.expire !== null || v.used > 0 || flow > 0) ? (
                    /* Объёма нет (панель не назвала его вовсе или назвала нулём — так панели
                       обозначают безлимит), а срок или расход есть. Показывать «осталось 0 из
                       0» было бы выдумкой интерфейса, поэтому здесь знак бесконечности, а
                       рядом — сколько трафика через неё уже прошло.
                       Чей это счёт, решается по одному правилу: панель, если она вообще
                       считает, иначе роутер. Складывать их нельзя — это два счёта одного и
                       того же с разных сторон и с разных моментов. */
                    <>
                        <Unlimited
                            used={v.used || flow}
                            note={[
                                'объём не ограничен',
                                v.used > 0
                                    ? 'по счёту панели'
                                    : flow > 0
                                      ? 'сосчитал роутер, с перезагрузки'
                                      : '',
                                v.expire !== null ? `сброс ${resetText(v.expire)}` : '',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        />
                        <dl className="mt-3 space-y-1 text-[13px]">
                            {v.daysLeft !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">до конца периода</dt>
                                    <dd className="font-medium">{daysText(v.daysLeft)}</dd>
                                </div>
                            )}
                            <Location cc={geo?.cc} name={country(geo?.cc) || node} />
                            <Address ip={geo?.ip} />
                        </dl>
                    </>
                ) : kind === 'url' ? (
                    <>
                        <div className="text-[15px]">Панель не сообщает остаток</div>
                        {/* Причина показывается только когда она НЕ «панель промолчала»:
                            пустая строка означает ровно это, и повторять её словами незачем. */}
                        {why && <p className="mt-1 text-xs text-muted-foreground">{why}</p>}
                        <dl className="mt-3 space-y-1 text-[13px]">
                            <Location cc={geo?.cc} name={country(geo?.cc) || node} />
                            <Address ip={geo?.ip} />
                        </dl>
                    </>
                ) : (
                    /* Вставленные руками ссылки: остатка не существует, и говорить о нём
                       нечего. Остаётся то, что человеку и нужно, — куда он сейчас выходит. */
                    <dl className="space-y-1 text-[13px]">
                        <Location cc={geo?.cc} name={country(geo?.cc) || node} />
                        <Address ip={geo?.ip} />
                    </dl>
                )}
            </CardContent>
        </Card>
    )
}

/** Строка локации. Отдельным куском, потому что она одна и та же во всех четырёх состояниях
 *  карточки, а повторить её четырьмя копиями значит однажды поправить три. */
function Location({ cc, name }: { cc?: string; name: string | null }) {
    if (!name) return null
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-subtle">локация</dt>
            <dd className="flex min-w-0 items-baseline justify-end gap-1.5 text-right font-medium">
                <Flag cc={cc} />
                <span className="min-w-0 truncate">{name}</span>
            </dd>
        </div>
    )
}

/** Бесконечность вместо числа. Знак, а не слово: он занимает то же место, что и остаток, и
 *  читается с той же строки — человек сравнивает «сколько осталось» глазами, не читая.
 *
 *  ЧИСЛО РЯДОМ СО ЗНАКОМ — израсходованное. Одна бесконечность отвечает только на половину
 *  вопроса: «ограничения нет» — это не «ничего не прошло», а второе спрашивают ровно так же
 *  часто. Крупным идёт объём, мелким — «из ∞ израсходовано»: та же форма строки, что у
 *  подписки с объёмом («68,0 ГБ из 200,0 ГБ осталось»), и глазу не нужно перестраиваться,
 *  переходя от одной карточки к другой.
 *
 *  Считать нечем — остаётся один знак: нуль вместо числа читался бы как «трафика не было»,
 *  а его никто не мерил. */
function Unlimited({ used, note }: { used?: number; note: string }) {
    return (
        <>
            <div className="flex flex-wrap items-baseline gap-x-2">
                {used ? (
                    <>
                        <span className="text-[30px] font-semibold leading-none">{human(used)}</span>
                        <span className="text-[13px] text-muted-foreground">
                            из ∞ израсходовано
                        </span>
                    </>
                ) : (
                    <span
                        className="text-[30px] font-semibold leading-none"
                        aria-label="без ограничения"
                    >
                        ∞
                    </span>
                )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        </>
    )
}

/** Плавный переезд числа к новому значению.
 *
 *  ЗАЧЕМ. Остаток спрашивается у панели при каждом открытии, а на экране к этому моменту уже
 *  нарисовано запомненное. Подмени его в одном кадре — и подмена читается как «показалось»:
 *  человек не понимает, обновилось ли что-нибудь. Переезд за семь десятых секунды делает ровно
 *  одно — показывает, что число ПРИЕХАЛО.
 *
 *  Первое значение не анимируется: ехать неоткуда, и старт с нуля выглядел бы как будто
 *  подписка была пустой. Там, где кадров нет вовсе (стенд, отключённая анимация), значение
 *  ставится сразу: анимация не должна быть условием того, что число видно. */
function useTween(target: number | null): number | null {
    const [shown, setShown] = useState<number | null>(target)
    const from = useRef<number | null>(target)
    useEffect(() => {
        const a = from.current
        if (
            target === null || a === null || a === target ||
            typeof requestAnimationFrame !== 'function'
        ) {
            from.current = target
            setShown(target)
            return
        }
        const t0 = Date.now()
        let raf = 0
        const step = () => {
            const k = Math.min(1, (Date.now() - t0) / 700)
            /* Замедление к концу (кубическое): равномерный ход читается как счётчик пробега,
             * а не как «значение встало на место». */
            setShown(a + (target - a) * (1 - Math.pow(1 - k, 3)))
            if (k < 1) raf = requestAnimationFrame(step)
            else from.current = target
        }
        raf = requestAnimationFrame(step)
        return () => cancelAnimationFrame(raf)
    }, [target])
    return shown
}

/** Внешний адрес — тот, которым роутер виден снаружи через этот выход.
 *
 *  Показывается только когда соединение работает: адрес, оставшийся от прошлого измерения,
 *  рядом со сломанным туннелем читался бы как «всё в порядке».
 *
 *  ЗАКРЫТ ПО УМОЛЧАНИЮ, как номер карты в банковском приложении. Обзор открывают при людях,
 *  показывают с телефона, снимают с экрана видео — а адрес выхода это то, чем роутер виден
 *  снаружи: по нему находят и узел, и того, кто за ним. Смотреть на него постоянно незачем,
 *  он нужен раз в месяц и на секунду, поэтому цена «нажать глаз» здесь мизерная, а цена
 *  случайно показанного адреса — нет.
 *
 *  Размыт, а не заменён точками: длина и форма адреса остаются на месте, и строка не
 *  прыгает, когда её открывают. Открытое состояние живёт до перерисовки карточки и никуда
 *  не запоминается — закрытое обязано быть тем, что человек видит, открыв страницу. */
function Address({ ip }: { ip?: string }) {
    const [shown, setShown] = useState(false)
    if (!ip) return null
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-subtle">внешний адрес</dt>
            <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right">
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
                    onClick={() => setShown((v) => !v)}
                    aria-label={shown ? 'скрыть внешний адрес' : 'показать внешний адрес'}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                    {shown ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                </button>
            </dd>
        </div>
    )
}

/** Беда вместо чисел.
 *
 *  Пока туннель не поднят, «осталось 800 ГБ» — не ответ, а издевательство: у человека не
 *  работает, а карточка рассказывает, сколько он не потратил. Поэтому здесь ровно то, что
 *  сейчас имеет значение: что именно не так и на каком выходе.
 *
 *  Перебор узлов — отдельное состояние, а не отказ: движок обходит узлы подписки по восемь
 *  секунд на узел, и «нет соединения» в этот момент было бы неправдой (I-100). */
function Trouble({
    st, name, probing,
}: { st?: OutputStatus; name: string; probing: boolean }) {
    if (probing) {
        const n = st?.probe?.node
        const total = st?.probe?.total
        return (
            <>
                <div className="text-[15px] font-medium text-warning-fg">Подключается…</div>
                <p className="mt-1 text-xs text-muted-foreground">
                    {n && total ? `проверяем узлы подписки: ${n} из ${total}` : `поднимаем выход ${name}`}
                </p>
            </>
        )
    }
    const failed = st?.probe?.state === 'failed'
    return (
        <>
            <div className="text-[15px] font-medium text-destructive">Нет соединения</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {failed
                    ? st?.probe?.total === 0
                        ? 'в подписке нет пригодных узлов'
                        : 'ни один узел подписки не ответил'
                    : `выход ${name} не поднят: устройства нет`}
                . Пока его нет, трафик этого выхода никуда не идёт — смотрите диагностику.
            </p>
        </>
    )
}
