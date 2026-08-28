import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FetchCard from '@/components/FetchCard'
import { rpc } from '@/lib/rpc'

// splify2#15, вторая половина. Обход по хостам самого GitHub спасает установку, но списки он
// решает не лучшим образом: contents API — лишний запрос, а при его лимите приезжает архив
// ветки целиком ради одного списка. Владелец назвал недостающее прямо: дать возможность
// качать списки и обновления через туннель — как ВЫБОР, а не как последнюю ступень.
//
// Проверяется поэтому не «карточка рисуется», а три обещания: выбор доезжает до роутера;
// неудавшаяся запись не остаётся на экране как сделанная; и «через туннель» честно
// предупреждает, когда поднятого выхода нет — иначе человек выберет режим, который ничего не
// изменит, и будет ждать.

describe('откуда качать списки и обновления (splify2#15)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('показывает то, что стоит на роутере', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'always', out: 'vl' })
        render(<FetchCard />)
        await waitFor(() =>
            expect(screen.getByRole('radio', { name: 'Через туннель' })).toHaveAttribute(
                'aria-checked',
                'true',
            ),
        )
        expect(screen.getByText(/vl/)).toBeInTheDocument()
    })

    it('выбор уезжает на роутер именно тем значением, которое понимает бэкенд', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: 'vl' })
        const set = vi.spyOn(rpc, 'fetchModeSet').mockResolvedValue({ ok: true, mode: 'always' })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('radio', { name: 'Через туннель' }))
        await waitFor(() => expect(set).toHaveBeenCalledWith('always'))
    })

    it('отказ записи возвращает прежний выбор, а не оставляет ложный', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: 'vl' })
        vi.spyOn(rpc, 'fetchModeSet').mockResolvedValue({
            ok: false,
            error: 'режим бывает auto, always или off',
        })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('radio', { name: 'Через туннель' }))
        await waitFor(() => expect(screen.getByText(/режим бывает/)).toBeInTheDocument())
        expect(screen.getByRole('radio', { name: 'Сам разберётся' })).toHaveAttribute(
            'aria-checked',
            'true',
        )
    })

    it('«через туннель» без поднятого выхода предупреждает, а не молчит', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'always', out: '' })
        render(<FetchCard />)
        await waitFor(() => expect(screen.getByText(/Поднятого выхода/)).toBeInTheDocument())
    })

    it('на «сам разберётся» про выход не говорит ничего: он и не понадобится', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: '' })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        expect(screen.queryByText(/Поднятого выхода/)).toBeNull()
    })
})
