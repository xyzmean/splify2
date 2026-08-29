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

describe('качать списки через туннель (splify2#15)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('показывает то, что стоит на роутере', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'always', out: 'vl' })
        render(<FetchCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        expect(screen.getByText(/vl/)).toBeInTheDocument()
    })

    it('выключенное состояние — это «auto», а не запрет туннеля', async () => {
        // Запрет (`off`) остаётся в uci для того, кто дойдёт до консоли: выключенный
        // переключатель означает «не ходи туда сразу», а не «не ходи туда никогда».
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: 'vl' })
        const set = vi.spyOn(rpc, 'fetchModeSet').mockResolvedValue({ ok: true, mode: 'always' })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        expect(screen.getByRole('switch')).not.toBeChecked()
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith('always'))
    })

    it('обратно выключается в auto', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'always', out: 'vl' })
        const set = vi.spyOn(rpc, 'fetchModeSet').mockResolvedValue({ ok: true, mode: 'auto' })
        render(<FetchCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith('auto'))
    })

    it('отказ записи возвращает прежнее положение, а не оставляет ложное', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: 'vl' })
        vi.spyOn(rpc, 'fetchModeSet').mockResolvedValue({
            ok: false,
            error: 'режим бывает auto, always или off',
        })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(screen.getByText(/режим бывает/)).toBeInTheDocument())
        expect(screen.getByRole('switch')).not.toBeChecked()
    })

    it('включено, а поднятого выхода нет — предупреждает, а не молчит', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'always', out: '' })
        render(<FetchCard />)
        await waitFor(() => expect(screen.getByText(/Поднятого выхода/)).toBeInTheDocument())
    })

    it('выключено — про выход не говорит ничего: он и не понадобится', async () => {
        vi.spyOn(rpc, 'fetchMode').mockResolvedValue({ mode: 'auto', out: '' })
        render(<FetchCard />)
        await waitFor(() => expect(rpc.fetchMode).toHaveBeenCalled())
        expect(screen.queryByText(/Поднятого выхода/)).toBeNull()
    })
})
