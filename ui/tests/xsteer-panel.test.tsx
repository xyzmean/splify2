import { render, screen, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Status } from '@/lib/model'
import { live } from './fixtures'

// Панель xsteer: то, чего в НАСТРОЙКЕ нет, — состояние туннеля и ссылка xs://.
//
// Проверяется не вёрстка, а четыре места, где ошибка молчалива и дорога:
//
//   1. «поднят» берётся из ответа ПРОЦЕССА, а не из наличия устройства. Устройство создаёт
//      обработчик протокола ДО запуска движка, поэтому оно есть и у туннеля, который ни разу
//      не дозвонился: судить по нему значило бы рисовать зелёную точку неработающему туннелю.
//   2. состояния нет вовсе (`state: null`) — это «не поднимался», а не «поднят и молчит».
//      Разница ровно та, за которой человек сюда и приходит.
//   3. файл состояния устарел — процесс убили, а его последнее «up: true» осталось лежать.
//      Без возраста такой туннель выглядел бы живым навсегда.
//   4. ссылка НЕ показывается сама: в ней приватный ключ, то есть выданный доступ целиком.
//      Показанная на обзорном экране, она остаётся открытой на чужом мониторе у всякого, кто
//      просто смотрел состояние.
//
// И пятое, про совместимость: движок без умения `xslink` не должен ломать панель — кнопки нет,
// а версия, с которой она появляется, названа.

const h = vi.hoisted(() => ({
    xsteerState: vi.fn(),
    devices: vi.fn(),
    xsteerLink: vi.fn(),
    xsteerLinkPut: vi.fn(),
}))

vi.mock('@/lib/rpc', () => ({
    rpc: {
        xsteerState: h.xsteerState,
        devices: h.devices,
        xsteerLink: h.xsteerLink,
        xsteerLinkPut: h.xsteerLinkPut,
    },
}))

const { default: XsteerPanel } = await import('@/components/XsteerPanel')

const FEATURES = ['lan_devices', 'pool', 'xslink', 'xsteer_state']
const status = (features: string[] = FEATURES): Status =>
    ({ schema: 1, features, outputs: {}, channels: [] }) as unknown as Status

const STATE = {
    up: true,
    mtu: 1420,
    conns: 2,
    hub: '203.0.113.7:443',
    hub_key: 'A8ltDzuN',
    handshake_age: 37,
    stream: false,
    offload: { gso: true, gro: true, rx: true },
    mtu_confirmed: 1420,
    resets: 3,
    last_down: 'путь молчит',
    tx_packets: 10,
    tx_bytes: 2048,
    rx_packets: 12,
    rx_bytes: 4096,
    dropped: 0,
}

function mount(tunnels: Record<string, unknown>, features = FEATURES) {
    h.xsteerState.mockResolvedValue({ ok: true, tunnels })
    h.devices.mockResolvedValue({ devices: [{ name: 'xs-home', up: true, kind: 'xsteer' }] })
    render(<XsteerPanel live={live({ status: status(features) })} />)
}

describe('панель xsteer', () => {
    it('показывает хаб, рукопожатие, разгрузку и переподнятия', async () => {
        mount({ home: { device: 'xs-home', age: 2, state: STATE } })
        expect(await screen.findByText('203.0.113.7:443')).toBeInTheDocument()
        expect(screen.getByText('(A8ltDzuN)')).toBeInTheDocument()
        expect(screen.getByText('37 с назад')).toBeInTheDocument()
        expect(screen.getByText('полная')).toBeInTheDocument()
        expect(screen.getByText('3')).toBeInTheDocument()
        expect(screen.getByText(/путь молчит/)).toBeInTheDocument()
    })

    it('разгрузка не встала — сказано отдельным словом, а не молчанием', async () => {
        mount({
            home: {
                device: 'xs-home',
                age: 1,
                state: { ...STATE, offload: { gso: false, gro: false, rx: false } },
            },
        })
        expect(await screen.findByText('выключена')).toBeInTheDocument()
    })

    it('встала наполовину — это третье состояние, а не «есть/нет»', async () => {
        mount({
            home: {
                device: 'xs-home',
                age: 1,
                state: { ...STATE, offload: { gso: true, gro: true, rx: false } },
            },
        })
        expect(await screen.findByText('частичная')).toBeInTheDocument()
    })

    it('состояния нет — «не поднимался», а не пустые числа', async () => {
        mount({ home: { device: 'xs-home', state: null } })
        expect(await screen.findByText(/не поднимался в эту загрузку/)).toBeInTheDocument()
        expect(screen.queryByText('203.0.113.7:443')).toBeNull()
    })

    it('устаревший файл: числа названы последними, а не текущими', async () => {
        mount({ home: { device: 'xs-home', age: 300, state: STATE } })
        expect(await screen.findByText(/Процесс не отвечает 300 с/)).toBeInTheDocument()
    })

    it('ссылка не показывается сама — только по нажатию', async () => {
        h.xsteerLink.mockResolvedValue({ ok: true, link: 'xs://k@203.0.113.7:443?pk=p&ip=10.77.0.2/24' })
        mount({ home: { device: 'xs-home', age: 1, state: STATE } })
        const btn = await screen.findByText('Показать ссылку xs://')
        expect(screen.queryByText(/^xs:\/\//)).toBeNull()
        await userEvent.click(btn)
        await waitFor(() =>
            expect(screen.getByText('xs://k@203.0.113.7:443?pk=p&ip=10.77.0.2/24')).toBeInTheDocument(),
        )
        expect(h.xsteerLink).toHaveBeenCalledWith({ iface: 'home' })
        /* И предупреждение рядом: без него скопированная ссылка выглядит как безобидный адрес. */
        expect(screen.getByText(/приватный ключ этого пира/)).toBeInTheDocument()
    })

    it('вставленная ссылка уходит на роутер вместе с именем интерфейса', async () => {
        h.xsteerLinkPut.mockResolvedValue({ ok: true, iface: 'home', hub: '198.51.100.9:8443' })
        mount({ home: { device: 'xs-home', age: 1, state: STATE } })
        await screen.findByText('Показать ссылку xs://')
        const area = screen.getByPlaceholderText(/^xs:\/\//)
        await userEvent.type(area, 'xs://k@198.51.100.9:8443?pk=p&ip=10.77.0.5/24')
        await userEvent.click(screen.getByText('Принять и поднять заново'))
        await waitFor(() =>
            expect(h.xsteerLinkPut).toHaveBeenCalledWith({
                iface: 'home',
                link: 'xs://k@198.51.100.9:8443?pk=p&ip=10.77.0.5/24',
            }),
        )
        expect(await screen.findByText(/хаб 198.51.100.9:8443/)).toBeInTheDocument()
    })

    it('отказ роутера показан его словами, а не «что-то не так»', async () => {
        h.xsteerLinkPut.mockResolvedValue({ ok: false, error: 'неизвестный параметр snii' })
        mount({ home: { device: 'xs-home', age: 1, state: STATE } })
        await screen.findByText('Показать ссылку xs://')
        await userEvent.type(screen.getByPlaceholderText(/^xs:\/\//), 'xs://k@1.2.3.4:443?snii=a')
        await userEvent.click(screen.getByText('Принять и поднять заново'))
        expect(await screen.findByText('неизвестный параметр snii')).toBeInTheDocument()
    })

    it('движок без умения xslink: кнопок нет, а нужная версия названа', async () => {
        mount({ home: { device: 'xs-home', age: 1, state: STATE } }, ['lan_devices'])
        expect(await screen.findByText(/steer 1.3.0 и новее/)).toBeInTheDocument()
        expect(screen.queryByText('Показать ссылку xs://')).toBeNull()
    })

    it('интерфейсов нет — сказано, что туннель создаётся в настройках сети', async () => {
        mount({})
        expect(await screen.findByText('Интерфейсов xsteer нет')).toBeInTheDocument()
        expect(screen.getByText(/Создать в настройках сети/)).toBeInTheDocument()
    })
})

// Бэкенд постарее интерфейса: метода xsteer_state он не знает, и вызов отказывает.
//
// Проверяется ровно то, что легко перепутать: отказ вызова — это НЕ «туннелей нет». Показать в
// этом случае «интерфейсов xsteer нет» значило бы соврать про настройку роутера, и человек пошёл
// бы создавать второй туннель рядом с существующим.
describe('панель xsteer: бэкенд старее интерфейса', () => {
    it('отказ вызова не выдаётся за отсутствие туннелей', async () => {
        h.xsteerState.mockRejectedValue(new Error('ubus: method not found'))
        h.devices.mockResolvedValue({ devices: [] })
        render(<XsteerPanel live={live({ status: status() })} />)
        expect(await screen.findByText('Роутер не рассказывает про xsteer')).toBeInTheDocument()
        expect(screen.queryByText('Интерфейсов xsteer нет')).toBeNull()
    })
})
