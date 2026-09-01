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

    /** Устройства роутера плюс те, что названы в спеке, но сейчас отсутствуют. Демон
     *  Tailscale запускается позже сети, и правило по `iifname` это переживает намеренно —
     *  значит и экран обязан: снятый молча флажок читался бы как «настройка пропала». */
    /** Устройства туннелей — не клиенты. Устройства выходов (wg0, TUN подписок, части пулов)
     *  бэкенд перечисляет наравне с br-lan, и человек видел в списке «кого маршрутизируем»
     *  Xui-1 и Xui-2 — то, куда трафик уходит, а не откуда приходит. Выбранное руками не
     *  прячется: снятый молча флажок читался бы как пропавшая настройка. */
    const tunnelDevs = useMemo(() => {
        const outs = Object.values(spec?.outputs || {})
        return new Set(outs.flatMap((o) => [
            ...devList(o),
            ...(o.kind === 'vless' || o.kind === 'xsteer' ? [o.name] : []),
        ]))
    }, [spec])

    const rows = useMemo(() => {
        const known = (nets || []).filter((n) => !tunnelDevs.has(n.name) || chosen.includes(n.name))
        const missing = chosen
            .filter((d) => !known.some((n) => n.name === d))
            .map((d) => ({ name: d, up: false, wan: false, subnets: [], absent: true }))
        return [...known.map((n) => ({ ...n, absent: false })), ...missing]
    }, [nets, chosen, tunnelDevs])

    function toggle(name: string) {
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

    const chosenWan = rows.some((n) => n.wan && chosen.includes(n.name))
    const anyAbsent = rows.some((n) => n.absent && chosen.includes(n.name))
    const anyBlank = rows.some((n) => !n.absent && !(n.subnets || []).length)

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
                        return (
                            <label
                                key={n.name}
                                className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5 text-sm last:border-b-0"
                            >
                                <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={byNets && !on}
                                    onChange={() => toggle(n.name)}
                                    className="shrink-0"
                                    aria-label={n.name}
                                />
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{n.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {n.absent
                                        ? 'сейчас на роутере нет'
                                        : (n.subnets || []).length
                                          ? (n.subnets || []).join(', ')
                                          : 'адреса пока нет'}
                                </span>
                                {n.wan && <span className="shrink-0 text-xs text-warning-fg">наружу</span>}
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

                {chosenWan && (
                    <p className="text-xs text-warning-fg">
                        Выбран интерфейс, ведущий наружу: в правила попадут не ваши устройства, а
                        весь мир по ту сторону роутера.
                    </p>
                )}
            </CardContent>
        </Card>
    )
}
