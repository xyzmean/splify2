import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RulesTab from '@/components/tabs/RulesTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { type Spec } from '@/lib/model'
import { live } from './fixtures'

const OUT = { name: 'awg', kind: 'interface' as const, devices: ['awg0'], on_fail: 'drop' as const }
const SPEC: Spec = {
    schema: 1,
    outputs: { awg: OUT },
    channels: [
        { name: 'YouTube Трафик', out: 'awg', match: { domains_files: ['/etc/steer/lists/domains/youtube.lst'] } },
        { name: 'Telegram', out: 'awg', match: { prefixes_files: ['/etc/steer/lists/telegram.lst'] } },
        { name: 'Discord Голос', out: 'awg', match: { domains_files: ['/etc/steer/lists/domains/discord.lst'] } },
    ],
} as unknown as Spec

describe('поиск и фильтрация правил', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(rpc, 'manifest').mockResolvedValue({} as never)
        vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: {} } as never)
        vi.spyOn(pending, 'load').mockResolvedValue(SPEC as never)
    })

    it('фильтрует правила по названию', async () => {
        render(<RulesTab live={live({ status: { outputs: SPEC.outputs } as never })} />)
        await waitFor(() => expect(screen.getAllByText('YouTube Трафик').length).toBeGreaterThan(0))
        expect(screen.getAllByText('Telegram').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Discord Голос').length).toBeGreaterThan(0)

        const searchInput = screen.getByPlaceholderText(/Поиск правил/i)
        fireEvent.input(searchInput, { target: { value: 'YouTube' } })

        expect(screen.getAllByText('YouTube Трафик').length).toBeGreaterThan(0)
        expect(screen.queryByText('Telegram')).toBeNull()
        expect(screen.queryByText('Discord Голос')).toBeNull()
        expect(screen.getByText(/найдено 1 из 3/)).toBeInTheDocument()
    })

    it('показывает пустое состояние при отсутствии совпадений и позволяет сбросить', async () => {
        render(<RulesTab live={live({ status: { outputs: SPEC.outputs } as never })} />)
        await waitFor(() => expect(screen.getAllByText('YouTube Трафик').length).toBeGreaterThan(0))

        const searchInput = screen.getByPlaceholderText(/Поиск правил/i)
        fireEvent.input(searchInput, { target: { value: 'Несуществующее' } })

        expect(screen.getByText(/ничего не нашлось/i)).toBeInTheDocument()
        const resetBtn = screen.getByRole('button', { name: 'Сбросить поиск' })
        fireEvent.click(resetBtn)

        expect(screen.getAllByText('YouTube Трафик').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Telegram').length).toBeGreaterThan(0)
    })

    it('блокирует кнопки перемещения при активном поиске', async () => {
        render(<RulesTab live={live({ status: { outputs: SPEC.outputs } as never })} />)
        await waitFor(() => expect(screen.getAllByText('YouTube Трафик').length).toBeGreaterThan(0))

        const searchInput = screen.getByPlaceholderText(/Поиск правил/i)
        fireEvent.input(searchInput, { target: { value: 'Telegram' } })

        const upButtons = screen.getAllByLabelText('Поднять приоритет')
        for (const btn of upButtons) {
            expect(btn).toBeDisabled()
        }
    })
})
