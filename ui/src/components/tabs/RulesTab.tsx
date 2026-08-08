import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { toCatalog, EMPTY_SPEC, type Channel, type ServiceEntry, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'
import RuleEditor, { pathFor, selectedIds } from '@/components/tabs/RuleEditor'

/** Правила: единственное место, где что-то назначается.
 *
 *  Строка читается как предложение — что перенаправляем, кого касается, куда. Порядок задаёт
 *  приоритет: движок раздаёт метки по первому совпадению, и интерфейс, который спрятал бы это,
 *  спрятал бы единственное, что человеку обязательно понимать.
 *
 *  Прежде маршрут назначался в двух местах: в правиле и на вкладке списков. Два места спорили
 *  об одном, и человек не знал, какое победит. Каталог теперь только справка.
 */

/** Выключение — поле спеки, а не память интерфейса.
 *
 *  Раньше выключенное правило ВЫНИМАЛОСЬ из спеки и лежало в памяти интерфейса: движок про
 *  `enabled` не знал, а держать правило в спеке с признаком было нельзя — оно продолжало бы
 *  работать, и выключатель врал бы. Теперь движок это поле понимает и пропускает такое правило,
 *  поэтому оно остаётся на своём месте в порядке, видно движку (status, explain) и не действует.
 */

/** Строка под именем правила: что оно перенаправляет, словами человека.
 *
 *  Называем СЕРВИСЫ, а не виды списков: «YouTube, Telegram» отвечает на вопрос, а «2 доменных
 *  списка» заставляет вспоминать, что в них лежит. Вид упоминается только когда сервисов много
 *  и перечислять их негде. */
function describe(ch: Channel, services: ServiceEntry[]) {
    const ids = selectedIds(ch, services)
    const entries = services.filter((sv) => ids.includes(sv.id))
    if (!entries.length) {
        const files = [...(ch.match.prefixes_files || []), ...(ch.match.domains_files || [])]
        if (ch.match.any) return 'весь трафик'
        if (!files.length) return 'сервис не выбран'
        return `свои списки: ${files.length}`
    }
    const total = entries.reduce((n, sv) => n + (sv.count || 0), 0)
    const what = entries.length <= 3
        ? entries.map((sv) => sv.name).join(', ')
        : `${entries.slice(0, 2).map((sv) => sv.name).join(', ')} и ещё ${entries.length - 2}`
    return total ? `${what} · ${total.toLocaleString('ru-RU')} записей` : what
}

function whoText(ch: Channel) {
    if (!ch.from?.length) return 'все устройства'
    if (ch.from.length === 1) return ch.from[0]
    return `${ch.from.length} адресов и подсетей`
}

interface Props {
    live: Live
    /** Запись каталога, которую попросили «в правило» с другой вкладки. */
    wanted?: ServiceEntry | null
    onWantedUsed?: () => void
    /** Уйти туда, где заводят outbound. Правилу некуда вести, пока его нет, и оставлять
     *  человека с советом «заведите» без дороги туда — это тупик в один щелчок. */
    onGoOutbounds?: () => void
}

export default function RulesTab({ live, wanted, onWantedUsed, onGoOutbounds }: Props) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [services, setServices] = useState<ServiceEntry[]>([])
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [open, setOpen] = useState<number | null>(null)
    const [dirty, setDirty] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.specGet().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then((m) => setServices(toCatalog(m).services)).catch(() => setServices([]))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        setDirty(true)
    }

    /** Просьба из каталога: завести правило с этой записью и открыть его.
     *
     *  Ждём загрузки спеки — иначе новое правило легло бы в пустую и затёрло настоящую. И
     *  сбрасываем просьбу сразу: иначе повторный заход на вкладку снова открывал бы редактор,
     *  которого человек уже не просил. */
    useEffect(() => {
        if (!wanted || !spec) return
        onWantedUsed?.()
        const out = Object.keys(spec.outputs)[0]
        if (!out) {
            notify('Сначала заведите outbound — правилу некуда вести', 'warning')
            return
        }
        const used = new Set(spec.channels.map((c) => c.name))
        let name = wanted.name
        let n = 2
        while (used.has(name)) name = `${wanted.name} ${n++}`
        /* Сразу ОБА вида, если у сервиса они есть: правило теперь про сервис, а движок такое
         * принимает — набор один, адреса в нём постоянны, домены кладёт резолвер. */
        const ch: Channel = {
            name,
            out,
            match: {
                ...(wanted.prefixes.length
                    ? { prefixes_files: wanted.prefixes.map(pathFor) }
                    : {}),
                ...(wanted.domains.length
                    ? { domains_files: wanted.domains.map(pathFor), mode: 'fakeip' as const }
                    : {}),
            },
        }
        edit({ ...spec, channels: [...spec.channels, ch] })
        setOpen(spec.channels.length)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wanted, spec])

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

    /** Переключить правило. Одно поле спеки — и порядок, и видимость движку сохраняются. */
    function toggle(i: number, on: boolean) {
        if (!spec) return
        edit({
            ...spec,
            channels: spec.channels.map((c, k) => (k === i ? { ...c, enabled: on } : c)),
        })
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
            for (const sv of services)
                for (const p of sv.parts)
                    if (needed.has(pathFor(p.file))) {
                        const r = await rpc.listFetch(p.id, p.kind)
                            .catch(() => ({ ok: false }) as { ok: boolean })
                        if (!r.ok)
                            notify(`${sv.name}: часть «${p.name}» не скачалась — правило будет без неё`,
                                   'warning')
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

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    const outputs = live.status?.outputs || {}

    if (open !== null && spec.channels[open]) {
        const ch = spec.channels[open]
        const mine = new Set(selectedIds(ch, services))
        const clashing = spec.channels
            .map((o, k) => ({ o, k }))
            .filter(({ o, k }) => k !== open && selectedIds(o, services).some((id) => mine.has(id)))
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
                    services={services}
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
                <p className="text-xs text-muted-foreground">
                    Проверяются сверху вниз, побеждает первое совпадение.
                </p>
                <Button onClick={add}>
                    <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Новое правило
                </Button>
            </div>

            <div className="overflow-x-auto rounded-md border border-border bg-card shadow-card">
                <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2">Что перенаправляем</th>
                            <th className="px-3 py-2">Кого касается</th>
                            <th className="px-3 py-2">Куда</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {spec.channels.map((ch, i) => {
                            const o = outputs[ch.out]
                            const on = ch.enabled !== false
                            return (
                                <tr
                                    key={`rule-${i}`}
                                    /* Выключенное приглушено, но НА ВИДУ и на своём месте: спрятанное
                                       правило человек считает удалённым и заводит второе такое же, а
                                       уехавшее вниз меняет порядок, то есть приоритет. */
                                    className={`border-b border-border/50 last:border-b-0 ${on ? '' : 'opacity-50'}`}
                                >
                                    <td className="px-3 py-2">
                                        <div className="flex items-start gap-3">
                                            <Switch
                                                on={on}
                                                label={on ? `Выключить правило ${ch.name}` : `Включить правило ${ch.name}`}
                                                onClick={() => toggle(i, !on)}
                                            />
                                            <div className="min-w-0">
                                                <div className="truncate font-medium">{ch.name}</div>
                                                <div className="truncate text-xs text-muted-foreground">
                                                    {describe(ch, services)}
                                                    {!on && ' · выключено'}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground">{whoText(ch)}</td>
                                    <td className="px-3 py-2">
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={`h-2 w-2 shrink-0 rounded-full ${
                                                    !o
                                                        ? 'bg-destructive'
                                                        : o.kind === 'direct'
                                                          ? 'bg-muted-foreground'
                                                          : o.up
                                                            ? 'bg-success'
                                                            : 'bg-destructive'
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

                        {spec.channels.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                                    Правил нет — весь трафик идёт напрямую.
                                    <div className="mt-1 text-xs">
                                        Правило говорит движку: этот сервис или категорию — вот этим
                                        устройствам — через такой outbound.
                                    </div>
                                    {Object.keys(outputs).length === 0 && (
                                        <div className="mt-2 text-xs">
                                            Сначала нужен outbound — вести пока некуда.{' '}
                                            <button
                                                type="button"
                                                onClick={onGoOutbounds}
                                                className="text-primary underline decoration-dotted"
                                            >
                                                Завести outbound
                                            </button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-muted-foreground">
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
            /* p-0 и flex здесь — не для красоты: тема LuCI задаёт кнопкам свои
               внутренние отступы, а у выключателя размер жёсткий, так что чужой
               отступ выталкивал ползунок за край дорожки. Сброс есть и в index.css,
               но контрол с фиксированной геометрией не должен на него полагаться. */
            className={`mt-0.5 flex h-5 w-9 shrink-0 items-center p-0 rounded-full border transition-colors ${
                on ? 'border-primary bg-primary' : 'border-border bg-muted'
            }`}
        >
            {/* Цвет ползунка — от токенов, а не белый. На светлой теме дорожка выключенного
                состояния сама светлая (#f4f5f7), и белый ползунок на ней исчезал: выключатель
                выглядел пустой рамкой, по которой не понять, включено или нет. */}
            <span
                className={`block h-4 w-4 rounded-full transition-transform ${
                    on
                        ? 'translate-x-4 bg-primary-foreground'
                        : 'translate-x-0.5 bg-muted-foreground'
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
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3">
            <Button onClick={() => onSave(true)} disabled={busy}>
                {busy ? 'Применяем…' : 'Сохранить и применить'}
            </Button>
            <Button variant="secondary" onClick={() => onSave(false)} disabled={busy}>
                Только сохранить
            </Button>
            <span className="text-xs text-muted-foreground">
                Применение перезаписывает настройку steer и перекомпилирует наборы — это около двух
                секунд, соединения не рвутся.
            </span>
        </div>
    )
}
