import { useEffect, useState } from 'react'
import { ChevronLeft, Globe, Network, ShieldCheck } from 'lucide-react'
import HubRow from '@/components/HubRow'
import PoolList from '@/components/PoolList'
import IfacesPanel from '@/components/IfacesPanel'
import VlessScreen from '@/components/VlessScreen'
import XsteerPanel from '@/components/XsteerPanel'
import { rpc } from '@/lib/rpc'
import { usePending } from '@/lib/pending'
import { devList, isPart } from '@/lib/model'
import { type Live } from '@/lib/live'

/** VPN: чем роутер выходит наружу.
 *
 *  Три входа и один список. Входы отвечают на «что у меня есть»: свои туннели, узлы подписки,
 *  звезда xsteer. Список ниже — выходы, то есть то, во что правила ведут трафик; выход
 *  собирается из того, что нашлось за тремя входами.
 *
 *  Подпункт открывается НА МЕСТЕ раздела, а не отдельной вкладкой рельса: рельс отвечает за
 *  четыре роли, и раздувать его до четырнадцати пунктов значит вернуть строку вкладок, из
 *  которой видно треть. */

type Screen = 'root' | 'ifaces' | 'vless' | 'xsteer'

const TITLE: Record<Exclude<Screen, 'root'>, string> = {
    ifaces: 'VPN',
    vless: 'VLESS',
    xsteer: 'XSTEER',
}

export default function Vpn({ live }: { live: Live }) {
    const [screen, setScreen] = useState<Screen>('root')
    /** Открыт редактор выхода. Тогда раздел показывает ТОЛЬКО его: три строки-входа сверху
     *  относятся к разделу, а не к правимому выходу, и над формой читались как её часть. */
    const [editing, setEditing] = useState(false)
    const { spec } = usePending()
    const [devices, setDevices] = useState<{ name: string; up: boolean; kind: string }[]>([])

    useEffect(() => {
        rpc.devices().then((d) => setDevices(d.devices || [])).catch(() => setDevices([]))
    }, [])

    if (screen !== 'root') {
        return (
            <div className="space-y-4">
                <button
                    type="button"
                    onClick={() => setScreen('root')}
                    className="flex items-center gap-1 text-sm text-primary"
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" /> VPN
                </button>
                <h2 className="sp-title">{TITLE[screen]}</h2>
                {screen === 'ifaces' && <IfacesPanel live={live} />}
                {screen === 'vless' && <VlessScreen />}
                {screen === 'xsteer' && <XsteerPanel live={live} />}
            </div>
        )
    }

    const outputs = Object.values(spec?.outputs || {})
    /* Названо ровно то, что человек увидит, открыв подпункт: какие устройства взяты в работу,
     * сколько локаций подписки заведено, какие устройства xsteer есть. Служебные части пулов
     * считаются локациями своей подписки, а их устройства — не «свои туннели». */
    const partNames = new Set(outputs.filter((o) => isPart(o)).map((o) => o.name))
    const ifaceDevs = outputs
        .filter((o) => o.kind === 'interface')
        .flatMap((o) => devList(o))
        .filter((d) => !partNames.has(d))
    const vless = outputs.filter((o) => o.kind === 'vless')
    const vlessCount = vless.reduce(
        (n, o) => n + Math.max(1, o.nodes?.length || 0),
        0,
    )
    const subCount = new Set(vless.map((o) => o.sub_file || '')).size
    const xs = devices.filter((d) => d.kind === 'xsteer' || /^xs-/.test(d.name)).map((d) => d.name)

    /* PoolList стоит на ОДНОМ месте дерева в обоих состояниях: редактор — его внутреннее
     * состояние, и отдельная ветка `if (editing) return <PoolList/>` пересоздавала бы список
     * с нуля, то есть закрывала бы редактор в момент открытия. */
    return (
        <div className="space-y-4">
            {!editing && <div className="space-y-2.5">
                <HubRow
                    icon={ShieldCheck}
                    title="VPN"
                    state={ifaceDevs.length ? `активны: ${ifaceDevs.join(', ')}` : 'ни один туннель не взят'}
                    onClick={() => setScreen('ifaces')}
                />
                <HubRow
                    icon={Globe}
                    title="VLESS"
                    state={
                        vlessCount
                            ? `подписок: ${subCount} · локаций: ${vlessCount}`
                            : 'подписок нет'
                    }
                    onClick={() => setScreen('vless')}
                />
                <HubRow
                    icon={Network}
                    title="XSTEER"
                    state={xs.length ? xs.join(', ') : 'интерфейсов нет'}
                    onClick={() => setScreen('xsteer')}
                />
            </div>}

            <div className="space-y-3">
                {!editing && <h2 className="sp-sub">Выходы</h2>}
                <PoolList live={live} onEditingChange={setEditing} />
            </div>
        </div>
    )
}
