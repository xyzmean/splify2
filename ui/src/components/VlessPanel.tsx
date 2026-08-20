import { useEffect, useRef, useState } from 'react'
import { Download, Gauge, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { isHttpUrl } from '@/lib/validate'
import type { Output, VlessNode, VlessProbe, VlessSkip } from '@/lib/model'

// Настройка выхода kind=vless: подписка и выбор узла.
//
// Почему узел выбирается номером, а не именем: имена узлов в подписке приходят от
// провайдера и меняются вместе с ней, а движок понимает именно номер среди пригодных
// узлов. Показываем имя, храним номер, и оба берём из одного ответа движка — так
// «выбрано в интерфейсе» и «поднимется движком» не могут разойтись.
//
// Умолчание — «первый рабочий» (node = -1), и оно намеренно первое в списке: зашитый
// номер молча перестаёт быть тем узлом при обновлении подписки, а проверка находит живой
// сама.

interface Props {
    name: string
    output: Output
    onChange: (o: Output) => void
    /** Спека сохранена и применена — до этого движок про выход ничего не знает, и
     *  спрашивать у него узлы бессмысленно. */
    saved: boolean
}

const SUB_FILE = '/etc/steer/sub.txt'

// Предел одновременных проверок при «проверить все». Три — не «побольше, чтобы быстрее»:
// каждая проверка поднимает через движок настоящее соединение до узла и меряет по нему
// время ответа, а роутер здесь однопроцессорный и с одним каналом наружу. Проверять по
// одному — это двадцать нажатий с ожиданием (R-019); запустить все сразу — значит
// померить не задержку узла, а собственную очередь на том же процессоре. Три сокращает
// ожидание втрое (три десятка узлов — десять волн вместо тридцати) и при этом замер ещё
// не соревнуется сам с собой. Движок при этом не меняется: один узел за вызов сделано
// намеренно, проверка упирается в таймаут, а вызов ubus столько не живёт (A-050).
const PROBE_LIMIT = 3

// С какого числа узлов список свёрнут при открытии панели. Двенадцать строк — это
// примерно экран: пока список короче, сворачивать нечего, а на подписке из трёх десятков
// узлов панель занимала весь экран и прятала всё, что под ней (R-019).
const FOLD_FROM = 12

/** Что происходит со строкой узла: 'queued' — стоит в очереди пачки, до неё ещё не
 *  дошли, 'running' — проверяется прямо сейчас. Различать обязательно: показать у
 *  строки из очереди пустое место значит соврать, что узел не проверяется, а показать
 *  «идёт проверка» — что замер уже начался, хотя вызова ещё не было. */
type Phase = 'queued' | 'running'

function when(ts?: number): string {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

/** Цвет по времени ответа. Порог 150 мс — не наука, а то, за чем видеосвязь начинает
 *  заметно мешать; 400 мс — где становится больно листать страницы. */
function latencyTone(ms: number): 'default' | 'secondary' | 'destructive' {
    if (ms < 150) return 'default'
    if (ms < 400) return 'secondary'
    return 'destructive'
}

export default function VlessPanel({ name, output, onChange, saved }: Props) {
    const [sub, setSub] = useState<{ url?: string; present: boolean; bytes?: number; mtime?: number } | null>(null)
    const [url, setUrl] = useState('')
    const [nodes, setNodes] = useState<VlessNode[] | null>(null)
    const [meta, setMeta] = useState<{ usable: number; skipped: number; foreign: number } | null>(null)
    const [skips, setSkips] = useState<VlessSkip[]>([])
    const [skipOther, setSkipOther] = useState(0)
    const [probes, setProbes] = useState<Record<number, VlessProbe>>({})
    const [fails, setFails] = useState<Record<number, string>>({})
    const [phase, setPhase] = useState<Record<number, Phase>>({})
    const [batchOn, setBatchOn] = useState(false)
    const [busy, setBusy] = useState('')
    /** null — «человек ещё не решал», тогда список сворачивается по длине. */
    const [open, setOpen] = useState<boolean | null>(null)
    const [urlTried, setUrlTried] = useState(false)

    /** Номер текущей пачки. Растёт при отмене, повторном нажатии и размонтировании;
     *  каждый воркер сверяет свой номер перед любым setState, поэтому уход со вкладки
     *  посреди проверки не оставляет обновлений состояния снятого компонента. */
    const batch = useRef(0)
    useEffect(() => () => { batch.current += 1 }, [])

    useEffect(() => {
        rpc.subInfo()
            .then((s) => { setSub(s); setUrl(s.url || '') })
            .catch(() => setSub(null))
    }, [])

    useEffect(() => {
        if (!saved || !sub?.present) return
        rpc.vlessNodes(name)
            .then((r) => {
                setNodes(r.nodes || [])
                setMeta({ usable: r.usable, skipped: r.skipped, foreign: r.foreign })
                setSkips(r.skipped_reasons || [])
                setSkipOther(r.skipped_other || 0)
            })
            .catch(() => setNodes(null))
    }, [name, saved, sub?.present])

    async function fetchSub() {
        setUrlTried(true)
        // Сообщение об ошибке — рядом с полем, а не всплывашкой: всплывашка уезжает и не
        // показывает, В КАКОМ поле опечатка, а править нужно именно это.
        if (!urlText || !isHttpUrl(urlText)) return
        setBusy('sub')
        try {
            const r = await rpc.subSet(urlText)
            if (!r.ok) throw new Error(r.error || 'не скачалось')
            notify(`Подписка загружена: ${r.bytes} байт`)
            // Путь в спеку ставим здесь: движку нужен файл, а не ссылка, и человек не
            // должен знать, где он лежит.
            onChange({ ...output, sub_file: SUB_FILE })
            setSub(await rpc.subInfo())
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    function mark(index: number, p: Phase | null) {
        setPhase((prev) => {
            const next = { ...prev }
            if (p) next[index] = p
            else delete next[index]
            return next
        })
    }

    /** Одна проверка одного узла — и для кнопки в строке, и как шаг пачки. Результат
     *  кладётся в таблицу сразу, как пришёл, поэтому пачка заполняет её постепенно, а не
     *  одним прыжком в конце. `token` — номер пачки на момент запуска: если он успел
     *  измениться (отмена, новая пачка, размонтирование), ответ молча выбрасывается. */
    async function probeOne(index: number, token: number) {
        mark(index, 'running')
        try {
            const r = await rpc.vlessProbe(name, index)
            if (batch.current !== token) return
            if (r.error) throw new Error(r.error)
            setProbes((prev) => {
                const next = { ...prev }
                for (const res of r.results || []) next[res.index] = res
                return next
            })
            setFails((prev) => {
                if (!(index in prev)) return prev
                const next = { ...prev }
                delete next[index]
                return next
            })
        } catch (e) {
            if (batch.current !== token) return
            // Отказ показываем в строке узла, а не всплывашкой: на проверке всех это
            // двадцать всплывашек подряд, и ни одна не говорит, к какому узлу относится.
            setFails((prev) => ({ ...prev, [index]: String(e instanceof Error ? e.message : e) }))
        } finally {
            if (batch.current === token) mark(index, null)
        }
    }

    /** Отмена пачки: номер сдвигается, ответы уже отправленных вызовов перестают
     *  считаться, пометки со строк снимаются. Сами вызовы не отзываются — ubus этого не
     *  умеет, — но и состояния они больше не трогают. */
    function stopAll() {
        batch.current += 1
        setPhase({})
        setBatchOn(false)
    }

    async function probeAll() {
        if (!nodes || nodes.length === 0) return
        // Повторное нажатие — отмена: пачка на слабом роутере идёт долго, и без отмены
        // единственный выход — ждать, пока она добежит до конца.
        if (batchOn) { stopAll(); return }
        const token = ++batch.current
        const queue = nodes.map((n) => n.index)
        setOpen(true)                 // проверять список, которого не видно, незачем
        setFails({})
        setPhase(Object.fromEntries(queue.map((i) => [i, 'queued' as Phase])))
        setBatchOn(true)
        let head = 0
        const worker = async () => {
            while (batch.current === token) {
                const index = queue[head++]
                if (index === undefined) return
                await probeOne(index, token)
            }
        }
        // Ровно PROBE_LIMIT воркеров тянут из общей очереди — так предел держится и на
        // подписке из тридцати узлов, а не только на первой волне.
        await Promise.all(Array.from({ length: Math.min(PROBE_LIMIT, queue.length) }, worker))
        if (batch.current !== token) return
        setPhase({})
        setBatchOn(false)
    }

    const chosen = output.node ?? -1
    const urlText = url.trim()
    // Пустое поле isHttpUrl считает годным («выключено»), поэтому пустоту проверяем
    // отдельно: здесь ссылка обязательна.
    const urlBad = urlText.length > 0 && !isHttpUrl(urlText)
    const urlErr = urlBad
        ? 'Нужна ссылка вида https://… — подписку скачивает роутер, других схем он не умеет.'
        : urlTried && !urlText ? 'Вставьте ссылку на подписку.' : ''
    const listOpen = open ?? (nodes ? nodes.length <= FOLD_FROM : true)
    const chosenName = chosen < 0
        ? 'первый рабочий'
        : nodes?.find((n) => n.index === chosen)?.name || `узел ${chosen}`
    const left = Object.keys(phase).length

    return (
        <div className="space-y-2 rounded-md border border-border p-2">
            <div className="text-xs text-muted-foreground">
                Клиент VLESS/Reality внутри движка: он поднимает своё устройство, поэтому каналы,
                метки и переключение при отказе работают с ним так же, как с wireguard.
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs">
                    Ссылка на подписку
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.currentTarget.value)}
                        placeholder="https://example.com/sub/xxxxx"
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                        aria-label="Ссылка на подписку"
                        aria-invalid={urlBad || undefined}
                        aria-describedby={urlErr ? `sub-url-err-${name}` : undefined}
                    />
                </label>
                <Button variant="secondary" size="sm" disabled={busy === 'sub'} onClick={fetchSub}>
                    {sub?.present
                        ? <><RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" /> Обновить</>
                        : <><Download className="mr-1 h-4 w-4" aria-hidden="true" /> Загрузить</>}
                </Button>
            </div>

            {/* Ссылку проверяем до вызова: sub_set отдаёт ссылку wget'у, и на «example.com»
              * без схемы или на скопированной вместе с текстом строке отказ приходит от
              * роутера, через секунды и словами про код возврата. Тот же ответ рядом с полем
              * и сразу понятнее, и не требует похода в сеть. */}
            {urlErr && (
                <p id={`sub-url-err-${name}`} role="alert" className="text-xs text-warning">
                    {urlErr}
                </p>
            )}

            {sub?.present && (
                <div className="text-xs text-muted-foreground">
                    Файл на роутере: {sub.bytes} байт{sub.mtime ? `, обновлён ${when(sub.mtime)}` : ''}
                    {meta && (
                        <> · узлов пригодно {meta.usable}
                            {meta.skipped ? `, пропущено ${meta.skipped}` : ''}
                            {meta.foreign ? `, чужих протоколов ${meta.foreign}` : ''}
                        </>
                    )}
                </div>
            )}

            {/* Почему узлы не попали в список. Движок знал причину и до запуска 45 её не
              * говорил: человек с подпиской из tls-узлов видел «пригодно 0, пропущено
              * 26» и делал единственный возможный вывод — «не подключается»
              * (splicicd#16). Показывается и когда пригодные есть: «пропущено 3» без
              * объяснения — это тот же вопрос, только тише. */}
            {sub?.present && skips.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {skips.map((s) => (
                        <li key={s.reason}>
                            {s.reason} — {s.count === 1 ? 'узел' : 'узлов'} {s.count}
                            {s.example ? `, например «${s.example}»` : ''}
                        </li>
                    ))}
                    {skipOther > 0 && <li>прочие причины — узлов {skipOther}</li>}
                </ul>
            )}

            {!sub?.present && (
                <p className="text-xs text-warning">
                    Подписки нет. Без неё выход никуда не ведёт: узлы движок берёт только из файла.
                </p>
            )}

            {sub?.present && !saved && (
                <p className="text-xs text-warning">
                    Сохраните выход — узлы движок покажет для уже сохранённой настройки.
                </p>
            )}

            {nodes && (
                <div className="space-y-1">
                    {/* Свёртка и «проверить все» — в одной строке над списком. Выбор «первый
                      * рабочий» из свёртки вынесен намеренно: это единственная строка, которую
                      * нужно видеть всегда, иначе свёрнутая панель прячет и сам выбор. */}
                    {nodes.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                aria-expanded={listOpen}
                                onClick={() => setOpen(!listOpen)}
                            >
                                {listOpen
                                    ? `Свернуть список узлов (${nodes.length})`
                                    : `Показать узлы (${nodes.length})`}
                            </Button>
                            {!listOpen && (
                                <span className="text-xs text-muted-foreground">выбран: {chosenName}</span>
                            )}
                            <Button
                                variant="secondary"
                                size="sm"
                                className="ml-auto"
                                onClick={probeAll}
                            >
                                <Gauge className="mr-1 h-4 w-4" aria-hidden="true" />
                                {batchOn ? `Остановить (осталось ${left})` : 'Проверить все'}
                            </Button>
                        </div>
                    )}

                    <label className="flex items-center gap-2 py-1 text-sm">
                        <input
                            type="radio"
                            name={`node-${name}`}
                            checked={chosen < 0}
                            onChange={() => onChange({ ...output, node: -1 })}
                        />
                        <span className="font-medium">Первый рабочий</span>
                        <span className="text-xs text-muted-foreground">
                            движок сам проверит узлы при подъёме — не сломается при обновлении подписки
                        </span>
                    </label>

                    {listOpen && nodes.map((n) => {
                        const p = probes[n.index]
                        const ph = phase[n.index]
                        const err = fails[n.index]
                        return (
                            <div key={n.index} className="flex flex-wrap items-center gap-2 py-0.5 text-sm">
                                <input
                                    type="radio"
                                    name={`node-${name}`}
                                    checked={chosen === n.index}
                                    onChange={() => onChange({ ...output, node: n.index })}
                                    aria-label={`Узел ${n.name}`}
                                />
                                <span className={chosen === n.index ? 'font-medium text-primary' : ''}>
                                    {n.name || `${n.host}:${n.port}`}
                                </span>
                                <Badge variant="secondary">{n.type}{n.mode ? `/${n.mode}` : ''}</Badge>
                                {n.vision && <Badge variant="secondary">vision</Badge>}

                                {/* Пока строка в работе, показываем состояние, а не прошлый
                                    замер: старое «ответ 90 мс» рядом с идущей проверкой
                                    читается как её результат. */}
                                {ph === 'queued' && <Badge variant="secondary">в очереди</Badge>}
                                {ph === 'running' && <Badge variant="secondary">идёт проверка</Badge>}

                                {!ph && err && <Badge variant="destructive">{err}</Badge>}

                                {!ph && !err && p && (p.ok
                                    ? <>
                                        <Badge variant={latencyTone(p.ttfb_ms)}>ответ {p.ttfb_ms} мс</Badge>
                                        <span className="text-xs text-muted-foreground">
                                            подключение {p.handshake_ms} мс
                                        </span>
                                      </>
                                    /* Причину показываем целиком: «не работает» без причины
                                       заставляет угадывать между ключом, транспортом и мёртвым
                                       сервером — а движок это различает. */
                                    : <Badge variant="destructive">{p.why}</Badge>)}

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto"
                                    disabled={!!ph}
                                    onClick={() => probeOne(n.index, batch.current)}
                                >
                                    <Gauge className="mr-1 h-4 w-4" aria-hidden="true" />
                                    {ph === 'running' ? 'Проверяем…' : ph === 'queued' ? 'В очереди' : 'Проверить'}
                                </Button>
                            </div>
                        )
                    })}

                    {listOpen && (
                        <p className="pt-1 text-xs text-muted-foreground">
                            «Ответ» — время до первого байта от 1.1.1.1 через туннель, то же, что показывает
                            curl. Не пинг: ICMP через туннель не ходит, и пинг измерял бы не тот путь.
                            «Проверить все» идёт по узлам не больше {PROBE_LIMIT} одновременно: больше —
                            и роутер начнёт мерить собственную очередь вместо задержки узла.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
