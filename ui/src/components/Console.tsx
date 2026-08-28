import { lazy, Suspense, useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { useLive } from '@/lib/live'
import { pending, usePending } from '@/lib/pending'
import { type ServiceEntry } from '@/lib/model'
import { SECTION_TITLE, type SectionId } from '@/lib/sections'
import Rail from '@/components/Rail'
import FirstRun from '@/components/FirstRun'
import ApplyPill from '@/components/ApplyPill'
import Overview from '@/components/sections/Overview'
import OutputsStatus from '@/components/OutputsStatus'

/** Пульт: рельс разделов слева, работа справа.
 *
 *  Прежде здесь была строка вкладок, и одна из четырёх («Логи steer») собрала всё, что не
 *  влезло в остальные. Дизайн Andromeda 26.9 заменил вкладки шестью разделами: обзор, правила,
 *  выходы, каталог, диагностика, система. Вложенных вкладок нет — у каждого раздела одна роль.
 *
 *  Что ещё изменилось вместе с этим. Закреплённая колонка состояния (StatusRail) разобрана:
 *  вердикт, предупреждения и счётчики трафика ушли на обзор, движок и «Остановить всё» — в
 *  подвал рельса, список выходов с откликом — в раздел выходов. Колонка повторяла половину
 *  каждой вкладки, и два числа об одном и том же расходились на глазах.
 *
 *  Живые данные читает ОДИН опрос на весь экран (lib/live.ts) — иначе рельс и раздел показывали
 *  бы два разных мгновения, и оба были бы правдой.
 *
 *  Сохранение автоматическое (lib/pending.ts): кнопок «Сохранить» в разделах нет, применение —
 *  одна плавающая пилюля (ApplyPill) на весь экран. */

const RulesTab = lazy(() => import('@/components/tabs/RulesTab'))
const OutboundsTab = lazy(() => import('@/components/tabs/OutboundsTab'))
const CatalogTab = lazy(() => import('@/components/tabs/CatalogTab'))
const Diagnostics = lazy(() => import('@/components/sections/Diagnostics'))
const System = lazy(() => import('@/components/sections/System'))

const FALLBACK = <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

export default function Console() {
    const [section, setSection] = useState<SectionId>('overview')
    const live = useLive()
    const { spec, savedFlash } = usePending()
    /** Сервис, который попросили «в правило». Живёт здесь, а не в каталоге, потому что переход
     *  между разделами — дело оболочки; каталог только просит. Считывается разделом правил один
     *  раз и сбрасывается: иначе повторный заход снова открывал бы редактор, которого человек
     *  уже не просил. */
    const [wanted, setWanted] = useState<ServiceEntry | null>(null)

    /* Спека нужна рельсу для счётчика правил, а он виден на всех разделах — значит загрузить её
     * обязана оболочка, а не раздел правил. Вызов идемпотентен: кто пришёл раньше, тот и
     * загрузил (lib/pending.ts). */
    useEffect(() => { void pending.load() }, [])

    /* Движка нет — показываем установку ВМЕСТО разделов. Не «рядом»: без движка ни один из них
     * не может подействовать, и открывать их значило бы дать человеку заполнить настройку,
     * которая откажется применяться на последнем шаге.
     *
     * Пока не знаем (build === null) — разделы, а не установку: угадав неверно, мы покажем
     * «движка нет» тому, у кого он работает, и это худшая из двух ошибок. */
    if (live.build && !live.build.present) return <FirstRun live={live} />

    const warnings = (live.diag?.fail ?? 0) + (live.diag?.warn ?? 0)
    const counts = {
        rules: spec ? { text: String(spec.channels.length) } : undefined,
        outputs: live.status
            ? { text: String(Object.keys(live.status.outputs || {}).length) }
            : undefined,
        diag: warnings > 0 ? { text: String(warnings), alarm: true } : undefined,
    }

    return (
        <div className="sp-root text-foreground">
            <div className="flex min-h-[32rem] flex-col lg:flex-row">
                <Rail live={live} section={section} onSection={setSection} counts={counts} />

                <main className="min-w-0 flex-1 p-4 lg:p-6">
                    {/* «Сохранено» — вспышка на полторы секунды после каждой УДАВШЕЙСЯ записи, а
                        не после правки: взамен кнопки эта галочка — единственное, по чему человек
                        судит, уехало ли что-нибудь на роутер. */}
                    <div className="mb-1 flex h-4 justify-end">
                        <span
                            aria-hidden={!savedFlash}
                            className={[
                                'flex items-center gap-1.5 text-xs text-muted-foreground',
                                'transition-opacity duration-300',
                                savedFlash ? 'opacity-100' : 'opacity-0',
                            ].join(' ')}
                        >
                            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> Сохранено
                        </span>
                    </div>

                    {/* Имя раздела печатает ОБОЛОЧКА, а не сам раздел: оно обязано совпадать
                        с пунктом рельса дословно, а два места с одной строкой расходятся. У
                        обзора заголовок другой — им служит вердикт, и второго над ним не надо. */}
                    {section !== 'overview' && (
                        <h1 className="sp-title mb-3">{SECTION_TITLE[section]}</h1>
                    )}

                    <Suspense fallback={FALLBACK}>
                        {section === 'overview' && <Overview live={live} onSection={setSection} />}
                        {section === 'rules' && (
                            <RulesTab
                                live={live}
                                wanted={wanted}
                                onWantedUsed={() => setWanted(null)}
                                onGoOutbounds={() => setSection('outputs')}
                            />
                        )}
                        {section === 'outputs' && (
                            <div className="space-y-4">
                                <OutputsStatus live={live} />
                                <OutboundsTab live={live} />
                            </div>
                        )}
                        {section === 'catalog' && (
                            <CatalogTab
                                onUseInRule={(l) => {
                                    setWanted(l)
                                    setSection('rules')
                                }}
                            />
                        )}
                        {section === 'diag' && <Diagnostics live={live} />}
                        {section === 'system' && <System live={live} />}
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
