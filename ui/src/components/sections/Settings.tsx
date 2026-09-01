import { useEffect, useState } from 'react'
import { ChevronLeft, Info, Layers, Library, Network, Sliders, Stethoscope } from 'lucide-react'
import HubRow from '@/components/HubRow'
import Diagnostics from '@/components/sections/Diagnostics'
import CatalogTab from '@/components/tabs/CatalogTab'
import BackupCard from '@/components/BackupCard'
import ClientNetsCard from '@/components/ClientNetsCard'
import CustomLists from '@/components/CustomLists'
import EngineCard from '@/components/EngineCard'
import FetchCard from '@/components/FetchCard'
import SelfUpdateCard from '@/components/SelfUpdateCard'
import XsteerPanel from '@/components/XsteerPanel'
import ZmFixCard from '@/components/ZmFixCard'
import { rpc } from '@/lib/rpc'
import { pending, usePending } from '@/lib/pending'
import { type ServiceEntry, type Spec } from '@/lib/model'
import { type Live } from '@/lib/live'

/** Настройки: всё, что не про маршрутизацию, шестью входами.
 *
 *  Раздел-склад («Логи steer») в проекте уже был: в него въезжало всё, что не влезло в
 *  остальные вкладки, и найти в нём что-либо можно было только прокруткой. Здесь вместо
 *  склада шесть названных входов, и каждый открывает своё содержимое на месте раздела. */

type Screen = 'root' | 'diag' | 'general' | 'catalog' | 'xsteer' | 'extra' | 'about'

const TITLE: Record<Exclude<Screen, 'root'>, string> = {
    diag: 'Диагностика',
    general: 'Общее',
    catalog: 'Каталог',
    xsteer: 'XSTEER',
    extra: 'Дополнительно',
    about: 'О ПО',
}

export default function Settings({
    live, onUseInRule, initial,
}: {
    live: Live
    /** Запись каталога «в правило»: переход между разделами — дело оболочки. */
    onUseInRule: (s: ServiceEntry) => void
    /** Подпункт, который просили открыть сразу: строка находки на главной ведёт в
     *  диагностику, а не в перечень входов, где её пришлось бы искать заново. */
    initial?: Screen
}) {
    const [screen, setScreen] = useState<Screen>(initial ?? 'root')
    const { spec } = usePending()
    const [local, setLocal] = useState<Record<string, { count: number; mtime: number }>>({})
    const [editable, setEditable] = useState<Spec | null>(null)

    const reloadLocal = () =>
        rpc.localLists().then((d) => setLocal(d.files || {})).catch(() => setLocal({}))

    useEffect(() => {
        void reloadLocal()
        pending.load().then(setEditable).catch(() => setEditable(null))
    }, [])

    /* Просьба открыть подпункт приходит снаружи и может повториться: человек вернулся на
     * главную и снова нажал на находку. */
    useEffect(() => { if (initial) setScreen(initial) }, [initial])

    const warnings = (live.diag?.fail ?? 0) + (live.diag?.warn ?? 0)

    if (screen !== 'root') {
        return (
            <div className="space-y-4">
                <div className="flex flex-wrap items-baseline gap-2">
                    <button
                        type="button"
                        onClick={() => setScreen('root')}
                        className="flex items-center gap-1 text-sm text-primary"
                    >
                        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Настройки
                    </button>
                    <span className="text-sm text-muted-foreground">/</span>
                    <h2 className="sp-title">{TITLE[screen]}</h2>
                </div>
                <>
                    {screen === 'diag' && <Diagnostics live={live} />}
                    {screen === 'general' && (
                        <div className="space-y-4">
                            <ClientNetsCard
                                spec={editable}
                                status={live.status}
                                onChange={(next) => {
                                    setEditable(next)
                                    pending.edit(next)
                                }}
                            />
                            <FetchCard />
                            <ZmFixCard />
                        </div>
                    )}
                    {screen === 'catalog' && <CatalogTab onUseInRule={onUseInRule} />}
                    {screen === 'xsteer' && <XsteerPanel live={live} />}
                    {screen === 'extra' && (
                        <div className="space-y-4">
                            <CustomLists local={local} onChanged={reloadLocal} />
                            <BackupCard />
                        </div>
                    )}
                    {screen === 'about' && (
                        <div className="space-y-4">
                            <EngineCard
                                engine={live.build}
                                releases={live.releases}
                                onInstalled={live.refresh}
                            />
                            <SelfUpdateCard info={live.selfUpdate} onInstalled={live.refresh} />
                        </div>
                    )}
                </>
            </div>
        )
    }

    /* Свои — это custom/, а не всё, что лежит на роутере: скачанные списки каталога тоже
       файлы, и «своих списков: 47» на роутере с двумя своими было неправдой. */
    const own = Object.keys(local).filter((f) => f.startsWith('custom/')).length
    const used = new Set(
        (spec?.channels || []).flatMap((c) => [
            ...(c.match.prefixes_files || []),
            ...(c.match.domains_files || []),
        ]),
    ).size

    return (
        <div className="space-y-2.5">
            <HubRow
                icon={Stethoscope}
                title="Диагностика"
                state={
                    live.diag?.fail
                        ? `проверок с отказом: ${live.diag.fail}`
                        : live.diag?.warn
                          ? `проверок с предупреждением: ${live.diag.warn}`
                          : 'находок нет'
                }
                alarm={warnings > 0}
                onClick={() => setScreen('diag')}
            />
            <HubRow
                icon={Sliders}
                title="Общее"
                state={(live.status?.lan_devices || spec?.lan_devices || []).join(', ') || undefined}
                onClick={() => setScreen('general')}
            />
            <HubRow
                icon={Library}
                title="Каталог"
                state={`списков используется: ${used}`}
                onClick={() => setScreen('catalog')}
            />
            <HubRow icon={Network} title="XSTEER" onClick={() => setScreen('xsteer')} />
            <HubRow
                icon={Layers}
                title="Дополнительно"
                state={own ? `своих списков: ${own}` : undefined}
                onClick={() => setScreen('extra')}
            />
            <HubRow
                icon={Info}
                title="О ПО"
                state={[
                    live.selfUpdate?.current ? `splify2 ${live.selfUpdate.current}` : '',
                    live.build?.version ? `steer ${live.build.version}` : '',
                ]
                    .filter(Boolean)
                    .join(' · ') || undefined}
                onClick={() => setScreen('about')}
            />
        </div>
    )
}
