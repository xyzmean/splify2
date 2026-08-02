import { useEffect, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { type Status } from '@/lib/model'

// Everything here comes from `steer status` verbatim. The dashboard does not compute
// its own opinion of what is live: the engine knows things the UI cannot see, and two
// answers to "is it working" is one answer too many.

export default function StatusPage() {
    const [status, setStatus] = useState<Status | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [answer, setAnswer] = useState<string | null>(null)

    useEffect(() => {
        const load = () =>
            rpc
                .status()
                .then((s) => { setStatus(s); setError(null) })
                .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        load()
        const id = setInterval(load, 5000)
        return () => clearInterval(id)
    }, [])

    async function explain() {
        const address = q.trim()
        if (!address) return
        try {
            const r = await rpc.explain(address)
            setAnswer(r.text)
        } catch (e) {
            setAnswer(String(e instanceof Error ? e.message : e))
        }
    }

    if (error) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Движок не отвечает</CardTitle>
                    <CardDescription>{error}</CardDescription>
                </CardHeader>
            </Card>
        )
    }
    if (!status) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const outputs = Object.entries(status.outputs || {})

    return (
        <div className="space-y-4">
            {(status.warnings?.length ?? 0) > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sp-warning">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Предупреждения движка
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {status.warnings!.map((w, i) => (
                            <p key={i} className="text-sm">
                                {w.channel && <span className="font-medium">{w.channel}: </span>}
                                {w.text}
                            </p>
                        ))}
                    </CardContent>
                </Card>
            )}

            {/* The one answer raw nft cannot give: which channel claims an address and
                where it leaves. Asked of the kernel, so it also covers a set that
                failed to load. */}
            <Card>
                <CardHeader>
                    <CardTitle>Куда пойдёт адрес</CardTitle>
                    <CardDescription>
                        Ответ даёт движок по живому состоянию ядра, а не по конфигурации.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2">
                        <input
                            value={q}
                            onChange={(e) => setQ(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === 'Enter' && explain()}
                            placeholder="216.58.198.206"
                            aria-label="Адрес для проверки"
                            className="min-w-48 flex-1 rounded-md border border-sp-border bg-sp-background px-3 py-1.5 text-sm"
                        />
                        <Button onClick={explain}>
                            <Search className="mr-1 h-4 w-4" aria-hidden="true" /> Проверить
                        </Button>
                    </div>
                    {answer && (
                        <pre className="mt-3 overflow-x-auto rounded-md bg-sp-muted p-3 text-xs">{answer}</pre>
                    )}
                </CardContent>
            </Card>

            {/* Один ответ на вопрос "работает ли" вместо россыпи фактов, из которых
                его надо собирать самому. Считается по тем же полям, но вывод делает
                интерфейс, а не человек. */}
            <Card>
                <CardHeader>
                    <CardTitle>Что происходит</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {(() => {
                        const bad: string[] = []
                        for (const [name, o] of outputs) {
                            if (o.kind !== 'interface') continue
                            if (!o.up) bad.push(`${name}: устройство ${o.device} выключено — трафик этого выхода никуда не идёт`)
                            else if (!o.nat) bad.push(`${name}: нет NAT на ${o.device} — пакеты уходят и не возвращаются, сайты будут молчать`)
                        }
                        const dead = (status.channels || []).filter((c) => !c.live)
                        for (const c of dead) bad.push(`${c.name}: правила нет в ядре — примените настройки`)
                        const silent = (status.channels || []).filter((c) => c.live && !(c.packets ?? 0))
                        if (!bad.length) {
                            return (
                                <>
                                    <p className="text-sm text-sp-success">
                                        Всё на месте: выходы подняты, NAT есть, правила в ядре.
                                    </p>
                                    {silent.length > 0 && (
                                        <p className="text-xs text-sp-muted-foreground">
                                            Пока не совпадал ни разу: {silent.map((c) => c.name).join(', ')}. Это
                                            нормально, если по этим спискам ещё никто не ходил.
                                        </p>
                                    )}
                                </>
                            )
                        }
                        return bad.map((t, i) => (
                            <p key={i} className="text-sm text-sp-destructive">{t}</p>
                        ))
                    })()}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Выходы</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {outputs.map(([name, o]) => (
                        <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{name}</span>
                            <span className="text-sp-muted-foreground">
                                {o.kind === 'direct' ? 'напрямую' : o.device}
                            </span>
                            {o.kind === 'interface' && (
                                <>
                                    <Badge variant={o.up ? 'default' : 'destructive'}>
                                        {o.up ? 'поднят' : 'выключен'}
                                    </Badge>
                                    <Badge variant={o.nat ? 'secondary' : 'destructive'}>
                                        {o.nat ? 'NAT есть' : 'NAT не найден'}
                                    </Badge>
                                </>
                            )}
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Каналы</CardTitle>
                    <CardDescription>
                        Счётчик показывает, что правило совпадало, — но не что трафик доехал. Если он растёт,
                        а сайты молчат, смотрите NAT у выхода.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-sp-muted-foreground">
                                <th className="pb-2">Канал</th>
                                <th className="pb-2">Выход</th>
                                <th className="pb-2 text-right">Пакетов</th>
                                <th className="pb-2 text-right">Байт</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(status.channels || []).map((c) => (
                                <tr key={c.name} className="border-t border-sp-border">
                                    <td className="py-1.5">
                                        {c.name}
                                        {!c.live && (
                                            <Badge variant="destructive" className="ml-2">
                                                нет в ядре
                                            </Badge>
                                        )}
                                    </td>
                                    <td className="py-1.5 text-sp-muted-foreground">{c.out}</td>
                                    <td className="py-1.5 text-right">
                                        {(c.packets ?? 0).toLocaleString('ru-RU')}
                                    </td>
                                    <td className="py-1.5 text-right">
                                        {(c.bytes ?? 0).toLocaleString('ru-RU')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </CardContent>
            </Card>
        </div>
    )
}
