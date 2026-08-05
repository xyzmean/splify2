import { useState } from 'react'
import { Check, Search, TriangleAlert, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import EngineCard from '@/components/EngineCard'
import { rpc } from '@/lib/rpc'
import { human, type Live } from '@/lib/live'

/** Диагностика: то, за чем приходят, когда «применилось, но не работает».
 *
 *  Здесь всё, что отвечает по ЖИВОМУ ядру, а не по настройке: проверки состояния, «куда пойдёт
 *  запрос», счётчики и последние слова движка. Совпадение с настройкой ничего не доказывает —
 *  именно поэтому вкладка называется по движку, а не «состояние». */

export default function LogsTab({ live }: { live: Live }) {
    const [q, setQ] = useState('')
    const [answer, setAnswer] = useState<string | null>(null)
    const [asking, setAsking] = useState(false)
    const [showOk, setShowOk] = useState(false)

    async function ask() {
        const address = q.trim()
        if (!address) return
        setAsking(true)
        try {
            const r = await rpc.explain(address)
            setAnswer(r.text)
        } catch (e) {
            setAnswer(String(e instanceof Error ? e.message : e))
        } finally {
            setAsking(false)
        }
    }

    const bad = (live.diag?.checks || []).filter((c) => c.verdict !== 'ok')
    const good = (live.diag?.checks || []).filter((c) => c.verdict === 'ok')

    return (
        <div className="space-y-4">
            {/* Проверки состояния. Плохое наверху, исправное свёрнуто: двенадцать зелёных
                галочек прячут одну красную. */}
            <Card>
                <CardHeader>
                    <CardTitle>
                        {live.diagOld
                            ? 'Проверка состояния недоступна'
                            : live.diag?.fail
                              ? `Есть поломки: ${live.diag.fail}`
                              : live.diag?.warn
                                ? `Работает, но есть о чём знать: ${live.diag.warn}`
                                : 'Всё в порядке'}
                    </CardTitle>
                    <CardDescription>
                        {live.diagOld
                            ? 'Движок этой версии не умеет проверки состояния — обновите steer ниже.'
                            : 'Движок спрашивает ядро и живые процессы, а не свою же настройку: совпадение с настройкой ничего не доказывает.'}
                    </CardDescription>
                </CardHeader>
                {!live.diagOld && (
                    <CardContent className="space-y-2">
                        {bad.map((c, i) => (
                            <div key={`${c.id}-${i}`} className="flex gap-2 text-sm">
                                {c.verdict === 'fail' ? (
                                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                                ) : (
                                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                                )}
                                <div>
                                    <div>{c.what}</div>
                                    {c.why && <div className="text-xs text-muted-foreground">{c.why}</div>}
                                </div>
                            </div>
                        ))}
                        {good.length > 0 && (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setShowOk((v) => !v)}
                                    className="text-xs text-muted-foreground underline"
                                >
                                    {showOk ? 'скрыть исправное' : `исправно: ${good.length} — показать`}
                                </button>
                                {showOk && (
                                    <div className="mt-2 space-y-1">
                                        {good.map((c, i) => (
                                            <div key={`${c.id}-ok-${i}`} className="flex gap-2 text-sm">
                                                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                                                <span className="text-muted-foreground">{c.what}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </CardContent>
                )}
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Куда пойдёт запрос</CardTitle>
                    <CardDescription>
                        Отвечает по живому ядру, а не по настройке. Имя движок сначала спрашивает у
                        своего резолвера и показывает, во что оно превратилось: у доменного правила это
                        fake-IP, и с настоящим адресом сайта он не совпадает вовсе — по системному
                        ответу понять, попадёт ли имя в набор, нельзя. Заодно это проверка самого
                        резолвера: не ответил — значит и клиентам не отвечает.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2">
                        <input
                            value={q}
                            onChange={(e) => setQ(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === 'Enter' && ask()}
                            placeholder="www.youtube.com или 142.250.185.78"
                            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                        />
                        <Button onClick={ask} disabled={asking || !q.trim()}>
                            <Search className="mr-1 h-4 w-4" aria-hidden="true" />
                            {asking ? 'Спрашиваем…' : 'Проверить'}
                        </Button>
                    </div>
                    {answer && (
                        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
                            {answer}
                        </pre>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Счётчики</CardTitle>
                    <CardDescription>
                        Считаются <b>с загрузки роутера</b> и переживают применение настройки. Одна строка —
                        это один набор в ядре, а не одно правило: правила, совпадающие по outbound, виду
                        списка и клиентам, движок сводит в один набор, и счётчик у них общий. Так на пакет
                        приходится одно правило вместо десятка — на роутере с 64 МБ это разница между
                        «работает» и «не влезло».
                    </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-sm">
                        <thead>
                            <tr className="text-left text-xs text-muted-foreground">
                                <th className="pb-2">Набор</th>
                                <th className="pb-2">Outbound</th>
                                <th className="pb-2 text-right">↑ наружу</th>
                                <th className="pb-2 text-right">↓ внутрь</th>
                                <th className="pb-2 text-right">сейчас</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(live.status?.channels || []).map((c) => (
                                <tr key={c.name} className="border-t border-border">
                                    <td className="py-1.5">
                                        {c.name}
                                        {!c.live && (
                                            <span className="ml-2 text-xs text-destructive">нет в ядре</span>
                                        )}
                                    </td>
                                    <td className="py-1.5 text-muted-foreground">{c.out}</td>
                                    <td
                                        className="py-1.5 text-right"
                                        title={`${(c.bytes ?? 0).toLocaleString('ru-RU')} Б, пакетов ${(c.packets ?? 0).toLocaleString('ru-RU')}`}
                                    >
                                        {human(c.bytes ?? 0)}
                                    </td>
                                    <td
                                        className="py-1.5 text-right"
                                        title={
                                            c.down_bytes === undefined
                                                ? 'движок не считает встречный путь'
                                                : `${c.down_bytes.toLocaleString('ru-RU')} Б, пакетов ${(c.down_packets ?? 0).toLocaleString('ru-RU')}`
                                        }
                                    >
                                        {c.down_bytes === undefined ? '—' : human(c.down_bytes)}
                                    </td>
                                    <td className="py-1.5 text-right whitespace-nowrap text-xs">
                                        {live.speed.ch[c.name]?.down || live.speed.ch[c.name]?.up ? (
                                            <>
                                                {live.speed.ch[c.name].down && <>↓ {live.speed.ch[c.name].down}</>}
                                                {live.speed.ch[c.name].down && live.speed.ch[c.name].up && <br />}
                                                {live.speed.ch[c.name].up && <>↑ {live.speed.ch[c.name].up}</>}
                                            </>
                                        ) : (
                                            <span className="text-muted-foreground">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {(live.status?.channels?.length ?? 0) === 0 && (
                                <tr>
                                    <td colSpan={5} className="py-6 text-center text-muted-foreground">
                                        Правил нет — весь трафик идёт напрямую.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Логи steer</CardTitle>
                    <CardDescription>
                        Последние строки, дословно. Уровень берётся из пометки движка{' '}
                        <code className="font-mono">steer[warn]</code> —{' '}
                        это формат, а не проза: меняться будет текст, а не префикс, поэтому разбирать его
                        можно. Строки без пометки — от более старого движка, они показаны как есть.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {live.engine?.log?.length ? (
                        <div className="max-h-72 overflow-auto rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed">
                            {live.engine.log.map((line, i) => {
                                const m = /steer\[(warn|info)\]/.exec(line)
                                return (
                                    <div key={i} className="flex gap-2 whitespace-pre-wrap">
                                        {m && (
                                            <span
                                                className={`shrink-0 font-mono ${
                                                    m[1] === 'warn' ? 'text-warning' : 'text-muted-foreground'
                                                }`}
                                            >
                                                {m[1]}
                                            </span>
                                        )}
                                        <span className="min-w-0">{line}</span>
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            Движок ничего не писал в журнал.
                        </p>
                    )}
                </CardContent>
            </Card>

            <EngineCard engine={live.build} onInstalled={live.refresh} />
        </div>
    )
}
