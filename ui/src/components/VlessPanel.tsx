import { useEffect, useState } from 'react'
import { Download, Gauge, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
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
    const [busy, setBusy] = useState('')

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
        if (!url.trim()) { notify('Вставьте ссылку на подписку', 'warning'); return }
        setBusy('sub')
        try {
            const r = await rpc.subSet(url.trim())
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

    async function probe(node: number) {
        setBusy(`probe${node}`)
        try {
            const r = await rpc.vlessProbe(name, node)
            if (r.error) throw new Error(r.error)
            const next = { ...probes }
            for (const res of r.results || []) next[res.index] = res
            setProbes(next)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    const chosen = output.node ?? -1

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
                    />
                </label>
                <Button variant="secondary" size="sm" disabled={busy === 'sub'} onClick={fetchSub}>
                    {sub?.present
                        ? <><RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" /> Обновить</>
                        : <><Download className="mr-1 h-4 w-4" aria-hidden="true" /> Загрузить</>}
                </Button>
            </div>

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

                    {nodes.map((n) => {
                        const p = probes[n.index]
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

                                {p && (p.ok
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
                                    disabled={busy === `probe${n.index}`}
                                    onClick={() => probe(n.index)}
                                >
                                    <Gauge className="mr-1 h-4 w-4" aria-hidden="true" />
                                    {busy === `probe${n.index}` ? 'Проверяем…' : 'Проверить'}
                                </Button>
                            </div>
                        )
                    })}

                    <p className="pt-1 text-xs text-muted-foreground">
                        «Ответ» — время до первого байта от 1.1.1.1 через туннель, то же, что показывает
                        curl. Не пинг: ICMP через туннель не ходит, и пинг измерял бы не тот путь.
                    </p>
                </div>
            )}
        </div>
    )
}
