import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from '@/components/sections/Home'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Status } from '@/lib/model'

// Данные ровно как на стенде 10.8.1.87: два выхода vless из одной подписки, у первого
// измерение пустое (бэкенд помнит пустой ответ), у второго — RU.
const STATUS: Status = {
    schema: 1,
    outputs: {
        direct: { name: 'direct', kind: 'direct' },
        vless: { name: 'vless', kind: 'vless', device: 'vless', devices: ['vless'], up: true },
        vless2: { name: 'vless2', kind: 'vless', device: 'vless2', devices: ['vless2'], up: true },
    },
    channels: [{ name: 'vless_dom', out: 'vless', live: true, bytes: 0, channels: ['Youtube'] }],
}

describe('стенд: две локации одной подписки', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'url', path: '/etc/steer/sub.txt', present: true } as never)
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ ok: true, kind: 'url', asked: true } as never)
        vi.spyOn(rpc, 'vlessNodes').mockImplementation((async (out: string) => ({
            output: out, sub_file: '', node: 6, usable: 10, skipped: 0, foreign: 0,
            nodes: [{ index: 6, name: '🇳🇱 Мобильный #6', host: 'h', port: 443, type: 'tcp', security: 'reality', vision: true }],
        })) as never)
        vi.spyOn(rpc, 'outboundGeo').mockImplementation((async (out: string) =>
            out === 'vless' ? { output: out, cached: true } : { output: out, cc: 'RU', ip: '94.198.217.66' }) as never)
        vi.spyOn(rpc, 'outboundProbe').mockImplementation((async (out: string) =>
            ({ output: out, state: 'ok', ms: 170, how: 'через туннель' })) as never)
    })

    it('обе строки на месте', async () => {
        render(<Home live={live({ status: STATUS, net: { uptime: 60, active_clients: 0 } })} onSection={() => {}} />)
        await screen.findByText('Нидерланды')
        await new Promise((r) => setTimeout(r, 300))
        const col = document.body.textContent || ''
        console.log('СТОЛБЕЦ:', col.slice(col.indexOf('Выходы')))
        expect(screen.getByText('Нидерланды')).toBeInTheDocument()
        expect(screen.getByText('Россия')).toBeInTheDocument()
        expect(screen.getByText('vless2')).toBeInTheDocument()
    })
})
