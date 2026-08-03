import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Loader2, ShieldAlert, ShieldCheck, Wrench } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { t } from '@/lib/i18n'
import { EMPTY_SPEC, type Channel, type RawManifest, type Spec, type Status } from '@/lib/model'

// Простая настройка: один экран от «ничего не настроено» до работающего туннеля.
//
// Зачем отдельный экран, если есть вкладки каналов, выходов и списков. Те вкладки — точный
// редактор модели движка, и для того, кто её понимает, это правильно. Но чтобы получить
// работающий VPN, человеку сейчас надо выучить четыре понятия («выход», «канал», режим
// отказа, адресный список против доменного), пройти три вкладки в верном порядке и знать,
// что каналы проверяются сверху вниз, а побеждает первый. Для «хочу ютуб через VPN» это
// непроходимо.
//
// Здесь того же результата добиваются двумя решениями: куда подключаться и что через это
// пустить. Слов «канал» и «выход» на экране нет вовсе — они появляются в спеке, но их
// составляет код, а не человек.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, которое делает это безопасным: мастер трогает РОВНО свои две записи
// (выход OUT_NAME и канал CH_NAME) и не касается ничего другого. Кто настроил что-то руками
// во вкладках, не потеряет это, открыв мастер, — иначе «простой режим» стал бы способом
// молча снести чужую работу.

/** Имя выхода, который создаёт мастер. Одно на весь мастер: два выхода — это уже выбор,
 *  который простому пользователю делать нечем и незачем. */
const OUT_NAME = 'vpn'
/** Один канал, и только доменный.
 *
 *  Адресные списки мастер не трогает СОЗНАТЕЛЬНО. Домены точнее — «пустить ютуб» работает
 *  независимо от того, какой из десятков его адресов выдал DNS в эту минуту, — и заодно это
 *  снимает целый класс ошибок: включить одно и то же в двух формах (адресами и доменами)
 *  стоит двойной памяти и двух каналов, спорящих за одну цель. Кому нужны адреса, тот идёт
 *  в расширенные настройки, и там это осознанный выбор, а не побочный эффект галочки. */
const CH_NAME = 'сервисы'
const SUB_FILE = '/etc/steer/sub.txt'
const LISTS_DIR = '/etc/steer/lists'

/** Списки, которых в мастере не будет.
 *
 *  Это хостинги и CDN: Cloudflare, Hetzner, OVH и подобные. Они не сервисы, а инфраструктура
 *  под чужими сервисами, и толк от них появляется только вместе с пониманием, зачем. При
 *  этом `hodca` — 250 доменов половины интернета, и включённый наугад он уводит в туннель
 *  куда больше, чем человек имел в виду.
 *
 *  Список ЯВНЫЙ, по идентификаторам, а не по признаку вроде размера: издатель добавит новый
 *  список — и он попадёт в один из двух видимых разделов, а не исчезнет молча. Прятать
 *  что-то по угаданному правилу хуже, чем показать лишнее. */
const INFRA = new Set(['hodca', 'svc_cloudflare', 'svc_cloudfront', 'svc_digitalocean', 'svc_hetzner', 'svc_ovh'])

/** Путь ПОВТОРЯЕТ путь у издателя — то же правило, что в ChannelsPage и в бэкенде.
 *  Иначе адресный `hodca.lst` и доменный `domains/hodca.lst` становятся одним локальным
 *  файлом и затирают друг друга, а nft отвергает набор целиком. */
function pathFor(file: string) {
    return `${LISTS_DIR}/${file.replace(/^\/+/, '')}`
}

interface Item {
    id: string
    name: string
    file: string
    count?: number
}

export default function SetupPage({ onExpert }: { onExpert: () => void }) {
    const [spec, setSpec] = useState<Spec | null>(null)
    const [raw, setRaw] = useState<RawManifest | null>(null)
    const [status, setStatus] = useState<Status | null>(null)
    const [vlessOk, setVlessOk] = useState<boolean | null>(null)
    const [sub, setSub] = useState<{ url?: string; present: boolean } | null>(null)
    const [url, setUrl] = useState('')
    /** Выбранные ФАЙЛЫ, а не идентификаторы: в спеку идут пути, и хранить то же, что
     *  сохраняем, значит не иметь второго представления, которое может разойтись. */
    const [picked, setPicked] = useState<Set<string>>(new Set())
    const [busy, setBusy] = useState('')
    const [node, setNode] = useState<{ name: string; ms: number } | null>(null)

    useEffect(() => {
        rpc.specGet().then((s) => { setSpec(s); seed(s) }).catch(() => setSpec(EMPTY_SPEC))
        rpc.manifest().then(setRaw).catch(() => setRaw(null))
        rpc.status().then(setStatus).catch(() => setStatus(null))
        rpc.engine().then((e) => setVlessOk(e.vless)).catch(() => setVlessOk(null))
        rpc.subInfo().then((s) => { setSub(s); setUrl(s.url || '') }).catch(() => setSub(null))
    }, [])

    /** Прочитать из спеки то, что мастер сам туда и положил. Без этого повторный вход
     *  показывал бы всё выключенным при работающем туннеле. */
    function seed(s: Spec) {
        const files = new Set<string>()
        for (const ch of s.channels)
            if (ch.name === CH_NAME) for (const f of ch.match.domains_files || []) files.add(f)
        setPicked(files)
    }

    const all: Item[] = useMemo(
        () => (raw?.domain_lists || []).map((d) => ({ id: d.id, name: d.name_ru, file: d.file, count: d.count })),
        [raw],
    )
    /** Узнаваемые сервисы: их человек ищет по имени и понимает без объяснений. */
    const services = useMemo(() => all.filter((i) => i.id.startsWith('svc_') && !INFRA.has(i.id)), [all])
    /** Широкие категории. Отдельно и с числом доменов, потому что «Не пускают из РФ» — это
     *  465 доменов, а YouTube — 18: разница в порядке, и она должна быть видна до включения. */
    const categories = useMemo(() => all.filter((i) => !i.id.startsWith('svc_') && !INFRA.has(i.id)), [all])
    const hidden = useMemo(() => all.filter((i) => INFRA.has(i.id)), [all])

    /** Каналы, которых мастер не касается. Показываются строкой: человек должен знать, что
     *  здесь не вся настройка, — иначе «Применить» выглядит так, будто он задаёт её целиком. */
    const foreign = (spec?.channels || []).filter((c) => c.name !== CH_NAME)

    const on = status?.outputs?.[OUT_NAME]?.up === true
    const configured = (spec?.channels || []).some((c) => c.name === CH_NAME)

    function toggle(i: Item) {
        const p = pathFor(i.file)
        const next = new Set(picked)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        setPicked(next)
    }

    async function check() {
        setBusy('check')
        try {
            const r = await rpc.vlessProbe(OUT_NAME, -1)
            if (r.error) throw new Error(r.error)
            const good = (r.results || []).find((x) => x.ok)
            if (!good) { notify(t('Ни один узел подписки не отвечает'), 'error'); setNode(null); return }
            setNode({ name: good.name, ms: good.ttfb_ms })
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function connect() {
        if (!url.trim()) { notify(t('Вставьте ссылку на подписку'), 'warning'); return }
        setBusy('sub')
        try {
            const r = await rpc.subSet(url.trim())
            if (!r.ok) throw new Error(r.error || t('не скачалось'))
            notify(t('Подписка загружена'))
            setSub(await rpc.subInfo())
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    /** Собрать спеку из выбранного и применить.
     *
     *  Списки скачиваются ДО применения: движок читает файлы в момент сборки правил и падает
     *  на отсутствующем, то есть выбранный, но не скачанный список превратил бы «Применить» в
     *  ошибку, с которой человеку нечего делать. */
    async function apply() {
        if (!spec) return
        if (!sub?.present) { notify(t('Сначала подключите подписку'), 'warning'); return }
        if (!picked.size) { notify(t('Выберите хотя бы один сервис'), 'warning'); return }
        setBusy('apply')
        try {
            const chosen = all.filter((i) => picked.has(pathFor(i.file)))
            for (const i of chosen) {
                const r = await rpc.listFetch(i.id, 'domains').catch(() => ({ ok: false }))
                if (!r.ok) notify(`${i.name}: ${t('список не скачался')}`, 'warning')
            }

            const mine: Channel = {
                name: CH_NAME,
                // fakeip: точность по домену. Именно она и делает «пустить ютуб» работающим
                // независимо от того, какой адрес выдал DNS в эту минуту.
                match: { domains_files: chosen.map((i) => pathFor(i.file)), mode: 'fakeip' },
                out: OUT_NAME,
            }
            const next: Spec = {
                ...spec,
                outputs: {
                    ...spec.outputs,
                    [OUT_NAME]: {
                        // node: -1 — «первый рабочий». Зашитый номер молча перестаёт быть тем
                        // узлом при обновлении подписки, а проверка находит живой сама.
                        name: OUT_NAME, kind: 'vless', sub_file: SUB_FILE, node: -1,
                        // drop, а не direct: туннель заводят ровно чтобы трафик НЕ шёл
                        // напрямую, и вернуть его на открытый путь при поломке — нарушить это
                        // обещание тогда, когда это опаснее всего, причём незаметно.
                        on_fail: 'drop',
                    },
                },
                // Свой канал первым: каналы проверяются сверху вниз, и сервисы должны
                // побеждать более широкие правила, настроенные вручную.
                channels: [mine, ...foreign],
            }

            const w = await rpc.specSet(next)
            if (!w.ok) throw new Error(w.error || t('настройка не сохранилась'))
            const a = await rpc.apply()
            if (!a.ok) throw new Error(a.output || t('не применилось'))
            notify(t('Готово'))
            setSpec(next)
            setStatus(await rpc.status().catch(() => null))
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    if (!spec) return <div className="p-5 text-sm text-sp-muted-foreground">{t('Загрузка…')}</div>

    /** Плитка выбора. Не браузерный чекбокс: у того съезжает базовая линия (это правили
     *  дважды), а крупная цель нажатия здесь ещё и уместнее — страницу открывают с телефона. */
    function Tile({ i, wide }: { i: Item; wide?: boolean }) {
        const active = picked.has(pathFor(i.file))
        return (
            <button
                type="button"
                aria-pressed={active}
                onClick={() => toggle(i)}
                className={[
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring',
                    wide ? 'w-full' : '',
                    active
                        ? 'border-sp-primary bg-sp-primary/10 text-sp-foreground'
                        : 'border-sp-border text-sp-muted-foreground hover:text-sp-foreground',
                ].join(' ')}
            >
                <span
                    className={[
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        active ? 'border-sp-primary bg-sp-primary text-sp-primary-foreground' : 'border-sp-border',
                    ].join(' ')}
                    aria-hidden="true"
                >
                    {active && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate">{i.name}</span>
                {wide && i.count ? (
                    <span className="ml-auto shrink-0 text-xs text-sp-muted-foreground">
                        {i.count} {t('домен.')}
                    </span>
                ) : null}
            </button>
        )
    }

    return (
        <div className="mx-auto max-w-3xl space-y-4">
            {/* Состояние одной строкой и человеческими словами. «up=true» и «канал жив» — это
                про устройство и счётчики, а человек спрашивает одно: работает ли. */}
            <Card>
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    {on ? (
                        <ShieldCheck className="h-6 w-6 text-sp-primary" aria-hidden="true" />
                    ) : (
                        <ShieldAlert className="h-6 w-6 text-sp-muted-foreground" aria-hidden="true" />
                    )}
                    <div className="mr-auto">
                        <div className="font-medium">
                            {on ? t('Работает') : configured ? t('Настроено, но туннель не поднялся') : t('Ещё не настроено')}
                        </div>
                        {node && (
                            <div className="text-xs text-sp-muted-foreground">
                                {node.name} · {node.ms} {t('мс')}
                            </div>
                        )}
                    </div>
                    {sub?.present && (
                        <Button variant="outline" size="sm" onClick={check} disabled={busy !== ''}>
                            {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" />}
                            {t('Проверить')}
                        </Button>
                    )}
                </CardContent>
            </Card>

            {/* Движок без VLESS — не ошибка настройки, а другой пакет. Говорим это до того,
                как человек вставит ссылку и не поймёт, почему ничего не вышло. */}
            {vlessOk === false && (
                <Card className="border-sp-destructive">
                    <CardContent className="py-4 text-sm">
                        {t('Установлен базовый движок — он не умеет VLESS. Нужен пакет steer-extended.')}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">1. {t('Подписка')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                        <input
                            type="url"
                            inputMode="url"
                            spellCheck={false}
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://…"
                            aria-label={t('Ссылка на подписку')}
                            className="min-w-0 flex-1 rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                        />
                        <Button onClick={connect} disabled={busy !== '' || vlessOk === false}>
                            {busy === 'sub' && <Loader2 className="h-4 w-4 animate-spin" />}
                            {t('Подключить')}
                        </Button>
                    </div>
                    <p className="text-xs text-sp-muted-foreground">
                        {sub?.present
                            ? t('Подписка на роутере. Вставьте другую ссылку, чтобы заменить.')
                            : t('Ссылку выдаёт продавец VPN. Серверы скачаются на роутер, узел выберется сам — первый рабочий.')}
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">2. {t('Что пустить через VPN')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {!all.length && (
                        <p className="text-sm text-sp-muted-foreground">
                            {t('Список сервисов не загрузился — проверьте интернет на роутере.')}
                        </p>
                    )}

                    {services.length > 0 && (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {services.map((i) => <Tile key={i.id} i={i} />)}
                        </div>
                    )}

                    {categories.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-sp-muted-foreground">
                                {t('Целиком')}
                            </div>
                            <div className="space-y-2">
                                {categories.map((i) => <Tile key={i.id} i={i} wide />)}
                            </div>
                        </div>
                    )}

                    {hidden.length > 0 && (
                        <p className="text-xs text-sp-muted-foreground">
                            {t('Хостинги и CDN')} ({hidden.map((i) => i.name).join(', ')}) —{' '}
                            {t('в расширенных настройках: они уводят в туннель больше, чем обычно нужно.')}
                        </p>
                    )}
                </CardContent>
            </Card>

            <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" onClick={apply} disabled={busy !== ''}>
                    {busy === 'apply' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('Применить')}
                </Button>
                {foreign.length > 0 && (
                    <span className="text-xs text-sp-muted-foreground">
                        {t('Настроенное вручную сохранится, каналов:')} {foreign.length}
                    </span>
                )}
            </div>

            {/* Выход в расширенное — ссылкой, не вкладкой: это дверь для того, кто уже знает,
                что за ней, а не пятый равноправный раздел. */}
            <button
                type="button"
                onClick={onExpert}
                className="flex items-center gap-2 pt-2 text-sm text-sp-muted-foreground hover:text-sp-foreground"
            >
                <Wrench className="h-4 w-4" aria-hidden="true" />
                {t('Расширенные настройки')}
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>

            {status?.warnings?.length ? (
                <div className="space-y-1 pt-2">
                    {status.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-sp-muted-foreground">
                            <Badge variant="secondary">{t('внимание')}</Badge>
                            <span>{w.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
