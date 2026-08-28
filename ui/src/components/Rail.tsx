import { useState } from 'react'
import {
    Gauge, Library, Power, Route, Settings, Stethoscope, Waypoints,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { engineAction } from '@/lib/engine'
import { type Live } from '@/lib/live'
import { type SectionId } from '@/lib/sections'

/** Рельс разделов: шесть пунктов, у каждого своя роль, вложенных вкладок нет.
 *
 *  Заменил строку вкладок. Вкладок было четыре, и в одну из них («Логи steer») въехало всё,
 *  что не влезло в остальные: диагностика, счётчики, движок, самообновление и архив настроек.
 *  Название вкладки перестало описывать её содержимое, а найти в ней что-либо можно было
 *  только прокруткой. Рельс это разделяет: шесть разделов, и каждый отвечает на один вопрос.
 *
 *  Счётчики у пунктов — не украшение. «Правила 4» отвечает на вопрос, который иначе требует
 *  зайти в раздел, а цифра у диагностики — единственное место, где о находке видно, не открывая
 *  её. Написаны они как счётчики, а не прозой: подпись и число, без склонений после числительного.
 *
 *  Внизу — движок и «Остановить всё». Оба переехали сюда из закреплённой колонки состояния и
 *  оба здесь по одной причине: они относятся к роутеру целиком, а не к разделу, и человек ищет
 *  их тогда же, когда смотрит «работает ли». */

const ITEMS: { id: SectionId; label: string; icon: typeof Gauge }[] = [
    { id: 'overview', label: 'Обзор', icon: Gauge },
    { id: 'rules', label: 'Правила', icon: Route },
    { id: 'outputs', label: 'Выходы', icon: Waypoints },
    { id: 'catalog', label: 'Каталог', icon: Library },
    { id: 'diag', label: 'Диагностика', icon: Stethoscope },
    { id: 'system', label: 'Система', icon: Settings },
]

export default function Rail({
    live, section, onSection, counts,
}: {
    live: Live
    section: SectionId
    onSection: (s: SectionId) => void
    /** Числа у пунктов. Приходят снаружи: рельс не должен спрашивать роутер сам — тогда на
     *  экране оказались бы два разных мгновения, его и разделов. */
    counts: Partial<Record<SectionId, { text: string; alarm?: boolean }>>
}) {
    const [toggling, setToggling] = useState(false)
    const [ask, confirmDialog] = useConfirm()
    const eng = live.build

    /** Остановить всё или вернуть обратно.
     *
     *  Подтверждение обязательно и только на остановке: она снимает маршрутизацию у всех, кто
     *  сейчас в сети, и вдобавок автозапуск, то есть перезагрузкой не чинится. Запуск ничего
     *  не ломает и спрашивать не о чем. */
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

    return (
        /* На узком экране рельс становится полосой поверх содержимого и прокручивается
           горизонтально. Нижняя панель, задуманная дизайном для телефона, — отдельная работа:
           она требует другого места для движка и «Остановить всё», а не только переноса
           пунктов. Полоса при этом уже работает и ничего не прячет. */
        <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-rail p-3 lg:h-full lg:w-[236px] lg:border-b-0 lg:border-r lg:p-4">
            {confirmDialog}
            <div className="hidden items-center gap-2.5 px-1.5 lg:flex">
                <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground"
                    aria-hidden="true"
                >
                    s
                </span>
                <div className="min-w-0 leading-tight">
                    <div className="text-[15px] font-semibold">splify2</div>
                    {/* Версия — та, что стоит, а не та, что задумана: строку читают, чтобы
                        сверить с релизом. Пока её не спросили, места она не занимает. */}
                    <div className="truncate text-[11px] text-muted-foreground">
                        {live.selfUpdate?.current ? `${live.selfUpdate.current} Andromeda` : 'Andromeda'}
                    </div>
                </div>
            </div>

            <nav className="flex gap-0.5 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="Разделы">
                {ITEMS.map(({ id, label, icon: Icon }) => {
                    const on = section === id
                    const c = counts[id]
                    return (
                        <button
                            key={id}
                            type="button"
                            aria-current={on ? 'page' : undefined}
                            onClick={() => onSection(id)}
                            className={[
                                'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors duration-200',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                on
                                    ? 'bg-primary/10 font-medium text-primary'
                                    : 'text-subtle hover:bg-accent hover:text-foreground',
                            ].join(' ')}
                        >
                            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                            {label}
                            {c && (
                                <span
                                    className={`ml-auto hidden text-[11px] lg:block ${
                                        c.alarm ? 'font-semibold text-warning' : 'text-muted-foreground'
                                    }`}
                                >
                                    {c.text}
                                </span>
                            )}
                        </button>
                    )
                })}
            </nav>

            <div className="mt-auto flex flex-col gap-2">
                {/* Сведения о движке — только на широком экране: на телефоне это три строки
                    справки в самом начале страницы, ради которых человек пролистывает до
                    содержимого. А вот кнопку ниже прятать нельзя — см. комментарий у неё. */}
                {eng && (
                    <div className="hidden rounded-xl border border-border p-2.5 lg:block">
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
                        <button
                            type="button"
                            onClick={() => onSection('system')}
                            className="mt-1 text-[12px] text-primary underline decoration-dotted"
                        >
                            {/* Подпись считает engineAction, а не эта строка: то же действие
                                названо ещё и в разделе «Система», и пока слово выбиралось в
                                двух местах, они расходились — колонка обещала обновление,
                                которого нет (I-038). */}
                            {engineAction(eng, live.releases).label}
                        </button>
                    </div>
                )}

                {/* Показывается только при установленном движке — останавливать нечего, пока
                    его нет, а кнопка в никуда хуже отсутствующей.

                    На телефоне она остаётся: просьба из публичного теста была дословно про
                    ОДНУ кнопку, которой снимается маршрутизация, и спрятать её на том экране,
                    с которого чаще всего и тушат интернет в доме, значит не выполнить просьбу. */}
                {eng?.present && (
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
        </aside>
    )
}
