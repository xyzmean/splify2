import { useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toLists, type ListEntry, type Manifest, type Spec } from '@/lib/model'

/** Каталог: что доступно, сколько записей, где используется. ТОЛЬКО справка.
 *
 *  Прежде маршрут назначался в двух местах — в канале и здесь, — и два места спорили об одном.
 *  Теперь назначение живёт только в правиле, а каталог отвечает на другой вопрос: «что вообще
 *  есть и задействовано ли оно». Колонка «где используется» и связывает одно с другим: у
 *  задействованной записи — имя правила, у свободной — кнопка, открывающая редактор с этой
 *  записью уже выбранной.
 *
 *  Загрузка и удаление здесь остаются: это не про маршрут, а про то, лежит ли файл на роутере.
 *  Список сам ничего не меняет — он становится работающим, когда на него укажет правило. */

interface Props {
    /** Открыть редактор правила с этой записью. Переключает вкладку — каталог не умеет
     *  назначать сам, и это ровно то разделение, ради которого он переписан. */
    onUseInRule: (l: ListEntry) => void
}

export default function CatalogTab({ onUseInRule }: Props) {
    const [manifest, setManifest] = useState<Manifest | null>(null)
    const [spec, setSpec] = useState<Spec | null>(null)
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [only, setOnly] = useState<'all' | 'domains' | 'prefixes' | 'used'>('all')

    useEffect(() => {
        rpc.manifest().then((m) => setManifest(toLists(m))).catch(() => setManifest(null))
        rpc.specGet().then(setSpec).catch(() => setSpec(null))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
    }, [])

    /** Кто на запись ссылается. Ключ — путь относительно каталога списков, а НЕ имя файла:
     *  `hodca.lst` есть и адресный, и доменный (`domains/hodca.lst`), и по имени они слились
     *  бы в одну запись. Ровно на этом однажды один список затёр другой. */
    const used = useMemo(() => {
        const m = new Map<string, string[]>()
        for (const ch of spec?.channels || [])
            for (const f of [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]) {
                const key = f.replace(/^.*\/etc\/steer\/lists\//, '')
                m.set(key, [...(m.get(key) || []), ch.name])
            }
        return m
    }, [spec])

    async function fetchList(l: ListEntry) {
        setBusy(l.id)
        try {
            const r = await rpc.listFetch(l.id, l.kind)
            if (!r.ok) throw new Error(r.error || 'не удалось загрузить')
            notify(`${l.name}: загружено ${r.count ?? '—'} записей`)
            setLocal((await rpc.localLists()).files || {})
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(null)
        }
    }

    async function removeList(l: ListEntry) {
        setBusy(l.id)
        try {
            const r = await rpc.listRemove(l.id, l.kind)
            if (!r.ok) throw new Error(r.error || 'не удалось удалить')
            notify(`${l.name}: удалён с роутера`)
            setLocal((await rpc.localLists()).files || {})
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(null)
        }
    }

    if (!manifest)
        return (
            <div className="rounded-md border border-sp-border bg-sp-card p-5 text-sm text-sp-muted-foreground">
                Каталог недоступен: манифест не загрузился. Проверьте, есть ли у роутера сеть — записи
                скачиваются с сервера издателя, а не лежат в пакете.
            </div>
        )

    const shown = manifest.lists.filter((l) => {
        const rel = l.file.replace(/^\/+/, '')
        if (only === 'used' && !used.get(rel)) return false
        if (only === 'domains' && l.kind !== 'domains') return false
        if (only === 'prefixes' && l.kind !== 'prefixes') return false
        const s = q.trim().toLowerCase()
        return !s || l.name.toLowerCase().includes(s) || l.id.toLowerCase().includes(s)
    })

    const usedCount = manifest.lists.filter((l) => used.get(l.file.replace(/^\/+/, ''))).length

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-sp-border bg-sp-card px-2">
                    <Search className="h-4 w-4 shrink-0 text-sp-muted-foreground" aria-hidden="true" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.currentTarget.value)}
                        placeholder="поиск по каталогу"
                        className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
                    />
                </div>
                <div className="flex gap-1" role="tablist" aria-label="Что показывать">
                    {([
                        ['all', 'все'],
                        ['domains', 'сервисы'],
                        ['prefixes', 'категории'],
                        ['used', `используются · ${usedCount}`],
                    ] as const).map(([id, label]) => (
                        <button
                            key={id}
                            role="tab"
                            aria-selected={only === id}
                            onClick={() => setOnly(id)}
                            className={[
                                'rounded-md px-3 py-1.5 text-sm',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-primary',
                                only === id
                                    ? 'bg-sp-primary text-sp-primary-foreground'
                                    : 'text-sp-muted-foreground hover:text-sp-foreground',
                            ].join(' ')}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="overflow-hidden rounded-md border border-sp-border bg-sp-card shadow-card">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-sp-border text-left text-xs uppercase tracking-wide text-sp-muted-foreground">
                            <th className="px-3 py-2">Запись</th>
                            <th className="px-3 py-2">Записей</th>
                            <th className="px-3 py-2">Где используется</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((l) => {
                            const rel = l.file.replace(/^\/+/, '')
                            const byRules = used.get(rel)
                            const have = local[rel]
                            return (
                                <tr key={l.id} className="border-b border-sp-border/50 last:border-b-0">
                                    <td className="px-3 py-2">
                                        <div className="truncate font-medium">{l.name}</div>
                                        {/* Вторая строка объясняет слово выше: «сервис» — это домены,
                                            «категория» — адреса, и разница не косметическая. Домены
                                            наполняет резолвер по мере запросов, адреса читаются из
                                            файла при компиляции. */}
                                        <div className="truncate text-xs text-sp-muted-foreground">
                                            {l.kind === 'domains' ? 'сервис · домены' : 'категория · адреса'}
                                            {l.source ? ` · ${l.source}` : ''}
                                            {have ? '' : ' · не загружен на роутер'}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap text-sp-muted-foreground">
                                        {have
                                            ? have.count.toLocaleString('ru-RU')
                                            : typeof l.count === 'number'
                                              ? l.count.toLocaleString('ru-RU')
                                              : '—'}
                                    </td>
                                    <td className="px-3 py-2">
                                        {byRules ? (
                                            <span className="text-sp-primary">{byRules.join(', ')}</span>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => onUseInRule(l)}
                                                className="text-sp-primary underline decoration-dotted"
                                            >
                                                В правило
                                            </button>
                                        )}
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex justify-end gap-1">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={busy === l.id}
                                                onClick={() => fetchList(l)}
                                            >
                                                {have ? (
                                                    <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
                                                ) : (
                                                    <Download className="mr-1 h-4 w-4" aria-hidden="true" />
                                                )}
                                                {busy === l.id ? 'Загрузка…' : have ? 'Обновить' : 'Загрузить'}
                                            </Button>
                                            {have && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Удалить ${l.name} с роутера`}
                                                    disabled={busy === l.id}
                                                    onClick={() => removeList(l)}
                                                >
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            )
                        })}
                        {shown.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-sm text-sp-muted-foreground">
                                    Ничего не нашлось.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-sp-muted-foreground">
                Здесь ничего не назначается: запись становится работающей, когда на неё укажет правило.
                Манифест версии {manifest.version}. Загрузка и удаление — про то, лежит ли файл на
                роутере, а не про маршрут.
            </p>
        </div>
    )
}
