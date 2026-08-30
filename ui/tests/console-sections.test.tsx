import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Console from '@/components/Console'
import { rpc } from '@/lib/rpc'
import type { Status } from '@/lib/model'

// Andromeda: вкладки заменены рельсом из ЧЕТЫРЁХ разделов — главная, правила, VPN, настройки.
// Проверяется не оформление, а разделение: раздел «Логи steer» был складом — в него въехали
// диагностика, счётчики трафика, движок, самообновление и архив настроек, — и по его названию
// нельзя было угадать содержимое. Здесь и стоит барьер на возврат к складу.
//
// Глубина внутри раздела — подпункты, а не пункты рельса: у VPN и настроек свои списки входов,
// которые открываются на месте раздела.
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

/** Пункт рельса. Разметка рельса ДВОЙНАЯ — колонка для широкого экрана и нижняя панель для
 *  узкого, — и в браузере видна ровно одна: вторую убирает `display: none` из медиазапроса.
 *  jsdom каскад не считает, поэтому здесь в дереве обе, и берётся первая (колонка). Проверять
 *  обе одним запросом нечем и незачем: раскладки разные по построению. */
const nav = (name: string | RegExp) => screen.getAllByRole('button', { name })[0]

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

    it('в рельсе четыре раздела, и это они', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        for (const name of ['Главная', 'Правила', 'VPN', 'Настройки'])
            expect(nav(new RegExp(name))).toBeInTheDocument()
        // Прежние пункты стали подпунктами и в рельсе их нет.
        for (const gone of ['Каталог', 'Диагностика', 'Система'])
            expect(screen.queryAllByRole('button', { name: new RegExp(`^\\s*${gone}`) })).toHaveLength(0)
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

    it('открывается главная: вердикт и счётчики устройств', async () => {
        render(<Console />)
        expect(await screen.findByRole('heading', { name: 'Маршрутизация работает' })).toBeInTheDocument()
        expect(screen.getByText(/устройств в сети: 9/)).toBeInTheDocument()
        expect(screen.getByText(/время работы 4 ч 12 мин/)).toBeInTheDocument()
    })

    it('находка названа счётчиком и ведёт в диагностику, а её текст — только там', async () => {
        render(<Console />)
        const strip = await screen.findByRole('button', { name: /проверок с предупреждением: 1/ })
        // Текст находки на главной НЕ печатается: он принадлежит движку и живёт в диагностике.
        expect(screen.queryByText(/telegram\.lst старше суток/)).toBeNull()
        strip.click()
        expect(await screen.findByText(/список domains\/telegram\.lst старше суток/)).toBeInTheDocument()
    })

    it('счётчики трафика есть на главной и НЕ повторяются в диагностике', async () => {
        // Трафик теперь стоит СТРОКОЙ ПРАВИЛА, а не отдельной таблицей наборов: набор — это
        // не правило, и таблица наборов рядом со списком правил была вторым списком того же.
        render(<Console />)
        expect(await screen.findByText(/1,0 КБ/)).toBeInTheDocument()
        nav(/Настройки/).click()
        // Раздел приезжает отдельным куском — ждём, пока появится список входов.
        ;(await screen.findByRole('button', { name: /Диагностика/ })).click()
        await waitFor(() => expect(screen.queryByText('Логи steer')).toBeInTheDocument())
        expect(screen.queryByText(/1,0 КБ/)).toBeNull()
    })

    it('архив — в «Дополнительно», а не в диагностике', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        nav(/Настройки/).click()
        ;(await screen.findByRole('button', { name: /Диагностика/ })).click()
        await waitFor(() => expect(screen.queryByText('Логи steer')).toBeInTheDocument())
        expect(screen.queryByText('Бекап настроек')).toBeNull()

        // Кнопка «назад» внутри раздела — последняя: до неё в дереве стоят два пункта рельса.
        screen.getAllByRole('button', { name: /Настройки/ }).at(-1)!.click()
        ;(await screen.findByRole('button', { name: /Дополнительно/ })).click()
        expect(await screen.findByText('Бекап настроек')).toBeInTheDocument()
    })

    it('у каждого раздела заголовок ровно как пункт рельса', async () => {
        // Имя печатает оболочка, а не раздел: два места с одной строкой расходятся, и человек
        // читает в рельсе одно, а над содержимым другое. У главной заголовок — вердикт.
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        for (const name of ['Правила', 'VPN', 'Настройки']) {
            /* Без якоря `^`: у пункта рельса в доступном имени есть ещё счётчик, а у части
               сборок — ведущий пробел от декоративной иконки. Проверяется заголовок, не имя. */
            nav(new RegExp(name)).click()
            expect(await screen.findByRole('heading', { name, level: 1 })).toBeInTheDocument()
        }
    })

    it('движок и «Остановить всё» доступны с любого раздела: они про роутер целиком', async () => {
        render(<Console />)
        // Кнопка тоже в двух местах: подвал колонки и блок под содержимым для узкого экрана.
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        expect(screen.getAllByRole('button', { name: /Остановить всё/ }).length).toBeGreaterThan(0)
        nav(/Настройки/).click()
        await waitFor(() =>
            expect(screen.getAllByRole('button', { name: /Остановить всё/ }).length).toBeGreaterThan(0),
        )
    })
})
