import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc, type SubQuota } from '@/lib/rpc'
import { human } from '@/lib/live'
import { daysText, isStale, readQuota, resetText } from '@/lib/quota'

/** Остаток трафика подписки. Один факт — одно место: только здесь, только на обзоре.
 *
 *  Числа принадлежат ПАНЕЛИ продавца, а не роутеру, и это главное, что карточка обязана
 *  сказать помимо самих чисел. Счётчики роутера выше на этом же экране показывают другое и
 *  никогда не сойдутся с этими: они обнуляются при перезагрузке и не видят трафик, ушедший с
 *  телефона мимо роутера. Пока это не было сказано словами, расхождение читалось как ошибка
 *  одного из двух счётчиков.
 *
 *  Панель отдаёт их заголовком ответа на запрос подписки (`subscription-userinfo`) — не
 *  телом, — поэтому узнать остаток можно только обращением к ней. Обращается бэкенд
 *  (`sub_quota`), а карточка решает, когда пора: при открытии, если запомненному больше
 *  четверти часа, и по нажатию. */

export default function SubscriptionCard() {
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

    /* Источника узлов нет вовсе — карточке нечего показывать и не о чем предупреждать:
     * подписки нет, значит и остатка её быть не может. Место занимать незачем. */
    if (kind === null || kind === 'none') return null

    const v = quota ? readQuota(quota) : null

    return (
        <Card>
            <CardHeader className="flex-row items-baseline justify-between gap-2 space-y-0">
                <CardTitle>Подписка</CardTitle>
                <div className="flex shrink-0 items-baseline gap-2 text-xs text-muted-foreground">
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
                                    <dd className={`font-medium ${v.tight ? 'text-warning' : ''}`}>
                                        на {daysText(v.forecastDays)}
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
                        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                            Цифры считает панель продавца и отдаёт в заголовке ответа на запрос
                            подписки. Они не совпадут со счётчиками роутера выше: те обнуляются
                            при перезагрузке и не видят трафик, ушедший с телефона мимо роутера.
                        </p>
                    </>
                ) : v && v.expire !== null ? (
                    /* Объёма нет, срок есть — подписка без ограничения по трафику. Показывать
                       «осталось 0 из 0» было бы выдумкой интерфейса. */
                    <>
                        <div className="text-[15px]">Без ограничения по объёму</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            панель назвала только срок: сброс {resetText(v.expire)}
                            {v.daysLeft !== null && <>, до конца периода {daysText(v.daysLeft)}</>}
                        </p>
                    </>
                ) : (
                    <>
                        <div className="text-[15px]">Панель не сообщает остаток</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Остаток берётся из заголовка ответа подписки. Его отдают не все
                            панели, а вставленные руками ссылки{' '}
                            <code className="font-mono">vless://</code> не несут его вовсе —
                            тогда считать нечего.
                        </p>
                        {/* Причина показывается только когда она НЕ «панель промолчала»:
                            пустая строка означает ровно то, что написано абзацем выше, и
                            повторять это второй раз другими словами незачем. */}
                        {why && (
                            <p className="mt-2 text-xs text-muted-foreground">{why}</p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    )
}
