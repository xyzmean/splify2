import { useEffect, useState } from 'react'
import { ArrowLeft, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { type Channel, type OutputStatus, type ServiceEntry } from '@/lib/model'

/** Редактор правила — на месте таблицы, а не в модальном окне.
 *
 *  Модальное окно здесь мешало бы ровно тому, зачем правило открывают: чтобы сравнить его с
 *  соседними. Окно закрывает список, и «чем это правило отличается от того» приходится держать
 *  в голове.
 *
 *  Три блока повторяют строку таблицы: что перенаправляем, кого касается, куда. Галочки
 *  каталога живут ЗДЕСЬ и только здесь — прежде маршрут назначался в двух местах, и два места
 *  спорили об одном и том же. */

/** Путь, по которому движок будет искать список. Повторяет путь у издателя, а не берёт от него
 *  одно имя файла: иначе адресный `hodca.lst` и доменный `domains/hodca.lst` становятся одним
 *  локальным файлом и затирают друг друга. Ровно это и случилось однажды — nft отверг набор
 *  ЦЕЛИКОМ, и встала вся маршрутизация, а не один канал. Правило продублировано в бэкенде
 *  (`local_path`), и это единственное место, где дублирование терпимо: разойдясь, они дадут
 *  «список скачан, а правило его не находит». */
export function pathFor(file: string) {
    return `/etc/steer/lists/${file.replace(/^\/+/, '')}`
}

/** Сервис выбран, если в правиле есть ХОТЯ БЫ ОДНА его часть.
 *
 *  Не «все части»: сервис бывает включён наполовину — например, руками правленной спекой, — и
 *  показать его невыбранным значило бы предложить включить то, что уже включено. */
export function selectedIds(ch: Channel, services: ServiceEntry[]): string[] {
    const files = new Set([...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])])
    return services
        .filter((sv) => [...sv.prefixes, ...sv.domains].some((f) => files.has(pathFor(f))))
        .map((sv) => sv.id)
}

export function isDomains(ch: Channel) {
    return (ch.match.domains_files?.length ?? 0) > 0
}

interface Props {
    ch: Channel
    index: number
    services: ServiceEntry[]
    local: Record<string, { count: number; mtime: number }>
    outputs: Record<string, OutputStatus>
    /** Пересечения с другими правилами — текстом, потому что решение принимает ПОРЯДОК, и
     *  прятать это нельзя: адрес достанется тому правилу, что выше. */
    clash: string | null
    onChange: (ch: Channel) => void
    onClose: () => void
    onDelete: () => void
}

export default function RuleEditor({
    ch, index, services, local, outputs, clash, onChange, onClose, onDelete,
}: Props) {
    const [q, setQ] = useState('')
    /** Аренды DHCP — чтобы устройства выбирали по имени, а не набирали MAC руками. Опечатка в
     *  MAC не совпадёт ни с чем и не пожалуется: правило просто не будет действовать. */
    const [leases, setLeases] = useState<{ mac: string; ip: string; name: string }[]>([])
    useEffect(() => {
        rpc.leases().then((r) => setLeases(r.leases || [])).catch(() => setLeases([]))
    }, [])
    const chosen = selectedIds(ch, services)
    const chosenEntries = services.filter((sv) => chosen.includes(sv.id))
    const outNames = Object.keys(outputs)
    const hasDomains = isDomains(ch)

    /** Включить или выключить сервис — сразу всеми его частями.
     *
     *  Раньше здесь переключался ВИД списка, и включение доменной записи сбрасывало адресную:
     *  движок отвергал правило с обоими видами. Теперь принимает — набор один, адреса из файла
     *  лежат в нём постоянно, домены кладёт резолвер с TTL. Поэтому и выбор стал про сервис. */
    function pick(sv: ServiceEntry) {
        const on = chosen.includes(sv.id)
        const pref = new Set(ch.match.prefixes_files || [])
        const doms = new Set(ch.match.domains_files || [])
        for (const f of sv.prefixes) on ? pref.delete(pathFor(f)) : pref.add(pathFor(f))
        for (const f of sv.domains) on ? doms.delete(pathFor(f)) : doms.add(pathFor(f))
        onChange({
            ...ch,
            match: {
                ...(pref.size ? { prefixes_files: [...pref] } : {}),
                ...(doms.size ? { domains_files: [...doms], mode: ch.match.mode ?? 'fakeip' } : {}),
            },
        })
    }

    const shown = services.filter((sv) => {
        const s = q.trim().toLowerCase()
        return !s || sv.name.toLowerCase().includes(s) || sv.id.toLowerCase().includes(s)
    })

    const total = chosenEntries.reduce((n, sv) => n + (sv.count || 0), 0)

    return (
        <div className="rounded-md border border-border bg-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
                <div className="flex items-center gap-2 text-sm">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Все правила
                    </button>
                    <span className="text-muted-foreground">/</span>
                    <span className="font-medium">Правило {index + 1}</span>
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                    {chosenEntries.length
                        ? `сервисов ${chosenEntries.length}`
                        : 'сервис не выбран'}
                    {total ? ` · ${total.toLocaleString('ru-RU')} записей` : ''}
                </div>
            </div>

            <div className="space-y-4 p-3">
                <section>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Что перенаправляем
                        </h3>
                        <span className="text-xs text-muted-foreground">
                            {chosen.length ? `${chosen.length} записей выбрано` : 'ничего не выбрано'}
                        </span>
                    </div>

                    <label className="mt-2 flex flex-col gap-1 text-xs">
                        Название правила
                        <input
                            value={ch.name}
                            onChange={(e) => onChange({ ...ch, name: e.currentTarget.value })}
                            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        />
                    </label>

                    {chosenEntries.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {chosenEntries.map((sv) => (
                                <button
                                    key={sv.id}
                                    type="button"
                                    onClick={() => pick(sv)}
                                    className="flex items-center gap-1 rounded border border-primary/50 bg-primary/10 px-2 py-0.5 text-xs"
                                >
                                    {sv.name} <span aria-hidden="true">×</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="mt-2 flex items-center gap-2 rounded-md border border-border px-2">
                        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <input
                            value={q}
                            onChange={(e) => setQ(e.currentTarget.value)}
                            placeholder="поиск по каталогу — сервисы, категории"
                            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {shown.length} записей
                        </span>
                    </div>

                    <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-border">
                        {shown.length === 0 && (
                            <p className="p-3 text-xs text-muted-foreground">Ничего не нашлось.</p>
                        )}
                        {shown.map((sv) => {
                            const on = chosen.includes(sv.id)
                            const kinds = [...new Set(sv.parts.map((p) => p.kind))]
                            const missing = sv.parts.filter((p) => !local[p.file.replace(/^\/+/, '')]).length
                            return (
                                <label
                                    key={sv.id}
                                    className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5 text-sm last:border-b-0"
                                >
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => pick(sv)}
                                        className="shrink-0"
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                        {sv.name}
                                        {/* «Скачается» — под именем, а не в строку справа: там
                                            оно вклинивалось между именем и видом, и вид с числом
                                            обрезался как раз у самых длинных названий. */}
                                        {missing > 0 && (
                                            <span className="ml-2 text-xs text-muted-foreground">
                                                скачается
                                            </span>
                                        )}
                                    </span>
                                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                                        {kinds.length === 2
                                            ? 'домены и адреса'
                                            : kinds[0] === 'domains'
                                              ? 'домены'
                                              : 'адреса'}
                                        {sv.count ? ` · ${sv.count.toLocaleString('ru-RU')}` : ''}
                                    </span>
                                </label>
                            )
                        })}
                    </div>

                    <p className="mt-1 text-xs text-muted-foreground">
                        Это тот же каталог, что на вкладке «Сервисы и категории». Там он показывает, где
                        запись используется, — выбирают её здесь. Выбирается СЕРВИС: если у него есть и
                        домены, и адреса, в правило попадут оба. Домены точнее (адрес сервиса меняется, имя
                        нет), адреса работают и когда клиент не спрашивает наш DNS.
                    </p>
                    {clash && <p className="mt-1 text-xs text-warning">{clash}</p>}
                </section>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <section className="rounded-md border border-border p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Кого касается
                        </h3>
                        <div className="mt-2 space-y-2">
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="radio"
                                    checked={!ch.from?.length}
                                    onChange={() => onChange({ ...ch, from: undefined })}
                                />
                                Все устройства в сети
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="radio"
                                    checked={!!ch.from?.length}
                                    onChange={() => onChange({ ...ch, from: ch.from?.length ? ch.from : [''] })}
                                />
                                Только выбранные
                            </label>
                            {!!ch.from?.length && (
                                <>
                                    {/* Устройства из аренд DHCP. Адрес у устройства меняется — DHCP
                                        выдаёт другой после перезагрузки, и правило начинает касаться
                                        не того; MAC живёт, пока живёт устройство. Поэтому в правило
                                        кладём MAC, а адрес показываем только чтобы узнать устройство. */}
                                    {leases.length > 0 && (
                                        <div className="max-h-32 overflow-y-auto rounded-md border border-border">
                                            {leases.map((l) => {
                                                const on = (ch.from || []).includes(l.mac)
                                                return (
                                                    <label
                                                        key={l.mac}
                                                        className="flex items-center gap-2 border-b border-border/50 px-2 py-1 text-sm last:border-b-0"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={on}
                                                            onChange={() => {
                                                                const cur = ch.from || []
                                                                const next = on
                                                                    ? cur.filter((x) => x !== l.mac)
                                                                    : [...cur.filter((x) => x.includes(':')), l.mac]
                                                                onChange({ ...ch, from: next.length ? next : [''] })
                                                            }}
                                                            className="shrink-0"
                                                        />
                                                        <span className="min-w-0 flex-1 truncate">
                                                            {l.name || l.ip}
                                                        </span>
                                                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                                            {l.mac}
                                                        </span>
                                                    </label>
                                                )
                                            })}
                                        </div>
                                    )}
                                    <input
                                        value={(ch.from || []).join(', ')}
                                        placeholder="192.168.1.50, 192.168.1.0/24 или MAC"
                                        onChange={(e) => {
                                            const v = e.currentTarget.value
                                                .split(',')
                                                .map((s) => s.trim())
                                                .filter(Boolean)
                                            onChange({ ...ch, from: v.length ? v : [''] })
                                        }}
                                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
                                    />
                                    {/* Смешивать нельзя, и это не наша прихоть: nft не умеет «или»
                                        внутри правила, поэтому движок такую спеку отвергает. Сказать
                                        это здесь дешевле, чем получить отказ при сохранении. */}
                                    <p className="text-xs text-muted-foreground">
                                        Либо адреса и подсети, либо MAC-адреса — вместе в одном правиле
                                        нельзя. MAC виден только у соседа по сети: за вторым роутером в
                                        пакете будет его MAC, и правило накроет всех, кто за ним.
                                    </p>
                                    {(() => {
                                        const macs = (ch.from || []).filter((x) => x.includes(':')).length
                                        const mixed = macs > 0 && macs !== (ch.from || []).filter(Boolean).length
                                        return mixed ? (
                                            <p className="text-xs text-destructive">
                                                Здесь и адреса, и MAC — движок такое правило отвергнет.
                                            </p>
                                        ) : null
                                    })()}
                                </>
                            )}
                        </div>
                    </section>

                    <section className="rounded-md border border-border p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Куда направить
                        </h3>
                        <div className="mt-2 space-y-2">
                            {outNames.length === 0 && (
                                <p className="text-xs text-warning">
                                    Outbound-ов нет — правилу некуда вести. Заведите его на вкладке
                                    «Outbounds».
                                </p>
                            )}
                            {outNames.map((n) => {
                                const o = outputs[n]
                                return (
                                    <label key={n} className="flex items-center gap-2 text-sm">
                                        <input
                                            type="radio"
                                            checked={ch.out === n}
                                            onChange={() => onChange({ ...ch, out: n })}
                                        />
                                        <span
                                            className={`h-2 w-2 shrink-0 rounded-full ${
                                                o.kind === 'direct'
                                                    ? 'bg-muted-foreground'
                                                    : o.up
                                                      ? 'bg-success'
                                                      : 'bg-destructive'
                                            }`}
                                            aria-hidden="true"
                                        />
                                        <span className="min-w-0 flex-1 truncate">{n}</span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {o.kind === 'direct'
                                                ? 'мимо туннеля'
                                                : o.nat === false
                                                  ? 'нет NAT'
                                                  : o.device || ''}
                                        </span>
                                    </label>
                                )
                            })}
                        </div>
                        {hasDomains && (
                            <label className="mt-3 flex flex-col gap-1 text-xs">
                                Режим доменов
                                <select
                                    value={ch.match.mode ?? 'fakeip'}
                                    onChange={(e) =>
                                        onChange({
                                            ...ch,
                                            match: { ...ch.match, mode: e.currentTarget.value as 'fakeip' | 'realip' },
                                        })
                                    }
                                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                                >
                                    <option value="fakeip">fake-IP — точнее</option>
                                    <option value="realip">real-IP — дешевле</option>
                                </select>
                                <span className="text-muted-foreground">
                                    fake-IP выдаёт каждому домену свой адрес: точно, но на домен нужен
                                    элемент набора. real-IP кладёт настоящие адреса из ответа — дешевле, но
                                    два домена за одним адресом станут одним.
                                </span>
                            </label>
                        )}
                    </section>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button onClick={onClose}>Готово</Button>
                    <Button variant="ghost" onClick={onDelete} className="text-destructive">
                        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> Удалить правило
                    </Button>
                </div>
            </div>
        </div>
    )
}
