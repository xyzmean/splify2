import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc, type SubQuota } from '@/lib/rpc'
import { human } from '@/lib/live'
import type { Status } from '@/lib/model'
import { daysText, isStale, readQuota, resetText } from '@/lib/quota'

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

export default function SubscriptionCard({ outputs }: { outputs?: Status['outputs'] }) {
    const [kind, setKind] = useState<'url' | 'links' | 'none' | null>(null)
    const [quota, setQuota] = useState<SubQuota | undefined>()
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
    const entries = Object.entries(outputs ?? {})
    const vlessOut = entries.find(([, o]) => o.kind === 'vless')?.[0]
    const wgOut = entries.find(([, o]) => o.kind === 'interface')
    /* Имя активного узла подписки — это и есть «локация»: у продавцов оно называет страну и
     * номер («🇩🇪 Германия №2»). Спрашивается только у выхода kind=vless: у остальных
     * узлов подписки нет вовсе. */
    const [node, setNode] = useState<string | null>(null)
    useEffect(() => {
        if (!vlessOut) { setNode(null); return }
        let stop = false
        rpc.vlessNodes(vlessOut)
            .then((r) => {
                if (stop) return
                const n = (r.nodes || []).find((x) => x.index === r.node)
                setNode(n?.name || null)
            })
            .catch(() => { if (!stop) setNode(null) })
        return () => { stop = true }
    }, [vlessOut])

    const refresh = useCallback(async () => {
        setBusy(true)
        try {
            const r = await rpc.subQuota()
            if (!alive.current) return
            setQuota(r.quota)
            setWhy(r.quota ? null : r.why || 'панель не сообщила остаток')
            if (r.kind) setKind(r.kind)
        } catch (e) {
            if (!alive.current) return
            /* Отказ метода — не то же, что молчание панели: первое чинится обновлением
             * splify2, второе не чинится вовсе. Причина показывается дословно. */
            setWhy(String(e instanceof Error ? e.message : e))
        } finally {
            if (alive.current) setBusy(false)
        }
    }, [])

    useEffect(() => {
        let stop = false
        rpc.subInfo()
            .then((r) => {
                if (stop) return
                setKind(r.kind ?? 'none')
                setQuota(r.quota)
                if (!r.quota) setWhy('')
                /* Спрашиваем панель, только если спрашивать есть кого И запомненное
                 * устарело. Свежие числа — повод не ходить наружу, а не наоборот. */
                if (!asked.current && r.kind === 'url' && isStale(r.quota)) {
                    asked.current = true
                    void refresh()
                }
            })
            .catch(() => { if (!stop) setKind('none') })
        return () => { stop = true }
    }, [refresh])

    /* Считать нечего и показывать нечего: ни подписки, ни туннеля. Пустая карточка на
     * обзоре занимала бы место ради строки «ничего нет». */
    const wg = !vlessOut && !!wgOut
    if ((kind === null || kind === 'none') && !wg) return null

    /* Остаток — ТОЛЬКО у подписки. У вставленных ссылок и у WireGuard его не существует, и
     * прежние запомненные числа рядом с ними были бы числами от другой настройки.
     *
     * Решает АКТИВНЫЙ туннель, а не то, что осталось в настройках: ссылка подписки может
     * лежать в uci с прошлой попытки, а трафик идти через WireGuard — и остаток подписки,
     * которой сейчас никто не пользуется, был бы числом не про этот роутер. */
    const v = !wg && kind === 'url' && quota ? readQuota(quota) : null
    const sub = !wg && (kind === 'url' || kind === 'links')

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
                            <Location name={node} />
                        </dl>
                    </>
                ) : v && v.total !== null && v.left !== null ? (
                    <>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-[30px] font-semibold leading-none">
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
                            {v.forecastDays !== null && (
                                <div className="flex items-baseline justify-between gap-2">
                                    <dt className="text-subtle">хватит при таком темпе</dt>
                                    <dd className={`font-medium ${v.tight ? 'text-warning-fg' : ''}`}>
                                        на {daysText(v.forecastDays)}
                                    </dd>
                                </div>
                            )}
                            <Location name={node} />
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
                            <Location name={node} />
                        </dl>
                    </>
                ) : kind === 'url' ? (
                    <>
                        <div className="text-[15px]">Панель не сообщает остаток</div>
                        {/* Причина показывается только когда она НЕ «панель промолчала»:
                            пустая строка означает ровно это, и повторять её словами незачем. */}
                        {why && <p className="mt-1 text-xs text-muted-foreground">{why}</p>}
                        <dl className="mt-3 space-y-1 text-[13px]">
                            <Location name={node} />
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
