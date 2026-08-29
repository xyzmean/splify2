/** Выключатель: дорожка с ползунком.
 *
 *  Один на весь пульт. Раньше жил внутри вкладки правил, и когда такой же понадобился в
 *  настройке скачивания, я поставил рядом обычную галочку — владелец сразу и сказал, что
 *  выключатель должен быть «вот такой». Две разные формы одного действия в одном интерфейсе
 *  — это не мелочь оформления: человек читает их как разные вещи.
 *
 *  Кнопка с role="switch", а не `input[type=checkbox]`: у галочки нельзя надёжно отобрать
 *  оформление темы LuCI, а тут геометрия жёсткая. */
export function Switch({
    on, label, onClick, disabled = false,
}: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            /* p-0 и flex здесь — не для красоты: тема LuCI задаёт кнопкам свои
               внутренние отступы, а у выключателя размер жёсткий, так что чужой
               отступ выталкивал ползунок за край дорожки. Сброс есть и в index.css,
               но контрол с фиксированной геометрией не должен на него полагаться. */
            className={`mt-0.5 flex h-5 w-9 shrink-0 items-center p-0 rounded-full border transition-colors duration-200 disabled:opacity-60 ${
                on ? 'border-primary bg-primary' : 'border-border bg-muted'
            }`}
        >
            <span
                className={`block h-4 w-4 rounded-full transition-transform duration-200 ${
                    on
                        ? 'translate-x-4 bg-primary-foreground'
                        : 'translate-x-0.5 bg-muted-foreground'
                }`}
            />
        </button>
    )
}
