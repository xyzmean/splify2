import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { devList, type ClientNet, type Spec, type Status } from '@/lib/model'
import { rpc } from '@/lib/rpc'

/** Кого маршрутизируем: устройства, с которых движок забирает трафик клиентов (splify2#16).
 *
 *  ЗАЧЕМ. Роутер бывает выходной точкой не только для домашнего моста. У автора обращения
 *  через него ходят ещё и хосты из Tailscale и ZeroTier, и правила к ним нужны те же — в
 *  splify1 для этого в /etc/config перечислялись интерфейсы через запятую. Здесь такого
 *  вопроса экран не задавал вовсе: движок без указаний забирает трафик с одного `br-lan`, и
 *  всё остальное молча не маршрутизируется. Снаружи это выглядит хуже отказа — правила
 *  заведены, счётчик стоит, и непонятно почему.
 *
 *  ПОЧЕМУ В СПЕКУ ЕДУТ ИМЕНА, А НЕ ПОДСЕТИ. Движок отвечает на «кто» правилом `iifname` по
 *  списку `lan_devices`. Имя отвечает точно там, где адрес не отвечает вовсе: у `tailscale0`
 *  адрес на роутере обычно /32, то есть подсеть пиров из него не выводится, а у клиентов за
 *  вторым роутером в LAN адреса чужой подсети при том же интерфейсе. Подсети рядом с именем
 *  на экране — подсказка, по которой человек узнаёт устройство, и ничего больше.
 *
 *  ЧТО ИСТОЧНИКОМ БЫТЬ НЕ МОЖЕТ. Перечень бэкенда — это устройства роутера, и в нём лежат
 *  не только сети клиентов: там же наши СОБСТВЕННЫЕ исходящие туннели (устройство выхода
 *  kind=vless, wg-клиент до провайдера, xsteer) и внешний интерфейс. Отметить `tun-vless`
 *  человек мог прямо здесь, ожидая «маршрутизировать тех, кто ко мне подключается», а
 *  получал правило `iifname` на пакеты, ПРИХОДЯЩИЕ из туннеля, — то есть на то, что из
 *  туннеля возвращается, а не на свои устройства.
 *
 *  Приговор считает БЭКЕНД (поле `usable`, причина строкой в `why`): он видит то, чего
 *  экрану не видно — маршрут по умолчанию, пиров wireguard, proto=xsteer в настройках
 *  сети. Экран решает это только там, где бэкенду нечего сказать: старый объект без
 *  приговора и устройство, которого на роутере сейчас нет вовсе (в /sys его нет, а в спеке
 *  он назван устройством выхода).
 *
 *  НЕГОДНОЕ НЕ ПРЯЧЕТСЯ. Спрятанное устройство человек ищет глазами, не находит и решает,
 *  что перечень сломан («куда делся мой wg0»), — тот же довод, по которому и wan
 *  помечается, а не выкидывается. А уже выбранное, ставшее негодным (человек завёл на него
 *  выход), обязано быть названо вслух: это ЕГО настройка, и снять её вправе только он.
 *
 *  ПОЧЕМУ УСТРОЙСТВА И ПОДСЕТИ ВЗАИМНО ИСКЛЮЧАЮТ ДРУГ ДРУГА. `from_default` пишут, чтобы
 *  клиентов ОГРАНИЧИТЬ: гостевая подсеть на том же мосту нарочно остаётся вне списка. Взять
 *  и подсети, и устройства значило бы молча расширить давно написанное ограничение, поэтому
 *  движок отвергает спеку, где заданы подсети и БОЛЬШЕ ОДНОГО устройства. Экран об этом не
 *  умалчивает и не решает за человека: пока подсети заданы, выбор устройств заперт, а рядом
 *  стоит кнопка, которая подсети убирает. */

interface Props {
    /** null — спека ещё не пришла. */
    spec: Spec | null
    /** Живое состояние движка. Нужно ровно для одного: узнать, понимает ли он перечень
     *  устройств вообще. Ответ `status` отдаёт `lan_devices` всегда, какой бы формой они ни
     *  были записаны в спеке; поля нет — движок старее перечня. */
    status: Status | null
    onChange: (next: Spec) => void
}

/** Умолчание движка. Здесь оно названо один раз: интерфейс, который выдумал бы своё, показывал
 *  бы человеку не то, что применено. */
const DEFAULT_DEV = 'br-lan'

export default function ClientNetsCard({ spec, status, onChange }: Props) {
    const [nets, setNets] = useState<ClientNet[] | null>(null)
    /** Почему щелчок ничего не сделал. На экране, а не всплывашкой: отказ здесь — это
     *  правило движка, и человек должен видеть его, пока смотрит на флажки. */
    const [why, setWhy] = useState('')

    useEffect(() => {
        rpc.clientNets()
            .then((r) => setNets(r.nets || []))
            .catch(() => setNets([]))
    }, [])

    /** Спека молчит — значит движок берёт своё умолчание, и показать надо именно его. */
    const chosen = useMemo(() => spec?.lan_devices ?? [DEFAULT_DEV], [spec])
    const byNets = useMemo(() => (spec?.from_default ?? []).length > 0, [spec])

    /** Устройства выходов по СПЕКЕ: устройства из `device`/`devices` плюс имена выходов
     *  kind=vless и kind=xsteer, у которых устройство выводится из имени. Это тот же
     *  приговор, что считает бэкенд, но по одному признаку из четырёх — и нужен он ровно
     *  там, где бэкенд молчит: на объекте старее поля `usable` и на устройстве, которого в
     *  /sys сейчас нет вовсе (перечень бэкенда идёт по /sys, и такого устройства в нём
     *  просто не будет, а в спеке оно названо устройством выхода). */
    const tunnelDevs = useMemo(() => {
        const outs = Object.values(spec?.outputs || {})
        return new Set(outs.flatMap((o) => [
            ...devList(o),
            ...(o.kind === 'vless' || o.kind === 'xsteer' ? [o.name] : []),
        ]))
    }, [spec])

    /** Почему устройство не годится в источники, или '' если годится. Приговор бэкенда
     *  главнее: он знает про маршрут по умолчанию, пиров wireguard и proto=xsteer, чего
     *  из спеки не видно. */
    const whyNotSource = (n: { name: string; wan?: boolean; usable?: boolean; why?: string }) => {
        if (n.usable === true) return ''
        if (n.usable === false)
            return n.why || 'через этот интерфейс роутер уходит наружу, а не принимает клиентов'
        if (tunnelDevs.has(n.name))
            return 'это устройство вашего выхода: через него трафик уходит наружу, а не приходит от клиентов'
        if (n.wan)
            return 'интерфейс ведёт наружу: оттуда приходит не ваша сеть, а весь мир по ту сторону роутера'
        return ''
    }

    /** Устройства роутера плюс те, что названы в спеке, но сейчас отсутствуют. Демон
     *  Tailscale запускается позже сети, и правило по `iifname` это переживает намеренно —
     *  значит и экран обязан: снятый молча флажок читался бы как «настройка пропала». */
    const rows = useMemo(() => {
        const known = nets || []
        const missing = chosen
            .filter((d) => !known.some((n) => n.name === d))
            .map((d) => ({ name: d, up: false, wan: false, subnets: [], absent: true }))
        return [...known.map((n) => ({ ...n, absent: false })), ...missing]
    }, [nets, chosen])

    function toggle(name: string, notSource: string) {
        if (!spec) return
        const on = chosen.includes(name)
        if (on && chosen.length === 1) {
            setWhy('Должно остаться хотя бы одно устройство — иначе движку некому адресовать правила.')
            return
        }
        if (!on && byNets) {
            setWhy('Сейчас клиентов задают подсети. Второе устройство рядом с ними движок отвергнет.')
            return
        }
        /** Второй барьер. Флажок негодного и так заперт (disabled), но запись в спеку не
         *  должна держаться на одном лишь виде: причина отказа здесь та же, что человек
         *  читает в самой строке. Снять уже отмеченное негодное можно всегда — это его
         *  настройка, и убирать её ему. Тот же порядок, что у запертого выбора выше. */
        if (!on && notSource) {
            setWhy(`${name}: ${notSource}`)
            return
        }
        setWhy('')
        const next = on ? chosen.filter((d) => d !== name) : [...chosen, name]
        onChange({ ...spec, lan_devices: next })
    }

    /** Перейти на устройства: подсети убираются, потому что вместе они противоречие, а не
     *  уточнение. Убирает по прямой просьбе человека — молча этого не делает никто. */
    function dropSubnets() {
        if (!spec) return
        const { from_default: _drop, ...rest } = spec
        setWhy('')
        onChange({ ...rest, lan_devices: chosen } as Spec)
    }

    /** Движок старее перечня устройств. Незнакомый ключ спеки его разбор пропускает МОЛЧА:
     *  отказа нет, правила есть, трафик идёт мимо — ровно тот вид поломки, из-за которого
     *  обращение и написано. Жалуемся только когда выбор ОТЛИЧАЕТСЯ от умолчания движка: на
     *  одном br-lan старая версия делает ровно то же самое, и пугать нечем. */
    const engineOld =
        !!status &&
        !('lan_devices' in status) &&
        !(chosen.length === 1 && chosen[0] === DEFAULT_DEV)

    /** Выбранное, что источником быть не может. Чаще всего так и появляется: устройство
     *  выбрали сетью клиентов, а потом завели на него выход. Молча снять отметку нельзя —
     *  это настройка человека, — поэтому здесь она называется вслух. */
    const chosenBad = rows.filter((n) => chosen.includes(n.name) && whyNotSource(n)).map((n) => n.name)
    const anyAbsent = rows.some((n) => n.absent && chosen.includes(n.name))
    /** Подсказка про адрес — только о тех устройствах, которые ВЫБРАТЬ можно: у негодного
     *  человек читает причину отказа, и «адрес нужен, чтобы вы узнали устройство» рядом с
     *  ней отвечает на вопрос, которого он не задавал. */
    const anyBlank = rows.some((n) => !n.absent && !(n.subnets || []).length && !whyNotSource(n))

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Кого маршрутизируем</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-[13px] text-muted-foreground">
                    Правила касаются устройств, которые приходят через эти интерфейсы. Роутер
                    бывает выходной точкой не только для домашней сети — например, для хостов из
                    Tailscale или ZeroTier, которым он шлюз.
                </p>

                {byNets && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                        <p className="text-warning-fg">
                            Сейчас клиентов задают подсети ({(spec?.from_default || []).join(', ')}), и
                            выбор устройств не действует. Так написаны настройки, сделанные до
                            появления перечня интерфейсов.
                        </p>
                        <Button variant="ghost" className="mt-2" onClick={dropSubnets}>
                            Задавать клиентов устройствами
                        </Button>
                    </div>
                )}

                <div className="rounded-md border border-border">
                    {rows.map((n) => {
                        const on = chosen.includes(n.name)
                        const notSource = whyNotSource(n)
                        /** Отметить негодное нельзя, снять — можно всегда: пока оно отмечено,
                         *  это настройка, и убрать её должен человек, а не экран за него. Тот
                         *  же порядок, что у выбора, запертого заданными подсетями. */
                        const locked = (byNets || !!notSource) && !on
                        return (
                            <label
                                key={n.name}
                                className={`flex items-start gap-2 border-b border-border/50 px-2 py-1.5 text-sm last:border-b-0 ${
                                    notSource && !on ? 'opacity-60' : ''
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={locked}
                                    onChange={() => toggle(n.name, notSource)}
                                    className="mt-0.5 shrink-0"
                                    aria-label={n.name}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                            {n.name}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {n.absent
                                                ? 'сейчас на роутере нет'
                                                : (n.subnets || []).length
                                                  ? (n.subnets || []).join(', ')
                                                  : 'адреса пока нет'}
                                        </span>
                                        {n.wan && (
                                            <span className="shrink-0 text-xs text-warning-fg">наружу</span>
                                        )}
                                    </span>
                                    {/* Причина стоит РЯДОМ с флажком, а не в сводке снизу:
                                        человек смотрит на строку, которую хотел отметить. */}
                                    {notSource && (
                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                            {notSource}
                                        </span>
                                    )}
                                </span>
                            </label>
                        )
                    })}
                    {nets !== null && rows.length === 0 && (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                            Устройств не нашлось — бэкенд старее интерфейса?
                        </p>
                    )}
                </div>

                {why && <p className="text-xs text-destructive">{why}</p>}

                {engineOld && (
                    <p className="text-xs text-warning-fg">
                        Движок этой версии перечня устройств не понимает и заберёт трафик только с
                        br-lan: незнакомое поле настройки он пропускает молча. Обновите движок в
                        разделе «Система» — иначе выбор здесь ничего не изменит.
                    </p>
                )}

                {anyAbsent && (
                    <p className="text-xs text-muted-foreground">
                        Устройства, которого сейчас нет, правило не боится: оно сверяется по имени
                        при проходе пакета и заработает само, когда устройство поднимется.
                    </p>
                )}

                {anyBlank && (
                    <p className="text-xs text-muted-foreground">
                        Адрес у устройства нужен не для правил — они по имени интерфейса, — а чтобы
                        вы узнали, какое из них какое.
                    </p>
                )}

                {chosenBad.length > 0 && (
                    <p className="text-xs text-warning-fg">
                        Выбрано то, что источником трафика быть не может: {chosenBad.join(', ')}.
                        Причина стоит рядом с каждым. Правило встанет на пакеты, ПРИХОДЯЩИЕ с
                        этого интерфейса, — то есть на то, что возвращается из туннеля или
                        приходит из интернета, а не на ваши устройства.
                    </p>
                )}
            </CardContent>
        </Card>
    )
}
