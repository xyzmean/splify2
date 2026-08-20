import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import EngineCard from '@/components/EngineCard'

// R-044: базовый и расширенный варианты существуют с самого начала, но снаружи их просят
// как отсутствующие. Половина причины — что вес назван был только у расширенного и только
// как «больше на ~250 КБ»: на вопрос «сколько займёт то, что я выбираю» это не отвечает, а
// аудитория проекта — роутеры со флешем в единицы мегабайт.
//
// Числа замерены по релизу steer 1.1.2, распакованным пакетом (то есть флеш, а не размер
// скачивания), по всем шести архитектурам: базовый 220–295 КБ, расширенный 470–590 КБ.
// Отсюда «вдвое», а не «втрое».
//
// Проверка смотрит на обе кнопки сразу: находка была в том, что вес есть у одной и нет у
// другой, и по одной кнопке её не видно.

const RELEASES = { arch: 'mipsel_24kc', versions: ['1.1.2'] }
const noop = () => {}

describe('вес вариантов движка', () => {
    it('назван у обоих вариантов, а не только у расширенного (R-044)', () => {
        render(<EngineCard engine={{ present: false, vless: false }} releases={RELEASES} onInstalled={noop} />)
        const ext = screen.getByRole('button', { name: /Расширенный/ })
        const basic = screen.getByRole('button', { name: /Базовый/ })
        expect(ext.textContent).toMatch(/~500 КБ/)
        expect(basic.textContent).toMatch(/~250 КБ/)
    })

    it('называет соотношение вариантов, чтобы выбор был понятен без калькулятора', () => {
        render(<EngineCard engine={{ present: false, vless: false }} releases={RELEASES} onInstalled={noop} />)
        expect(screen.getByRole('button', { name: /Базовый/ }).textContent).toMatch(/вдвое меньше/)
    })

    it('вес виден и когда стоит базовый, то есть в момент решения обновиться', () => {
        render(
            <EngineCard
                engine={{ present: true, vless: false, version: '1.1.2', arch: 'mipsel_24kc' }}
                releases={RELEASES}
                onInstalled={noop}
            />,
        )
        expect(screen.getByRole('button', { name: /Расширенный/ }).textContent).toMatch(/~500 КБ/)
    })
})
