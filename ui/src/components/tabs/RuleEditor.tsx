import { useState } from 'react'
import { ArrowLeft, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type Channel, type ListEntry, type OutputStatus } from '@/lib/model'

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
export function pathFor(l: ListEntry) {
    return `/etc/steer/lists/${l.file.replace(/^\/+/, '')}`
}

export function selectedIds(ch: Channel, lists: ListEntry[]): string[] {
    const files = [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]
    return lists.filter((l) => files.includes(pathFor(l))).map((l) => l.id)
}

export function isDomains(ch: Channel) {
    return (ch.match.domains_files?.length ?? 0) > 0
}

interface Props {
    ch: Channel
    index: number
    lists: ListEntry[]
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
    ch, index, lists, local, outputs, clash, onChange, onClose, onDelete,
}: Props) {
    const [q, setQ] = useState('')
    const kind: 'prefixes' | 'domains' = isDomains(ch) ? 'domains' : 'prefixes'
    const chosen = selectedIds(ch, lists)
    const chosenEntries = lists.filter((l) => chosen.includes(l.id))
    const outNames = Object.keys(outputs)

    /** Переключение вида чистит другую сторону, а не оставляет спеку, которую движок отвергнет.
     *  Адреса и домены попадают в набор разными путями: адресный список читается из файла при
     *  компиляции, доменный наполняет резолвер по мере запросов. */
    function pick(l: ListEntry) {
        const key = l.kind === 'domains' ? 'domains_files' : 'prefixes_files'
        const other = l.kind === 'domains' ? 'prefixes_files' : 'domains_files'
        const cur = (ch.match as Record<string, string[] | undefined>)[key] || []
        const otherCur = (ch.match as Record<string, string[] | undefined>)[other] || []
        const p = pathFor(l)
        const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
        onChange({
            ...ch,
            match: {
                ...(l.kind === 'domains' ? { mode: ch.match.mode ?? 'fakeip' } : {}),
                [key]: next,
                // Другой вид сбрасываем ТОЛЬКО если он был непуст: иначе каждое нажатие
                // переписывало бы поле, которого и так нет.
                ...(otherCur.length ? { [other]: [] } : {}),
            },
        })
    }

    const shown = lists.filter((l) => {
        const s = q.trim().toLowerCase()
        return !s || l.name.toLowerCase().includes(s) || l.id.toLowerCase().includes(s)
    })

    const total = chosenEntries.reduce((n, l) => n + (l.count || 0), 0)

    return (
        <div className="rounded-md border border-sp-border bg-sp-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sp-border p-3">
                <div className="flex items-center gap-2 text-sm">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex items-center gap-1 text-sp-muted-foreground hover:text-sp-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Все правила
                    </button>
                    <span className="text-sp-muted-foreground">/</span>
                    <span className="font-medium">Правило {index + 1}</span>
                </div>
                <div className="font-mono text-xs text-sp-muted-foreground">
                    {kind === 'domains' ? 'домены' : 'адреса'}
                    {total ? ` · ${total.toLocaleString('ru-RU')} записей` : ''}
                </div>
            </div>

            <div className="space-y-4 p-3">
                <section>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-sp-muted-foreground">
                            Что перенаправляем
                        </h3>
                        <span className="text-xs text-sp-muted-foreground">
                            {chosen.length ? `${chosen.length} записей выбрано` : 'ничего не выбрано'}
                        </span>
                    </div>

                    <label className="mt-2 flex flex-col gap-1 text-xs">
                        Название правила
                        <input
                            value={ch.name}
                            onChange={(e) => onChange({ ...ch, name: e.currentTarget.value })}
                            className="rounded-md border border-sp-border bg-sp-background px-2 py-1.5 text-sm"
                        />
                    </label>

                    {chosenEntries.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {chosenEntries.map((l) => (
                                <button
                                    key={l.id}
                                    type="button"
                                    onClick={() => pick(l)}
                                    className="flex items-center gap-1 rounded border border-sp-primary/50 bg-sp-primary/10 px-2 py-0.5 text-xs"
                                >
                                    {l.name} <span aria-hidden="true">×</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="mt-2 flex items-center gap-2 rounded-md border border-sp-border px-2">
                        <Search className="h-4 w-4 shrink-0 text-sp-muted-foreground" aria-hidden="true" />
                        <input
                            value={q}
                            onChange={(e) => setQ(e.currentTarget.value)}
                            placeholder="поиск по каталогу — сервисы, категории"
                            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
                        />
                        <span className="shrink-0 text-xs text-sp-muted-foreground">
                            {shown.length} записей
                        </span>
                    </div>

                    <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-sp-border">
                        {shown.length === 0 && (
                            <p className="p-3 text-xs text-sp-muted-foreground">Ничего не нашлось.</p>
                        )}
                        {shown.map((l) => {
                            const on = chosen.includes(l.id)
                            /* Запись другого вида, когда вид уже выбран: нажатие её ВКЛЮЧИТ и
                             * сбросит выбранное. Молча делать это нельзя — человек потеряет
                             * набор, который собирал. */
                            const swaps = chosen.length > 0 && !on &&
                                (l.kind === 'domains' ? kind === 'prefixes' : kind === 'domains')
                            return (
                                <label
                                    key={l.id}
                                    className="flex items-center gap-2 border-b border-sp-border/50 px-2 py-1.5 text-sm last:border-b-0"
                                >
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => pick(l)}
                                        className="shrink-0"
                                    />
                                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                                    {swaps && (
                                        <span className="shrink-0 text-xs text-sp-warning">
                                            сменит вид, выбранное сбросится
                                        </span>
                                    )}
                                    {!local[l.file.replace(/^\/+/, '')] && (
                                        <span className="shrink-0 text-xs text-sp-muted-foreground">
                                            скачается
                                        </span>
                                    )}
                                    <span className="shrink-0 text-xs text-sp-muted-foreground">
                                        {l.kind === 'domains' ? 'сервис' : 'категория'}
                                        {typeof l.count === 'number' ? ` · ${l.count.toLocaleString('ru-RU')}` : ''}
                                    </span>
                                </label>
                            )
                        })}
                    </div>

                    <p className="mt-1 text-xs text-sp-muted-foreground">
                        Это тот же каталог, что на вкладке «Сервисы и категории». Там он показывает, где
                        запись используется, — выбирают её здесь. В одном правиле только один вид: адреса
                        читаются из файла при компиляции, домены наполняет резолвер по мере запросов, и
                        одним набором они быть не могут.
                    </p>
                    {clash && <p className="mt-1 text-xs text-sp-warning">{clash}</p>}
                </section>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <section className="rounded-md border border-sp-border p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-sp-muted-foreground">
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
                                    <input
                                        value={(ch.from || []).join(', ')}
                                        placeholder="192.168.1.50, 192.168.1.0/24"
                                        onChange={(e) => {
                                            const v = e.currentTarget.value
                                                .split(',')
                                                .map((s) => s.trim())
                                                .filter(Boolean)
                                            onChange({ ...ch, from: v.length ? v : [''] })
                                        }}
                                        className="w-full rounded-md border border-sp-border bg-sp-background px-2 py-1.5 font-mono text-sm"
                                    />
                                    {/* MAC движок пока не понимает: «кого касается» это `ip saddr`.
                                        Обещать выбор по MAC в интерфейсе раньше, чем он есть в
                                        движке, значит нарисовать поле, которое молча не работает. */}
                                    <p className="text-xs text-sp-muted-foreground">
                                        Адреса и подсети. Выбор по MAC движок пока не умеет.
                                    </p>
                                </>
                            )}
                        </div>
                    </section>

                    <section className="rounded-md border border-sp-border p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-sp-muted-foreground">
                            Куда направить
                        </h3>
                        <div className="mt-2 space-y-2">
                            {outNames.length === 0 && (
                                <p className="text-xs text-sp-warning">
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
                                                    ? 'bg-sp-muted-foreground'
                                                    : o.up
                                                      ? 'bg-sp-success'
                                                      : 'bg-sp-destructive'
                                            }`}
                                            aria-hidden="true"
                                        />
                                        <span className="min-w-0 flex-1 truncate">{n}</span>
                                        <span className="shrink-0 text-xs text-sp-muted-foreground">
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
                        {kind === 'domains' && (
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
                                    className="rounded-md border border-sp-border bg-sp-background px-2 py-1 text-sm"
                                >
                                    <option value="fakeip">fake-IP — точнее</option>
                                    <option value="realip">real-IP — дешевле</option>
                                </select>
                                <span className="text-sp-muted-foreground">
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
                    <Button variant="ghost" onClick={onDelete} className="text-sp-destructive">
                        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> Удалить правило
                    </Button>
                </div>
            </div>
        </div>
    )
}
