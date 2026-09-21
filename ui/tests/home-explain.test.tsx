import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from '@/components/sections/Home'
import { rpc } from '@/lib/rpc'
import { type Live } from '@/lib/live'
import type { Status } from '@/lib/model'

const status = {
    outputs: {
        vless: { kind: 'vless', device: 'vless', up: true, mark: '0x00100000', table: 300 },
    },
    channels: [{ name: 'Youtube', out: 'vless', kind: 'domains', live: true }],
} as unknown as Status

const live = {
    status,
    devices: {},
    net: { uptime: 1200, active_clients: 0 },
    diag: undefined,
    build: { present: true, version: '1.3.0' },
    releases: [],
    selfUpdate: { current: '1.2.5' },
    refresh: () => undefined,
} as unknown as Live

describe('обзор: проверка маршрутизации (ExplainCard)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
        vi.spyOn(rpc, 'specGet').mockResolvedValue({
            schema: 1,
            outputs: { vless: { name: 'vless', kind: 'vless' } },
            channels: [{ name: 'Youtube', out: 'vless', match: { domains_files: ['/a.lst'] } }],
        } as never)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue({ schema: 1, outputs: {}, channels: [] } as never)
        vi.spyOn(rpc, 'subList').mockRejectedValue(new Error('нет метода'))
        vi.spyOn(rpc, 'subQuota').mockRejectedValue(new Error('нет метода'))
        vi.spyOn(rpc, 'outboundGeo').mockRejectedValue(new Error('нет метода'))
    })

    it('быстрые подсказки доменов вызывают rpc.explain', async () => {
        const spy = vi.spyOn(rpc, 'explain').mockResolvedValue({ text: 'youtube.com -> vless (правило: Youtube)' })
        render(<Home live={live} onSection={() => undefined} onAddRule={() => undefined} />)

        const youtubeChip = screen.getByRole('button', { name: 'youtube.com' })
        expect(youtubeChip).toBeInTheDocument()

        fireEvent.click(youtubeChip)
        await waitFor(() => expect(spy).toHaveBeenCalledWith('youtube.com'))
        expect(await screen.findByText(/youtube\.com -> vless/)).toBeInTheDocument()

        // Кнопка очистки стирает результат и поле
        const clearBtn = screen.getByLabelText('Очистить')
        fireEvent.click(clearBtn)
        expect(screen.queryByText(/youtube\.com -> vless/)).toBeNull()
    })
})
