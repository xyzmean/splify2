import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, LoaderCircle, Play, Plus, RefreshCw, Square, Waves } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { rpc, type ZapretFamily, type ZapretResults, type ZapretSet } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'
import { cacheGet, cacheSet } from '@/lib/cache'
import { pending } from '@/lib/pending'
import { type Output, type Spec } from '@/lib/model'

/** Zapret: обход DPI своей стратегией — на весь роутер или на отдельное правило.
 *
 *  ЧТО ЗДЕСЬ ГЛАВНОЕ, кроме списка. Стратегия, которая открывает YouTube, — не та, что
 *  открывает Discord, и не та, что нужна играм; а выбрать до сих пор можно было ровно одну,
 *  на весь роутер. Поэтому у стратегии два места применения: весь роутер (как у Zapret
 *  Manager, чтобы выбранное здесь читалось и там) и ВЫХОД kind=zapret — тогда правило «эти
 *  домены — сюда» значит «эти домены — через эту настройку обхода».
 *
 *  ПРОВЕРКА ИДЁТ В ФОНЕ, и это требование владельца, а не удобство: окно роутера можно
 *  закрыть, проверка доработает и запишет результат, а при следующем открытии числа стоят
 *  напротив каждой стратегии. Поэтому здесь нет «прогресса в памяти страницы» — есть опрос
 *  файла хода, который пишет фоновый процесс.
 *
 *  И проверка НЕ ТРОГАЕТ пользовательский трафик: она поднимает свой обработчик на своей
 *  очереди и отдаёт в неё только свои же запросы (по диапазону исходящих портов). Стратегия,
 *  которая работает у человека, продолжает работать всю проверку — в отличие от того, как это
 *  устроено в самом менеджере, где на время проверки всей сети достаётся то одна случайная
 *  стратегия, то другая.
 *
 *  СПИСОК — СЕМЕЙСТВАМИ ПОД СПОЙЛЕРАМИ, И ПРОВЕРЯЕТСЯ ТО, ЧТО НАЗВАНО. Полсотни строк одним
 *  столбом не читались; хуже, ряд кнопок «все · Flowseal · v · YouTube» стоял здесь дважды —
 *  один фильтровал список, другой выбирал набор для проверки, — и человек, нажав в списке
 *  «Flowseal», получал проверку всех 58 (снято с живого роутера). Теперь семейство — одна
 *  строка-заголовок со своей кнопкой проверки, у каждой стратегии — своя, а общая «Проверить»
 *  честно называется проверкой всех. У развёрнутой стратегии видны её ключи и то, какие
 *  именно сайты с ней открылись: число «14/18» само по себе не говорит, YouTube это или
 *  госуслуги.
 *
 *  КОМПОНОВКА — ЧЕТЫРЕ КАРТОЧКИ, А НЕ ШЕСТЬ, и не равного веса. Прежде вкладка была столбом из
 *  шести одинаковых карточек с абзацем пояснений в каждой, и владелец назвал это хаосом: «куда
 *  применить» и «стратегии» — один выбор, разнесённый по двум карточкам; проверка и её кнопка
 *  «Проверить» стояли в третьей, отдельно от списка, который она заполняет числами. Теперь:
 *    - «Обход DPI» — состояние и служебные кнопки, одной строкой;
 *    - «Стратегия» — место применения (весь роутер и выходы обхода — кнопками в ряд, там же
 *      заводится новый выход), под ним список семейств, а «Проверить» и ход проверки — в
 *      шапке этого же списка: проверка существует ради чисел в нём;
 *    - «Автоподбор» — кнопка, приговор и расписание;
 *    - «Игровой фильтр» — как был, только короче.
 *  На широком экране список стратегий — правая, широкая колонка; остальное — левая, узкая:
 *  список длинный и живёт прокруткой, а три остальные карточки короткие и читаются сверху
 *  вниз. На узком экране всё в один столбец в том же порядке чтения. Пояснения ужаты до
 *  строки: длинный абзац над каждой кнопкой читался как предупреждение, а не как подсказка. */

const FAMILY: Record<ZapretFamily, string> = {
    flowseal: 'Flowseal',
    v: 'v',
    yv: 'YouTube',
    other: 'другие',
}
const FAMILY_ORDER: ZapretFamily[] = ['flowseal', 'v', 'yv', 'other']
/** Семейство → набор целей, которым его меряет проверка (см. splify2-zapret-test, zt_set_of). */
const SET_OF: Record<ZapretFamily, ZapretSet> = {
    flowseal: 'general', v: 'general', yv: 'youtube', other: 'general',
}
const SET_NAME: Record<ZapretSet, string> = { general: 'общий набор', youtube: 'YouTube' }
/** Сроки расписания. Ноль первым — «не надо» это умолчание, и оно обязано быть видно как
 *  выбранное, а не как отсутствие выбора. Значения редкие нарочно: подбор гоняет три десятка
 *  запросов на каждую из полусотни стратегий, и делать это чаще раза в неделю незачем —
 *  каталог стратегий у автора меняется не быстрее. */
const AUTO_EVERY = [0, 7, 30] as const

function ago(ts: number): string {
    if (!ts) return 'ни разу'
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
    if (s < 90) return 'только что'
    if (s < 5400) return `${Math.round(s / 60)} мин назад`
    if (s < 172800) return `${Math.round(s / 3600)} ч назад`
    return `${Math.round(s / 86400)} сут назад`
}

/** Число проверки для стратегии: удач, целей и контрольное «без обхода» её набора.
 *  Файл постарше наборов не знает — тогда верхние числа, они и были про общий набор. */
function scoreOf(res: ZapretResults | null, name: string, family: ZapretFamily) {
    const r = res?.results.find((x) => x.name === name)
    if (!r) return undefined
    const set = r.set || SET_OF[family]
    const s = res?.sets?.[set]
    return {
        ok: r.ok,
        total: r.total ?? s?.total ?? res?.targets ?? 0,
        baseline: s?.baseline ?? res?.baseline ?? 0,
        set,
        opened: r.opened,
        targets: s?.targets,
        baseOpened: s?.opened,
    }
}

export default function Zapret() {
    /* Рисуется С ЗАПОМНЕННОГО: zapret_state спрашивает у пакетного менеджера версию, и это
     * секунды на роутере — всё это время вкладка стояла с одним словом «Загрузка…». Снимок
     * прошлого открытия показывает каталог сразу, свежее приезжает следом. */
    type St = Awaited<ReturnType<typeof rpc.zapretState>>
    type Cat = Awaited<ReturnType<typeof rpc.zapretStrategies>>
    const [st, setStRaw] = useState<St | null>(() => cacheGet<St>('zapret:state'))
    const [cat, setCatRaw] = useState<Cat | null>(() => cacheGet<Cat>('zapret:cat'))
    const [res, setResRaw] = useState<ZapretResults | null>(() => cacheGet<ZapretResults>('zapret:res'))
    const setSt = (v: St | null) => { setStRaw(v); if (v) cacheSet('zapret:state', v) }
    const setCat = (v: Cat | null) => { setCatRaw(v); if (v) cacheSet('zapret:cat', v) }
    const setRes = (v: ZapretResults | null) => { setResRaw(v); if (v) cacheSet('zapret:res', v) }
    const [test, setTest] = useState<Awaited<ReturnType<typeof rpc.zapretTest>> | null>(null)
    /** Автоподбор: состояние, рейтинг и приговор одним ответом. Не кэшируется в отличие от
     *  каталога: «можно ли откатиться» и «идёт ли подбор» — сведения, которые устаревают за
     *  минуты, и показать их из снимка прошлого открытия значило бы предложить откат, которого
     *  уже нет. */
    const [auto, setAuto] = useState<Awaited<ReturnType<typeof rpc.zapretAutoselect>> | null>(null)
    const [busy, setBusy] = useState('')
    /** Куда применять выбранное: пусто — весь роутер, иначе имя выхода kind=zapret. */
    const [target, setTarget] = useState('')
    /** Развёрнутые семейства. По умолчанию открыто то, где применённая стратегия: за ним и
     *  пришли; остальное — по нажатию. */
    const [openFam, setOpenFam] = useState<Partial<Record<ZapretFamily, boolean>> | null>(null)
    /** Развёрнутая стратегия и её ключи (грузятся по запросу). */
    const [openRow, setOpenRow] = useState('')
    const [opts, setOpts] = useState<Record<string, string[] | null>>({})
    /** Имя нового выхода. Заводится ЗДЕСЬ, а не в общем редакторе выходов, и это не про
     *  удобство: у выхода обхода нет устройства вовсе, а без стратегии он не значит ничего —
     *  стратегии же живут тут. */
    const [newOut, setNewOut] = useState('')
    /** Форма нового выхода развёрнута. Свёрнута по умолчанию: выход заводят один раз, а поле
     *  ввода с абзацем пояснения при каждом открытии вкладки читалось как незаконченная
     *  настройка. */
    const [adding, setAdding] = useState(false)

    const reloadState = useCallback(
        () => Promise.all([
            rpc.zapretState().then(setSt).catch(() => setStRaw(null)),
            rpc.zapretStrategies().then(setCat).catch(() => setCatRaw(null)),
            rpc.zapretResults().then(setRes).catch(() => setResRaw(null)),
            rpc.zapretAutoselect().then(setAuto).catch(() => setAuto(null)),
        ]).then(() => undefined),
        [],
    )

    useEffect(() => { void reloadState() }, [reloadState])

    /* Ход проверки опрашивается ТОЛЬКО пока она идёт, и опрашивается дешёвым методом: он
     * читает один файл в /var и ничего больше. Как только проверка закончилась — забираем
     * результаты один раз и опрос прекращаем. */
    const wasRunning = useRef(false)
    useEffect(() => {
        let alive = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const tick = () => {
            rpc.zapretTest()
                .then((r) => {
                    if (!alive) return
                    setTest(r)
                    if (wasRunning.current && !r.running) {
                        /* Проверка только что закончилась — забрать числа. */
                        void rpc.zapretResults().then(setRes).catch(() => undefined)
                    }
                    wasRunning.current = r.running
                    /* Подбор идёт минуты и заканчивается сам — значит его состояние надо
                     * перечитывать, пока он идёт, ровно как ход проверки. Отдельного цикла
                     * для этого нет: подбор ГОНЯЕТ проверку, поэтому пока «идёт проверка»,
                     * этот круг уже частый, а по её окончании нужен ещё один вопрос — не
                     * применилось ли что-нибудь. */
                    void rpc.zapretAutoselect().then(setAuto).catch(() => undefined)
                    timer = setTimeout(tick, r.running ? 2000 : 15000)
                })
                .catch(() => { if (alive) timer = setTimeout(tick, 15000) })
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
    }, [])

    async function act(what: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
        if (busy) return
        setBusy(what)
        try {
            const r = await fn()
            if (!r.ok) throw new Error(r.error || t('не получилось'))
            notify(done)
            await reloadState()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    /** Запустить проверку набора: все, семейство или одна стратегия. Ход подхватит опрос выше
     *  на следующем круге; чтобы «идёт» появилось сразу, а не через две секунды, ход спрашивается
     *  здесь же. */
    async function startTest(scope: string) {
        await act('test', () => rpc.zapretTestStart(scope), t('Проверка запущена'))
        rpc.zapretTest().then((r) => { setTest(r); wasRunning.current = r.running }).catch(() => undefined)
    }

    /** Подобрать и применить. Ход подхватит общий опрос; чтобы «подбираю…» появилось сразу,
     *  состояние спрашивается здесь же. */
    async function startAuto(scope: string) {
        await act('auto', () => rpc.zapretAutoselectStart(scope), t('Подбор запущен'))
        rpc.zapretAutoselect().then(setAuto).catch(() => undefined)
    }

    function toggleRow(name: string) {
        const next = openRow === name ? '' : name
        setOpenRow(next)
        if (next && opts[next] === undefined) {
            rpc.zapretStrategy(next)
                .then((r) => setOpts((m) => ({ ...m, [next]: r.opts || [] })))
                .catch(() => setOpts((m) => ({ ...m, [next]: null })))
        }
    }

    /** Завести выход kind=zapret в спеке.
     *
     *  Правка уходит в черновик (lib/pending), а не применяется сама: это изменение
     *  МАРШРУТИЗАЦИИ, и применяет его та же плавающая пилюля, что и остальные правки спеки.
     *  Своё «Применить» здесь означало бы второй способ применять спеку. */
    async function addOutput() {
        const n = newOut.trim()
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(n)) {
            notify(t('Имя: латиница, цифры, дефис или подчёркивание'), 'warning')
            return
        }
        setBusy('newout')
        try {
            const spec: Spec = await pending.load()
            if (spec.outputs[n]) throw new Error(`${t('Выход уже есть')}: ${n}`)
            const out: Output = { name: n, kind: 'zapret', on_fail: 'drop' }
            pending.edit({ ...spec, outputs: { ...spec.outputs, [n]: out } })
            setNewOut('')
            /* Выход обязан появиться в списке «Куда применить» СРАЗУ, а не после «Применить»
               (владелец: «новый выход должен появиться тут по нажатию «Завести выход»»).
               Список строит бэкенд по сохранённой спеке, а правка уезжает туда через
               полсекунды тишины — значит дождаться записи, потом перечитать. И сразу выбрать
               новый выход местом применения: за стратегией для него человек и пришёл. */
            await pending.flush()
            await reloadState()
            setTarget(n)
            setAdding(false)
            notify(`${t('Выход заведён')}: ${n}. ${t('Выберите ему стратегию ниже; заработает после «Применить»')}`)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    if (!st) return <div className="p-5 text-sm text-muted-foreground">{t('Загрузка…')}</div>

    if (!st.installed) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Waves className="h-4 w-4" aria-hidden="true" />
                        {t('Обход DPI')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="text-sm">
                        {t('Zapret не установлен. Он ставится по желанию: обход нужен не всем, а весит около полумегабайта.')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                        {t('Пакет — из релизов remittor/zapret-openwrt, стратегии — из Zapret Manager и Flowseal.')}
                    </div>
                    <Button
                        disabled={busy !== ''}
                        onClick={() => void act('install', () => rpc.zapretInstall(), t('Обход DPI установлен'))}
                    >
                        {busy === 'install' ? t('ставлю…') : t('Установить обход DPI')}
                    </Button>
                </CardContent>
            </Card>
        )
    }

    const outs = cat?.outputs || []
    const all = cat?.strategies || []
    const running = test?.running === true
    /* Что применено в выбранном месте: у роутера — отметка из /etc/config/zapret (её же
       ставит Zapret Manager), у выхода — заголовок его файла ключей. */
    const applied = target
        ? (outs.find((o) => o.name === target)?.strategy || '')
        : st.active
    const appliedFam = all.find((s) => s.name === applied)?.family
    const isOpen = (f: ZapretFamily) => (openFam ? !!openFam[f] : f === appliedFam)
    const toggleFam = (f: ZapretFamily) =>
        setOpenFam((m) => {
            const base = m ?? Object.fromEntries(FAMILY_ORDER.map((x) => [x, x === appliedFam]))
            return { ...base, [f]: !base[f] }
        })
    const families = FAMILY_ORDER.filter((f) => all.some((s) => s.family === f))
    const testable = st.curl && st.strategies > 0 && !running && busy === ''
    const targetOut = target ? outs.find((o) => o.name === target) : undefined

    /** Кнопка места применения. Имя крупно, применённая стратегия мелко под ним: за этой
     *  парой человек и смотрит на ряд — «что где стоит». Отметки состояния (выключен, не
     *  применён, обработчик не запущен, изменилась в каталоге) — там же, третьей строкой
     *  не нужны: их одна-две и они короткие. */
    const chip = (key: string, on: boolean, name: string, sub: string, notes: React.ReactNode[]) => (
        <button
            key={key}
            type="button"
            onClick={() => setTarget(key)}
            aria-pressed={on}
            className={[
                'flex min-w-0 max-w-full flex-col items-start rounded-xl border px-3 py-1.5 text-left',
                'transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                on ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
            ].join(' ')}
        >
            <span className={`text-sm ${on ? 'font-medium text-primary' : ''}`}>{name}</span>
            <span className="flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <span>{sub}</span>
                {/* Разделитель — своим элементом, а не приклеенным к слову: отметка должна
                    оставаться отдельным текстом, по которому её находят и глазом, и стендом. */}
                {notes.filter(Boolean).map((n, i) => (
                    <span key={i} className="flex items-center gap-x-1.5">
                        <span aria-hidden="true">·</span>
                        {n}
                    </span>
                ))}
            </span>
        </button>
    )

    /* Ряды сетки — auto, auto, 1fr, а не равные: карточка стратегий тянется на три ряда, и без
     * явных размеров её высота делилась между рядами поровну — три левые карточки расползались
     * по высоте списка с пустотой между ними (владелец, со скрина). Первые два ряда — по
     * содержимому левых карточек, остаток отдаётся третьему. */
    return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] xl:grid-rows-[auto_auto_1fr] xl:items-start">
            {/* ---- состояние ------------------------------------------------------------ */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Waves className="h-4 w-4" aria-hidden="true" />
                        <span className="flex-1">{t('Обход DPI')}</span>
                        {/* Три состояния, а не два: «выключен» — решение человека (кнопка у
                            места «Весь роутер»), «не запущен» — поломка. */}
                        <span className="text-sm font-normal">
                            {st.running
                                ? <span className="text-success">{t('работает')}</span>
                                : !st.enabled
                                    ? <span className="text-muted-foreground">{t('выключен')}</span>
                                    : <span className="text-warning-fg">{t('не запущен')}</span>}
                        </span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {st.version && <span>{st.version}</span>}
                        <span>{t('стратегий')}: {st.strategies}</span>
                        <span>{t('каталог обновлён')}: {ago(st.updated)}</span>
                    </div>
                    {/* Каталог обновляется сам раз в сутки, и обновление НЕ ТРОГАЕТ активную
                        стратегию — иначе правка у автора меняла бы работающий роутер ночью, с
                        перезапуском обхода. Поэтому расхождение показывается, а решение
                        остаётся человеку. */}
                    {st.drifted && (
                        <div className="rounded-lg bg-accent px-3 py-2 text-xs text-muted-foreground">
                            {t('Выбранная стратегия в каталоге изменилась. Ночное обновление её не подменяет — примените заново, если хотите новую версию.')}
                        </div>
                    )}
                    {!st.curl && (
                        <div className="text-xs text-warning-fg">
                            {t('нет curl — проверять стратегии нечем')}
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== ''}
                            onClick={() => void act('sync', () => rpc.zapretSync(), t('Каталог обновлён'))}
                        >
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                            {busy === 'sync' ? t('обновляю…') : t('Обновить каталог')}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy !== '' || running}
                            onClick={() => void act('remove', () => rpc.zapretRemove(), t('Обход DPI удалён'))}
                        >
                            {t('Удалить обход')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* ---- стратегия: куда и какую ---------------------------------------------- */}
            <Card className="xl:col-start-2 xl:row-start-1 xl:row-span-3">
                <CardHeader>
                    <CardTitle className="text-base">{t('Стратегия')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    {/* Места применения — в ряд, а не столбиком: их два-три, и выбор между ними
                        читается как переключатель, которым он и является. */}
                    <div className="flex flex-wrap items-stretch gap-2">
                        {chip(
                            '',
                            target === '',
                            t('Весь роутер'),
                            st.active || t('стратегия не отмечена'),
                            [!st.enabled && <span key="off" className="rounded bg-accent px-1.5 py-0.5">{t('выключен')}</span>],
                        )}
                        {outs.map((o) => chip(
                            o.name,
                            target === o.name,
                            `${t('выход')} ${o.name}`,
                            o.strategy || t('нет стратегии'),
                            [
                                /* Не применённый выход — не поломка: его обработчик и не должен
                                   быть запущен, пока спеку не применили. Предупреждение оставлено
                                   тому, что применено и всё равно не поднялось. */
                                !o.up && (
                                    pending.applied && !pending.applied.outputs?.[o.name]
                                        ? <span key="down">{t('не применён')}</span>
                                        : <span key="down" className="text-warning-fg">{t('обработчик не запущен')}</span>
                                ),
                                /* То же расхождение, что у стратегии всего роутера, и по той же
                                   причине: ночное обновление каталога файл ключей выхода не
                                   трогает. */
                                o.drifted && <span key="drift" className="text-warning-fg">{t('изменилась в каталоге')}</span>,
                            ],
                        ))}
                        {/* Завести выход — здесь же, потому что иначе «стратегия только для
                            YouTube» остаётся недостижимой: выход есть куда применить, а завести
                            его негде. Правило в него человек создаёт во вкладке «Правила». */}
                        <button
                            type="button"
                            onClick={() => setAdding((v) => !v)}
                            aria-expanded={adding}
                            className={[
                                'flex items-center gap-1 rounded-xl border border-dashed px-3 py-1.5 text-sm text-muted-foreground',
                                'transition-colors duration-200 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                adding ? 'border-primary text-primary' : 'border-border',
                            ].join(' ')}
                        >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('новый выход')}
                        </button>
                    </div>

                    {/* Строка о выбранном месте: у роутера — выключатель службы; выключается
                        служба, а не стирается стратегия: отметка остаётся, Zapret Manager видит
                        своё, а выходы обхода (свои обработчики) продолжают работать. Выключатель
                        стоит РЯДОМ с местом применения, а не в шапке: вопрос человека — «как
                        отключить стратегию на весь роутер», и ответ должен быть там, где эта
                        стратегия названа. */}
                    {target === '' && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy !== ''}
                                onClick={() => void act(
                                    'enable',
                                    () => rpc.zapretEnable(!st.enabled),
                                    st.enabled ? t('Обход на весь роутер выключен') : t('Обход на весь роутер включён'),
                                )}
                            >
                                {busy === 'enable' ? '…' : st.enabled ? t('Выключить обход') : t('Включить обход')}
                            </Button>
                            {!st.enabled && (
                                <span>
                                    {t('Стратегия выше не действует, а выходы обхода работают своими обработчиками. «Применить» стратегию всему роутеру включит его обратно.')}
                                </span>
                            )}
                        </div>
                    )}
                    {targetOut && !targetOut.up && pending.applied && !pending.applied.outputs?.[targetOut.name] && (
                        <div className="text-xs text-muted-foreground">
                            {t('Выход заведён, но ещё не применён: заработает после «Применить».')}
                        </div>
                    )}

                    {adding && (
                        <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    value={newOut}
                                    onChange={(e) => setNewOut(e.currentTarget.value)}
                                    placeholder={t('имя нового выхода')}
                                    aria-label={t('имя нового выхода')}
                                    className="h-9 min-w-[10rem] flex-1 rounded-lg border border-border bg-background px-3 text-sm"
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy !== '' || newOut.trim() === ''}
                                    onClick={() => void addOutput()}
                                >
                                    {t('Завести выход')}
                                </Button>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {t('Выход — это то, во что ведёт правило. Заведите его, выберите ему стратегию ниже, а правило «эти домены — сюда» создайте во вкладке «Правила». Заработает после «Применить».')}
                            </div>
                        </div>
                    )}

                    {/* ---- список --------------------------------------------------------- */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                        <h3 className="sp-sub">
                            {t('Стратегии')}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                {target ? `${t('для выхода')} ${target}` : t('для всего роутера')}
                            </span>
                        </h3>
                        {/* «Проверить» — в шапке списка, а не в отдельной карточке: проверка
                            существует ради чисел напротив стратегий, и кнопка должна стоять над
                            ними. Семейство или одну — кнопками в самом списке. */}
                        {!running && (
                            <Button
                                size="sm"
                                disabled={busy !== '' || !st.curl || st.strategies === 0}
                                onClick={() => void startTest('all')}
                            >
                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('Проверить')}
                            </Button>
                        )}
                    </div>
                    {running ? (
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <span>
                                    {test?.state === 'starting'
                                        ? t('собираю цели…')
                                        : `${t('стратегия')} ${test?.done ?? 0} ${t('из')} ${test?.total ?? 0}${test?.current ? ` · ${test.current}` : ''}`}
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy !== ''}
                                    onClick={() => void act('stop', () => rpc.zapretTestStop(), t('Проверка остановлена'))}
                                >
                                    <Square className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('Остановить')}
                                </Button>
                            </div>
                            {/* Полоса, а не проценты числом: доля от полусотни шагов читается
                                глазом быстрее, чем «14%». */}
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
                                <div
                                    className="h-full bg-primary transition-all duration-500"
                                    style={{
                                        width: `${Math.round(
                                            (100 * (test?.done ?? 0)) / Math.max(1, test?.total ?? 1),
                                        )}%`,
                                    }}
                                />
                            </div>
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {t('Проверка идёт в фоне — окно можно закрыть. Ваш трафик она не трогает: стратегия работает как обычно.')}
                        </p>
                    )}
                    {test?.state === 'error' && test.error_text && (
                        <div className="text-xs text-destructive">{test.error_text}</div>
                    )}
                    {/* Без числа «без обхода» результат не значит ничего: «30 из 54» может быть
                        и отличным, и никаким — смотря сколько открывается без обхода вовсе. */}
                    {res && res.at > 0 && (
                        <p className="text-xs text-muted-foreground">
                            {t('последняя проверка')}: {ago(res.at)}
                            {res.sets && Object.keys(res.sets).length ? (
                                (['general', 'youtube'] as ZapretSet[])
                                    .filter((k) => res.sets?.[k])
                                    .map((k) => (
                                        <span key={k}>
                                            {' · '}{SET_NAME[k]}: {t('целей')} {res.sets![k]!.total},{' '}
                                            {t('без обхода открылось')} {res.sets![k]!.baseline}
                                        </span>
                                    ))
                            ) : (
                                <>
                                    {' · '}{t('целей')} {res.targets} · {t('без обхода открылось')} {res.baseline}
                                </>
                            )}
                            {' · '}
                            <span className="text-success">{t('зелёное')}</span> — {t('больше, чем без обхода')},{' '}
                            <span className="text-warning-fg">{t('жёлтое')}</span> — {t('меньше')}.
                        </p>
                    )}
                    {all.length === 0 && (
                        <div className="py-3 text-sm text-muted-foreground">
                            {t('Каталог пуст — обновите его.')}
                        </div>
                    )}
                    <div className="space-y-1">
                        {families.map((fam) => {
                            const list = all.filter((s) => s.family === fam)
                            const open = isOpen(fam)
                            /* Лучшее число семейства — в заголовок: так свёрнутое семейство всё
                               же отвечает на вопрос «стоит ли сюда заглядывать». */
                            const best = list
                                .map((s) => scoreOf(res, s.name, fam))
                                .filter((x): x is NonNullable<typeof x> => !!x && x.ok >= 0)
                                .sort((a, b) => b.ok / Math.max(1, b.total) - a.ok / Math.max(1, a.total))[0]
                            const hasApplied = list.some((s) => s.name === applied)
                            return (
                                <div key={fam} className="rounded-xl border border-border">
                                    <div className="flex items-center gap-1 px-2 py-1.5">
                                        <button
                                            type="button"
                                            onClick={() => toggleFam(fam)}
                                            aria-expanded={open}
                                            aria-label={`${open ? t('свернуть') : t('развернуть')} ${FAMILY[fam]}`}
                                            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-transparent px-1 py-1 text-left text-sm hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                        >
                                            {open
                                                ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                            <span className="shrink-0 font-medium">{FAMILY[fam]}</span>
                                            {/* Одной неразрывной строкой с обрезкой: на телефоне число
                                                «21» рассыпалось на две строки по цифре. */}
                                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                                                {list.length}
                                                {hasApplied ? ` · ${t('применена')} ${applied}` : ''}
                                                {best ? ` · ${t('лучшая')} ${best.ok}/${best.total}` : ''}
                                            </span>
                                        </button>
                                        {!running && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={!testable}
                                                aria-label={`${t('проверить семейство')} ${FAMILY[fam]}`}
                                                title={`${t('проверить семейство')} ${FAMILY[fam]}`}
                                                onClick={() => void startTest(fam)}
                                                className="shrink-0"
                                            >
                                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                                <span className="hidden sm:inline">{t('проверить семейство')}</span>
                                            </Button>
                                        )}
                                    </div>
                                    {open && (
                                        <div className="border-t border-border p-1">
                                            {list.map((s) => {
                                                const on = applied === s.name
                                                const sc = scoreOf(res, s.name, fam)
                                                const expanded = openRow === s.name
                                                return (
                                                    <div key={s.name} className={on ? 'rounded-lg bg-primary/10' : ''}>
                                                        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
                                                            {on
                                                                ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                                                                : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleRow(s.name)}
                                                                aria-expanded={expanded}
                                                                className={`flex min-w-0 flex-1 items-center gap-1 rounded bg-transparent px-1 text-left hover:underline decoration-dotted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? 'font-medium text-primary' : ''}`}
                                                            >
                                                                {/* Шеврон — знак, что строка раскрывается: без него никто не
                                                                    догадывался нажать на имя. */}
                                                                {expanded
                                                                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                                                <span className="min-w-0 truncate">{s.name}</span>
                                                            </button>
                                                            {/* Число проверки стоит НАПРОТИВ стратегии, а не отдельным
                                                                списком: вопрос человека — «какую выбрать», и ответ должен
                                                                быть в той же строке, где кнопка выбора. -1 значит «не
                                                                поднялась вовсе» — такой же ответ, как плохое число. */}
                                                            <span className="w-14 shrink-0 text-right text-xs">
                                                                {sc === undefined ? (
                                                                    <span className="text-muted-foreground">—</span>
                                                                ) : sc.ok < 0 ? (
                                                                    <span className="text-destructive">{t('не идёт')}</span>
                                                                ) : (
                                                                    <span
                                                                        className={
                                                                            sc.ok > sc.baseline
                                                                                ? 'font-medium text-success'
                                                                                : sc.ok < sc.baseline
                                                                                  ? 'text-warning-fg'
                                                                                  : 'text-muted-foreground'
                                                                        }
                                                                    >
                                                                        {sc.ok}/{sc.total}
                                                                    </span>
                                                                )}
                                                            </span>
                                                            {/* Слой к выходу не применяется: у выхода стратегия лежит
                                                                одним файлом ключей целиком, и «слой поверх» означал бы
                                                                файл, собранный из двух источников. Бэкенд это и отвечает
                                                                отказом — значит предлагать кнопку, которая не может
                                                                сработать, нечестно. Слой берётся у бэкенда полем `layer`,
                                                                а не выводится здесь из имени. */}
                                                            {target && s.layer !== 'main' ? (
                                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                                    {t('только всему роутеру')}
                                                                </span>
                                                            ) : (
                                                                <Button
                                                                    variant="outline"
                                                                    size="sm"
                                                                    disabled={busy !== '' || on}
                                                                    className="shrink-0"
                                                                    onClick={() =>
                                                                        void act(
                                                                            `apply:${s.name}`,
                                                                            () => rpc.zapretApply(s.name, target),
                                                                            `${t('Применена')} ${s.name}`,
                                                                        )}
                                                                >
                                                                    {busy === `apply:${s.name}` ? t('…') : t('Применить')}
                                                                </Button>
                                                            )}
                                                        </div>
                                                        {expanded && (
                                                            <StrategyDetails
                                                                opts={opts[s.name]}
                                                                score={sc}
                                                                testable={testable}
                                                                running={running}
                                                                onTest={() => void startTest(`one:${s.name}`)}
                                                            />
                                                        )}
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </CardContent>
            </Card>

            {/* ---- автоподбор ------------------------------------------------------------ */}
            {/* Кнопка честно называется «Подобрать и применить»: подбор без применения был бы
                обманом, а применить победителя, не сказав, — тем, за что этот продукт и
                переписывали. */}
            <Card>
                <CardHeader><CardTitle className="text-base">{t('Автоподбор')}</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                    <p className="text-xs text-muted-foreground">
                        {t('Проверяет стратегии и применяет победителя — только если он открывает больше, чем нынешняя стратегия и чем без обхода.')}
                    </p>

                    {/* Приговор. Строка отказа здесь ценнее пустоты: «уже применена лучшая» и
                        «проверка не проходила» — разные состояния, и человек по ним решает,
                        жать ли кнопку. */}
                    {/* Подбор отложен или упал — это ответ, и он важнее приговора по старым
                        числам. Откладывается только подбор ПО РАСПИСАНИЮ (роутер занят — ночью
                        повторится); по кнопке он идёт всегда: проверка изолирована и трафика
                        человека не касается. Причину называет сам подбор. */}
                    {auto && !auto.running && auto.state === 'skipped' && (
                        <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-fg">
                            {t('Подбор по расписанию отложен')}{auto.state_note ? `: ${auto.state_note}` : ''}.{' '}
                            {t('Повторится следующей ночью; кнопка запускает подбор сразу.')}
                        </div>
                    )}
                    {auto && !auto.running && auto.state === 'error' && auto.state_note && (
                        <div className="text-xs text-destructive">{t('Подбор не удался')}: {auto.state_note}</div>
                    )}
                    {auto?.winner ? (
                        <div>
                            {t('лучшая по замеру')}: <span className="font-medium">{auto.winner.name}</span>
                            {' '}({auto.winner.ok} {t('из')} {auto.winner.total})
                        </div>
                    ) : auto?.note ? (
                        <div className="text-muted-foreground">{auto.note}</div>
                    ) : null}

                    {/* Что применено подбором и когда. Различение «подобрал сам» и «нажали
                        кнопку» здесь не украшение: через месяц это единственный способ понять,
                        почему стратегия не та, которую выбирали руками. */}
                    {auto && auto.at > 0 && auto.applied && (
                        <div className="text-xs text-muted-foreground">
                            {auto.by === 'auto' ? t('подобрано по расписанию') : t('подобрано вручную')}
                            : {auto.applied}
                            {auto.applied_ok !== undefined && auto.applied_total
                                ? ` (${auto.applied_ok} ${t('из')} ${auto.applied_total})`
                                : ''}
                            {' · '}{ago(auto.at)}
                            {auto.prev ? ` · ${t('было')}: ${auto.prev}` : ''}
                        </div>
                    )}

                    {/* Ход подбора — здесь, под приговором, а не только в списке стратегий:
                        человек нажал кнопку в этой карточке и здесь же ждёт ответа. Проверку
                        подбор гоняет ту же, поэтому числа берутся из её хода; между проверкой
                        и применением — короткие слова о том, что делается. */}
                    {auto?.running && (
                        <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs">
                                <span>
                                    {running
                                        ? (test?.state === 'starting'
                                            ? t('собираю цели…')
                                            : `${t('проверяю')} ${test?.done ?? 0} ${t('из')} ${test?.total ?? 0}`)
                                        : auto.state === 'ranking'
                                            ? t('ранжирую и применяю…')
                                            : t('готовлю проверку…')}
                                </span>
                                {running && test?.current && (
                                    <span className="min-w-0 truncate text-muted-foreground">{test.current}</span>
                                )}
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
                                <div
                                    className={`h-full bg-primary transition-all duration-500 ${running ? '' : 'animate-pulse'}`}
                                    style={{
                                        width: running
                                            ? `${Math.round((100 * (test?.done ?? 0)) / Math.max(1, test?.total ?? 1))}%`
                                            : auto.state === 'ranking' ? '100%' : '4%',
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            disabled={busy !== '' || running || auto?.running || !st.curl || st.strategies === 0}
                            onClick={() => void startAuto('all')}
                        >
                            {auto?.running
                                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                            {auto?.running ? t('подбираю…') : t('Подобрать и применить')}
                        </Button>
                        {/* Откат предлагается ТОЛЬКО когда он возможен: копия на месте и
                            работает то, что применил подбор. Кнопка, отказывающая при нажатии,
                            хуже отсутствующей. */}
                        {auto?.can_undo && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy !== ''}
                                onClick={() => void act(
                                    'undo',
                                    () => rpc.zapretAutoselectUndo(),
                                    t('Вернулось как было'),
                                )}
                            >
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('Вернуть как было')}
                            </Button>
                        )}
                    </div>

                    {/* Расписание. ВЫКЛЮЧЕНО по умолчанию, и это видно: применение стратегии
                        перезапускает обход и меняет то, что работает у всех клиентов роутера. */}
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                        <span className="mr-1 text-xs text-muted-foreground">{t('по расписанию')}:</span>
                        {AUTO_EVERY.map((d) => (
                            <Button
                                key={d}
                                variant={(auto?.every_days ?? 0) === d ? 'default' : 'outline'}
                                size="sm"
                                disabled={busy !== ''}
                                onClick={() => void act(
                                    'every',
                                    () => rpc.zapretAutoselectSet(d),
                                    d === 0 ? t('Автоподбор выключен') : t('Расписание сохранено'),
                                )}
                            >
                                {d === 0 ? t('не надо') : `${t('раз в')} ${d} ${t('сут')}`}
                            </Button>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t('Ночью, вместе с обновлением списков, и только когда через роутер не идёт трафик — иначе откладывается до следующей ночи.')}
                    </p>
                </CardContent>
            </Card>

            {/* ---- игровой фильтр (Gv) ---------------------------------------------------
                «Стратегия для игр» Zapret Manager: выключатель с вариантами, а не кандидат в
                каталог — проверкой не меряется (владелец: «тестить не надо»), выхода не имеет
                («покрывает весь UDP-трафик, как в оригинале»). Читает и пишет тот же блок #GvN в
                /etc/config/zapret, что и менеджер, поэтому включённое там видно здесь и наоборот. */}
            {st.game && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t('Игровой фильтр')}</CardTitle>
                        <CardDescription>
                            {t('На весь роутер: игровой UDP и порты игр, как Gv в Zapret Manager. Что подойдёт, зависит от провайдера — пробуйте по очереди прямо в игре.')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="flex flex-wrap items-center gap-1.5">
                            {(['0', '1', '2', '3', '4'] as const).map((n) => {
                                const on = n === '0' ? st.game.gv === '' : st.game.gv === n
                                return (
                                    <button
                                        key={n}
                                        type="button"
                                        disabled={busy !== ''}
                                        aria-pressed={on}
                                        onClick={() => on ? undefined : void act(
                                            'game',
                                            () => rpc.zapretGameSet(Number(n)),
                                            n === '0' ? t('Игровой фильтр снят') : `${t('Игровой фильтр')}: Gv${n}`,
                                        )}
                                        className={[
                                            'rounded-lg border px-3 py-1.5 text-sm',
                                            on ? 'border-primary bg-primary/10 font-medium text-primary'
                                               : 'border-border hover:bg-accent',
                                        ].join(' ')}
                                    >
                                        {n === '0' ? t('Выкл') : `Gv${n}`}
                                    </button>
                                )
                            })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {st.game.gv === '0'
                                ? t('сейчас — встроенный фильтр стратегии Flowseal (GvF); Gv1–Gv4 встанут вместо него.') + ' '
                                : ''}
                            {t('Gv1 — одна подделка на первые два пакета; Gv2–Gv4 — по десять подделок, обрыв после 2, 3 или 4 пакетов.')}
                        </p>
                        {st.game.gv !== '' && (
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">{t('подделка для UDP')}</span>
                                    <select
                                        value={st.game.fake}
                                        disabled={busy !== ''}
                                        aria-label={t('подделка для UDP')}
                                        onChange={(e) => {
                                            const f = e.currentTarget.value
                                            if (f && f !== st.game.fake)
                                                void act('game', () => rpc.zapretGameSet(undefined, f), `${t('Подделка')}: ${f}`)
                                        }}
                                        className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
                                    >
                                        {/* Текущая может быть не из списка менеджера (правили руками) —
                                            тогда она добавляется, иначе select показал бы чужое. */}
                                        {st.game.fake && !st.game.fakes.some((f) => f.name === st.game.fake) && (
                                            <option value={st.game.fake}>{st.game.fake}</option>
                                        )}
                                        {st.game.fakes.map((f) => (
                                            <option key={f.name} value={f.name} disabled={!f.present}>
                                                {f.name}{f.present ? '' : ` — ${t('нет файла')}`}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <Button
                                    variant={st.game.xtreme ? 'default' : 'outline'}
                                    size="sm"
                                    disabled={busy !== ''}
                                    onClick={() => void act(
                                        'game',
                                        () => rpc.zapretGameSet(undefined, undefined, !st.game.xtreme),
                                        st.game.xtreme ? t('Xtreme выключен') : t('Xtreme включён'),
                                    )}
                                >
                                    {st.game.xtreme ? t('Выключить Xtreme') : t('Включить Xtreme')}
                                </Button>
                                <span className="text-xs text-warning-fg">
                                    {t('Xtreme расширяет фильтр почти на все порты — может мешать приложениям; только чтобы проверить игру.')}
                                </span>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

/** Развёрнутая стратегия: её ключи nfqws и что с ней открылось.
 *
 *  Ключи — дословно, по строке: человек видит, ЧТО применяет, а не только имя. Цели — все,
 *  из набора этой стратегии, и у каждой две отметки: открылась ли с обходом и открывалась ли
 *  без него. Цель, которая открывается и так, стратегии в заслугу не идёт — и видно это
 *  только рядом, а не по двум числам сверху. */
function StrategyDetails({
    opts, score, testable, running, onTest,
}: {
    opts: string[] | null | undefined
    score: ReturnType<typeof scoreOf>
    testable: boolean
    running: boolean
    onTest: () => void
}) {
    const opened = new Set(score?.opened || [])
    const base = new Set(score?.baseOpened || [])
    const targets = score?.targets || []
    return (
        <div className="space-y-2 px-3 pb-3 pt-1 text-xs">
            <div>
                <div className="sp-label uppercase tracking-wide text-muted-foreground">{t('ключи nfqws')}</div>
                {opts === undefined ? (
                    <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                        <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> {t('читаю…')}
                    </div>
                ) : opts === null ? (
                    <div className="mt-1 text-warning-fg">{t('ключи не пришли — если splify2 только что обновился, откройте страницу заново')}</div>
                ) : (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2 font-mono text-[11px] leading-relaxed">
                        {opts.join('\n')}
                    </pre>
                )}
            </div>
            <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="sp-label uppercase tracking-wide text-muted-foreground">
                        {score
                            ? score.ok < 0
                                ? t('стратегия не поднялась')
                                : `${t('открылось')} ${score.ok} ${t('из')} ${score.total} · ${SET_NAME[score.set]} · ${t('без обхода')} ${score.baseline}`
                            : t('ещё не проверялась')}
                    </div>
                    {!running && (
                        <Button variant="ghost" size="sm" disabled={!testable} onClick={onTest}>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('проверить эту стратегию')}
                        </Button>
                    )}
                </div>
                {score && score.ok >= 0 && targets.length > 0 && (
                    <ul className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                        {targets.map((h) => {
                            const ok = opened.has(h)
                            const free = base.has(h)
                            return (
                                <li key={h} className="flex items-center gap-1.5 truncate">
                                    <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`}
                                        aria-hidden="true"
                                    />
                                    <span className={`truncate ${ok ? '' : 'text-muted-foreground'}`}>{h}</span>
                                    {free && (
                                        <span className="shrink-0 text-[10px] text-muted-foreground" title={t('открывается и без обхода')}>
                                            {t('и без обхода')}
                                        </span>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                )}
                {score && score.ok >= 0 && targets.length === 0 && score.opened && (
                    <div className="mt-1 text-muted-foreground">{score.opened.join(', ') || t('ничего не открылось')}</div>
                )}
            </div>
        </div>
    )
}
