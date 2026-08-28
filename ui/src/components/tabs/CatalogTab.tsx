import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import CustomLists from '@/components/CustomLists'
import { Hint } from '@/components/ui/hint'
import { toCatalog, type Catalog, type ListOrigin, type ServiceEntry, type Spec } from '@/lib/model'

/** Каталог: что доступно, сколько записей, где используется. ТОЛЬКО справка.
 *
 *  Кнопки «Загрузить» больше нет: списки, на которые указывает правило, скачивает бэкенд
 *  в момент применения (ветка apply в rpcd), а свежесть держит расписание. Человеку
 *  осталась одна необязательная кнопка — обновить уже лежащий список прямо сейчас.
 *
 *  Назначение живёт только в правиле, каталог отвечает на другой вопрос: «что вообще
 *  есть и задействовано ли оно». */

interface Props {
    /** Открыть редактор правила с этим сервисом. Переключает вкладку — каталог не умеет
     *  назначать сам, и это ровно то разделение, ради которого он переписан. */
    onUseInRule: (s: ServiceEntry) => void
}

/** Признак источника доменной части: откуда список берётся и что делать с недостающим
 *  доменом. Форма у зеркала и у своего списка издателя одна, разное — единственное, что
 *  человеку и важно: переживёт ли обновление то, что он добавит, и куда идти с доменом.
 *
 *  Выросло из splify2#7: категория «18+» включена, нужного сайта в ней нет, и узнать
 *  почему было негде. */
function SourceNote({ origin, ours, mixed }: { origin: ListOrigin; ours: boolean; mixed: boolean }) {
    const label = ours ? 'список наш' : 'список внешний'
    return (
        <div className="mt-0.5 text-xs text-muted-foreground">
            <Hint
                tip={
                    ours
                        ? `Список наш${origin.repo ? ` (${origin.repo})` : ''}: не хватает домена — предложите его сюда, он попадёт в список и переживёт обновление. Дописанное прямо на роутере всё равно исчезнет: файл перезаписывается целиком.`
                        : `Список внешний: чтобы добавить домен, предложите его апстриму${origin.repo ? ` (${origin.repo})` : ''} или используйте свой список — кнопка «Свой список» выше. Дописанное на роутере исчезнет при следующем обновлении: файл перезаписывается целиком.`
                }
            >
                {mixed ? `домены — ${label}` : label}
            </Hint>
            {origin.suggest_url && (
                <>
                    {' · '}
                    <a
                        href={origin.suggest_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-dotted hover:text-foreground"
                    >
                        предложить домен
                    </a>
                </>
            )}
        </div>
    )
}

export default function CatalogTab({ onUseInRule }: Props) {
    const [manifest, setManifest] = useState<Catalog | null>(null)
    const [spec, setSpec] = useState<Spec | null>(null)
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
    const mark = (id: string) => setBusy((b) => new Set(b).add(id))
    const unmark = (id: string) =>
        setBusy((b) => {
            const n = new Set(b)
            n.delete(id)
            return n
        })
    const [q, setQ] = useState('')
    const [only, setOnly] = useState<'all' | 'used'>('all')
    /** Форма своих списков — по кнопке, а не всегда: за ней приходят редко, а место
     *  над каталогом она занимала всегда. Открытой остаётся, пока вкладку не покинули. */
    const [customOpen, setCustomOpen] = useState(false)

    useEffect(() => {
        rpc.manifest().then((m) => setManifest(toCatalog(m))).catch(() => setManifest(null))
        rpc.specGet().then(setSpec).catch(() => setSpec(null))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
    }, [])

    /** Кто на запись ссылается. Ключ — путь относительно каталога списков, а НЕ имя файла:
     *  `hodca.lst` есть и адресный, и доменный (`domains/hodca.lst`), и по имени они слились
     *  бы в одну запись. */
    const used = useMemo(() => {
        const m = new Map<string, string[]>()
        for (const ch of spec?.channels || [])
            for (const f of [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]) {
                const key = f.replace(/^.*\/etc\/steer\/lists\//, '')
                m.set(key, [...(m.get(key) || []), ch.name])
            }
        return m
    }, [spec])

    /* Обновление — по ВСЕМ частям сервиса: человек попросил сервис, и отчитываться
     * надо о нём. */
    async function fetchService(sv: ServiceEntry) {
        mark(sv.id)
        let bad = 0
        // Каким путём приехали файлы. Пусто — прямым; иначе бэкенд обошёл закрытый
        // githubusercontent, и сказать об этом надо здесь: обход медленнее, и человек
        // иначе видит только затянувшееся ожидание (splify2#15).
        let via = ''
        try {
            for (const p of sv.parts) {
                const r = await rpc
                    .listFetch(p.id, p.kind)
                    .catch(() => ({ ok: false }) as { ok: boolean; via?: string })
                if (!r.ok) bad++
                if (r.via) via = r.via
            }
            setLocal((await rpc.localLists()).files || {})
            if (bad) notify(`${sv.name}: не обновилось частей — ${bad} из ${sv.parts.length}`, 'warning')
            else notify(`${sv.name}: обновлено${via ? ` (${via})` : ''}`)
        } finally {
            unmark(sv.id)
        }
    }

    async function removeService(sv: ServiceEntry) {
        mark(sv.id)
        let bad = 0
        let last = ''
        try {
            for (const p of sv.parts) {
                const r = await rpc.listRemove(p.id, p.kind).catch(
                    () => ({ ok: false }) as { ok: boolean; error?: string },
                )
                if (!r.ok) {
                    bad++
                    if (r.error) last = r.error
                }
            }
            setLocal((await rpc.localLists()).files || {})
            if (bad)
                notify(
                    last || `${sv.name}: не удалось удалить (частей ${bad} из ${sv.parts.length})`,
                    'warning',
                )
            else notify(`${sv.name}: удалён с роутера`)
        } finally {
            unmark(sv.id)
        }
    }

    if (!manifest)
        return (
            <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
                Каталог недоступен: манифест не загрузился. Проверьте, есть ли у роутера сеть — записи
                скачиваются с сервера издателя, а не лежат в пакете.
            </div>
        )

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
                                'rounded-md px-3 py-1.5 text-sm transition-colors',
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
                <Button variant="secondary" onClick={() => setCustomOpen((v) => !v)} aria-expanded={customOpen}>
                    <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Свой список
                </Button>
            </div>

            {customOpen && (
                <CustomLists
                    local={local}
                    onChanged={async () => setLocal((await rpc.localLists()).files || {})}
                />
            )}

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
                            const have = sv.parts.filter((p) => local[p.file.replace(/^\/+/, '')])
                            const localCount = have.reduce(
                                (n, p) => n + (local[p.file.replace(/^\/+/, '')]?.count || 0), 0)
                            const kinds = [...new Set(sv.parts.map((p) => p.kind))]
                            return (
                                <tr key={sv.id} className="border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/40">
                                    <td className="px-3 py-2">
                                        <div className="truncate font-medium">{sv.name}</div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {kinds.length === 2
                                                ? 'домены и адреса'
                                                : kinds[0] === 'domains'
                                                  ? 'только домены'
                                                  : 'только адреса'}
                                            {sv.parts.length > 1 && ` · частей ${sv.parts.length}`}
                                        </div>
                                        {sv.same_prefixes && (
                                            /* Прочитать это надо ДО включения: адресный список у пары
                                               совпадает побайтово, и второй выбор не добавляет ни
                                               одного адреса. Причина — издателя, не наша. */
                                            <div className="mt-0.5 text-xs text-warning">
                                                <Hint
                                                    /* Причина — строка издателя, и она вставляется
                                                       как есть: своей формулировки у интерфейса
                                                       здесь быть не должно. */
                                                    tip={`${sv.same_prefixes.reason ? `Причина: ${sv.same_prefixes.reason}. ` : ''}${
                                                        sv.same_prefixes.within
                                                            ? 'Это одна и та же группа адресов, вошедшая в запись двумя файлами: второй не добавляет ни одного адреса.'
                                                            : 'Включать обе записи одновременно бессмысленно: вторая не добавляет ни одного адреса, а расход памяти удваивается.'
                                                    }`}
                                                >
                                                    {sv.same_prefixes.within
                                                        ? `один список адресов: «${sv.same_prefixes.names.join('» = «')}»`
                                                        : `тот же список адресов, что у «${sv.same_prefixes.names.join('», «')}»`}
                                                </Hint>
                                            </div>
                                        )}
                                        {sv.upstream && (
                                            <SourceNote origin={sv.upstream} ours={false} mixed={sv.prefixes.length > 0} />
                                        )}
                                        {sv.maintained && (
                                            <SourceNote origin={sv.maintained} ours mixed={sv.prefixes.length > 0} />
                                        )}
                                        {sv.complement && (
                                            /* Вторая половина splify2#7: домена нет в зеркале, он есть
                                               в дополнении — но дополнение это ОТДЕЛЬНАЯ строка
                                               каталога. Промолчать здесь значит оставить человека с
                                               включённым зеркалом и тем же отсутствующим доменом. */
                                            <div className="mt-0.5 text-xs text-warning">
                                                <Hint
                                                    tip={
                                                        sv.complement.ours
                                                            ? `Эта запись дополняет «${sv.complement.names.join('», «')}», а не заменяет её: в ней только домены, которых там нет. Включать имеет смысл обе — по отдельности каждая неполна.`
                                                            : `Рядом есть наш список «${sv.complement.names.join('», «')}»: он дополняет эту запись, а не заменяет её — в нём домены, которых здесь нет. Включать имеет смысл обе, иначе добавленный домен в туннель не попадёт.`
                                                    }
                                                >
                                                    {sv.complement.ours
                                                        ? `дополняет «${sv.complement.names.join('», «')}» — включайте оба`
                                                        : `рядом наш список «${sv.complement.names.join('», «')}» — включайте оба`}
                                                </Hint>
                                            </div>
                                        )}
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
                                        <div className="flex items-center justify-end gap-1">
                                            {have.length === 0 ? (
                                                /* Не кнопка, а обещание: файл скачает бэкенд в момент
                                                   применения — человеку здесь делать нечего. */
                                                <Hint tip="Списка ещё нет на роутере. Как только правило на него укажет и вы нажмёте «Применить», бэкенд скачает его сам.">
                                                    <span className="text-xs text-muted-foreground">
                                                        скачается сам
                                                    </span>
                                                </Hint>
                                            ) : (
                                                <>
                                                    <Hint tip="Списки обновляются сами раз в сутки по расписанию. Кнопка — если свежая версия нужна прямо сейчас.">
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={`Обновить ${sv.name}`}
                                                            disabled={busy.has(sv.id)}
                                                            onClick={() => fetchService(sv)}
                                                        >
                                                            <RefreshCw className={`h-4 w-4 ${busy.has(sv.id) ? 'animate-spin' : ''}`} aria-hidden="true" />
                                                        </Button>
                                                    </Hint>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Удалить ${sv.name} с роутера`}
                                                        className="hover:bg-destructive/10 hover:text-destructive"
                                                        disabled={busy.has(sv.id)}
                                                        onClick={() => removeService(sv)}
                                                    >
                                                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                    </Button>
                                                </>
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
                Каталог — справка: запись начинает работать, когда на неё укажет правило. Нужные
                списки скачиваются и обновляются сами. Манифест версии {manifest.version}.
            </p>
        </div>
    )
}
