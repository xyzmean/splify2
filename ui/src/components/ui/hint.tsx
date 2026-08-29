import { useRef, useState } from 'react'

/** Термин с пунктиром и подсказкой при наведении.
 *
 *  Подсказка позиционируется от окна, а не от слова. Раньше она была обычным absolute внутри
 *  строки — и её резало: у карточек и таблиц свои переполнения, и подсказка у левого края
 *  выезжала за них с обрезанным текстом. С координатами от окна её не режет ничто, а по
 *  горизонтали она прижимается к экрану, а не уходит за край. */
const W = 256

export function Hint({ tip, children }: { tip: string; children?: React.ReactNode }) {
    const anchor = useRef<HTMLSpanElement>(null)
    const [at, setAt] = useState<{ left: number; top: number } | null>(null)

    function show() {
        const r = anchor.current?.getBoundingClientRect()
        if (!r) return
        const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8)
        setAt({ left, top: r.bottom + 6 })
    }

    return (
        <span
            ref={anchor}
            className="relative inline-block"
            onMouseEnter={show}
            onMouseLeave={() => setAt(null)}
        >
            <span className="cursor-default underline decoration-dotted underline-offset-[3px]">
                {children}
            </span>
            {at && (
                <span
                    role="tooltip"
                    style={{ position: 'fixed', left: at.left, top: at.top, width: W }}
                    className="pointer-events-none z-50 block rounded-md bg-[#1f2333] px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-white shadow-lg"
                >
                    {tip}
                </span>
            )}
        </span>
    )
}
