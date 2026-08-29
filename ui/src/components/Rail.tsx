import {
    Gauge, Library, Route, Settings, Stethoscope, Waypoints,
} from 'lucide-react'
import EngineToggle from '@/components/EngineToggle'
import { type Live } from '@/lib/live'
import { type SectionId } from '@/lib/sections'

/** Рельс разделов: шесть пунктов, у каждого своя роль, вложенных вкладок нет.
 *
 *  Заменил строку вкладок. Вкладок было четыре, и в одну из них («Логи steer») въехало всё,
 *  что не влезло в остальные: диагностика, счётчики, движок, самообновление и архив настроек.
 *  Название вкладки перестало описывать её содержимое, а найти в ней что-либо можно было
 *  только прокруткой. Рельс это разделяет: шесть разделов, и каждый отвечает на один вопрос.
 *
 *  ДВЕ РАСКЛАДКИ, и это решение дизайна 26.9, а не адаптация «на всякий случай». На широком
 *  экране рельс стоит слева колонкой и держит в подвале движок и «Остановить всё». На узком он
 *  уходит в НИЖНЮЮ ПАНЕЛЬ: колонка, сжатая до ширины телефона, превращалась в полосу, из
 *  которой видно три пункта из шести, а остальные надо было проматывать, не зная, что там
 *  есть что проматывать. Нижняя панель показывает все шесть сразу и стоит там, где до неё
 *  дотягивается большой палец.
 *
 *  Счётчики у пунктов — не украшение. «Правила 4» отвечает на вопрос, который иначе требует
 *  зайти в раздел, а цифра у диагностики — единственное место, где о находке видно, не
 *  открывая её. Написаны они как счётчики: подпись и число, без склонений после числительного.
 *  В нижней панели их нет: там на пункт приходится 60 пикселей, и число в них читается как
 *  часть подписи. */

const ITEMS: { id: SectionId; label: string; icon: typeof Gauge }[] = [
    { id: 'overview', label: 'Обзор', icon: Gauge },
    { id: 'rules', label: 'Правила', icon: Route },
    { id: 'outputs', label: 'Выходы', icon: Waypoints },
    { id: 'catalog', label: 'Каталог', icon: Library },
    { id: 'diag', label: 'Диагностика', icon: Stethoscope },
    { id: 'system', label: 'Система', icon: Settings },
]

export interface RailProps {
    live: Live
    section: SectionId
    onSection: (s: SectionId) => void
    /** Числа у пунктов. Приходят снаружи: рельс не должен спрашивать роутер сам — тогда на
     *  экране оказались бы два разных мгновения, его и разделов. */
    counts: Partial<Record<SectionId, { text: string; alarm?: boolean }>>
}

export default function Rail({ live, section, onSection, counts }: RailProps) {
    return (
        <>
            {/* ── широкий экран: колонка слева ─────────────────────────────────────── */}
            <aside className="hidden shrink-0 flex-col gap-4 border-r border-border bg-rail p-4 lg:flex lg:w-[236px]">
                <div className="flex items-center gap-2.5 px-1.5">
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

                <nav className="flex flex-col gap-0.5" aria-label="Разделы">
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
                                    'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors duration-200',
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
                                        className={`ml-auto text-[11px] ${
                                            c.alarm ? 'font-semibold text-warning-fg' : 'text-muted-foreground'
                                        }`}
                                    >
                                        {c.text}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </nav>

                <div className="mt-auto">
                    <EngineToggle live={live} variant="rail" onSection={onSection} />
                </div>
            </aside>

            {/* ── узкий экран: нижняя панель ───────────────────────────────────────── */}
            <nav
                aria-label="Разделы"
                className="sp-bottom-bar fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-rail lg:hidden"
            >
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
                                'relative flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 pb-2 pt-2.5',
                                'text-[11px] leading-tight transition-colors duration-200',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                                on ? 'font-medium text-primary' : 'text-subtle',
                            ].join(' ')}
                        >
                            <Icon className="h-[19px] w-[19px] shrink-0" aria-hidden="true" />
                            {/* Подпись не сокращается до иконки: шесть значков без слов — это
                                шесть загадок, и «Каталог» от «Системы» по картинке не отличить.
                                «Диагностика» в 60 пикселей не влезает целиком, поэтому у неё
                                короткая форма — она же стоит и в заголовке раздела ниже. */}
                            <span className="w-full truncate text-center">
                                {id === 'diag' ? 'Диагн.' : label}
                            </span>
                            {/* Находка помечается точкой, а не числом: числу здесь негде встать,
                                а вопрос, на который отвечает пункт, — «есть ли о чём знать». */}
                            {c?.alarm && (
                                <span
                                    className="absolute right-[18%] top-1.5 h-1.5 w-1.5 rounded-full bg-warning"
                                    aria-hidden="true"
                                />
                            )}
                        </button>
                    )
                })}
            </nav>
        </>
    )
}
