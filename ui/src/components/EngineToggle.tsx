import { useState } from 'react'
import { Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { engineAction } from '@/lib/engine'
import { type Live } from '@/lib/live'
import { type SectionId } from '@/lib/sections'

/** «Остановить всё» — и то, что стоит рядом с ней: какой движок установлен и есть ли что
 *  обновлять.
 *
 *  Отдельным компонентом, потому что мест у неё ДВА, и это не дубль: на широком экране она
 *  живёт в подвале рельса, на узком рельс уезжает в нижнюю панель, куда красная кнопка на всю
 *  ширину не поместится и не должна. Логика при этом одна — включая подтверждение, которое
 *  обязано быть одинаковым в обоих местах.
 *
 *  Просьба из публичного теста (R-017) была дословно про ОДНУ кнопку, которой снимается
 *  маршрутизация целиком. Спрятать её на телефоне значило бы не выполнить просьбу ровно на том
 *  экране, с которого чаще всего и тушат интернет в доме. */

export default function EngineToggle({
    live, variant, onSection,
}: {
    live: Live
    /** `rail` — подвал рельса: сведения о движке плюс кнопка. `block` — узкий экран: только
     *  кнопка, сведения там были бы тремя строками справки поперёк дороги. */
    variant: 'rail' | 'block'
    onSection?: (s: SectionId) => void
}) {
    const [toggling, setToggling] = useState(false)
    const [ask, confirmDialog] = useConfirm()
    const eng = live.build

    /** Подтверждение обязательно и только на остановке: она снимает маршрутизацию у всех, кто
     *  сейчас в сети, и вдобавок автозапуск, то есть перезагрузкой не чинится. Запуск ничего не
     *  ломает и спрашивать не о чем. */
    async function toggleEngine() {
        const stopping = eng?.enabled !== false
        if (stopping) {
            const ok = await ask({
                title: 'Остановить всё?',
                body:
                    'Маршрутизация снимется целиком: движок остановится, правила из ядра уйдут. ' +
                    'Автозапуск тоже снимется, поэтому перезагрузка роутера ничего не вернёт — ' +
                    'включать придётся этой же кнопкой.',
                confirmLabel: 'Остановить',
            })
            if (!ok) return
        }
        setToggling(true)
        try {
            const r = stopping ? await rpc.engineStop() : await rpc.engineStart()
            notify(
                stopping ? 'Движок остановлен' : r.running ? 'Движок запущен' : 'Движок включён, но не поднялся',
                stopping || r.running ? 'info' : 'warning',
            )
            live.refresh()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setToggling(false)
        }
    }

    /* Ни движка, ни сведений о нём — показывать нечего: останавливать нечего, пока его нет, а
     * кнопка в никуда хуже отсутствующей. */
    if (!eng) return null

    return (
        <div className="flex flex-col gap-2">
            {confirmDialog}
            {variant === 'rail' && (
                <div className="rounded-xl border border-border p-2.5">
                    {eng.present ? (
                        <>
                            <div className="text-[11px] text-muted-foreground">движок</div>
                            <div className="truncate text-[13px]">
                                steer {eng.version || '—'} · {eng.vless ? 'extended' : 'basic'}
                            </div>
                        </>
                    ) : (
                        <div className="text-[13px]">
                            Движка нет
                            <div className="text-[11px] text-muted-foreground">
                                применить настройку нечем
                            </div>
                        </div>
                    )}
                    {onSection && (
                        <button
                            type="button"
                            onClick={() => onSection('settings')}
                            className="mt-1 text-[12px] text-primary underline decoration-dotted"
                        >
                            {/* Подпись считает engineAction, а не эта строка: то же действие
                                названо ещё и в разделе «Система», и пока слово выбиралось в двух
                                местах, они расходились — рельс обещал обновление, которого нет
                                (I-038). */}
                            {engineAction(eng, live.releases).label}
                        </button>
                    )}
                </div>
            )}

            {eng.present && (
                <div>
                    <Button
                        variant={eng.enabled === false ? 'secondary' : 'destructive'}
                        className="w-full"
                        onClick={toggleEngine}
                        disabled={toggling}
                    >
                        <Power className="h-4 w-4" aria-hidden="true" />
                        {toggling ? 'Секунду…' : eng.enabled === false ? 'Запустить' : 'Остановить всё'}
                    </Button>
                    {eng.enabled === false && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                            автозапуск снят: перезагрузка движок не вернёт
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
