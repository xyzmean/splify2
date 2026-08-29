import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'
import { toCatalog, customServices, EMPTY_SPEC, type Channel, type OutputStatus, type ServiceEntry, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'
import { Hint } from '@/components/ui/hint'
import ClientNetsCard from '@/components/ClientNetsCard'
import RuleEditor, { pathFor, selectedIds } from '@/components/tabs/RuleEditor'

/** Правила: единственное место, где что-то назначается.
 *
 *  Строка читается как предложение — что перенаправляем, кого касается, куда. Порядок задаёт
 *  приоритет: движок раздаёт метки по первому совпадению, и интерфейс, который спрятал бы это,
 *  спрятал бы единственное, что человеку обязательно понимать.
 *
 *  Кнопок «Сохранить» здесь больше нет: каждая правка уходит в spec_set сама (lib/pending.ts),
 *  а применяет одна плавающая пилюля. Скачивание выбранных, но отсутствующих списков переехало
 *  в бэкенд, в ветку apply: человек не обязан помнить, что движок читает файлы при компиляции.
 */

/** Строка под именем правила: что оно перенаправляет, словами человека. */
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

/** То же самое в родительном падеже: на узком экране правило читается фразой «что → для кого →
 *  куда», и «для все устройства» в ней — не мелочь, а место, где интерфейс перестаёт читаться
 *  как текст. Столбцу таблицы на широком экране нужен именительный, поэтому форм две.
 *
 *  Счётчик остаётся счётчиком — «устройств: 2», подпись с двоеточием и числом, — и склонения
 *  после числительного здесь не нужны по построению. */
function whoTextFor(ch: Channel) {
    if (!ch.from?.length) return 'всех устройств'
    if (ch.from.length === 1) return ch.from[0]
    return `адресов и подсетей: ${ch.from.length}`
}

/** Спорят ли два правила за одни и те же записи.
 *
 *  По путям файлов, а не по записям каталога: свой список каталогу неизвестен, а перекрыть
 *  исключение он может не хуже. `any` пересекается со всем — правило «весь трафик» забирает и
 *  то, что ниже названо по имени. Ограничение по устройствам (`from`) здесь СОЗНАТЕЛЬНО не
 *  учитывается: правило, накрывающее только телефон, перекрывает исключение именно для
 *  телефона, и «у меня на телефоне исключение не работает» — это тот же случай, а не другой. */
function overlaps(a: Channel, b: Channel) {
    if (a.match.any || b.match.any) return true
    const fa = new Set([...(a.match.prefixes_files || []), ...(a.match.domains_files || [])])
    return [...(b.match.prefixes_files || []), ...(b.match.domains_files || [])].some((f) => fa.has(f))
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
    const [catalogServices, setServices] = useState<ServiceEntry[]>([])
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const services = useMemo(
        () => [...catalogServices, ...customServices(local)],
        [catalogServices, local],
    )
    const [open, setOpen] = useState<number | null>(null)

    useEffect(() => {
        /* Спека приходит из общего хранилища (pending), а не своим запросом: хранилище
         * помнит и несохранённые полсекунды, и снимок применённого — свой specGet здесь
         * вернул бы то, что вкладка Outbounds уже успела поменять. */
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then((m) => setServices(toCatalog(m).services)).catch(() => setServices([]))
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))
    }, [])

    /** Правка: в свой стейт для мгновенной перерисовки и в хранилище для автосохранения. */
    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    /** Просьба из каталога: завести правило с этой записью и открыть его. */
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

    /** Исключение: «этот сервис — мимо туннеля».
     *
     *  Отдельной сущности в движке нет и не требуется — исключение это канал в выход `direct`,
     *  стоящий ВЫШЕ туннельных: метки раздаются по первому совпадению, поэтому верхнее правило
     *  забирает записи себе и оставляет их на обычном пути. Механизм был в продукте с самого
     *  начала, но нигде так не назывался, и человек с «у меня Spotify без VPN работает лучше»
     *  (splify2#3) его не находил — искал настройку, которой нет, потому что она есть в виде
     *  порядка строк. */
    function addException() {
        if (!spec) return
        /* Выход в direct нужен как адрес назначения. Если его ещё нет — заводим здесь же: у
         * этого выхода нет ни одной настройки, и отправлять за ним на другую вкладку значит
         * превратить шаблон в инструкцию из двух шагов, то есть в то же скрытое знание. */
        let outputs = spec.outputs
        let out = Object.keys(outputs).find((n) => outputs[n].kind === 'direct')
        if (!out) {
            out = 'direct'
            let d = 2
            while (outputs[out]) out = `direct${d++}`
            outputs = { ...outputs, [out]: { name: out, kind: 'direct' } }
        }
        const used = new Set(spec.channels.map((c) => c.name))
        let name = 'исключение'
        let n = 2
        while (used.has(name)) name = `исключение ${n++}`
        /* Место — перед первым туннельным правилом, а не в конец списка: исключение, попавшее
         * ниже туннельного канала с теми же записями, не срабатывает вовсе. Не в самое начало
         * тоже осознанно — так уже стоящие исключения сохраняют свой порядок между собой. */
        const at = spec.channels.findIndex((c) => outputs[c.out]?.kind !== 'direct')
        const idx = at < 0 ? spec.channels.length : at
        const channels = spec.channels.slice()
        channels.splice(idx, 0, { name, match: {}, out })
        edit({ ...spec, outputs, channels })
        setOpen(idx)
    }

    /** Переключить правило. Одно поле спеки — и порядок, и видимость движку сохраняются. */
    function toggle(i: number, on: boolean) {
        if (!spec) return
        edit({
            ...spec,
            channels: spec.channels.map((c, k) => (k === i ? { ...c, enabled: on } : c)),
        })
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    /** Выходы: спека плюс то, что о них знает движок.
     *
     *  Одних фактов движка мало — выход, заведённый минуту назад и ещё не применённый, в
     *  status отсутствует: правило на него читалось бы как «не найден», а в редакторе такого
     *  выхода не было бы в списке вовсе, то есть шаблон «Исключение» выглядел бы сломанным
     *  ровно в тот момент, когда им пользуются впервые. Факты кладутся сверху: `up`, метку и
     *  таблицу знает только движок. */
    const outputs: Record<string, OutputStatus> = { ...spec.outputs, ...(live.status?.outputs || {}) }

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
        /* Перекрытие исключения — отдельно от `clash`: то говорит, кто заберёт общие записи,
         * а это отвечает на вопрос «сработает ли вообще». Считается только для канала в
         * direct и только по правилам ВЫШЕ, включённым и туннельным. */
        const coveredBy =
            outputs[ch.out]?.kind === 'direct'
                ? spec.channels
                      .filter(
                          (o, k) =>
                              k < open &&
                              o.enabled !== false &&
                              outputs[o.out]?.kind !== 'direct' &&
                              overlaps(o, ch),
                      )
                      .map((o) => o.name)
                : []
        return (
            <RuleEditor
                ch={ch}
                index={open}
                services={services}
                local={local}
                outputs={outputs}
                clash={clash}
                rulesTotal={spec.channels.length}
                coveredBy={coveredBy}
                onChange={(next) =>
                    edit({ ...spec, channels: spec.channels.map((c, k) => (k === open ? next : c)) })
                }
                onClose={() => setOpen(null)}
                onDelete={() => {
                    edit({ ...spec, channels: spec.channels.filter((_, k) => k !== open) })
                    setOpen(null)
                }}
            />
        )
    }

    /* Куски строки правила. Раскладок ДВЕ — таблица на широком экране и строки на узком, — и
       вёрстка, повторённая в обеих, разошлась бы на первой же правке. */
    type Rule = Spec['channels'][number]

    const ruleName = (ch: Rule, i: number, on: boolean) => (
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
    )

    const ruleOut = (ch: Rule) => {
        const o = outputs[ch.out]
        return (
            <span className="flex min-w-0 items-center gap-2">
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
        )
    }

    const ruleActions = (i: number) => (
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
                    className="hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => edit({ ...spec, channels: spec.channels.filter((_, k) => k !== i) })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
        </div>
    )

    return (
        <div className="space-y-3">
            {/* Кого касаются правила — ПЕРЕД самими правилами, а не после: правило, заведённое
                на сеть, из которой никто не приходит, выглядит настроенным и не работает
                (splify2#16). Здесь, а не в «Системе»: это про маршрутизацию, а не про коробку. */}
            <ClientNetsCard spec={spec} status={live.status} onChange={edit} />

            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    Сверху вниз — побеждает{' '}
                    <Hint tip="steer раздаёт метки по первому совпадению: адрес достаётся самому верхнему правилу, остальное идёт напрямую. Стрелками меняется приоритет. Поэтому правило «Напрямую», стоящее ВЫШЕ туннельного, и есть исключение: оно забирает свои записи первым и оставляет их мимо VPN.">
                        первое совпадение
                    </Hint>
                    . Изменения сохраняются сами. Правило «Напрямую» выше туннельных — это
                    исключение: выбранное пойдёт мимо VPN.
                </p>
                <div className="flex flex-wrap gap-2">
                    {/* Без иконки и вторичной кнопкой: исключение — частный случай правила, а
                        не второй способ его завести. Название кнопки и есть вся новизна — сам
                        механизм в движке тот же. */}
                    <Button variant="ghost" onClick={addException}>
                        Исключение
                    </Button>
                    <Button onClick={add}>
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Новое правило
                    </Button>
                </div>
            </div>

            {/* ДВЕ РАСКЛАДКИ. Таблица из трёх столбцов на телефоне не работала: «кого
                касается» переносилось по слову, а столбец «куда» вместе со всеми действиями
                (выше, ниже, изменить, удалить) уезжал за край экрана — то есть правило нельзя
                было ни переставить, ни удалить, и об этом ничто не сообщало.

                На узком экране правило читается фразой, как и велит дизайн 26.9: что → кому →
                куда, по строке на каждое, а действия — рядом и целиком. Куски строки собраны
                функциями выше: вёрстка, повторённая дважды, разошлась бы на первой же правке. */}
            {spec.channels.length === 0 ? (
                <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground shadow-card lg:rounded-2xl">
                    Правил нет — весь трафик идёт напрямую.
                    <div className="mt-1 text-xs">
                        Правило говорит движку: этот сервис или категорию — вот этим устройствам —
                        через такой outbound.
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
                </div>
            ) : (
                <>
                    <ul className="space-y-2 md:hidden">
                        {spec.channels.map((ch, i) => {
                            const on = ch.enabled !== false
                            return (
                                <li
                                    key={`rule-m-${i}`}
                                    className={`rounded-xl border border-border bg-card p-3 shadow-card ${on ? '' : 'opacity-50'}`}
                                >
                                    {ruleName(ch, i, on)}
                                    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
                                        <span className="text-muted-foreground">для</span>
                                        <span>{whoTextFor(ch)}</span>
                                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        {ruleOut(ch)}
                                    </div>
                                    <div className="mt-1 border-t border-border pt-1">{ruleActions(i)}</div>
                                </li>
                            )
                        })}
                    </ul>

                    <div className="hidden overflow-x-auto rounded-2xl border border-border bg-card shadow-card md:block">
                        <table className="w-full text-sm">
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
                                    const on = ch.enabled !== false
                                    return (
                                        <tr
                                            key={`rule-${i}`}
                                            /* Выключенное приглушено, но НА ВИДУ и на своём месте: спрятанное
                                               правило человек считает удалённым и заводит второе такое же, а
                                               уехавшее вниз меняет порядок, то есть приоритет. */
                                            className={`border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/40 ${on ? '' : 'opacity-50'}`}
                                        >
                                            <td className="px-3 py-2">{ruleName(ch, i, on)}</td>
                                            <td className="px-3 py-2 text-muted-foreground">{whoText(ch)}</td>
                                            <td className="px-3 py-2">{ruleOut(ch)}</td>
                                            <td className="px-3 py-2">{ruleActions(i)}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    )
}
