import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { subsRemember, subsRemembered } from '@/lib/subs'
import Flag from '@/components/Flag'
import { country } from '@/lib/geo'
import { ccFromName, plainName } from '@/lib/nodename'
import { poolsSupported } from '@/lib/engine'
import { ON_FAIL_TEXT, type OnFail, type Output, type Spec, type VlessNode } from '@/lib/model'
import { type Live } from '@/lib/live'

/** Состав выхода: из чего он собран и в каком порядке.
 *
 *  ЧТО ТАКОЕ ВЫХОД. Это то, во что ведёт правило, — не устройство и не узел. Внутри у него
 *  список кандидатов по предпочтению: первый живой забирает трафик, и возврат наверх
 *  происходит сам, когда верхний оживает.
 *
 *  ЧЕГО ЗДЕСЬ ПОКА НЕТ. Смешать в одном выходе локацию подписки и свой туннель нельзя, и это
 *  не наше ограничение: движок выбирает проверку здоровья по виду ВЫХОДА, а не по устройству
 *  (steer, src/failover.c). У выхода kind=interface проверка — ICMP, а через VLESS-туннель
 *  ICMP не ходит принципиально: живая локация в таком списке сразу считалась бы мёртвой, и
 *  трафик уходил бы к следующему кандидату на исправном туннеле. Пока движок не научится
 *  проверять устройство по его владельцу (задача steer T-013), выбор здесь один из двух:
 *  либо свои туннели, либо одна локация подписки. */

interface Sub {
    name: string
    title?: string
    path: string
    present: boolean
}

export default function PoolEditor({
    spec, name, live, onSave, onCancel,
}: {
    spec: Spec
    /** Имя правимого выхода; пусто — заводим новый. */
    name?: string
    live?: Live
    onSave: (next: Spec) => void
    onCancel: () => void
}) {
    /** Умеет ли движок список локаций и смешанный пул. Спрашивается у состояния, а не у
     *  версии: см. lib/engine.ts. */
    const pools = poolsSupported(live?.status ?? null)
    const existing = name ? spec.outputs[name] : undefined
    const [title, setTitle] = useState(name || '')
    const [devices, setDevices] = useState<string[]>(
        existing?.devices?.length ? existing.devices : existing?.device ? [existing.device] : [],
    )
    const [sub, setSub] = useState<string | null>(
        existing?.kind === 'vless' ? existing.sub_file || null : null,
    )
    const [onFail, setOnFail] = useState<OnFail>(existing?.on_fail || 'drop')
    const [tunnels, setTunnels] = useState<{ name: string; up: boolean; kind: string }[]>([])
    /* Перечень подписок начинается с запомненного: пока `sub_list` идёт, список говорил
     * «подписок нет» — утверждение, а не ожидание, и человек успевал ему поверить. */
    const [subs, setSubs] = useState<Sub[]>(() => subsRemembered() ?? [])
    /** Какой узел подписки берём. −1 — «первый рабочий»: выбор делает проверка при подъёме, а
     *  не человек, угадывающий номер. Зашитый номер молча ломается при обновлении подписки. */
    const [picked, setPicked] = useState<number[]>(
        existing?.nodes?.length
            ? existing.nodes
            : typeof existing?.node === 'number' && existing.node >= 0
              ? [existing.node]
              : [],
    )
    /** Узлы подписки глазами движка. Спросить их можно только у ПРИМЕНЁННОГО выхода: до
     *  применения движок про выход ничего не знает, и спрашивать нечего. */
    const [nodes, setNodes] = useState<VlessNode[] | null>(null)

    /* Узлы просим у любого выхода, который уже стоит на ЭТОЙ подписке: движок читает их из
     * её файла, и ответ один на всех, кто в неё смотрит. Свой выход — первый кандидат. */
    const asker = sub
        ? [name, ...Object.keys(spec.outputs)].find(
              (n) => !!n && spec.outputs[n]?.kind === 'vless' && spec.outputs[n]?.sub_file === sub,
          )
        : undefined
    useEffect(() => {
        if (!asker) { setNodes(null); return }
        let stop = false
        rpc.vlessNodes(asker)
            .then((r) => { if (!stop) setNodes(r.nodes || []) })
            .catch(() => { if (!stop) setNodes(null) })
        return () => { stop = true }
    }, [asker])

    useEffect(() => {
        rpc.devices().then((d) => setTunnels(d.devices || [])).catch(() => setTunnels([]))
        rpc.subList()
            .then((r) => { setSubs(r.subs || []); subsRemember(r.subs) })
            /* Старый бэкенд про несколько подписок не знает — тогда единственная известная
             * подписка та, что лежит на своём месте. */
            .catch(() => setSubs([{ name: 'main', path: '/etc/steer/sub.txt', present: true }]))
    }, [])

    /** Устройства, занятые ДРУГИМИ выходами: одно устройство в двух выходах kind=interface —
     *  это две таблицы маршрутизации на один туннель, и вторая молча не работает.
     *
     *  Устройство выхода vless/xsteer сюда НЕ идёт, когда движок понимает смешанный пул: оно
     *  и есть локация, которую в пул кладут. Проба здоровья и masquerade решаются по владельцу
     *  устройства, а не по виду выхода, который его назвал (контракт steer T-015). */
    const taken = new Set(
        Object.entries(spec.outputs)
            .filter(([n, o]) => n !== name && (o.kind === 'interface' || !pools))
            .flatMap(([, o]) => (o.devices?.length ? o.devices : o.device ? [o.device] : [])),
    )

    /* Подписка и устройства исключают друг друга, и на новом движке тоже: выход бывает либо
     * kind=vless (подписка и номера локаций), либо kind=interface (список устройств). Смешанный
     * пул собирается ВТОРЫМ способом — устройство уже заведённой локации кладётся в список
     * рядом с wg0, — а не третьей формой спеки. */
    function toggleDev(dev: string) {
        setSub(null)
        setDevices((d) => (d.includes(dev) ? d.filter((x) => x !== dev) : [...d, dev]))
    }

    function pickSub(path: string) {
        setDevices([])
        setSub((s) => (s === path ? null : path))
    }

    function toggleNode(idx: number) {
        setPicked((p) =>
            p.includes(idx) ? p.filter((x) => x !== idx) : pools ? [...p, idx] : [idx],
        )
    }

    function moveNode(i: number, d: number) {
        const j = i + d
        if (j < 0 || j >= picked.length) return
        const next = picked.slice()
        ;[next[i], next[j]] = [next[j], next[i]]
        setPicked(next)
    }

    function move(i: number, d: number) {
        const j = i + d
        if (j < 0 || j >= devices.length) return
        const next = devices.slice()
        ;[next[i], next[j]] = [next[j], next[i]]
        setDevices(next)
    }

    function save() {
        const n = title.trim()
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(n)) {
            notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning')
            return
        }
        if (n !== name && spec.outputs[n]) {
            notify(`Выход «${n}» уже есть`, 'warning')
            return
        }
        if (!sub && devices.length === 0) {
            notify('Выберите, через что выходить', 'warning')
            return
        }
        const out: Output = sub
            ? {
                  name: n,
                  kind: 'vless',
                  sub_file: sub,
                  /* ОДНА форма из двух: спеку с `node` и `nodes` разом движок отвергает
                   * целиком. Список — только там, где движок его понимает; иначе выбранная
                   * локация уезжает единственным номером, и молчаливой подмены узла не
                   * происходит. */
                  ...(pools && picked.length > 1
                      ? { nodes: picked }
                      : { node: picked.length ? picked[0] : -1 }),
                  on_fail: onFail,
              }
            : { name: n, kind: 'interface', devices, device: devices[0], on_fail: onFail }
        const outputs: Record<string, Output> = {}
        for (const [k, v] of Object.entries(spec.outputs)) if (k !== name) outputs[k] = v
        outputs[n] = out
        /* Переименование уводит за собой правила: канал ведёт в ИМЯ выхода, и оставить их
         * указывать на прежнее значит осиротить каждое. */
        const channels =
            name && n !== name
                ? spec.channels.map((c) => (c.out === name ? { ...c, out: n } : c))
                : spec.channels
        onSave({ ...spec, outputs, channels })
    }

    function remove() {
        if (!name) return
        const used = spec.channels.filter((c) => c.out === name).map((c) => c.name)
        if (used.length) {
            notify(`Выход «${name}» занят правилами: ${used.join(', ')}`, 'warning')
            return
        }
        const outputs = { ...spec.outputs }
        delete outputs[name]
        onSave({ ...spec, outputs })
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <input
                    value={title}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                    placeholder="имя выхода"
                    aria-label="имя выхода"
                    className="h-[38px] min-w-[12rem] rounded-lg border border-border bg-background px-3 text-sm"
                />
                <div className="flex gap-2">
                    {name && (
                        <Button variant="destructive" onClick={remove}>
                            <Trash2 className="h-4 w-4" aria-hidden="true" /> Удалить
                        </Button>
                    )}
                    <Button variant="secondary" onClick={onCancel}>
                        <X className="h-4 w-4" aria-hidden="true" /> Отмена
                    </Button>
                    <Button onClick={save}>
                        <Check className="h-4 w-4" aria-hidden="true" /> Сохранить выход
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <Card>
                    <CardHeader>
                        <CardTitle>Что можно взять</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div>
                            <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                Подписки
                            </div>
                            <ul className="mt-2 space-y-1">
                                {subs.length === 0 && (
                                    <li className="text-xs text-muted-foreground">подписок нет</li>
                                )}
                                {subs.map((s) => (
                                    <li key={s.path}>
                                        <button
                                            type="button"
                                            onClick={() => pickSub(s.path)}
                                            className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary ${
                                                sub === s.path ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                                            }`}
                                        >
                                            <span
                                                className={`h-4 w-4 shrink-0 rounded-full border ${
                                                    sub === s.path
                                                        ? 'border-[5px] border-primary'
                                                        : 'border-input'
                                                }`}
                                                aria-hidden="true"
                                            />
                                            <span className="min-w-0 flex-1 truncate font-medium">
                                                {s.title || s.name}
                                            </span>
                                            {!s.present && (
                                                <span className="shrink-0 text-[11px] text-warning-fg">
                                                    не скачана
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        <div>
                            <div className="sp-label uppercase tracking-wide text-muted-foreground">
                                Свои туннели
                            </div>
                            <ul className="mt-2 space-y-1">
                                {tunnels.length === 0 && (
                                    <li className="text-xs text-muted-foreground">
                                        туннельных устройств нет
                                    </li>
                                )}
                                {tunnels.map((t) => {
                                    const on = devices.includes(t.name)
                                    const busy = taken.has(t.name)
                                    /* Чьё это устройство: у локации подписки его создаёт сам
                                     * движок, и человеку оно известно именем выхода. */
                                    const owner = Object.entries(spec.outputs).find(
                                        ([n, o]) =>
                                            n !== name &&
                                            o.kind !== 'interface' &&
                                            (o.device === t.name || o.devices?.includes(t.name)),
                                    )?.[0]
                                    return (
                                        <li key={t.name}>
                                            <button
                                                type="button"
                                                disabled={busy && !on}
                                                onClick={() => toggleDev(t.name)}
                                                className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${
                                                    on ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                                                }`}
                                            >
                                                <span
                                                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                                        on
                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                            : 'border-input'
                                                    }`}
                                                    aria-hidden="true"
                                                >
                                                    {on && <Check className="h-3 w-3" />}
                                                </span>
                                                <span className="min-w-0 flex-1 truncate font-medium">
                                                    {t.name}
                                                </span>
                                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                                    {busy && !on
                                                        ? 'занято другим выходом'
                                                        : owner || t.kind}
                                                </span>
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>{sub ? 'Локации' : 'Порядок предпочтения'}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {sub ? (
                                <ul className="space-y-1">
                                    <li>
                                        <button
                                            type="button"
                                            onClick={() => setPicked([])}
                                            className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary ${
                                                picked.length === 0 ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                                            }`}
                                        >
                                            <span
                                                className={`h-4 w-4 shrink-0 rounded-full border ${
                                                    picked.length === 0
                                                        ? 'border-[5px] border-primary'
                                                        : 'border-input'
                                                }`}
                                                aria-hidden="true"
                                            />
                                            <span className="font-medium">любая рабочая</span>
                                        </button>
                                    </li>
                                    {/* Выбранные — сверху и по порядку: порядок здесь и есть
                                        предпочтение, как у устройств выхода.

                                        ТОЛЬКО У ДВИЖКА, КОТОРЫЙ УМЕЕТ ПУЛ. Старый берёт одну
                                        локацию (`node`), и порядок предпочтения на нём —
                                        обещание, которого никто не исполнит. */}
                                    {pools && picked.map((idx, i) => {
                                        const nd = (nodes || []).find((x) => x.index === idx)
                                        const cc = ccFromName(nd?.name)
                                        return (
                                            <li
                                                key={`p${idx}`}
                                                className="flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-2"
                                            >
                                                <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                                                    {i + 1}
                                                </span>
                                                <Flag cc={cc} />
                                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                                    {plainName(nd?.name) || `узел ${idx + 1}`}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => moveNode(i, -1)}
                                                    aria-label={`локация ${i + 1} выше`}
                                                    className="sp-row bg-transparent p-0 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ArrowUp className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => moveNode(i, 1)}
                                                    aria-label={`локация ${i + 1} ниже`}
                                                    className="sp-row bg-transparent p-0 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ArrowDown className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => toggleNode(idx)}
                                                    aria-label={`убрать локацию ${i + 1}`}
                                                    className="sp-row bg-transparent p-0 text-muted-foreground hover:text-destructive"
                                                >
                                                    <X className="h-4 w-4" />
                                                </button>
                                            </li>
                                        )
                                    })}
                                    {/* КВАДРАТНАЯ ГАЛОЧКА ТОЛЬКО ТАМ, ГДЕ ЛОКАЦИЙ МОЖНО ВЗЯТЬ
                                        НЕСКОЛЬКО. Список локаций понимает не всякий движок:
                                        старый берёт ровно одну (`node`), и вторая галочка на
                                        нём не ставится, а переезжает — человек нажимает и
                                        видит, как отметка «перепрыгивает» с локации на
                                        локацию, ничего об этом не узнав. Форма отметки теперь
                                        говорит правду сама: круг — выбор одной из, квадрат —
                                        набор. Объяснять словами нечего, а починить по-другому
                                        нельзя: пул, записанный в спеку, старый движок молча
                                        пропустит и повезёт трафик не туда. */}
                                    {(nodes || [])
                                        .filter((nd) => !pools || !picked.includes(nd.index))
                                        .map((nd) => {
                                            const cc = ccFromName(nd.name)
                                            /* У движка без пула выбрана ровно одна локация — та,
                                             * которая и уедет в спеку (см. save). */
                                            const chosen = !pools && picked[0] === nd.index
                                            return (
                                                <li key={nd.index}>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleNode(nd.index)}
                                                        className={`flex w-full items-center gap-2.5 rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary ${
                                                            chosen ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                                                        }`}
                                                    >
                                                        <span
                                                            className={
                                                                pools
                                                                    ? 'h-4 w-4 shrink-0 rounded border border-input'
                                                                    : `h-4 w-4 shrink-0 rounded-full border ${
                                                                          chosen ? 'border-[5px] border-primary' : 'border-input'
                                                                      }`
                                                            }
                                                            aria-hidden="true"
                                                        />
                                                        <Flag cc={cc} />
                                                        <span className="min-w-0 flex-1 truncate">
                                                            {plainName(nd.name) || `узел ${nd.index + 1}`}
                                                        </span>
                                                        <span className="shrink-0 text-[11px] text-muted-foreground">
                                                            {country(cc)}
                                                        </span>
                                                    </button>
                                                </li>
                                            )
                                        })}
                                    {nodes === null && (
                                        <li className="px-2.5 text-xs text-muted-foreground">
                                            узлы появятся после «Применить»
                                        </li>
                                    )}
                                </ul>
                            ) : devices.length === 0 ? (
                                <p className="text-xs text-muted-foreground">ничего не выбрано</p>
                            ) : (
                                <ul className="space-y-1.5">
                                    {devices.map((d, i) => (
                                        <li
                                            key={d}
                                            className="flex items-center gap-2 rounded-xl border border-border p-2"
                                        >
                                            <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                                                {i + 1}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                                {d}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => move(i, -1)}
                                                aria-label={`${d} выше`}
                                                className="sp-row bg-transparent p-0 text-muted-foreground hover:text-foreground"
                                            >
                                                <ArrowUp className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => move(i, 1)}
                                                aria-label={`${d} ниже`}
                                                className="sp-row bg-transparent p-0 text-muted-foreground hover:text-foreground"
                                            >
                                                <ArrowDown className="h-4 w-4" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Если всё упало</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-1.5">
                            {(['drop', 'direct', 'zapret'] as OnFail[]).map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setOnFail(v)}
                                    className={`flex w-full items-center gap-2.5 select-none rounded-lg bg-transparent px-2.5 py-2 text-left text-[13px] focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary ${
                                        onFail === v ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                                    }`}
                                >
                                    <span
                                        className={`h-4 w-4 shrink-0 rounded-full border ${
                                            onFail === v ? 'border-[5px] border-primary' : 'border-input'
                                        }`}
                                        aria-hidden="true"
                                    />
                                    {ON_FAIL_TEXT[v]}
                                </button>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
