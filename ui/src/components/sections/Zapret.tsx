import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, LoaderCircle, Play, RefreshCw, Square, Waves } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
 *  госуслуги. */

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

    const reloadState = useCallback(
        () => Promise.all([
            rpc.zapretState().then(setSt).catch(() => setStRaw(null)),
            rpc.zapretStrategies().then(setCat).catch(() => setCatRaw(null)),
            rpc.zapretResults().then(setRes).catch(() => setResRaw(null)),
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
                        {t('Пакет приезжает из релизов remittor/zapret-openwrt, стратегии — из Zapret Manager и Flowseal, теми же источниками, что у самого менеджера. Вместе с обходом ставится curl: без него нечем проверять стратегии.')}
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

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Waves className="h-4 w-4" aria-hidden="true" />
                        {t('Обход DPI')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                            {/* Три состояния, а не два: «выключен» — решение человека
                                (кнопка в строке «Весь роутер»), «не запущен» — поломка. */}
                            {st.running
                                ? <span className="text-success">{t('работает')}</span>
                                : !st.enabled
                                    ? <span className="text-muted-foreground">{t('выключен')}</span>
                                    : <span className="text-warning-fg">{t('не запущен')}</span>}
                        </span>
                        {st.version && <span className="text-muted-foreground">{st.version}</span>}
                        <span className="text-muted-foreground">
                            {t('стратегий')}: {st.strategies}
                        </span>
                        <span className="text-muted-foreground">
                            {t('каталог обновлён')}: {ago(st.updated)}
                        </span>
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
                            variant="outline"
                            size="sm"
                            disabled={busy !== '' || running}
                            onClick={() => void act('remove', () => rpc.zapretRemove(), t('Обход DPI удалён'))}
                        >
                            {t('Удалить обход')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* ---- проверка ------------------------------------------------------------- */}
            <Card>
                <CardHeader><CardTitle className="text-base">{t('Проверка стратегий')}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                        {t('Идёт в фоне: окно роутера можно закрыть. Пользовательского трафика проверка не касается — она поднимает свой обработчик и отдаёт в него только свои запросы, а ваша стратегия всё это время работает как обычно. Наборов целей два, как у Zapret Manager: общий (сайты и dpi-checkers) для Flowseal и v, домены YouTube — для Yv.')}
                    </div>
                    {running ? (
                        <div className="space-y-2">
                            <div className="text-sm">
                                {test?.state === 'starting'
                                    ? t('собираю цели…')
                                    : `${t('стратегия')} ${test?.done ?? 0} ${t('из')} ${test?.total ?? 0}${test?.current ? ` · ${test.current}` : ''}`}
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
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                size="sm"
                                disabled={busy !== '' || !st.curl || st.strategies === 0}
                                onClick={() => void startTest('all')}
                            >
                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('Проверить')}
                            </Button>
                            <span className="text-xs text-muted-foreground">
                                {t('все стратегии; семейство или одну — кнопками в списке ниже')}
                            </span>
                        </div>
                    )}
                    {test?.state === 'error' && test.error_text && (
                        <div className="text-xs text-destructive">{test.error_text}</div>
                    )}
                    {/* Без этого числа результат не значит ничего: «30 из 54» может быть и
                        отличным, и никаким — смотря сколько открывается без обхода вовсе. */}
                    {res && res.at > 0 && (
                        <div className="text-xs text-muted-foreground">
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
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ---- куда применять ------------------------------------------------------- */}
            <Card>
                <CardHeader><CardTitle className="text-base">{t('Куда применить')}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                    {/* Выключатель стоит РЯДОМ с местом применения, а не в шапке: вопрос
                        человека — «как отключить стратегию на весь роутер», и ответ должен быть
                        в той строке, где эта стратегия названа. Выключается служба, а не
                        стирается стратегия: отметка остаётся, Zapret Manager видит своё, а
                        выходы обхода (свои обработчики) продолжают работать. */}
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => setTarget('')}
                            className={[
                                'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                                target === '' ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                            ].join(' ')}
                        >
                            <span className="min-w-0 flex-1">{t('Весь роутер')}</span>
                            <span className="text-xs text-muted-foreground">
                                {!st.enabled && <span className="mr-1 rounded bg-accent px-1.5 py-0.5">{t('выключен')}</span>}
                                {st.active || t('стратегия не отмечена')}
                            </span>
                        </button>
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy !== ''}
                            className="shrink-0"
                            onClick={() => void act(
                                'enable',
                                () => rpc.zapretEnable(!st.enabled),
                                st.enabled ? t('Обход на весь роутер выключен') : t('Обход на весь роутер включён'),
                            )}
                        >
                            {busy === 'enable' ? '…' : st.enabled ? t('Выключить обход') : t('Включить обход')}
                        </Button>
                    </div>
                    {!st.enabled && (
                        <div className="px-3 text-xs text-muted-foreground">
                            {t('Обход на весь роутер выключен: стратегия выше не действует, а выходы обхода ниже работают своими обработчиками. «Применить» стратегию всему роутеру включит его обратно.')}
                        </div>
                    )}
                    {outs.map((o) => (
                        <button
                            key={o.name}
                            type="button"
                            onClick={() => setTarget(o.name)}
                            className={[
                                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                                target === o.name ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                            ].join(' ')}
                        >
                            <span className="min-w-0 flex-1 truncate">
                                {t('выход')} {o.name}
                                {/* Не применённый выход — не поломка: его обработчик и не
                                    должен быть запущен, пока спеку не применили. Предупреждение
                                    оставлено тому, что применено и всё равно не поднялось. */}
                                {!o.up && (
                                    pending.applied && !pending.applied.outputs?.[o.name]
                                        ? <span className="ml-2 text-xs text-muted-foreground">{t('не применён')}</span>
                                        : <span className="ml-2 text-xs text-warning-fg">{t('обработчик не запущен')}</span>
                                )}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {o.strategy || t('нет стратегии')}
                            </span>
                        </button>
                    ))}
                    {/* Завести выход — здесь же, потому что иначе «стратегия только для
                        YouTube» остаётся недостижимой: выход есть куда применить, а завести
                        его негде. Правило в него человек создаёт во вкладке «Правила». */}
                    <div className="flex flex-wrap items-center gap-2 pt-2">
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
                        {t('Выход — это то, во что ведёт правило. Заведите его здесь — он сразу появится в списке выше, — выберите ему стратегию ниже, а правило «эти домены — сюда» создайте во вкладке «Правила». Заработает после «Применить».')}
                    </div>
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
                        <CardTitle className="text-base">
                            {t('Игровой фильтр')}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                {t('на весь роутер · игровой UDP и порты игр, как Gv в Zapret Manager')}
                            </span>
                        </CardTitle>
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
                            {st.game.gv === '0' && (
                                <span className="text-xs text-muted-foreground">
                                    {t('сейчас — встроенный фильтр стратегии Flowseal (GvF); Gv1–Gv4 встанут вместо него')}
                                </span>
                            )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {t('Gv1 — одна подделка на первые два пакета; Gv2–Gv4 — по десять подделок, обрыв после 2, 3 или 4 пакетов. Что подойдёт, зависит от провайдера — пробуйте по очереди прямо в игре.')}
                        </div>
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
                                    {t('Xtreme расширяет фильтр почти на все порты — может мешать приложениям и соединениям; только чтобы проверить игру.')}
                                </span>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* ---- список стратегий ----------------------------------------------------- */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">
                        {t('Стратегии')}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {target ? `${t('для выхода')} ${target}` : t('для всего роутера')}
                        </span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                    {res && res.at > 0 && (
                        <p className="pb-1 text-xs text-muted-foreground">
                            {t('Число — сколько целей открылось со стратегией.')}{' '}
                            <span className="text-success">{t('Зелёное')}</span> — {t('больше, чем без обхода')},{' '}
                            <span className="text-warning-fg">{t('жёлтое')}</span> — {t('меньше')}, {t('серое — столько же')}.{' '}
                            {t('Нажмите на имя стратегии — покажутся её ключи и открывшиеся сайты.')}
                        </p>
                    )}
                    {all.length === 0 && (
                        <div className="py-3 text-sm text-muted-foreground">
                            {t('Каталог пуст — обновите его.')}
                        </div>
                    )}
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
                                <div className="flex items-center gap-2 px-2 py-1.5">
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
                                        <span className="font-medium">{FAMILY[fam]}</span>
                                        <span className="text-xs text-muted-foreground">
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
                                            onClick={() => void startTest(fam)}
                                        >
                                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                            {t('проверить семейство')}
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
                                                        <span className="w-16 shrink-0 text-right text-xs">
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
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={busy !== '' || on}
                                                            onClick={() =>
                                                                void act(
                                                                    `apply:${s.name}`,
                                                                    () => rpc.zapretApply(s.name, target),
                                                                    `${t('Применена')} ${s.name}`,
                                                                )}
                                                        >
                                                            {busy === `apply:${s.name}` ? t('…') : t('Применить')}
                                                        </Button>
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
                </CardContent>
            </Card>
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
                    <div className="mt-1 text-warning-fg">{t('бэкенд постарше ключи не отдаёт — обновите интерфейс')}</div>
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
