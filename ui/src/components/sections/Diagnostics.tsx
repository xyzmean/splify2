import { useState } from 'react'
import { Check, Info, TriangleAlert, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Live } from '@/lib/live'
import { parseLog } from '@/lib/log'

/** Диагностика: то, за чем приходят, когда «применилось, но не работает».
 *
 *  Проверки идут по ЖИВОМУ ядру и живым процессам, а не по настройке: совпадение с настройкой
 *  ничего не доказывает. Текст находки печатается ДОСЛОВНО из `diag.checks[].what` — интерфейс
 *  движок не пересказывает: формулировки принадлежат ему и меняются вместе с ним, а пересказ
 *  здесь означал бы, что правка сообщения в движке тихо ломает показ.
 *
 *  Чего здесь больше нет. Счётчики трафика и «куда пойдёт запрос» уехали на обзор, а движок,
 *  самообновление и архив настроек — в «Систему». Раздел был складом: в него въезжало всё, что
 *  не влезало в остальные вкладки, и по его названию нельзя было угадать содержимое. */

export default function Diagnostics({ live }: { live: Live }) {
    const [showOk, setShowOk] = useState(false)

    const bad = (live.diag?.checks || []).filter((c) => c.verdict === 'fail' || c.verdict === 'warn')
    /* Советы отдельно и НЕ в счётчиках: они верны всегда, а не описывают эту установку. Смешав
     * их с находками, мы держали бы «есть о чём знать» постоянно — и человек перестал бы читать
     * находки вовсе. */
    const notes = (live.diag?.checks || []).filter((c) => c.verdict === 'note')
    const good = (live.diag?.checks || []).filter((c) => c.verdict === 'ok')

    return (
        <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
                Проверки идут по ядру и живым процессам, не по настройке.
            </p>

            {/* Плохое наверху, исправное свёрнуто: двенадцать зелёных галочек прячут одну
                красную. */}
            <Card>
                <CardHeader>
                    <CardTitle>
                        {live.diagOld
                            ? 'Проверка состояния недоступна'
                            : live.diag?.fail
                              ? `проверок с отказом: ${live.diag.fail}`
                              : live.diag?.warn
                                ? `проверок с предупреждением: ${live.diag.warn}`
                                : 'Всё в порядке'}
                    </CardTitle>
                    <CardDescription>
                        {live.diagOld
                            ? 'Движок этой версии не умеет проверки состояния — обновите steer в разделе «Система».'
                            : 'Движок спрашивает ядро и живые процессы, а не свою же настройку: совпадение с настройкой ничего не доказывает.'}
                    </CardDescription>
                </CardHeader>
                {!live.diagOld && (
                    <CardContent className="space-y-2">
                        {bad.map((c, i) => (
                            <div
                                key={`${c.id}-${i}`}
                                className={[
                                    'flex gap-2 rounded-xl border p-2.5 text-[13px]',
                                    c.verdict === 'fail'
                                        ? 'border-destructive/40 bg-destructive/10'
                                        : 'border-warning/40 bg-warning/10',
                                ].join(' ')}
                            >
                                {c.verdict === 'fail' ? (
                                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                                ) : (
                                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" aria-hidden="true" />
                                )}
                                <div className="min-w-0">
                                    <div>{c.what}</div>
                                    {c.why && <div className="text-xs text-muted-foreground">{c.why}</div>}
                                </div>
                            </div>
                        ))}
                        {notes.length > 0 && (
                            <div className="space-y-2 border-t border-border pt-2">
                                {notes.map((c, i) => (
                                    <div key={`${c.id}-note-${i}`} className="flex gap-2 text-[13px]">
                                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        <div className="min-w-0">
                                            <div>{c.what}</div>
                                            {c.why && (
                                                <div className="text-xs text-muted-foreground">{c.why}</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {good.length > 0 && (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setShowOk((s) => !s)}
                                    className="text-xs text-muted-foreground underline"
                                >
                                    {showOk ? 'скрыть исправное' : `исправно: ${good.length} — показать`}
                                </button>
                                {showOk && (
                                    <div className="mt-2 space-y-1">
                                        {good.map((c, i) => (
                                            <div key={`${c.id}-ok-${i}`} className="flex gap-2 text-[13px]">
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
                    <CardTitle>Логи steer</CardTitle>
                    <CardDescription>
                        Последние строки движка. Оформление syslog снято: день недели, год и
                        номер процесса ничего не добавляют, а средство (<code className="font-mono">daemon.err</code>)
                        здесь врёт — движок пишет в stderr, и syslog метит так ВСЁ, включая
                        обычные сообщения. Уровень берётся из собственной пометки движка{' '}
                        <code className="font-mono">steer[warn]</code>: это формат, а не проза.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {live.engine?.log?.length ? (
                        <div className="max-h-72 overflow-auto rounded-xl border border-border bg-muted p-3 text-[11px] leading-relaxed">
                            {live.engine.log.map((line, i) => {
                                const l = parseLog(line)
                                return (
                                    <div key={i} className="flex gap-2 whitespace-pre-wrap">
                                        {l.time && (
                                            <span className="shrink-0 font-mono text-muted-foreground">
                                                {l.time}
                                            </span>
                                        )}
                                        {/* Значок только у предупреждения: подпись «info» на
                                            каждой строке — это шум, из-за которого перестают
                                            замечать те самые строки, ради которых сюда и
                                            пришли. */}
                                        {l.level === 'warn' && (
                                            <span className="shrink-0 font-mono text-warning-fg">!</span>
                                        )}
                                        <span
                                            className={`min-w-0 ${l.level === 'warn' ? 'text-warning-fg' : ''}`}
                                        >
                                            {l.text}
                                        </span>
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
        </div>
    )
}
