import { lazy, Suspense, useState } from 'react'
import { useLive } from '@/lib/live'
import StatusRail from '@/components/StatusRail'

/** Пульт: один экран вместо пары «мастер / эксперт».
 *
 *  Прежде интерфейс сам решал, что показать: пока каналов нет — мастер, появились — редактор.
 *  Переключение происходило без участия человека, и он не понимал, куда делись настройки и как
 *  вернуться. Режим теперь один: всё видно на месте, а глубина открывается по мере надобности.
 *
 *  Слева закреплённое состояние, справа работа. Разделение не косметическое: вопрос «работает
 *  ли» задаётся ПОСРЕДИ работы, и раньше за ответом надо было уйти с той вкладки, где человек
 *  что-то набирал.
 *
 *  Живые данные читает ОДИН опрос на весь экран (lib/live.ts) — иначе колонка и вкладка
 *  показывали бы два разных мгновения, и оба были бы правдой. */

const RulesTab = lazy(() => import('@/components/tabs/RulesTab'))
const OutboundsTab = lazy(() => import('@/components/OutputsPage'))
const CatalogTab = lazy(() => import('@/components/ListsPage'))
const LogsTab = lazy(() => import('@/components/tabs/LogsTab'))

type TabId = 'rules' | 'outbounds' | 'catalog' | 'logs'

/** Ярлыки вкладок. Установившиеся слова остаются английскими: «outbound» переводом не
 *  становится понятнее, а расходится с тем, что человек читает в документации движка и в
 *  чужих настройках. Переведено то, у чего есть точный русский эквивалент. */
const TABS: { id: TabId; label: string }[] = [
    { id: 'rules', label: 'Правила' },
    { id: 'outbounds', label: 'Outbounds' },
    { id: 'catalog', label: 'Сервисы и категории' },
    { id: 'logs', label: 'Логи steer' },
]

const FALLBACK = <div className="p-5 text-sm text-sp-muted-foreground">Загрузка…</div>

export default function Console() {
    const [tab, setTab] = useState<TabId>('rules')
    const live = useLive()

    return (
        <div className="sp-root text-sp-foreground">
            {/* Одна колонка на узком экране: закреплённое состояние уезжает наверх, а не
                прячется — на телефоне это первое, что человек хочет увидеть. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                <StatusRail live={live} onGoDiag={() => setTab('logs')} />

                <main className="min-w-0">
                    <nav className="mb-4 flex flex-wrap gap-1 border-b border-sp-border" role="tablist">
                        {TABS.map(({ id, label }) => (
                            <button
                                key={id}
                                role="tab"
                                aria-selected={tab === id}
                                onClick={() => setTab(id)}
                                className={[
                                    'rounded-t-md px-4 py-2 text-sm transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-primary',
                                    tab === id
                                        ? 'border-b-2 border-sp-primary font-medium text-sp-primary'
                                        : 'border-b-2 border-transparent text-sp-muted-foreground hover:text-sp-foreground',
                                ].join(' ')}
                            >
                                {label}
                            </button>
                        ))}
                    </nav>

                    <Suspense fallback={FALLBACK}>
                        {tab === 'rules' && <RulesTab live={live} />}
                        {tab === 'outbounds' && <OutboundsTab />}
                        {tab === 'catalog' && <CatalogTab />}
                        {tab === 'logs' && <LogsTab live={live} />}
                    </Suspense>

                    <div className="mt-6 border-t border-sp-border pt-3 text-right text-xs text-sp-muted-foreground">
                        powered by{' '}
                        <a
                            href="https://github.com/xyzmean/steer"
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted hover:text-sp-foreground"
                        >
                            steer
                        </a>
                    </div>
                </main>
            </div>
        </div>
    )
}
