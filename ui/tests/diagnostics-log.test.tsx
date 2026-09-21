import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Diagnostics from '@/components/sections/Diagnostics'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

describe('диагностика: журнал steer', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('поиск по журналу фильтрует строки и позволяет сбросить фильтр', async () => {
        const lines = [
            '2026-09-21 12:00:00 steer[100]: routing packet to wg0',
            '2026-09-21 12:00:01 steer[100]: dns query youtube.com',
            '2026-09-21 12:00:02 steer[100]: warning interface down',
        ]
        vi.spyOn(rpc, 'engineState').mockResolvedValue({ log: lines } as never)
        render(<Diagnostics live={live({ diag: { checks: [], warn: 0, fail: 0 } })} />)

        expect(await screen.findByText(/dns query youtube\.com/)).toBeInTheDocument()
        expect(screen.getByText(/routing packet to wg0/)).toBeInTheDocument()

        const input = screen.getByPlaceholderText('Поиск по журналу…')
        fireEvent.input(input, { target: { value: 'youtube' } })

        expect(screen.getByText(/dns query youtube\.com/)).toBeInTheDocument()
        expect(screen.queryByText(/routing packet to wg0/)).toBeNull()

        // Кнопка сброса поиска
        const clearBtn = screen.getByLabelText('Очистить поиск')
        fireEvent.click(clearBtn)
        expect(screen.getByText(/routing packet to wg0/)).toBeInTheDocument()
    })

    it('кнопка Обновить повторно запрашивает engineState', async () => {
        const spy = vi.spyOn(rpc, 'engineState').mockResolvedValue({ log: ['line 1'] } as never)
        render(<Diagnostics live={live({ diag: { checks: [], warn: 0, fail: 0 } })} />)

        expect(await screen.findByText(/line 1/)).toBeInTheDocument()
        const refreshBtn = screen.getByRole('button', { name: /Обновить/ })
        fireEvent.click(refreshBtn)

        await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    })
})
