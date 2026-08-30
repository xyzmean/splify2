import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from '@/components/sections/Home'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Status } from '@/lib/model'

// Данные ровно как на стенде: две подписки, у первой лимит 800 ГБ, вторая безлимитная.
const GB = 1024 ** 3
const STATUS: Status = {
    schema: 1,
    outputs: { vless: { name: 'vless', kind: 'vless', device: 'vless', up: true } },
    channels: [],
}
const SPEC = {
    schema: 1 as const,
    outputs: { vless: { name: 'vless', kind: 'vless' as const, sub_file: '/etc/steer/sub.txt', node: -1 } },
    channels: [],
}

describe('две подписки: числа у каждой свои', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        pending.saved = SPEC
        pending.applied = SPEC
        vi.spyOn(rpc, 'specGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vless', cc: 'RU', ms: 900 } as never)
        vi.spyOn(rpc, 'vlessNodes').mockRejectedValue(new Error('не спрашиваем'))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ ok: true, kind: 'url', asked: true } as never)
        vi.spyOn(rpc, 'subList').mockResolvedValue({
            subs: [
                {
                    name: 'main', title: 'Riot VPN (Основной)', kind: 'url', path: '/etc/steer/sub.txt',
                    present: true, used: 3,
                    quota: { up: '0', down: String(6 * 1024 ** 2), total: String(800 * GB), expire: 1789402768, at: 1788122278, since: 1788120366, since_used: String(6 * 1024 ** 2) },
                },
                {
                    name: 'sub2', title: '🌨️ VPN', kind: 'url', path: '/etc/steer/subs/sub2.txt',
                    present: true, used: 0,
                    quota: { up: '0', down: String(8 * 1024 ** 2), total: '0', expire: 1790694656, at: 1788121795, since: 1788121795, since_used: String(8 * 1024 ** 2) },
                },
            ],
            hwid: 'x',
        } as never)
    })

    it('у первой лимит, у второй — бесконечность, и они не путаются', async () => {
        render(<Home live={live({ status: STATUS, net: { uptime: 60, active_clients: 1 } })} onSection={() => {}} />)
        expect(await screen.findByText('Riot VPN (Основной)')).toBeInTheDocument()
        expect(await screen.findByText(/🌨️ VPN/)).toBeInTheDocument()
        // Лимит — только у первой.
        expect(screen.getAllByText(/из 800,0 ГБ осталось/)).toHaveLength(1)
        // У второй — расход из бесконечности.
        expect(screen.getByText('из ∞ израсходовано')).toBeInTheDocument()
    })
})
