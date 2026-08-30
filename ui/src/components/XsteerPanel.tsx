import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc } from '@/lib/rpc'
import { type Live } from '@/lib/live'

/** XSTEER: устройства звезды, их состояние и дорога к настройке.
 *
 *  ПОЛЯ ПИРЫ (ключ, адрес в туннеле, хаб, SNI, MTU) живут в настройке сети роутера — их
 *  описывает страница протокола (luci/htdocs/luci-static/resources/protocol/xsteer.js), и
 *  правит их netifd через uci. Второй формы тех же полей здесь быть не должно: два места,
 *  пишущие одну настройку, расходятся, а расхождение видно только тем, что туннель не
 *  поднялся.
 *
 *  Что здесь есть: живое состояние устройств и переход к их настройке одним нажатием. */

/** Устройство xsteer: TUN, созданный движком. Имя по умолчанию — `xs-<интерфейс>`. */
const isXsteer = (d: { name: string; kind: string }) =>
    d.kind === 'xsteer' || /^xs-/.test(d.name)

export default function XsteerPanel({ live }: { live: Live }) {
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[] | null>(null)

    useEffect(() => {
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
    }, [])

    const mine = (devices || []).filter(isXsteer)
    const outputs = Object.entries(live.status?.outputs || {})

    return (
        <div className="space-y-3">
            {devices === null ? (
                <p className="text-sm text-muted-foreground">Загрузка…</p>
            ) : mine.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Интерфейсов xsteer нет</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <a
                            href="/cgi-bin/luci/admin/network/network"
                            className="inline-flex items-center gap-1.5 text-sm text-primary underline decoration-dotted"
                        >
                            Создать в настройках сети
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                    </CardContent>
                </Card>
            ) : (
                mine.map((d) => {
                    const out = outputs.find(([, o]) => o.device === d.name)
                    const up = d.up || d.name in (live.devs || {})
                    return (
                        <Card key={d.name}>
                            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                                <CardTitle className="flex items-center gap-2">
                                    <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                            up ? 'bg-success' : 'bg-destructive'
                                        }`}
                                        aria-hidden="true"
                                    />
                                    {d.name}
                                </CardTitle>
                                <a
                                    href="/cgi-bin/luci/admin/network/network"
                                    className="inline-flex items-center gap-1.5 text-xs text-primary underline decoration-dotted"
                                >
                                    Настроить
                                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                </a>
                            </CardHeader>
                            <CardContent className="text-[13px]">
                                <div className="flex items-baseline justify-between gap-2">
                                    <span className="text-subtle">в выходе</span>
                                    <span className="font-medium">{out ? out[0] : '—'}</span>
                                </div>
                            </CardContent>
                        </Card>
                    )
                })
            )}
        </div>
    )
}
