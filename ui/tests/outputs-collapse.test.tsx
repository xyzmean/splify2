import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OutboundsTab from '@/components/tabs/OutboundsTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Spec, Status } from '@/lib/model'

// Выход целиком — это подписка, узлы, обфускация и список устройств. Развёрнутыми все они
// занимали экран целиком: на роутере с тремя выходами найти нужный можно было только
// прокруткой, а на телефоне прокруткой длиной в несколько экранов.
//
// Свёрнутый выход обязан отвечать на «работает ли и куда ведёт» БЕЗ нажатия — иначе спойлер
// не сворачивает, а прячет. Поэтому в шапке точка состояния, имя, расшифровка и отклик, и
// проверяется здесь именно это, а не сам факт сворачивания.
//
// Заодно барьер на возврат карточки «Сейчас работает»: она повторяла имя, состояние и
// устройство каждого выхода прямо над его же настройкой.

const SPEC: Spec = {
    schema: 1,
    outputs: {
        vl: { name: 'vl', kind: 'vless', sub_file: '/etc/steer/sub.txt', node: -1, on_fail: 'drop' },
        wg: { name: 'wg', kind: 'interface', device: 'wg0', devices: ['wg0'], on_fail: 'drop' },
    },
    channels: [],
}

const STATUS: Status = {
    schema: 1,
    outputs: {
        vl: { name: 'vl', kind: 'vless', device: 'vl', up: true, mark: '0x00100000', table: 300 },
        wg: { name: 'wg', kind: 'interface', device: 'wg0', up: true, nat: true, mark: '0x00200000', table: 301 },
    },
    channels: [],
}

describe('выходы свёрнуты в спойлеры (Andromeda 26.9)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        pending.saved = SPEC
        pending.applied = SPEC
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [{ name: 'wg0', up: true, kind: 'wireguard' }] })
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true })
        vi.spyOn(rpc, 'outboundGeo').mockImplementation(
            (async (n: string) => ({ output: n, state: 'ok', ms: n === 'vl' ? 71 : 12, how: '' })) as never,
        )
        vi.spyOn(rpc, 'vlessNodes').mockRejectedValue(new Error('не спрашиваем'))
    })

    it('шапка отвечает на «куда ведёт» без нажатия', async () => {
        render(<OutboundsTab live={live({ status: STATUS })} />)
        expect(await screen.findByText('VLESS/Reality · vl')).toBeInTheDocument()
        expect(screen.getByText('свой туннель · wg0')).toBeInTheDocument()
    })

    it('отклик спрашивается один раз и показан в шапке', async () => {
        render(<OutboundsTab live={live({ status: STATUS })} />)
        await waitFor(() => expect(screen.getByText('71 мс')).toBeInTheDocument())
        expect(screen.getByText('12 мс')).toBeInTheDocument()
        expect(rpc.outboundGeo).toHaveBeenCalledTimes(2)
    })

    it('свёрнутый выход не разворачивает свою настройку', async () => {
        render(<OutboundsTab live={live({ status: STATUS })} />)
        await screen.findByText('VLESS/Reality · vl')
        // Два выхода — оба свёрнуты: полей имени нет ни у одного.
        expect(screen.queryByLabelText('Имя выхода vl')).toBeNull()
        expect(screen.queryByLabelText('Имя выхода wg')).toBeNull()
    })

    it('нажатие раскрывает ровно один выход', async () => {
        render(<OutboundsTab live={live({ status: STATUS })} />)
        const head = await screen.findByText('VLESS/Reality · vl')
        ;(head.closest('button') as HTMLButtonElement).click()
        expect(await screen.findByLabelText('Имя выхода vl')).toBeInTheDocument()
        expect(screen.queryByLabelText('Имя выхода wg')).toBeNull()
    })

    it('единственный выход раскрыт сам: нажатие ни за что не нужно', async () => {
        pending.saved = { ...SPEC, outputs: { vl: SPEC.outputs.vl } }
        pending.applied = pending.saved
        render(<OutboundsTab live={live({ status: STATUS })} />)
        expect(await screen.findByLabelText('Имя выхода vl')).toBeInTheDocument()
    })

    it('карточки «Сейчас работает» больше нет: имя и состояние в одном месте', async () => {
        render(<OutboundsTab live={live({ status: STATUS })} />)
        await screen.findByText('VLESS/Reality · vl')
        expect(screen.queryByText('Сейчас работает')).toBeNull()
        // Имя выхода встречается РОВНО один раз — в шапке своего спойлера.
        expect(screen.getAllByText('vl').length).toBe(1)
    })
})
