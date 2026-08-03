import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, GitBranch, ListChecks, Network, Wand2 } from 'lucide-react'
import { t } from '@/lib/i18n'
import { rpc } from '@/lib/rpc'

// Channels is the page people open; the rest are split out so the first paint does
// not carry them. The chunk names and their ?v= pinning are handled by the build —
// see ui/scripts/pin-chunks.mjs, and note that ONE chunk referenced two ways is
// loaded twice by the browser, which cost a dead tab in splify 1.
const OutputsPage = lazy(() => import('@/components/OutputsPage'))
const ListsPage = lazy(() => import('@/components/ListsPage'))
const StatusPage = lazy(() => import('@/components/StatusPage'))
const SetupPage = lazy(() => import('@/components/SetupPage'))
import ChannelsPage from '@/components/ChannelsPage'

type TabId = 'channels' | 'outputs' | 'lists' | 'status'

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
    { id: 'channels', label: 'Каналы', icon: GitBranch },
    { id: 'outputs', label: 'Выходы', icon: Network },
    { id: 'lists', label: 'Списки', icon: ListChecks },
    { id: 'status', label: 'Состояние', icon: Activity },
]

/** Простая настройка или редактор модели.
 *
 *  Решается ПО КОНФИГУРАЦИИ, а не переключателем в настройках: пока каналов нет, человеку
 *  нечего редактировать и незачем знать слово «канал» — ему нужен работающий туннель. Как
 *  только настройка появилась, интерфейс открывается там, где её видно целиком.
 *
 *  Почему не «всегда простой по умолчанию»: мастер выражает не всякую настройку (несколько
 *  выходов, свои подсети, failover), и открывать его тому, у кого настроено больше, значит
 *  каждый раз показывать неполную картину и заставлять из неё уходить. */
type Mode = 'setup' | 'expert'

export default function App() {
    const [tab, setTab] = useState<TabId>('channels')
    /** null — ещё не знаем, что в спеке. Показывать что-то до этого нельзя: угадаешь
     *  неверно, и человек увидит, как интерфейс переключается сам под ним. */
    const [mode, setMode] = useState<Mode | null>(null)

    useEffect(() => {
        rpc.specGet()
            .then((s) => setMode(s.channels.length ? 'expert' : 'setup'))
            // Спека не читается — это чистая установка либо сломанный бэкенд. В обоих
            // случаях мастер полезнее редактора: он умеет сказать, чего не хватает.
            .catch(() => setMode('setup'))
    }, [])

    if (mode === null)
        return <div className="sp-root p-5 text-sm text-sp-muted-foreground">{t('Загрузка…')}</div>

    if (mode === 'setup')
        return (
            <div className="sp-root text-sp-foreground">
                <Suspense fallback={<div className="p-5 text-sm text-sp-muted-foreground">{t('Загрузка…')}</div>}>
                    <SetupPage onExpert={() => setMode('expert')} />
                </Suspense>
            </div>
        )

    return (
        <div className="sp-root text-sp-foreground">
            <nav className="mb-4 flex flex-wrap gap-1 border-b border-sp-border" role="tablist">
                {TABS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => setTab(id)}
                        className={[
                            'flex items-center gap-2 rounded-t-md px-4 py-2 text-sm transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-primary',
                            tab === id
                                ? 'border-b-2 border-sp-primary font-medium text-sp-primary'
                                : 'border-b-2 border-transparent text-sp-muted-foreground hover:text-sp-foreground',
                        ].join(' ')}
                    >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {t(label)}
                    </button>
                ))}
                {/* Дорога обратно к мастеру. Нужна не для симметрии: подписку меняют чаще
                    всего остального, а в мастере это одно поле вместо трёх экранов. */}
                <button
                    type="button"
                    onClick={() => setMode('setup')}
                    className="ml-auto flex items-center gap-2 rounded-t-md px-4 py-2 text-sm text-sp-muted-foreground transition-colors hover:text-sp-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-primary"
                >
                    <Wand2 className="h-4 w-4" aria-hidden="true" />
                    {t('Простая настройка')}
                </button>
            </nav>

            {tab === 'channels' ? (
                <ChannelsPage />
            ) : (
                <Suspense
                    fallback={<div className="p-5 text-sm text-sp-muted-foreground">{t('Загрузка…')}</div>}
                >
                    {tab === 'outputs' && <OutputsPage />}
                    {tab === 'lists' && <ListsPage />}
                    {tab === 'status' && <StatusPage />}
                </Suspense>
            )}
        </div>
    )
}
