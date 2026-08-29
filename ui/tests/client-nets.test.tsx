import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ClientNetsCard from '@/components/ClientNetsCard'
import { rpc } from '@/lib/rpc'
import { normalizeSpec } from '@/lib/model'
import { type Spec } from '@/lib/model'

// splify2#16: «Не только устройства из br-lan».
//
// Роутер бывает выходной точкой не только для домашнего моста: у автора обращения через него
// ходят хосты из Tailscale и ZeroTier, и правила к ним нужны те же. В splify1 это был перечень
// интерфейсов через запятую в /etc/config; здесь экран об этом вопросе не знал вовсе, а движок
// без указаний забирает трафик с одного br-lan.
//
// Движок отвечает на «кто» ИМЕНЕМ устройства (`iifname`), а не подсетью, и это решает сам
// вопрос обращения: у tailscale0 адрес на роутере /32, подсеть пиров из него не выводится.
// Поэтому в спеку едет `lan_devices` — имена, — а подсети на экране только помогают узнать
// устройство.
//
// Проверяется круг «показал — записал — прочитал обратно»: что на экране, то и в спеке.

const NETS = {
    nets: [
        { name: 'br-lan', up: true, wan: false, subnets: ['192.168.1.0/24'] },
        { name: 'br-guest', up: false, wan: false, subnets: [] },
        { name: 'tailscale0', up: true, wan: false, subnets: ['100.64.1.5/32'] },
        { name: 'wan', up: true, wan: true, subnets: ['46.42.16.0/22'] },
    ],
}

const BASE: Spec = { schema: 1, outputs: {}, channels: [] }

function mount(spec: Spec) {
    const onChange = vi.fn()
    render(<ClientNetsCard spec={spec} onChange={onChange} />)
    return onChange
}

function lastSpec(onChange: ReturnType<typeof vi.fn>): Spec {
    return onChange.mock.calls[onChange.mock.calls.length - 1][0] as Spec
}

describe('кого маршрутизируем (splify2#16)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
        vi.spyOn(rpc, 'clientNets').mockResolvedValue(NETS)
    })

    it('молчащая спека показана как умолчание движка, а не как «никого»', async () => {
        mount(BASE)
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByRole('checkbox', { name: /br-lan/ })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /tailscale0/ })).not.toBeChecked()
    })

    it('отметка кладёт в спеку ИМЯ устройства, а не подсеть', async () => {
        const onChange = mount(BASE)
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('checkbox', { name: /tailscale0/ }))
        await waitFor(() => expect(onChange).toHaveBeenCalled())
        expect(lastSpec(onChange).lan_devices).toEqual(['br-lan', 'tailscale0'])
        expect(lastSpec(onChange).from_default).toBeUndefined()
    })

    it('сокращённая форма читается наравне с полной', async () => {
        mount({ ...BASE, lan_devices: ['tailscale0'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByRole('checkbox', { name: /tailscale0/ })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /br-lan/ })).not.toBeChecked()
    })

    it('последнее устройство снять нельзя: пустой список движок отвергает', async () => {
        const onChange = mount({ ...BASE, lan_devices: ['br-lan'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('checkbox', { name: /br-lan/ }))
        expect(onChange).not.toHaveBeenCalled()
        expect(screen.getByText(/хотя бы одно/i)).toBeInTheDocument()
    })

    it('устройство из спеки, которого на роутере нет, не теряется', async () => {
        // Демон Tailscale запускается позже сети, и правило по `iifname` это переживает —
        // значит и экран обязан: снятый молча флажок означал бы, что настройка пропала.
        mount({ ...BASE, lan_devices: ['br-lan', 'ztrfyzwvfa'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        const gone = screen.getByRole('checkbox', { name: /ztrfyzwvfa/ })
        expect(gone).toBeChecked()
        expect(screen.getByText(/сейчас на роутере нет/i)).toBeInTheDocument()
    })

    it('выбор внешнего интерфейса не запрещён, но назван бедой', async () => {
        mount({ ...BASE, lan_devices: ['br-lan', 'wan'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByRole('checkbox', { name: /wan/ })).toBeChecked()
        expect(screen.getByText(/весь мир по ту сторону/i)).toBeInTheDocument()
    })

    it('пока клиентов задают подсети, устройства не действуют — и это сказано', async () => {
        // Движок берёт ЛИБО подсети, либо устройства: from_default пишут, чтобы клиентов
        // ограничить, и второе правило по устройству молча расширило бы это ограничение.
        mount({ ...BASE, from_default: ['192.168.1.0/24'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByText(/подсет/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /устройств/i })).toBeInTheDocument()
    })

    it('переход на устройства убирает подсети, а не оставляет противоречие', async () => {
        const onChange = mount({ ...BASE, from_default: ['192.168.1.0/24'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: /устройств/i }))
        await waitFor(() => expect(onChange).toHaveBeenCalled())
        expect(lastSpec(onChange).from_default).toBeUndefined()
    })

    it('второе устройство рядом с подсетями не отправляется: движок отверг бы спеку', async () => {
        const onChange = mount({ ...BASE, from_default: ['192.168.1.0/24'] })
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByRole('checkbox', { name: /tailscale0/ })).toBeDisabled()
        expect(onChange).not.toHaveBeenCalled()
    })

    it('устройство без адреса отмечается, о пустоте сказано', async () => {
        mount(BASE)
        await waitFor(() => expect(rpc.clientNets).toHaveBeenCalled())
        expect(screen.getByRole('checkbox', { name: /br-guest/ })).not.toBeDisabled()
        expect(screen.getByText(/адреса пока нет/i)).toBeInTheDocument()
    })
})

describe('две формы записи устройств (splify2#16)', () => {
    it('сокращённая сводится к списку на входе, как и у путей списков', () => {
        const s = normalizeSpec({ schema: 1, outputs: {}, channels: [], lan_device: 'br-lan' })
        expect(s.lan_devices).toEqual(['br-lan'])
        expect(s.lan_device).toBeUndefined()
    })

    it('полная форма побеждает сокращённую, а не складывается с ней', () => {
        // Движок такую спеку отвергает («задано и lan_device, и lan_devices»), но прочитать
        // её интерфейс обязан: она могла приехать из архива настроек чужого роутера.
        const s = normalizeSpec({
            schema: 1,
            outputs: {},
            channels: [],
            lan_device: 'br-lan',
            lan_devices: ['br-lan', 'tailscale0'],
        })
        expect(s.lan_devices).toEqual(['br-lan', 'tailscale0'])
        expect(s.lan_device).toBeUndefined()
    })

    it('спека без устройств остаётся без них: молчание значит «умолчание движка»', () => {
        const s = normalizeSpec({ schema: 1, outputs: {}, channels: [] })
        expect(s.lan_devices).toBeUndefined()
        expect('lan_device' in s).toBe(false)
    })
})
