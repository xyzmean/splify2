import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Play, RefreshCw, Square, Waves } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'
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
 *  стратегия, то другая. */

const SCOPES: { id: string; label: string }[] = [
    { id: 'all', label: 'все' },
    { id: 'flowseal', label: 'Flowseal' },
    { id: 'v', label: 'v' },
    { id: 'yv', label: 'YouTube' },
]

const FAMILY: Record<string, string> = {
    flowseal: 'Flowseal',
    v: 'v',
    yv: 'YouTube',
    other: '—',
}

function ago(ts: number): string {
    if (!ts) return 'ни разу'
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
    if (s < 90) return 'только что'
    if (s < 5400) return `${Math.round(s / 60)} мин назад`
    if (s < 172800) return `${Math.round(s / 3600)} ч назад`
    return `${Math.round(s / 86400)} сут назад`
}

export default function Zapret() {
    const [st, setSt] = useState<Awaited<ReturnType<typeof rpc.zapretState>> | null>(null)
    const [cat, setCat] = useState<Awaited<ReturnType<typeof rpc.zapretStrategies>> | null>(null)
    const [res, setRes] = useState<Awaited<ReturnType<typeof rpc.zapretResults>> | null>(null)
    const [test, setTest] = useState<Awaited<ReturnType<typeof rpc.zapretTest>> | null>(null)
    const [busy, setBusy] = useState('')
    const [scope, setScope] = useState('all')
    /** Куда применять выбранное: пусто — весь роутер, иначе имя выхода kind=zapret. */
    const [target, setTarget] = useState('')
    const [family, setFamily] = useState('')
    /** Имя нового выхода. Заводится ЗДЕСЬ, а не в общем редакторе выходов, и это не про
     *  удобство: тот знает два вида выхода (локация подписки и свои туннели), а выход обхода
     *  не имеет устройства вовсе. Плюс выход без стратегии не значит ничего, а стратегии — тут. */
    const [newOut, setNewOut] = useState('')

    const reloadState = useCallback(
        () => Promise.all([
            rpc.zapretState().then(setSt).catch(() => setSt(null)),
            rpc.zapretStrategies().then(setCat).catch(() => setCat(null)),
            rpc.zapretResults().then(setRes).catch(() => setRes(null)),
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
            notify(`${t('Выход заведён')}: ${n}. ${t('Осталось применить')}`)
            await reloadState()
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

    const score = new Map((res?.results || []).map((r) => [r.name, r.ok]))
    const outs = cat?.outputs || []
    const all = cat?.strategies || []
    const list = family ? all.filter((s) => s.family === family) : all
    const running = test?.running === true
    /* Что применено в выбранном месте: у роутера — отметка из /etc/config/zapret (её же
       ставит Zapret Manager), у выхода — заголовок его файла ключей. */
    const applied = target
        ? (outs.find((o) => o.name === target)?.strategy || '')
        : st.active

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
                            {st.running
                                ? <span className="text-success">{t('работает')}</span>
                                : <span className="text-muted-foreground">{t('не запущен')}</span>}
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
                        {t('Идёт в фоне: окно роутера можно закрыть. Пользовательского трафика проверка не касается — она поднимает свой обработчик и отдаёт в него только свои запросы, а ваша стратегия всё это время работает как обычно.')}
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
                            <div className="flex gap-1">
                                {SCOPES.map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => setScope(s.id)}
                                        className={[
                                            'rounded-lg px-2.5 py-1 text-xs transition-colors duration-200',
                                            scope === s.id
                                                ? 'bg-primary/10 font-medium text-primary'
                                                : 'text-subtle hover:bg-accent',
                                        ].join(' ')}
                                    >
                                        {t(s.label)}
                                    </button>
                                ))}
                            </div>
                            <Button
                                size="sm"
                                disabled={busy !== '' || !st.curl || st.strategies === 0}
                                onClick={() => void act('test', () => rpc.zapretTestStart(scope), t('Проверка запущена'))}
                            >
                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('Проверить')}
                            </Button>
                        </div>
                    )}
                    {test?.state === 'error' && test.error_text && (
                        <div className="text-xs text-destructive">{test.error_text}</div>
                    )}
                    {/* Без этого числа результат не значит ничего: «30 из 54» может быть и
                        отличным, и никаким — смотря сколько открывается без обхода вовсе. */}
                    {res && res.at > 0 && (
                        <div className="text-xs text-muted-foreground">
                            {t('последняя проверка')}: {ago(res.at)} · {t('целей')} {res.targets} ·{' '}
                            {t('без обхода открылось')} {res.baseline}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ---- куда применять ------------------------------------------------------- */}
            <Card>
                <CardHeader><CardTitle className="text-base">{t('Куда применить')}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                    <button
                        type="button"
                        onClick={() => setTarget('')}
                        className={[
                            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                            target === '' ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                        ].join(' ')}
                    >
                        <span className="min-w-0 flex-1">{t('Весь роутер')}</span>
                        <span className="text-xs text-muted-foreground">
                            {st.active || t('стратегия не отмечена')}
                        </span>
                    </button>
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
                                {!o.up && (
                                    <span className="ml-2 text-xs text-warning-fg">
                                        {t('обработчик не запущен')}
                                    </span>
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
                        {t('Выход — это то, во что ведёт правило. Заведите его здесь, выберите ему стратегию ниже, а правило «эти домены — сюда» создайте во вкладке «Правила».')}
                    </div>
                </CardContent>
            </Card>

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
                    <div className="flex gap-1 pb-1">
                        {[{ id: '', label: 'все' }, ...SCOPES.slice(1).map((s) => ({ id: s.id, label: s.label }))]
                            .map((f) => (
                                <button
                                    key={f.id || 'any'}
                                    type="button"
                                    onClick={() => setFamily(f.id)}
                                    className={[
                                        'rounded-lg px-2.5 py-1 text-xs transition-colors duration-200',
                                        family === f.id
                                            ? 'bg-primary/10 font-medium text-primary'
                                            : 'text-subtle hover:bg-accent',
                                    ].join(' ')}
                                >
                                    {t(f.label)}
                                </button>
                            ))}
                    </div>
                    {list.length === 0 && (
                        <div className="py-3 text-sm text-muted-foreground">
                            {t('Каталог пуст — обновите его.')}
                        </div>
                    )}
                    {list.map((s) => {
                        const on = applied === s.name
                        const ok = score.get(s.name)
                        return (
                            <div
                                key={s.name}
                                className={[
                                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
                                    on ? 'bg-primary/10' : '',
                                ].join(' ')}
                            >
                                {on
                                    ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                                    : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium text-primary' : ''}`}>
                                    {s.name}
                                </span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                    {FAMILY[s.family]}
                                </span>
                                {/* Число проверки стоит НАПРОТИВ стратегии, а не отдельным
                                    списком: вопрос человека — «какую выбрать», и ответ должен
                                    быть в той же строке, где кнопка выбора. -1 значит «не
                                    поднялась вовсе» — такой же ответ, как плохое число. */}
                                <span className="w-16 shrink-0 text-right text-xs">
                                    {ok === undefined ? (
                                        <span className="text-muted-foreground">—</span>
                                    ) : ok < 0 ? (
                                        <span className="text-destructive">{t('не идёт')}</span>
                                    ) : (
                                        <span
                                            className={
                                                res && ok > res.baseline
                                                    ? 'font-medium text-success'
                                                    : res && ok < res.baseline
                                                      ? 'text-warning-fg'
                                                      : 'text-muted-foreground'
                                            }
                                        >
                                            {ok}/{res?.targets ?? 0}
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
                        )
                    })}
                </CardContent>
            </Card>
        </div>
    )
}
