import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import Diagnostics from '@/components/sections/Diagnostics'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

// I-253: спор за порт 53 (https-dns-proxy с force_dns=1 против резолвера движка) считался и
// показывался только на вкладке DoH. Теперь бэкенд отдаёт его приговором `doh_force` среди
// проверок, и диагностика — то место, куда приходят с «применилось, но не работает», — обязана
// не только показать его, но и дать ту же кнопку, что на вкладке DoH: посылать человека на
// другую вкладку за одним нажатием значило бы показать проблему и спрятать решение.

const CHECK = {
    id: 'doh_force', verdict: 'fail' as const,
    what: 'https-dns-proxy перенаправляет DNS сети сам и спорит с движком: правила по доменам действуют через раз',
    why: 'Кто перехватит запрос первым, решает порядок запуска служб.',
}
const OTHER = { id: 'table', verdict: 'fail' as const, what: 'таблицы нет', why: '' }

function mount(checks: typeof CHECK[]) {
    vi.spyOn(rpc, 'engineState').mockResolvedValue({ log: [] } as never)
    const refresh = vi.fn()
    render(<Diagnostics live={live({ diag: { checks, warn: 0, fail: checks.length }, refresh })} />)
    return refresh
}

describe('диагностика: спор за порт 53', () => {
    it('приговор doh_force показан дословно и с кнопкой «Оставить движку»', async () => {
        mount([CHECK])
        expect(await screen.findByText(/спорит с движком/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Оставить движку' })).toBeInTheDocument()
    })

    it('кнопка чинит ключ тем же методом, что вкладка DoH, и перечитывает проверки', async () => {
        const fix = vi.spyOn(rpc, 'dohForceFix').mockResolvedValue({ ok: true })
        const refresh = mount([CHECK])
        fireEvent.click(await screen.findByRole('button', { name: 'Оставить движку' }))
        await waitFor(() => expect(fix).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(refresh).toHaveBeenCalled())
    })

    it('у остальных приговоров кнопки нет', async () => {
        mount([OTHER])
        expect(await screen.findByText('таблицы нет')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Оставить движку' })).toBeNull()
    })
})
