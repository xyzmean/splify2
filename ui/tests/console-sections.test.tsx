import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Console from '@/components/Console'
import { rpc } from '@/lib/rpc'
import type { Status } from '@/lib/model'

// Andromeda 26.9: вкладки заменены рельсом из шести разделов, у каждого своя роль, вложенных
// вкладок нет. Проверяется не оформление, а разделение: раздел «Логи steer» был складом — в
// него въехали диагностика, счётчики трафика, движок, самообновление и архив настроек, — и по
// его названию нельзя было угадать содержимое. Здесь и стоит барьер на возврат к складу.
//
// Второе требование дизайна — «один факт, одно место». Счётчики трафика есть на обзоре и
// больше нигде; проверка на это тоже здесь, потому что доказать её можно только сравнением
// двух разделов.

const STATUS: Status = {
    schema: 1,
    outputs: { vpn: { name: 'vpn', kind: 'interface', device: 'wg0', devices: ['wg0'], up: true } },
    channels: [{ name: 'youtube', out: 'vpn', kind: 'domains', live: true, bytes: 1024, lists: 1, channels: ['youtube'] }],
}

const DIAG = {
    warn: 1,
    fail: 0,
    checks: [
        { id: 'list', verdict: 'warn' as const, what: 'список domains/telegram.lst старше суток', why: 'последняя удачная загрузка: 21 ч назад' },
        { id: 'table', verdict: 'ok' as const, what: 'правила движка в ядре', why: '' },
    ],
}

describe('рельс разделов вместо вкладок (Andromeda 26.9)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(rpc, 'status').mockResolvedValue(STATUS)
        vi.spyOn(rpc, 'diag').mockResolvedValue(DIAG)
        vi.spyOn(rpc, 'netInfo').mockResolvedValue({ uptime: 15120, active_clients: 9 })
        vi.spyOn(rpc, 'engine').mockResolvedValue({
            present: true, vless: true, version: '1.1.2', enabled: true, running: true,
        })
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [{ name: 'wg0', up: true, kind: 'wireguard' }] })
        vi.spyOn(rpc, 'devStats').mockResolvedValue({ devices: {} })
        vi.spyOn(rpc, 'engineState').mockResolvedValue({ instances: {}, log: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', path: '', present: false } as never)
    })

    it('в рельсе шесть разделов, и это они', async () => {
        render(<Console />)
        for (const name of ['Обзор', 'Правила', 'Выходы', 'Каталог', 'Диагностика', 'Система'])
            expect(await screen.findByRole('button', { name: new RegExp(name) })).toBeInTheDocument()
    })

    it('находок нет — под вердиктом НЕ печатается одинокий нуль', async () => {
        // Поймано на снимке живого роутера: условие было написано как `diag.fail || diag.warn`,
        // а нуль в JSX печатается как «0» — на исправном роутере под заголовком висела цифра,
        // которую нечем объяснить.
        vi.spyOn(rpc, 'diag').mockResolvedValue({ warn: 0, fail: 0, checks: [] })
        const { container } = render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        const main = container.querySelector('main') as HTMLElement
        expect(main.textContent).not.toMatch(/время работы 5 мин\s*0/)
        expect(screen.queryByRole('button', { name: /проверок с/ })).toBeNull()
    })

    it('открывается обзор: вердикт и счётчики устройств', async () => {
        render(<Console />)
        expect(await screen.findByRole('heading', { name: 'Маршрутизация работает' })).toBeInTheDocument()
        expect(screen.getByText(/устройств в сети: 9/)).toBeInTheDocument()
        expect(screen.getByText(/время работы 4 ч 12 мин/)).toBeInTheDocument()
    })

    it('находка названа счётчиком и ведёт в диагностику, а её текст — только там', async () => {
        render(<Console />)
        const strip = await screen.findByRole('button', { name: /проверок с предупреждением: 1/ })
        // Текст находки на обзоре НЕ печатается: он принадлежит движку и живёт в диагностике.
        expect(screen.queryByText(/telegram\.lst старше суток/)).toBeNull()
        strip.click()
        expect(await screen.findByText(/список domains\/telegram\.lst старше суток/)).toBeInTheDocument()
    })

    it('счётчики трафика есть на обзоре и НЕ повторяются в диагностике', async () => {
        render(<Console />)
        expect(await screen.findByText('Куда идёт трафик')).toBeInTheDocument()
        screen.getByRole('button', { name: /Диагностика/ }).click()
        await waitFor(() => expect(screen.queryByText('Логи steer')).toBeInTheDocument())
        expect(screen.queryByText('Куда идёт трафик')).toBeNull()
    })

    it('движок, самообновление и архив — в «Системе», а не в диагностике', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        screen.getByRole('button', { name: /Диагностика/ }).click()
        await waitFor(() => expect(screen.queryByText('Логи steer')).toBeInTheDocument())
        expect(screen.queryByText('Бекап настроек')).toBeNull()

        screen.getByRole('button', { name: /Система/ }).click()
        expect(await screen.findByText('Бекап настроек')).toBeInTheDocument()
    })

    it('у каждого раздела заголовок ровно как пункт рельса', async () => {
        // Имя печатает оболочка, а не раздел: два места с одной строкой расходятся, и человек
        // читает в рельсе одно, а над содержимым другое. У обзора заголовок — вердикт.
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        for (const name of ['Правила', 'Выходы', 'Каталог', 'Диагностика', 'Система']) {
            /* Без якоря `^`: у пункта рельса в доступном имени есть ещё счётчик, а у части
               сборок — ведущий пробел от декоративной иконки. Проверяется заголовок, не имя. */
            screen.getByRole('button', { name: new RegExp(name) }).click()
            expect(await screen.findByRole('heading', { name, level: 1 })).toBeInTheDocument()
        }
    })

    it('движок и «Остановить всё» доступны с любого раздела: они про роутер целиком', async () => {
        render(<Console />)
        expect(await screen.findByRole('button', { name: /Остановить всё/ })).toBeInTheDocument()
        screen.getByRole('button', { name: /Каталог/ }).click()
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: /Остановить всё/ })).toBeInTheDocument(),
        )
    })
})
