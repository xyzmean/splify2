import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Link2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { rpc, type XsteerTunnel } from '@/lib/rpc'
import { human, type Live } from '@/lib/live'
import { xsLinkSupported } from '@/lib/engine'

/** XSTEER: устройства звезды, их живое состояние и ссылка xs:// в обе стороны.
 *
 *  ПОЛЯ ПИРЫ (ключ, адрес в туннеле, хаб, SNI, MTU, разгрузка) живут в настройке сети роутера —
 *  их описывает страница протокола (luci/htdocs/luci-static/resources/protocol/xsteer.js), и
 *  правит их netifd через uci. Второй формы тех же полей здесь быть не должно: два места,
 *  пишущие одну настройку, расходятся, а расхождение видно только тем, что туннель не
 *  поднялся.
 *
 *  Что здесь есть — то, чего в настройке нет: СОСТОЯНИЕ. Какой хаб отвечает, сколько секунд
 *  назад было рукопожатие, встала ли разгрузка сегментации, сколько раз соединение
 *  переподнималось и почему. Это знает только процесс пира, и он пишет это в свой файл
 *  состояния (steer, src/ext/xsclient.c).
 *
 *  И ссылка. Она здесь, а не только на странице сети, потому что вопрос «перенести этот доступ
 *  на телефон» — это вопрос про работающий туннель, а не про его настройку; ту же кнопку на
 *  странице настройки человек ищет после того, как всё уже настроено. */

/** Секунды человеческим сроком. Отдельная функция, а не `${n} с`: «3600 с назад» человек
 *  считает глазами, а «час назад» читает. */
function ago(sec: number): string {
    if (sec < 0) return 'не было'
    if (sec < 60) return `${sec} с назад`
    if (sec < 3600) return `${Math.round(sec / 60)} мин назад`
    return `${Math.round(sec / 360) / 10} ч назад`.replace('.', ',')
}

/** Что удалось договориться с ядром про разгрузку — одним словом и с подсказкой.
 *
 *  ТРИ ФЛАГА СВОДЯТСЯ К ОДНОМУ СЛОВУ намеренно. Человеку нужен ответ на вопрос «работает ли
 *  быстрый путь», а не отчёт по трём ioctl; но частичный случай («отдаём склеенное, а принимать
 *  не дали») скрывать нельзя — он означает, что половина прибавки потеряна, и причина у него
 *  своя (ядро без TUNSETOFFLOAD). Поэтому слов три, а не два. */
function offloadLabel(o?: { gso: boolean; gro: boolean; rx: boolean }) {
    if (!o) return { text: 'неизвестно', variant: 'outline' as const, tip: 'Движок не сообщает — сборка старее 1.3.0.' }
    if (!o.gso)
        return {
            text: 'выключена',
            variant: 'destructive' as const,
            tip: 'Быстрый путь не встал: устройство без multi_queue, ядро без vnet_hdr или разгрузка выключена в настройке интерфейса. Туннель работает, но в разы медленнее — отдача в устройство стоит 3920 нс на пакет вместо 269.',
        }
    if (o.gso && o.gro && o.rx)
        return {
            text: 'полная',
            variant: 'default' as const,
            tip: 'И отдаём ядру склеенные кадры, и принимаем склеенное от него. Это самая крупная прибавка к скорости из всего, что есть в туннеле.',
        }
    return {
        text: 'частичная',
        variant: 'secondary' as const,
        tip: `Встала не целиком: отдача ${o.gro ? 'есть' : 'нет'}, приём склеенного ${o.rx ? 'есть' : 'нет'}. Приём просит TUNSETOFFLOAD — его может не дать ядро.`,
    }
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-subtle">{label}</span>
            <span className="font-medium text-right">{children}</span>
        </div>
    )
}

export default function XsteerPanel({ live }: { live: Live }) {
    const [tunnels, setTunnels] = useState<Record<string, XsteerTunnel> | null>(null)
    /* Устройства нужны для одного: связать туннель с выходом спеки, в котором он числится.
     * Само наличие туннеля берётся из настройки (xsteer_state), а не из списка устройств, —
     * иначе выключенный интерфейс исчезал бы с экрана вместо того, чтобы показать, что он
     * выключен. Ровно это и есть состояние, за которым сюда приходят. */
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[] | null>(null)
    const [link, setLink] = useState<Record<string, string>>({})
    const [copied, setCopied] = useState<string | null>(null)
    const [paste, setPaste] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [dead, setDead] = useState(false)
    const [note, setNote] = useState<Record<string, { text: string; bad: boolean }>>({})

    const links = xsLinkSupported(live.status)

    /* Отказ вызова и «туннелей нет» РАЗДЕЛЕНЫ, и это не мелочь: rpcd постарее интерфейса метода
     * не знает вовсе, и показать в этом случае «интерфейсов xsteer нет» значило бы соврать про
     * настройку роутера — человек пошёл бы создавать второй туннель рядом с существующим.
     *
     * На умение движка вызов НЕ смотрит: перечень туннелей бэкенд берёт из настройки сети, а не
     * у движка, и работает он с движком любого поколения. Новые поля состояния (разгрузка,
     * переподнятия) необязательны по типу — движок постарше их просто не печатает. */
    const reload = useCallback(() => {
        rpc.xsteerState()
            .then((r) => { setTunnels(r.tunnels || {}); setDead(false) })
            .catch(() => { setTunnels({}); setDead(true) })
    }, [])

    /* Перечитываем на КРУГЕ РОДИТЕЛЯ, а не своим таймером: страница уже опрашивает роутер, и
     * второй таймер означал бы два разных ритма на одном экране — числа в карточках отставали
     * бы от чисел рядом. Зависимость по live.status: он меняется на каждом круге. */
    useEffect(reload, [reload, live.status])
    useEffect(() => {
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
    }, [])

    const outputs = Object.entries(live.status?.outputs || {})
    const names = Object.keys(tunnels || {}).sort()

    async function showLink(iface: string) {
        setBusy(iface)
        try {
            const r = await rpc.xsteerLink({ iface })
            if (r.ok && r.link) setLink((p) => ({ ...p, [iface]: r.link as string }))
            else setNote((p) => ({ ...p, [iface]: { text: r.error || 'роутер не отдал ссылку', bad: true } }))
        } catch {
            setNote((p) => ({ ...p, [iface]: { text: 'роутер не ответил', bad: true } }))
        } finally {
            setBusy(null)
        }
    }

    async function applyLink(iface: string) {
        const v = (paste[iface] || '').trim()
        if (!v) return
        setBusy(iface)
        try {
            const r = await rpc.xsteerLinkPut({ iface, link: v })
            if (r.ok) {
                setPaste((p) => ({ ...p, [iface]: '' }))
                setNote((p) => ({
                    ...p,
                    [iface]: { text: `принята: хаб ${r.hub}. Интерфейс поднимается заново.`, bad: false },
                }))
                live.refresh()
            } else {
                setNote((p) => ({ ...p, [iface]: { text: r.error || 'ссылка не принята', bad: true } }))
            }
        } catch {
            setNote((p) => ({ ...p, [iface]: { text: 'роутер не ответил', bad: true } }))
        } finally {
            setBusy(null)
        }
    }

    function copy(iface: string, value: string) {
        navigator.clipboard?.writeText(value).then(
            () => {
                setCopied(iface)
                setTimeout(() => setCopied(null), 1500)
            },
            () => setNote((p) => ({ ...p, [iface]: { text: 'браузер не дал доступ к буферу — выделите строку руками', bad: true } })),
        )
    }

    if (tunnels === null) return <p className="text-sm text-muted-foreground">Загрузка…</p>

    if (dead)
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Роутер не рассказывает про xsteer</CardTitle>
                </CardHeader>
                <CardContent className="text-[13px] text-subtle">
                    Состояние туннелей отдаёт бэкенд splify2, и установленный его не отдаёт —
                    обновите splify2. Сами туннели при этом работают: экран не знает про них, а
                    не они про сеть.
                </CardContent>
            </Card>
        )

    if (names.length === 0)
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Интерфейсов xsteer нет</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <p className="text-[13px] text-subtle">
                        Туннель создаётся как обычный интерфейс: зона фаервола, адрес и MTU ему
                        нужны так же, как остальным. Ссылку <code>xs://</code> можно вставить прямо
                        на странице создания — поля заполнятся сами.
                    </p>
                    <a
                        href="/cgi-bin/luci/admin/network/network"
                        className="inline-flex items-center gap-1.5 text-sm text-primary underline decoration-dotted"
                    >
                        Создать в настройках сети
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                </CardContent>
            </Card>
        )

    return (
        <div className="space-y-3">
            {names.map((iface) => {
                const t = tunnels[iface]
                const st = t.state
                const dev = devices?.find((d) => d.name === t.device)
                const out = outputs.find(([, o]) => o.device === t.device)
                /* «Поднят» — это ответ ПРОЦЕССА, а не наличие устройства: устройство создаёт
                 * обработчик протокола до запуска движка, поэтому оно есть и у туннеля, который
                 * ни разу не дозвонился. Спрашивать надо у того, кто знает. */
                const up = !!st?.up
                /* Устаревший файл — это убитый процесс, оставивший последнее «up: true» лежать.
                 * Порог свой, а не бэкенда: круг опроса знает страница. Пятнадцать секунд —
                 * втрое больше круга, чтобы одна пропущенная запись не поднимала ложную тревогу. */
                const stale = st != null && (t.age ?? 0) > 15
                const off = offloadLabel(st?.offload)
                const n = note[iface]

                return (
                    <Card key={iface}>
                        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                            <CardTitle className="flex items-center gap-2">
                                <span
                                    className={`h-2 w-2 shrink-0 rounded-full ${
                                        up && !stale ? 'bg-success' : 'bg-destructive'
                                    }`}
                                    aria-hidden="true"
                                />
                                {iface}
                                <span className="text-[11px] font-normal text-subtle">{t.device}</span>
                            </CardTitle>
                            <a
                                href="/cgi-bin/luci/admin/network/network"
                                className="inline-flex items-center gap-1.5 text-xs text-primary underline decoration-dotted"
                            >
                                Настроить
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                        </CardHeader>
                        <CardContent className="space-y-1.5 text-[13px]">
                            {st === null ? (
                                <p className="text-subtle">
                                    Туннель не поднимался в эту загрузку: интерфейс выключен или
                                    движок его ещё не запускал. Настройка при этом есть — состояния
                                    нет.
                                </p>
                            ) : (
                                <>
                                    {stale && (
                                        <p className="text-destructive">
                                            Процесс не отвечает {t.age} с — числа ниже последние, а
                                            не текущие.
                                        </p>
                                    )}
                                    <Row label="хаб">
                                        {st.hub}{' '}
                                        <span className="font-normal text-subtle">({st.hub_key})</span>
                                    </Row>
                                    <Row label="рукопожатие">{ago(st.handshake_age)}</Row>
                                    <Row
                                        label={
                                            <Hint tip={off.tip}>
                                                <span className="border-b border-dotted border-current">
                                                    разгрузка
                                                </span>
                                            </Hint>
                                        }
                                    >
                                        <Badge variant={off.variant}>{off.text}</Badge>
                                    </Row>
                                    <Row label="MTU">
                                        {st.mtu}
                                        {st.mtu_confirmed != null && st.mtu_confirmed !== st.mtu && (
                                            <span className="font-normal text-subtle">
                                                {' '}
                                                — проба ищет предел
                                            </span>
                                        )}
                                    </Row>
                                    <Row label="соединений">
                                        {st.conns}
                                        <span className="font-normal text-subtle">
                                            {' '}
                                            · {st.stream ? 'поток TCP' : 'поддельный TCP'}
                                        </span>
                                    </Row>
                                    {!!st.resets && (
                                        <Row
                                            label={
                                                <Hint tip="Сколько раз поднятое соединение падало за жизнь процесса. Восстановление происходит само и за секунды — и ровно поэтому снаружи его не видно: туннель выглядит работающим и тогда, когда его чинят каждую минуту.">
                                                    <span className="border-b border-dotted border-current">
                                                        переподнятий
                                                    </span>
                                                </Hint>
                                            }
                                        >
                                            {st.resets}
                                            {st.last_down && (
                                                <span className="font-normal text-subtle">
                                                    {' '}
                                                    · {st.last_down}
                                                </span>
                                            )}
                                        </Row>
                                    )}
                                    <Row label="прошло">
                                        {human(st.rx_bytes)} ← / → {human(st.tx_bytes)}
                                        {!!st.dropped && (
                                            <span className="text-destructive">
                                                {' '}
                                                · отброшено {st.dropped}
                                            </span>
                                        )}
                                    </Row>
                                </>
                            )}
                            <Row label="в выходе">{out ? out[0] : '—'}</Row>
                            {dev && !dev.up && st !== null && (
                                <p className="text-subtle">
                                    Устройство {t.device} опущено — адрес и зону ему даёт netifd.
                                </p>
                            )}

                            {/* ---- ссылка ----
                              *
                              * НЕ ПОКАЗЫВАЕТСЯ САМА. В ссылке лежит приватный ключ этого пира, то
                              * есть выданный доступ целиком: она и есть то, что нельзя пересылать
                              * открытым каналом. Показать её на обзорном экране значило бы
                              * оставить её открытой на чужом мониторе у всякого, кто просто
                              * смотрел состояние туннеля. Поэтому нажатие. */}
                            {links && (
                                <div className="space-y-2 border-t pt-2">
                                    {link[iface] ? (
                                        <div className="space-y-1">
                                            <p className="text-subtle">
                                                Здесь приватный ключ этого пира — ссылка и есть
                                                доступ целиком. Не пересылайте её открытым каналом.
                                            </p>
                                            <div className="flex items-start gap-2">
                                                <code className="min-w-0 flex-1 break-all rounded-sm bg-muted px-2 py-1 text-[11px]">
                                                    {link[iface]}
                                                </code>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => copy(iface, link[iface])}
                                                >
                                                    {copied === iface ? (
                                                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                                    ) : (
                                                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                                    )}
                                                    <span className="ml-1.5">
                                                        {copied === iface ? 'Скопировано' : 'Копировать'}
                                                    </span>
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={busy === iface}
                                            onClick={() => showLink(iface)}
                                        >
                                            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                                            <span className="ml-1.5">Показать ссылку xs://</span>
                                        </Button>
                                    )}

                                    <details>
                                        <summary className="cursor-pointer text-subtle">
                                            Вставить другую ссылку
                                        </summary>
                                        <div className="mt-2 space-y-2">
                                            <p className="text-subtle">
                                                Заменит настройку этого интерфейса целиком — ключ,
                                                адрес и хаб — и поднимет его заново. Зона фаервола и
                                                имя устройства останутся свои: их в ссылке нет.
                                            </p>
                                            <textarea
                                                className="w-full rounded-sm border bg-background px-2 py-1 font-mono text-[11px]"
                                                rows={3}
                                                placeholder="xs://<ключ>@203.0.113.7:443?pk=<ключ хаба>&ip=10.77.0.2/24"
                                                value={paste[iface] || ''}
                                                onChange={(e) =>
                                                    setPaste((p) => ({ ...p, [iface]: e.target.value }))
                                                }
                                            />
                                            <Button
                                                size="sm"
                                                disabled={busy === iface || !(paste[iface] || '').trim()}
                                                onClick={() => applyLink(iface)}
                                            >
                                                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                                <span className="ml-1.5">Принять и поднять заново</span>
                                            </Button>
                                        </div>
                                    </details>
                                </div>
                            )}
                            {!links && (
                                <p className="border-t pt-2 text-subtle">
                                    Ссылки <code>xs://</code> понимает steer 1.3.0 и новее — на
                                    установленном движке этого умения нет.
                                </p>
                            )}
                            {n && (
                                <p className={n.bad ? 'text-destructive' : 'text-success'}>{n.text}</p>
                            )}
                        </CardContent>
                    </Card>
                )
            })}
        </div>
    )
}
