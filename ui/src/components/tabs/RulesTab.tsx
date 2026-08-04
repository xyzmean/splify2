import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toLists, EMPTY_SPEC, type Channel, type ListEntry, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'
import RuleEditor, { pathFor, selectedIds, isDomains } from '@/components/tabs/RuleEditor'

/** Правила: единственное место, где что-то назначается.
 *
 *  Строка читается как предложение — что перенаправляем, кого касается, куда. Порядок задаёт
 *  приоритет: движок раздаёт метки по первому совпадению, и интерфейс, который спрятал бы это,
 *  спрятал бы единственное, что человеку обязательно понимать.
 *
 *  Прежде маршрут назначался в двух местах: в правиле и на вкладке списков. Два места спорили
 *  об одном, и человек не знал, какое победит. Каталог теперь только справка.
 */

/** Выключенные правила.
 *
 *  Гасить правило, не удаляя, — то, чего просят чаще всего («отключу на вечер»), а поля
 *  `enabled` в спеке движка нет: он знает только `channels`, и всё, что там лежит, применяется.
 *
 *  Поэтому выключенное правило ВЫНИМАЕТСЯ из спеки и лежит в памяти интерфейса вместе со своим
 *  местом в порядке. Так оно и правда не действует — движок его не видит вовсе, — а порядок
 *  восстанавливается при включении. Когда в движке появится `enabled`, это уедет туда, и
 *  память останется пустой.
 *
 *  Альтернативой было держать его в спеке с признаком и учить движок пропускать — но тогда до
 *  появления такого движка правило продолжало бы работать, а выключатель показывал бы обратное.
 *  Врать выключателем нельзя. */
interface Off {
    at: number
    ch: Channel
}

interface Memo {
    v: 1
    off?: Off[]
    /** Память мастера прежних версий. Читаем и пишем обратно НЕ РАЗБИРАЯ: выбросив её, мы бы
     *  сломали установки, где она ещё что-то значит. */
    dests?: unknown
}

async function memoLoad(): Promise<Memo> {
    try {
        const r = await rpc.uiGet()
        if (!r.state) return { v: 1 }
        const m = JSON.parse(r.state) as Memo
        return m && typeof m === 'object' ? { ...m, v: 1 } : { v: 1 }
    } catch {
        return { v: 1 }
    }
}

function describe(ch: Channel, lists: ListEntry[]) {
    const ids = selectedIds(ch, lists)
    const entries = lists.filter((l) => ids.includes(l.id))
    const total = entries.reduce((n, l) => n + (l.count || 0), 0)
    const kind = isDomains(ch) ? 'сервис' : 'категория'
    if (!entries.length) {
        const files = [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]
        if (ch.match.any) return 'весь трафик'
        if (!files.length) return 'список не выбран'
        return `${files.length} свой список`
    }
    const what = entries.length === 1 ? `${kind} · ${entries[0].name}` : `${entries.length} записей`
    return total ? `${what} · ${total.toLocaleString('ru-RU')} записей` : what
}

function whoText(ch: Channel) {
    if (!ch.from?.length) return 'все устройства'
    if (ch.from.length === 1) return ch.from[0]
    return `${ch.from.length} адресов и подсетей`
}

export default function RulesTab({ live }: { live: Live }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [lists, setLists] = useState<ListEntry[]>([])
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [memo, setMemo] = useState<Memo>({ v: 1 })
    const [open, setOpen] = useState<number | null>(null)
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.specGet().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then((m) => setLists(toLists(m).lists)).catch(() => setLists([]))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
        void memoLoad().then(setMemo)
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    function move(i: number, delta: number) {
        if (!spec) return
        const j = i + delta
        if (j < 0 || j >= spec.channels.length) return
        const channels = spec.channels.slice()
        ;[channels[i], channels[j]] = [channels[j], channels[i]]
        edit({ ...spec, channels })
        setOpen(open === i ? j : open === j ? i : open)
    }

    function add() {
        if (!spec) return
        const out = Object.keys(spec.outputs)[0]
        if (!out) {
            notify('Сначала заведите outbound — правилу некуда вести', 'warning')
            return
        }
        const used = new Set(spec.channels.map((c) => c.name))
        let n = spec.channels.length + 1
        while (used.has(`правило${n}`)) n++
        edit({ ...spec, channels: [...spec.channels, { name: `правило${n}`, match: {}, out }] })
        setOpen(spec.channels.length)
    }

    /** Выключить: вынуть из спеки и запомнить место. Включить: вернуть на место. */
    async function toggle(i: number, on: boolean) {
        if (!spec) return
        let next: Spec
        let off: Off[]
        if (on) {
            const rec = (memo.off || [])[i]
            if (!rec) return
            off = (memo.off || []).filter((_, k) => k !== i)
            const channels = spec.channels.slice()
            channels.splice(Math.min(rec.at, channels.length), 0, rec.ch)
            next = { ...spec, channels }
        } else {
            const ch = spec.channels[i]
            off = [...(memo.off || []), { at: i, ch }]
            next = { ...spec, channels: spec.channels.filter((_, k) => k !== i) }
        }
        const m = { ...memo, v: 1 as const, off }
        setMemo(m)
        edit(next)
        // Память пишем сразу: она не часть спеки, и держать её до «Применить» значило бы
        // потерять выключенное правило при перезагрузке страницы.
        await rpc.uiSet(JSON.stringify(m)).catch(() => {})
        setOpen(null)
    }

    async function save(andApply: boolean) {
        if (!spec) return
        setBusy(true)
        try {
            /* Списки скачиваем ДО применения: движок читает файлы при компиляции и умирает на
             * отсутствующем, так что выбранный, но не скачанный список превратил бы «Применить»
             * в ошибку, с которой человеку нечего делать. */
            const needed = new Set<string>()
            for (const ch of spec.channels)
                for (const f of [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])])
                    needed.add(f)
            for (const l of lists)
                if (needed.has(pathFor(l))) {
                    const r = await rpc.listFetch(l.id, l.kind).catch(() => ({ ok: false }) as { ok: boolean })
                    if (!r.ok) notify(`${l.name}: список не скачался — правило будет без него`, 'warning')
                }

            const res = await rpc.specSet(JSON.stringify(spec))
            if (!res.ok) throw new Error(res.error || 'не удалось сохранить')
            setLocal((await rpc.localLists()).files || {})
            setDirty(false)
            if (andApply) {
                const ap = await rpc.apply()
                notify(ap.output?.trim() || 'Применено', ap.ok ? 'info' : 'error')
                live.refresh()
            } else {
                notify('Сохранено. Вступит в силу после применения')
            }
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

    const outputs = live.status?.outputs || {}
    const off = memo.off || []

    if (open !== null && spec.channels[open]) {
        const ch = spec.channels[open]
        const mine = new Set(selectedIds(ch, lists))
        const clashing = spec.channels
            .map((o, k) => ({ o, k }))
            .filter(({ o, k }) => k !== open && selectedIds(o, lists).some((id) => mine.has(id)))
        const above = clashing.filter(({ k }) => k < open)
        const clash = clashing.length
            ? `Общие записи с: ${clashing.map(({ o }) => o.name).join(', ')}. ` +
              (above.length
                  ? `Совпавшее заберёт «${above[above.length - 1].o.name}» — оно выше.`
                  : 'Совпавшее заберёт это правило — оно выше.')
            : null
        return (
            <div className="space-y-3">
                <RuleEditor
                    ch={ch}
                    index={open}
                    lists={lists}
                    local={local}
                    outputs={outputs}
                    clash={clash}
                    onChange={(next) =>
                        edit({ ...spec, channels: spec.channels.map((c, k) => (k === open ? next : c)) })
                    }
                    onClose={() => setOpen(null)}
                    onDelete={() => {
                        edit({ ...spec, channels: spec.channels.filter((_, k) => k !== open) })
                        setOpen(null)
                    }}
                />
                <SaveBar dirty={dirty} busy={busy} onSave={save} />
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-sp-muted-foreground">
                    Проверяются сверху вниз, побеждает первое совпадение.
                </p>
                <Button onClick={add}>
                    <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Новое правило
                </Button>
            </div>

            <div className="overflow-hidden rounded-md border border-sp-border bg-sp-card shadow-card">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-sp-border text-left text-xs uppercase tracking-wide text-sp-muted-foreground">
                            <th className="px-3 py-2">Что перенаправляем</th>
                            <th className="px-3 py-2">Кого касается</th>
                            <th className="px-3 py-2">Куда</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {spec.channels.map((ch, i) => {
                            const o = outputs[ch.out]
                            return (
                                <tr key={`on-${i}`} className="border-b border-sp-border/50 last:border-b-0">
                                    <td className="px-3 py-2">
                                        <div className="flex items-start gap-3">
                                            <Switch
                                                on
                                                label={`Выключить правило ${ch.name}`}
                                                onClick={() => void toggle(i, false)}
                                            />
                                            <div className="min-w-0">
                                                <div className="truncate font-medium">{ch.name}</div>
                                                <div className="truncate text-xs text-sp-muted-foreground">
                                                    {describe(ch, lists)}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-sp-muted-foreground">{whoText(ch)}</td>
                                    <td className="px-3 py-2">
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={`h-2 w-2 shrink-0 rounded-full ${
                                                    !o
                                                        ? 'bg-sp-destructive'
                                                        : o.kind === 'direct'
                                                          ? 'bg-sp-muted-foreground'
                                                          : o.up
                                                            ? 'bg-sp-success'
                                                            : 'bg-sp-destructive'
                                                }`}
                                                aria-hidden="true"
                                            />
                                            <span className="truncate">
                                                {o ? (o.kind === 'direct' ? 'Напрямую' : ch.out) : `${ch.out} — не найден`}
                                            </span>
                                        </span>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" aria-label="Поднять приоритет"
                                                    disabled={i === 0} onClick={() => move(i, -1)}>
                                                <ArrowUp className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label="Опустить приоритет"
                                                    disabled={i === spec.channels.length - 1}
                                                    onClick={() => move(i, 1)}>
                                                <ArrowDown className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label="Изменить правило"
                                                    onClick={() => setOpen(i)}>
                                                <Pencil className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label="Удалить правило"
                                                    onClick={() =>
                                                        edit({ ...spec, channels: spec.channels.filter((_, k) => k !== i) })
                                                    }>
                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            )
                        })}

                        {/* Выключенные — приглушённые, но НА ВИДУ: спрятанное правило человек
                            считает удалённым и заводит второе такое же. */}
                        {off.map((rec, i) => (
                            <tr key={`off-${i}`} className="border-b border-sp-border/50 opacity-50 last:border-b-0">
                                <td className="px-3 py-2">
                                    <div className="flex items-start gap-3">
                                        <Switch
                                            on={false}
                                            label={`Включить правило ${rec.ch.name}`}
                                            onClick={() => void toggle(i, true)}
                                        />
                                        <div className="min-w-0">
                                            <div className="truncate font-medium">{rec.ch.name}</div>
                                            <div className="truncate text-xs text-sp-muted-foreground">
                                                {describe(rec.ch, lists)} · выключено
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-3 py-2 text-sp-muted-foreground">{whoText(rec.ch)}</td>
                                <td className="px-3 py-2 text-sp-muted-foreground">{rec.ch.out}</td>
                                <td />
                            </tr>
                        ))}

                        {spec.channels.length === 0 && off.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-sm text-sp-muted-foreground">
                                    Правил нет — весь трафик идёт напрямую.
                                    <div className="mt-1 text-xs">
                                        Правило говорит движку: этот сервис или категорию — вот этим
                                        устройствам — через такой outbound.
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-sp-muted-foreground">
                Правило собирается из записей каталога: карандаш открывает тот же список сервисов и
                категорий, что и вкладка «Сервисы и категории». Порядок задаёт приоритет — steer раздаёт
                метки по первому совпадению, остальное идёт напрямую.
            </p>

            <SaveBar dirty={dirty} busy={busy} onSave={save} />
        </div>
    )
}

function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            onClick={onClick}
            className={`mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors ${
                on ? 'border-sp-primary bg-sp-primary' : 'border-sp-border bg-sp-muted'
            }`}
        >
            <span
                className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                    on ? 'translate-x-4' : 'translate-x-0.5'
                }`}
            />
        </button>
    )
}

function SaveBar({
    dirty, busy, onSave,
}: { dirty: boolean; busy: boolean; onSave: (andApply: boolean) => void }) {
    if (!dirty && !busy) return null
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-sp-border bg-sp-card p-3">
            <Button onClick={() => onSave(true)} disabled={busy}>
                {busy ? 'Применяем…' : 'Сохранить и применить'}
            </Button>
            <Button variant="secondary" onClick={() => onSave(false)} disabled={busy}>
                Только сохранить
            </Button>
            <span className="text-xs text-sp-muted-foreground">
                Применение перезаписывает настройку steer и перекомпилирует наборы — это около двух
                секунд, соединения не рвутся.
            </span>
        </div>
    )
}
