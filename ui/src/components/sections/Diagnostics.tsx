import { useEffect, useMemo, useState } from 'react'
import { Check, Info, RefreshCw, Search, TriangleAlert, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Live } from '@/lib/live'
import { parseLog } from '@/lib/log'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'

/** Диагностика: то, за чем приходят, когда «применилось, но не работает».
 *
 *  Проверки идут по ЖИВОМУ ядру и живым процессам, а не по настройке: совпадение с настройкой
 *  ничего не доказывает. Текст находки печатается ДОСЛОВНО из `diag.checks[].what` — интерфейс
 *  движок не пересказывает: формулировки принадлежат ему и меняются вместе с ним, а пересказ
 *  здесь означал бы, что правка сообщения в движке тихо ломает показ.
 *
 *  Чего здесь больше нет. Счётчики трафика и «куда пойдёт запрос» уехали на обзор, а движок,
 *  самообновление и архив настроек — в «Настройки → О ПО». Раздел был складом: в него въезжало всё, что
 *  не влезало в остальные вкладки, и по его названию нельзя было угадать содержимое. */

export default function Diagnostics({ live }: { live: Live }) {
    /* Журнал движка спрашивает ЭТОТ экран, пока он открыт, а не общий круг опроса.
     *
     * Читает его один-единственный список — тот, что ниже, — а стоил он дороже всего
     * остального вместе взятого: `logread -l 300 | grep steer` это 76 мс на каждом круге,
     * плюс запуск скрипта объекта (126 мс), то есть 350 мс каждые пять секунд ради строк,
     * которых на экране в это время нет. Замер на стенде 10.8.1.87.
     *
     * Общий круг от этого не расходится во времени с журналом: числа и вердикты приходят
     * своим ответом, строки журнала — своим, и сверять их между собой незачем — это
     * разные вопросы. Расхождение мгновений опасно там, где два числа об одном и том же
     * (см. шапку lib/live.ts), а здесь такого нет. */
    const [log, setLog] = useState<string[] | null>(null)
    const [logFilter, setLogFilter] = useState('')
    const [refreshingLog, setRefreshingLog] = useState(false)

    const pull = async () => {
        setRefreshingLog(true)
        try {
            const e = await rpc.engineState()
            setLog(e.log || [])
        } catch {
            setLog([])
        } finally {
            setRefreshingLog(false)
        }
    }

    useEffect(() => {
        let stop = false
        const timerPull = () => {
            if (!stop && !document.hidden) {
                rpc.engineState()
                    .then((e) => { if (!stop) setLog(e.log || []) })
                    .catch(() => { if (!stop) setLog([]) })
            }
        }
        void timerPull()
        const id = setInterval(timerPull, 5000)
        return () => { stop = true; clearInterval(id) }
    }, [])

    const filteredLog = useMemo(() => {
        if (!log) return []
        const q = logFilter.trim().toLowerCase()
        if (!q) return log
        return log.filter((line) => line.toLowerCase().includes(q))
    }, [log, logFilter])

    const bad = (live.diag?.checks || []).filter((c) => c.verdict === 'fail' || c.verdict === 'warn')

    /* Один приговор — с кнопкой. `doh_force` (спор за порт 53 с https-dns-proxy) добавляет к
     * проверкам движка сам бэкенд, и чинится он одним нажатием — тем же методом, что кнопка на
     * вкладке DoH. Показать проблему здесь и отправить за решением на другую вкладку значило бы
     * показать её наполовину. После правки — refresh(): проверки перечитываются первым же кругом. */
    const [fixing, setFixing] = useState(false)
    async function fixForce() {
        if (fixing) return
        setFixing(true)
        try {
            const r = await rpc.dohForceFix()
            if (!r.ok) throw new Error(r.error || 'не получилось')
            notify('Перенаправление DNS оставлено движку')
            live.refresh()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setFixing(false)
        }
    }
    /* Советы отдельно и НЕ в счётчиках: они верны всегда, а не описывают эту установку. Смешав
     * их с находками, мы держали бы «есть о чём знать» постоянно — и человек перестал бы читать
     * находки вовсе. */
    const notes = (live.diag?.checks || []).filter((c) => c.verdict === 'note')
    const good = (live.diag?.checks || []).filter((c) => c.verdict === 'ok')

    return (
        <div className="space-y-4">
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
                    {/* Объяснять, ЧТО такое проверки, на экране незачем: об этом не
                        спрашивают. Остаётся то, после чего человек делает следующий шаг —
                        движок старый и проверок не умеет. */}
                    {live.diagOld && (
                        <CardDescription>Обновите steer в разделе «Настройки → О ПО».</CardDescription>
                    )}
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
                                <div className="min-w-0 flex-1">
                                    <div>{c.what}</div>
                                    {c.why && <div className="text-xs text-muted-foreground">{c.why}</div>}
                                </div>
                                {c.id === 'doh_force' && (
                                    <Button size="sm" className="shrink-0 self-center" disabled={fixing} onClick={() => void fixForce()}>
                                        {fixing ? 'минуту…' : 'Оставить движку'}
                                    </Button>
                                )}
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
                            <div className="space-y-1 border-t border-border pt-2">
                                {good.map((c, i) => (
                                    <div key={`${c.id}-ok-${i}`} className="flex gap-2 text-[13px]">
                                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                                        <span className="text-muted-foreground">{c.what}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                )}
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle>Логи steer</CardTitle>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                        disabled={refreshingLog}
                        onClick={() => void pull()}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${refreshingLog ? 'animate-spin' : ''}`} />
                        <span>Обновить</span>
                    </Button>
                </CardHeader>
                <CardContent className="space-y-2">
                    {log && log.length > 0 && (
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                            <input
                                type="text"
                                value={logFilter}
                                onChange={(e) => setLogFilter(e.target.value)}
                                placeholder="Поиск по журналу…"
                                className="w-full h-8 pl-8 pr-8 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                            {logFilter && (
                                <button
                                    type="button"
                                    onClick={() => setLogFilter('')}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    aria-label="Очистить поиск"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>
                    )}
                    {log === null ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            Загрузка журнала…
                        </p>
                    ) : filteredLog.length > 0 ? (
                        <div className="max-h-72 overflow-auto rounded-xl border border-border bg-muted p-3 text-[11px] leading-relaxed font-mono">
                            {filteredLog.map((line, i) => {
                                const l = parseLog(line)
                                return (
                                    <div key={i} className="flex gap-2 whitespace-pre-wrap">
                                        {l.time && (
                                            <span className="shrink-0 text-muted-foreground">
                                                {l.time}
                                            </span>
                                        )}
                                        {/* Значок только у предупреждения: подпись «info» на
                                            каждой строке — это шум, из-за которого перестают
                                             замечать те самые строки, ради которых сюда и
                                             пришли. */}
                                        {l.level === 'warn' && (
                                            <span className="shrink-0 text-warning-fg font-bold">!</span>
                                        )}
                                        <span
                                            className={`min-w-0 ${l.level === 'warn' ? 'text-warning-fg font-medium' : ''}`}
                                        >
                                            {l.text}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                    ) : log.length > 0 ? (
                        <div className="py-6 text-center space-y-1 text-xs text-muted-foreground">
                            <p>Строк по запросу «{logFilter}» не найдено.</p>
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLogFilter('')}>
                                Сбросить фильтр
                            </Button>
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
