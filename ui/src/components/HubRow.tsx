import { ChevronRight } from 'lucide-react'

/** Строка-подпункт раздела: значок, название, состояние под ним, шеврон у правого края.
 *
 *  ОДИН СТОЛБЕЦ ВО ВСЮ ШИРИНУ, а не сетка. Сетка из шести плиток в две колонки заставляет
 *  читать зигзагом и ломает порядок пунктов, который человек помнит как список; узкая
 *  колонка посреди широкого экрана оставляет справа пустоту. Строка тянется на всю область
 *  содержимого, и шеврон стоит там, где его ищут, — у края.
 *
 *  Состояние — короткая строка о том, что там сейчас: «списков используется: 6 из 142»,
 *  «активны: wg0, awg0». Не объяснение раздела: что он такое, сказано его названием. */
export default function HubRow({
    icon: Icon, title, state, alarm, onClick,
}: {
    icon: typeof ChevronRight
    title: string
    state?: string
    /** Внутри есть находка. Красит значок, а не всю строку: строка — это дорога, а не тревога. */
    alarm?: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={[
                'flex w-full select-none items-center gap-3.5 rounded-xl border border-border bg-card p-3.5 text-left shadow-card',
                'transition-colors duration-200 hover:bg-accent',
                'focus:outline-none focus:shadow-none focus-visible:ring-2 focus-visible:ring-primary lg:rounded-2xl lg:p-4',
            ].join(' ')}
        >
            <span
                className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl ${
                    alarm ? 'bg-warning/15 text-warning-fg' : 'bg-primary/10 text-primary'
                }`}
                aria-hidden="true"
            >
                <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold leading-tight">{title}</span>
                {state && (
                    <span
                        className={`mt-0.5 block truncate text-xs ${
                            alarm ? 'text-warning-fg' : 'text-subtle'
                        }`}
                    >
                        {state}
                    </span>
                )}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
    )
}
