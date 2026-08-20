import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OutboundsTab from '@/components/tabs/OutboundsTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

// splify2#12: у человека два туннеля, а выбрать в правиле можно только один.
//
// Кнопка «Туннель» ищет свободное устройство по полю `device`, но с тех пор как выход
// стал списком кандидатов (`devices[]`), свежесозданный выход поля `device` не несёт
// вовсе: его ставит движок, когда failover выберет активное. Значит множество занятых
// состоит из одного `undefined`, и вторая кнопка снова берёт ПЕРВОЕ устройство. Второй
// туннель не получает выхода, в правиле его нет, и это читается как «его нельзя выбрать».
//
// Проверяется не вёрстка, а результат: два нажатия — два разных устройства.

const DEVS = [
    { name: 'awg0', up: true, kind: 'wireguard' },
    { name: 'warp0', up: true, kind: 'wireguard' },
]

const EMPTY = { schema: 1, outputs: {}, channels: [] }

describe('кнопка «Туннель» садится на свободное устройство (splify2#12)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        // Хранилище неприменённого — модульный синглтон: без сброса второй тест
        // работает со спекой первого.
        pending.saved = null
        pending.applied = null
        pending.dirty = false
        vi.spyOn(rpc, 'specGet').mockResolvedValue(EMPTY as never)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue(EMPTY as never)
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: DEVS })
        vi.spyOn(rpc, 'engine').mockResolvedValue({ vless: false } as never)
        vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
    })

    it('второе нажатие берёт второй туннель, а не тот же самый', async () => {
        render(<OutboundsTab live={live()} />)
        const add = await screen.findByRole('button', { name: /Туннель/ })
        fireEvent.click(add)
        await waitFor(() => expect(screen.getByLabelText('Убрать awg0')).toBeInTheDocument())
        fireEvent.click(add)
        // Ровно та жалоба: warp0 нигде не появляется, потому что выхода на него нет.
        await waitFor(() => expect(screen.getByLabelText('Убрать warp0')).toBeInTheDocument())
        // И первое устройство не раздаётся дважды: два выхода на одном устройстве — это
        // две метки и две таблицы маршрутизации, ведущие в одно и то же место.
        expect(screen.getAllByLabelText('Убрать awg0')).toHaveLength(1)
    })

    it('свободных устройств больше нет — говорит вслух, а не выдаёт занятое', async () => {
        render(<OutboundsTab live={live()} />)
        const add = await screen.findByRole('button', { name: /Туннель/ })
        fireEvent.click(add)
        fireEvent.click(add)
        await waitFor(() => expect(screen.getByLabelText('Убрать warp0')).toBeInTheDocument())
        fireEvent.click(add)
        await waitFor(() =>
            expect(screen.getByText(/Свободных туннельных устройств нет/)).toBeInTheDocument(),
        )
        expect(screen.getAllByLabelText(/^Убрать /)).toHaveLength(2)
    })
})
