import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import EngineCard from '@/components/EngineCard'
import SelfUpdateCard from '@/components/SelfUpdateCard'
import Rail from '@/components/Rail'
import { cmpVersion, engineAction, releaseName } from '@/lib/engine'
import { live } from './fixtures'

// Выпуски проекта названы кодовым именем: «26.9 Andromeda», «26.9.1 Andromeda». Ставится при
// этом ЧИСЛО — в имени файла пакета (`luci-app-splify2-26.9-1_noarch.apk`), в теге и в URL
// пробелу места нет ни у apk, ни у opkg. То есть версия и название — две разные строки, и
// путать их нельзя ни в одну сторону: подпись без имени не сходится со страницей релизов, а
// значение с именем не скачается.
//
// Второе требование — «считать новее». Сравнение числовое, поэтому «26.9» новее «1.2.0», хотя
// строкой меньше; и число составляющих значения не имеет — требовать три части значило бы
// объявить собственный выпуск непонятным.

const RELEASES = {
    arch: 'aarch64_cortex-a53',
    versions: ['26.9.1', '26.9', '1.2.0'],
    names: { '26.9.1': '26.9.1 Andromeda', '26.9': '26.9 Andromeda' },
}
const noop = () => {}

describe('сравнение версий', () => {
    it('«26.9» новее «1.2.0», хотя строкой меньше', () => {
        expect(cmpVersion('1.2.0', '26.9')).toBeLessThan(0)
        expect(cmpVersion('26.9', '1.2.0')).toBeGreaterThan(0)
    })

    it('число составляющих сравнению не мешает', () => {
        expect(cmpVersion('26.9', '26.9.1')).toBeLessThan(0)
        expect(cmpVersion('26.9', '26.9.0')).toBe(0)
        expect(cmpVersion('26.10', '26.9')).toBeGreaterThan(0)
    })

    it('кодовое имя в строке версии сравнение не ломает', () => {
        // Версия с именем приезжать не должна, но если приедет — сравниваются числа, а не
        // буквы: иначе «26.9 Andromeda» оказалось бы несравнимым ни с чем.
        expect(cmpVersion('26.9 Andromeda', '1.2.0')).toBeGreaterThan(0)
        expect(cmpVersion('26.9 Andromeda', '26.9.1 Andromeda')).toBeLessThan(0)
        expect(cmpVersion('26.9 Andromeda', '26.9')).toBe(0)
    })

    it('нечисловая версия не считается старше всех молча', () => {
        // Пустой набор чисел равен пустому: «неизвестно» — это не «нуль».
        expect(cmpVersion('nightly', 'dev')).toBe(0)
    })
})

describe('название выпуска', () => {
    it('берётся из релиза', () => {
        expect(releaseName('26.9', RELEASES.names)).toBe('26.9 Andromeda')
    })
    it('нет названия — версия называет себя сама', () => {
        expect(releaseName('1.2.0', RELEASES.names)).toBe('1.2.0')
        expect(releaseName('1.2.0', undefined)).toBe('1.2.0')
        expect(releaseName('1.2.0', { '1.2.0': '   ' })).toBe('1.2.0')
    })
})

describe('подпись действия называет выпуск, а не число', () => {
    it('«Обновить до 26.9.1 Andromeda» на устаревшем движке', () => {
        const a = engineAction(
            { present: true, vless: true, version: '1.2.0' },
            RELEASES,
        )
        expect(a.outdated).toBe(true)
        expect(a.label).toBe('Обновить до 26.9.1 Andromeda')
        // Ставится при этом версия, а не название.
        expect(a.latest).toBe('26.9.1')
    })

    it('бэкенд названий не присылает — подпись остаётся с числом', () => {
        const a = engineAction(
            { present: true, vless: true, version: '1.2.0' },
            { arch: 'x', versions: ['26.9.1'] },
        )
        expect(a.label).toBe('Обновить до 26.9.1')
    })

    it('на самом свежем выпуске обновляться не зовёт', () => {
        const a = engineAction({ present: true, vless: true, version: '26.9.1' }, RELEASES)
        expect(a.outdated).toBe(false)
        expect(a.label).toBe('Переустановить')
    })
})

describe('выпадающие списки: показывается имя, ставится версия', () => {
    it('карточка движка', () => {
        render(
            <EngineCard
                engine={{ present: true, vless: true, version: '1.2.0', arch: 'aarch64_cortex-a53' }}
                releases={RELEASES}
                onInstalled={noop}
            />,
        )
        const opt = screen.getByRole('option', { name: /26\.9\.1 Andromeda/ }) as HTMLOptionElement
        expect(opt.value).toBe('26.9.1')
        // Релиз без названия остаётся числом и из списка не исчезает.
        expect(screen.getByRole('option', { name: /^1\.2\.0/ })).toBeInTheDocument()
    })

    it('карточка интерфейса', () => {
        render(
            <SelfUpdateCard
                info={{ current: '1.2.0', versions: ['26.9', '1.2.0'], names: RELEASES.names }}
                onInstalled={noop}
            />,
        )
        const opt = screen.getByRole('option', { name: /26\.9 Andromeda/ }) as HTMLOptionElement
        expect(opt.value).toBe('26.9')
        expect(screen.getByRole('button', { name: /Обновить до 26\.9 Andromeda/ })).toBeInTheDocument()
    })

    it('и подвал рельса говорит то же слово, что карточка (I-038)', () => {
        render(
            <Rail
                live={live({
                    build: { present: true, vless: true, version: '1.2.0', arch: 'aarch64_cortex-a53' },
                    releases: RELEASES,
                })}
                section="overview"
                onSection={noop}
                counts={{}}
            />,
        )
        expect(screen.getByRole('button', { name: 'Обновить до 26.9.1 Andromeda' })).toBeInTheDocument()
    })
})
