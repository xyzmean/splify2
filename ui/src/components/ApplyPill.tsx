import { Check, Loader2 } from 'lucide-react'
import { usePending } from '@/lib/pending'

/** Плавающая пилюля «Применить · N» — единственная кнопка применения на весь экран.
 *
 *  Появляется только когда сохранённое отличается от применённого, и исчезает сама,
 *  если человек вернул всё как было: N — это разница со снимком apply, а не число
 *  кликов. Сохранение к этому моменту уже произошло (lib/pending.ts), поэтому пилюля
 *  ничем не рискует: не нажал — настройка просто ждёт на диске. */
export default function ApplyPill() {
    const { count, applying, justApplied, apply } = usePending()
    if (count === 0 && !applying && !justApplied) return null
    /* На телефоне снизу рельс: пилюля встаёт над ним, а не на него. */
    return (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 lg:bottom-6">
            <button
                type="button"
                onClick={apply}
                disabled={applying}
                title="Изменения уже сохранены. Кнопка отправит их в ядро — около двух секунд, соединения не рвутся."
                className={[
                    'flex h-11 items-center gap-2.5 rounded-full px-6 text-sm font-medium text-white',
                    'shadow-[0_6px_20px_rgba(0,0,0,0.18)] transition-all duration-300',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    justApplied ? 'bg-success' : applying ? 'bg-muted-foreground' : 'bg-primary hover:-translate-y-px',
                ].join(' ')}
            >
                {justApplied ? (
                    <>
                        <Check className="h-4 w-4" aria-hidden="true" /> Применено
                    </>
                ) : applying ? (
                    <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Применяем…
                    </>
                ) : (
                    <>
                        <Check className="h-4 w-4" aria-hidden="true" /> Применить
                        <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-white/25 px-1.5 text-xs font-semibold">
                            {count}
                        </span>
                    </>
                )}
            </button>
        </div>
    )
}
