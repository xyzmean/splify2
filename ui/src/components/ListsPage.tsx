import { useEffect, useMemo, useState } from 'react'
import { Download, Globe, Network, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toLists, type ListEntry, type Manifest, type Spec } from '@/lib/model'

// Two kinds of list, and the difference is not cosmetic:
//
//   prefixes — addresses, loaded into the channel's set from the file;
//   domains  — names, resolved at query time; the set fills itself as clients ask.
//
// A domain list is what makes "route youtube" work regardless of which of its
// dozens of addresses DNS returns this minute. An address list is what works when
// there is no DNS to inspect. The picker offers both because a channel takes either.

function kindLabel(k: ListEntry['kind']) {
    return k === 'domains' ? 'домены' : 'адреса'
}

export default function ListsPage() {
    const [manifest, setManifest] = useState<Manifest | null>(null)
    const [spec, setSpec] = useState<Spec | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [filter, setFilter] = useState<'all' | 'domains' | 'prefixes'>('all')

    useEffect(() => {
        rpc.manifest().then((m) => setManifest(toLists(m))).catch(() => setManifest(null))
        rpc.specGet().then(setSpec).catch(() => setSpec(null))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
    }, [])

    const used = useMemo(() => {
        const m = new Map<string, string[]>()
        for (const ch of spec?.channels || []) {
            for (const f of [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]) {
                /* Ключ — путь относительно каталога списков, а не имя файла: иначе
                 * адресный и доменный список с одним именем считались бы одним. */
                const key = f.replace(/^.*\/etc\/steer\/lists\//, '')
                m.set(key, [...(m.get(key) || []), ch.name])
            }
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

    if (!manifest) {
        return (
            <div className="p-5 text-sm text-sp-muted-foreground">
                Манифест списков недоступен. Проверьте подключение к сети.
            </div>
        )
    }

    const shown = manifest.lists.filter((l) => filter === 'all' || l.kind === filter)
    const totalDomains = manifest.lists.filter((l) => l.kind === 'domains').length
    const totalPrefixes = manifest.lists.filter((l) => l.kind === 'prefixes').length

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Списки</CardTitle>
                    <CardDescription>
                        Версия манифеста {manifest.version}. Доменных списков {totalDomains}, адресных{' '}
                        {totalPrefixes}. Список сам ничего не меняет — он становится работающим, когда на
                        него укажет канал.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="mb-3 flex gap-1" role="tablist" aria-label="Вид списков">
                        {(['all', 'domains', 'prefixes'] as const).map((f) => (
                            <button
                                key={f}
                                role="tab"
                                aria-selected={filter === f}
                                onClick={() => setFilter(f)}
                                className={[
                                    'rounded-md px-3 py-1 text-sm',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-primary',
                                    filter === f
                                        ? 'bg-sp-primary text-sp-primary-foreground'
                                        : 'text-sp-muted-foreground hover:text-sp-foreground',
                                ].join(' ')}
                            >
                                {f === 'all' ? 'все' : f === 'domains' ? 'домены' : 'адреса'}
                            </button>
                        ))}
                    </div>

                    <ul className="space-y-2">
                        {shown.map((l) => {
                            /* Ключ — путь относительно каталога списков, как у издателя.
                             * По имени файла нельзя: `hodca.lst` есть и адресный, и
                             * доменный (`domains/hodca.lst`), и они бы слились в один. */
                            const rel = l.file.replace(/^\/+/, '')
                            const byChannels = used.get(rel)
                            const have = local[rel]
                            return (
                                <li
                                    key={l.id}
                                    className="flex flex-wrap items-center gap-3 rounded-md border border-sp-border bg-sp-card p-3"
                                >
                                    {l.kind === 'domains' ? (
                                        <Globe className="h-4 w-4 shrink-0 text-sp-muted-foreground" aria-hidden="true" />
                                    ) : (
                                        <Network className="h-4 w-4 shrink-0 text-sp-muted-foreground" aria-hidden="true" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate font-medium">{l.name}</span>
                                            <Badge variant="secondary">{kindLabel(l.kind)}</Badge>
                                            {typeof l.count === 'number' && (
                                                <span className="text-xs text-sp-muted-foreground">
                                                    {l.count.toLocaleString('ru-RU')} записей
                                                </span>
                                            )}
                                            {have ? (
                                                <Badge variant="default">
                                                    на роутере: {have.count.toLocaleString('ru-RU')}
                                                </Badge>
                                            ) : (
                                                <Badge variant="secondary">не загружен</Badge>
                                            )}
                                            {l.source && (
                                                <span className="text-xs text-sp-muted-foreground">
                                                    источник: {l.source}
                                                </span>
                                            )}
                                        </div>
                                        {l.description && (
                                            <p className="mt-1 text-xs text-sp-muted-foreground">{l.description}</p>
                                        )}
                                        {byChannels && (
                                            <p className="mt-1 text-xs text-sp-primary">
                                                используется каналами: {byChannels.join(', ')}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
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
                                </li>
                            )
                        })}
                    </ul>
                </CardContent>
            </Card>
        </div>
    )
}
