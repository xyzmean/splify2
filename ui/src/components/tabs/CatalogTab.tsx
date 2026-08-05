import { useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toCatalog, type Catalog, type ServiceEntry, type Spec } from '@/lib/model'

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
    /** Открыть редактор правила с этим сервисом. Переключает вкладку — каталог не умеет
     *  назначать сам, и это ровно то разделение, ради которого он переписан. */
    onUseInRule: (s: ServiceEntry) => void
}

export default function CatalogTab({ onUseInRule }: Props) {
    const [manifest, setManifest] = useState<Catalog | null>(null)
    const [spec, setSpec] = useState<Spec | null>(null)
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [only, setOnly] = useState<'all' | 'used'>('all')

    useEffect(() => {
        rpc.manifest().then((m) => setManifest(toCatalog(m))).catch(() => setManifest(null))
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

    /* Загрузка и удаление — по ВСЕМ частям сервиса. Части качаются по отдельности (у издателя
     * это разные файлы), но человек попросил сервис, и отчитываться надо о нём. */
    async function fetchService(sv: ServiceEntry) {
        setBusy(sv.id)
        let bad = 0
        try {
            for (const p of sv.parts) {
                const r = await rpc.listFetch(p.id, p.kind).catch(() => ({ ok: false }) as { ok: boolean })
                if (!r.ok) bad++
            }
            setLocal((await rpc.localLists()).files || {})
            if (bad) notify(`${sv.name}: не загрузилось частей — ${bad} из ${sv.parts.length}`, 'warning')
            else notify(`${sv.name}: загружено`)
        } finally {
            setBusy(null)
        }
    }

    async function removeService(sv: ServiceEntry) {
        setBusy(sv.id)
        try {
            for (const p of sv.parts) await rpc.listRemove(p.id, p.kind).catch(() => {})
            setLocal((await rpc.localLists()).files || {})
            notify(`${sv.name}: удалён с роутера`)
        } finally {
            setBusy(null)
        }
    }

    if (!manifest)
        return (
            <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
                Каталог недоступен: манифест не загрузился. Проверьте, есть ли у роутера сеть — записи
                скачиваются с сервера издателя, а не лежат в пакете.
            </div>
        )

    /** Кем занят сервис — по всем его частям сразу: включённый доменный список и есть
     *  «сервис используется», даже если адресная часть не тронута. */
    const rulesFor = (sv: ServiceEntry) => {
        const names = new Set<string>()
        for (const p of sv.parts)
            for (const r of used.get(p.file.replace(/^\/+/, '')) || []) names.add(r)
        return [...names]
    }

    const shown = manifest.services.filter((sv) => {
        if (only === 'used' && rulesFor(sv).length === 0) return false
        const s = q.trim().toLowerCase()
        return !s || sv.name.toLowerCase().includes(s) || sv.id.toLowerCase().includes(s)
    })

    const usedCount = manifest.services.filter((sv) => rulesFor(sv).length > 0).length

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.currentTarget.value)}
                        placeholder="поиск по каталогу"
                        className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
                    />
                </div>
                <div className="flex gap-1" role="tablist" aria-label="Что показывать">
                    {/* Разделения по виду списка здесь больше нет: человек выбирает сервис, а
                        не «адресами или доменами». Осталось только «что уже задействовано». */}
                    {([
                        ['all', `все · ${manifest.services.length}`],
                        ['used', `используются · ${usedCount}`],
                    ] as const).map(([id, label]) => (
                        <button
                            key={id}
                            role="tab"
                            aria-selected={only === id}
                            onClick={() => setOnly(id)}
                            className={[
                                'rounded-md px-3 py-1.5 text-sm',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                only === id
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground',
                            ].join(' ')}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-border bg-card shadow-card">
                <table className="w-full min-w-[38rem] text-sm">
                    <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2">Запись</th>
                            <th className="px-3 py-2">Записей</th>
                            <th className="px-3 py-2">Где используется</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((sv) => {
                            const byRules = rulesFor(sv)
                            /* «Загружено» считаем по частям: сервис бывает наполовину на роутере,
                               и сказать про него «загружен» было бы неправдой. */
                            const have = sv.parts.filter((p) => local[p.file.replace(/^\/+/, '')])
                            const localCount = have.reduce(
                                (n, p) => n + (local[p.file.replace(/^\/+/, '')]?.count || 0), 0)
                            const kinds = [...new Set(sv.parts.map((p) => p.kind))]
                            return (
                                <tr key={sv.id} className="border-b border-border/50 last:border-b-0">
                                    <td className="px-3 py-2">
                                        <div className="truncate font-medium">{sv.name}</div>
                                        {/* Вторая строка — из чего сервис собран. Вид списка не
                                            исчез из мира, он перестал быть тем, что ВЫБИРАЮТ:
                                            домены точнее, адреса работают без DNS. */}
                                        <div className="truncate text-xs text-muted-foreground">
                                            {kinds.length === 2
                                                ? 'домены и адреса'
                                                : kinds[0] === 'domains'
                                                  ? 'только домены'
                                                  : 'только адреса'}
                                            {sv.parts.length > 1 && ` · частей ${sv.parts.length}`}
                                            {have.length === 0 && ' · не загружен на роутер'}
                                            {have.length > 0 && have.length < sv.parts.length &&
                                                ` · загружено ${have.length} из ${sv.parts.length}`}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                                        {(localCount || sv.count || 0).toLocaleString('ru-RU')}
                                    </td>
                                    <td className="px-3 py-2">
                                        {byRules.length ? (
                                            <span className="text-primary">{byRules.join(', ')}</span>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => onUseInRule(sv)}
                                                className="text-primary underline decoration-dotted"
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
                                                disabled={busy === sv.id}
                                                onClick={() => fetchService(sv)}
                                            >
                                                {have.length ? (
                                                    <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
                                                ) : (
                                                    <Download className="mr-1 h-4 w-4" aria-hidden="true" />
                                                )}
                                                {busy === sv.id ? 'Загрузка…' : have.length ? 'Обновить' : 'Загрузить'}
                                            </Button>
                                            {have.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Удалить ${sv.name} с роутера`}
                                                    disabled={busy === sv.id}
                                                    onClick={() => removeService(sv)}
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
                                <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                                    Ничего не нашлось.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-muted-foreground">
                Здесь ничего не назначается: запись становится работающей, когда на неё укажет правило.
                Манифест версии {manifest.version}. Загрузка и удаление — про то, лежит ли файл на
                роутере, а не про маршрут.
            </p>
        </div>
    )
}
