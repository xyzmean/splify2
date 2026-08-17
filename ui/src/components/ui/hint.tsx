import { useState } from 'react'

/** Термин с пунктиром и тултипом при наведении.
 *
 *  Замена длинным абзацам под контролами: короткая строка остаётся на экране, а
 *  объяснение приходит тогда, когда о нём спросили наведением. Позиционируется
 *  относительно самого слова, так что работает в таблицах и переполняемых панелях. */
export function Hint({ tip, children }: { tip: string; children?: React.ReactNode }) {
    const [on, setOn] = useState(false)
    return (
        <span
            className="relative inline-block"
            onMouseEnter={() => setOn(true)}
            onMouseLeave={() => setOn(false)}
        >
            <span className="cursor-default underline decoration-dotted underline-offset-[3px]">
                {children}
            </span>
            {on && (
                <span
                    role="tooltip"
                    className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 w-64 -translate-x-1/2 rounded-md bg-[#1f2333] px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-white shadow-lg"
                >
                    {tip}
                </span>
            )}
        </span>
    )
}
