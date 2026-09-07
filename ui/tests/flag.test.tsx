import { render } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import Flag, { flagEmoji } from '@/components/Flag'

// Флаг — эмодзи вшитым шрифтом, а не спрайт картинок. У спрайта был потолок в сорок пять стран,
// и половина локаций подписки оставалась без флага (владелец: «половины флагов нет»); шрифт
// знает все. Сторожится:
//   1. Код страны становится парой региональных букв — то, что рисует шрифт; любая страна,
//      а не только известная списку названий.
//   2. Шрифт объявляется ОДИН раз на страницу и по адресу стиля, вместе с номером сборки:
//      иначе после обновления браузер отдал бы прежний файл.
//   3. Не код страны — пусто, а не квадратик.

describe('флаг страны', () => {
    beforeEach(() => {
        document.body.innerHTML = ''
        document.getElementById('splify2-flag-font')?.remove()
        document.head.querySelectorAll('link[id^="splify2-app-css"]').forEach((l) => l.remove())
    })

    it('код — пара региональных букв, и для стран вне списка названий тоже', () => {
        expect(flagEmoji('EE')).toBe('🇪🇪')
        expect(flagEmoji('si')).toBe('🇸🇮')
        expect(flagEmoji('EU')).toBe('🇪🇺')
        const { container } = render(<Flag cc="VN" />)
        expect(container.textContent).toBe('🇻🇳')
        expect(container.firstElementChild?.getAttribute('style')).toMatch(/Twemoji Country Flags/)
    })

    it('шрифт объявляется один раз на страницу, по адресу стиля и с номером сборки', () => {
        const css = document.createElement('link')
        css.id = 'splify2-app-css-26.9.15'
        css.rel = 'stylesheet'
        css.href = 'http://router/luci-static/resources/splify2/splify-index.css?v=26.9.15'
        document.head.appendChild(css)
        render(<Flag cc="EE" />)
        render(<Flag cc="DE" />)
        const styles = document.head.querySelectorAll('#splify2-flag-font')
        expect(styles.length).toBe(1)
        expect(styles[0].textContent).toContain("url('/luci-static/resources/splify2/TwemojiCountryFlags.woff2?v=26.9.15')")
        expect(styles[0].textContent).toContain('unicode-range:U+1F1E6-1F1FF')
        css.remove()
    })

    it('не код страны — пусто, а не квадратик', () => {
        const { container } = render(<Flag cc="ZZZ" />)
        expect(container.firstElementChild).toBeNull()
        expect(render(<Flag />).container.firstElementChild).toBeNull()
    })
})
