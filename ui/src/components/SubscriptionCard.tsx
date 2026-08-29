import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc, type SubQuota } from '@/lib/rpc'
import { human } from '@/lib/live'
import type { Status } from '@/lib/model'
import { cacheGet, cacheSet } from '@/lib/cache'
import { place } from '@/lib/geo'
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

export default function SubscriptionCard({ outputs }: { outputs?: Status['outputs'] }) {
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
    const [geo, setGeo] = useState<{ cc?: string; ip?: string } | null>(seen.current.geo ?? null)
    const [node, setNode] = useState<string | null>(seen.current.node ?? null)
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
    }, [tunnelOut, remember])
    useEffect(() => {
        if (!vlessOut) return
        let stop = false
        rpc.vlessNodes(vlessOut)
            .then((r) => {
                if (stop) return
                const n = (r.nodes || []).find((x) => x.index === r.node)
                if (n?.name) { setNode(n.name); remember({ node: n.name }) }
            })
            .catch(() => {})
        return () => { stop = true }
    }, [vlessOut, remember])

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
                {wg ? (
                    /* WireGuard: объёма не считает никто — ни роутер, ни та сторона. Это не
                       «неизвестно», а «ограничения нет», поэтому знак бесконечности, а не
                       прочерк. */
                    <>
                        <Unlimited note="объём не ограничен: у туннеля нет счётчика" />
                        <dl className="mt-3 space-y-1 text-[13px]">
                            <Location name={place(geo?.cc) || node} />
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
                            {v.forecastDays !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">хватит при таком темпе</dt>
                                    <dd className={`font-medium ${v.tight ? 'text-warning-fg' : ''}`}>
                                        на {daysText(v.forecastDays)}
                                    </dd>
                                </div>
                            )}
                            <Location name={place(geo?.cc) || node} />
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
                ) : v && v.expire !== null ? (
                    /* Объёма нет, срок есть — подписка без ограничения по трафику. Показывать
                       «осталось 0 из 0» было бы выдумкой интерфейса. */
                    <>
                        <Unlimited note={`панель назвала только срок: сброс ${resetText(v.expire)}`} />
                        <dl className="mt-3 space-y-1 text-[13px]">
                            {v.daysLeft !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">до конца периода</dt>
                                    <dd className="font-medium">{daysText(v.daysLeft)}</dd>
                                </div>
                            )}
                            <Location name={place(geo?.cc) || node} />
                        </dl>
                    </>
                ) : kind === 'url' ? (
                    <>
                        <div className="text-[15px]">Панель не сообщает остаток</div>
                        {/* Причина показывается только когда она НЕ «панель промолчала»:
                            пустая строка означает ровно это, и повторять её словами незачем. */}
                        {why && <p className="mt-1 text-xs text-muted-foreground">{why}</p>}
                        <dl className="mt-3 space-y-1 text-[13px]">
                            <Location name={place(geo?.cc) || node} />
                        </dl>
                    </>
                ) : (
                    /* Вставленные руками ссылки: остатка не существует, и говорить о нём
                       нечего. Остаётся то, что человеку и нужно, — куда он сейчас выходит. */
                    <dl className="space-y-1 text-[13px]">
                        <Location name={node} />
                    </dl>
                )}
            </CardContent>
        </Card>
    )
}

/** Строка локации. Отдельным куском, потому что она одна и та же во всех четырёх состояниях
 *  карточки, а повторить её четырьмя копиями значит однажды поправить три. */
function Location({ name }: { name: string | null }) {
    if (!name) return null
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-subtle">локация</dt>
            <dd className="min-w-0 text-right font-medium">{name}</dd>
        </div>
    )
}

/** Бесконечность вместо числа. Знак, а не слово: он занимает то же место, что и остаток, и
 *  читается с той же строки — человек сравнивает «сколько осталось» глазами, не читая. */
function Unlimited({ note }: { note: string }) {
    return (
        <>
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[30px] font-semibold leading-none" aria-label="без ограничения">
                    ∞
                </span>
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
