import { lazy, Suspense, useState } from 'react'
import { Activity, GitBranch, ListChecks, Network } from 'lucide-react'
import { t } from '@/lib/i18n'

// Channels is the page people open; the rest are split out so the first paint does
// not carry them. The chunk names and their ?v= pinning are handled by the build —
// see ui/scripts/pin-chunks.mjs, and note that ONE chunk referenced two ways is
// loaded twice by the browser, which cost a dead tab in splify 1.
const OutputsPage = lazy(() => import('@/components/OutputsPage'))
const ListsPage = lazy(() => import('@/components/ListsPage'))
const StatusPage = lazy(() => import('@/components/StatusPage'))
import ChannelsPage from '@/components/ChannelsPage'

type TabId = 'channels' | 'outputs' | 'lists' | 'status'

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
    { id: 'channels', label: 'Каналы', icon: GitBranch },
    { id: 'outputs', label: 'Выходы', icon: Network },
    { id: 'lists', label: 'Списки', icon: ListChecks },
    { id: 'status', label: 'Состояние', icon: Activity },
]

export default function App() {
    const [tab, setTab] = useState<TabId>('channels')

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
