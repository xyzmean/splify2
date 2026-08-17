import { lazy, Suspense, useState } from 'react'
import { useLive } from '@/lib/live'
import { usePending } from '@/lib/pending'
import { type ServiceEntry } from '@/lib/model'
import StatusRail from '@/components/StatusRail'
import FirstRun from '@/components/FirstRun'
import ApplyPill from '@/components/ApplyPill'
import { Check } from 'lucide-react'

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
 *  показывали бы два разных мгновения, и оба были бы правдой.
 *
 *  Сохранение автоматическое (lib/pending.ts): кнопок «Сохранить» на вкладках больше нет,
 *  применение — одна плавающая пилюля (ApplyPill) на весь экран. */

const RulesTab = lazy(() => import('@/components/tabs/RulesTab'))
const OutboundsTab = lazy(() => import('@/components/tabs/OutboundsTab'))
const CatalogTab = lazy(() => import('@/components/tabs/CatalogTab'))
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

const FALLBACK = <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

export default function Console() {
    const [tab, setTab] = useState<TabId>('rules')
    const live = useLive()
    const { savedFlash } = usePending()
    /** Сервис, который попросили «в правило». Живёт здесь, а не в каталоге, потому что
     *  переход между вкладками — дело оболочки; каталог только просит. Считывается вкладкой
     *  правил один раз и сбрасывается: иначе повторный заход на вкладку снова открывал бы
     *  редактор, которого человек уже не просил. */
    const [wanted, setWanted] = useState<ServiceEntry | null>(null)

    /* Движка нет — показываем установку ВМЕСТО вкладок. Не «рядом»: без движка ни одна из них
     * не может подействовать, и открывать их значило бы дать человеку заполнить настройку,
     * которая откажется применяться на последнем шаге.
     *
     * Пока не знаем (build === null) — вкладки, а не установку: угадав неверно, мы покажем
     * «движка нет» тому, у кого он работает, и это худшая из двух ошибок. */
    if (live.build && !live.build.present) return <FirstRun live={live} />

    return (
        <div className="sp-root text-foreground">
            {/* Одна колонка на узком экране: закреплённое состояние уезжает наверх, а не
                прячется — на телефоне это первое, что человек хочет увидеть. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                <StatusRail live={live} onGoDiag={() => setTab('logs')} />

                <main className="min-w-0">
                    <div className="mb-4 flex items-center justify-between gap-2 border-b border-border">
                        <nav className="flex flex-wrap gap-1" role="tablist">
                            {TABS.map(({ id, label }) => (
                                <button
                                    key={id}
                                    role="tab"
                                    aria-selected={tab === id}
                                    onClick={() => setTab(id)}
                                    className={[
                                        'rounded-t-md px-4 py-2 text-sm transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                        tab === id
                                            ? 'border-b-2 border-primary font-medium text-primary'
                                            : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
                                    ].join(' ')}
                                >
                                    {label}
                                </button>
                            ))}
                        </nav>
                        {/* «Сохранено» — вспышка на полторы секунды после каждой правки.
                            Взамен кнопки: подтверждение, что ничего нажимать не нужно. */}
                        <span
                            aria-hidden={!savedFlash}
                            className={[
                                'flex shrink-0 items-center gap-1.5 pb-1.5 text-xs text-muted-foreground',
                                'transition-opacity duration-300',
                                savedFlash ? 'opacity-100' : 'opacity-0',
                            ].join(' ')}
                        >
                            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> Сохранено
                        </span>
                    </div>

                    <Suspense fallback={FALLBACK}>
                        {tab === 'rules' && (
                            <RulesTab
                                live={live}
                                wanted={wanted}
                                onWantedUsed={() => setWanted(null)}
                                onGoOutbounds={() => setTab('outbounds')}
                            />
                        )}
                        {tab === 'outbounds' && <OutboundsTab live={live} />}
                        {tab === 'catalog' && (
                            <CatalogTab
                                onUseInRule={(l) => {
                                    setWanted(l)
                                    setTab('rules')
                                }}
                            />
                        )}
                        {tab === 'logs' && <LogsTab live={live} />}
                    </Suspense>

                    <div className="mt-6 border-t border-border pt-3 text-right text-xs text-muted-foreground">
                        powered by{' '}
                        <a
                            href="https://github.com/xyzmean/steer"
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted hover:text-foreground"
                        >
                            steer
                        </a>
                    </div>
                </main>
            </div>

            <ApplyPill />
        </div>
    )
}
