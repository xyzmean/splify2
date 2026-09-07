/** Флаг страны — эмодзи, нарисованное ВШИТЫМ шрифтом.
 *
 *  Флаг-эмодзи — это пара региональных букв (🇪🇪 = E+E), и рисует его шрифт. В Windows своего
 *  шрифта с флагами нет: там, где мы ждали флаг, человек видел две мелкие буквы. Первый ответ
 *  на это был спрайт из картинок — 55 КБ на сорок пять стран, собранных вручную, — и у него
 *  оказался потолок: у подписки нашлись Словения, Вьетнам и «EU», и половина строк осталась без
 *  флага (владелец: «svg это круто, но… половины флагов нет»). Дорисовывать по стране в
 *  спрайт — бесконечная работа, а все двести пятьдесят картинками весят мегабайты.
 *
 *  Шрифт решает это разом: Twemoji Country Flags — подмножество шрифта Twemoji Mozilla, только
 *  флаги, цветной COLR, 78 КБ на все страны. Его и подкладывает Firefox в Windows, а мы
 *  подкладываем всем: браузер берёт наш шрифт для региональных букв (unicode-range) и системный
 *  для всего остального. Где системные флаги есть (macOS, iOS, Android), они тоже подойдут —
 *  наш стоит первым в списке ради одинакового вида везде.
 *
 *  ОТДЕЛЬНЫМ ФАЙЛОМ, А НЕ В БАНДЛЕ: 78 КБ удорожали бы каждое открытие страницы ради картинки,
 *  которой на неподнятом туннеле и не будет. @font-face объявляется отсюда, а не из index.css:
 *  адрес шрифта выводится из адреса уже загруженного стиля (под LuCI ресурсы лежат в
 *  /luci-static/resources/splify2/, на стенде — в корне; lib/assets.ts), и номер сборки берётся
 *  оттуда же — иначе после обновления браузер отдал бы прежний файл. Стиль в документе один на
 *  все флаги.
 *
 *  Незнакомый код — пусто, а не заглушка: рядом всегда стоит название страны или сам код. */

import { assetUrl } from '@/lib/assets'

const STYLE_ID = 'splify2-flag-font'
export const FLAG_FONT = "'Twemoji Country Flags', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif"

/** Объявить шрифт один раз на страницу, сколько бы флагов её ни просило. */
function ensureFont() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
    const st = document.createElement('style')
    st.id = STYLE_ID
    /* unicode-range — только региональные буквы: шрифт не должен перехватывать ничего
       другого, а браузер благодаря диапазону не скачает его на странице без флагов. */
    st.textContent =
        `@font-face{font-family:'Twemoji Country Flags';src:url('${assetUrl('TwemojiCountryFlags.woff2')}') format('woff2');` +
        'unicode-range:U+1F1E6-1F1FF;font-display:swap}'
    document.head.appendChild(st)
}

/** 🇪🇪 из «EE»: две региональные буквы подряд. Не двухбуквенный код — пусто. */
export function flagEmoji(cc?: string): string {
    const code = (cc || '').trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) return ''
    return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
}

export default function Flag({ cc, className = '' }: { cc?: string; className?: string }) {
    const glyph = flagEmoji(cc)
    if (!glyph) return null
    ensureFont()
    return (
        <span
            className={`inline-block shrink-0 leading-none ${className}`}
            style={{ fontFamily: FLAG_FONT }}
            aria-hidden="true"
        >
            {glyph}
        </span>
    )
}
