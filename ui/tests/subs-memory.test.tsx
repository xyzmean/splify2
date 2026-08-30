import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from '@/components/sections/Home'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Status } from '@/lib/model'

// Перечень подписок приезжает отдельным вызовом, и до его ответа блоков подписок нет вовсе:
// на роутере это несколько секунд пустоты, после которых блоки появляются рывком и разъезжают
// всё, что под ними. Числа каждая подписка помнила и раньше — не помнился САМ ПЕРЕЧЕНЬ, то
// есть то, без чего блок нельзя нарисовать.

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
const ROWS = [
    { name: 'main', title: 'Riot VPN (Основной)', kind: 'url', path: '/etc/steer/sub.txt', present: true },
    { name: 'sub2', title: '🌨️ VPN', kind: 'url', path: '/etc/steer/subs/sub2.txt', present: true },
]
const quota = (total: string, down: number) => ({
    up: '0', down: String(down), total, expire: 1790694656,
    at: 1788121795, since: 1788121795, since_used: String(down),
})

describe('перечень подписок переживает закрытие страницы', () => {
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
    })

    it('блоки и числа обеих подписок нарисованы ДО ответа роутера', async () => {
        window.localStorage.setItem('splify2:subs', JSON.stringify(ROWS))
        window.localStorage.setItem(
            'splify2:card:main',
            JSON.stringify({ kind: 'url', quota: quota(String(800 * GB), 6 * 1024 ** 2) }),
        )
        window.localStorage.setItem(
            'splify2:card:sub2',
            JSON.stringify({ kind: 'url', quota: quota('0', 8 * 1024 ** 2) }),
        )
        // Роутер молчит: ни перечня, ни ответа панели. Всё, что на экране, — запомненное.
        vi.spyOn(rpc, 'subList').mockReturnValue(new Promise(() => {}) as never)
        vi.spyOn(rpc, 'subQuota').mockReturnValue(new Promise(() => {}) as never)

        render(<Home live={live({ status: STATUS, net: { uptime: 60, active_clients: 1 } })} onSection={() => {}} />)

        expect(screen.getByText('Riot VPN (Основной)')).toBeInTheDocument()
        expect(screen.getByText(/🌨️ VPN/)).toBeInTheDocument()
        // И числа у каждой свои: лимит у первой, бесконечность у второй.
        expect(screen.getByText(/из 800,0 ГБ осталось/)).toBeInTheDocument()
        expect(screen.getByText('из ∞ израсходовано')).toBeInTheDocument()
    })

    it('пришедший перечень запоминается — БЕЗ чисел: у них своё место', async () => {
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ ok: true, kind: 'url', asked: true } as never)
        vi.spyOn(rpc, 'subList').mockResolvedValue({
            subs: ROWS.map((s) => ({ ...s, quota: quota(String(800 * GB), 6 * 1024 ** 2) })),
            hwid: 'x',
        } as never)

        render(<Home live={live({ status: STATUS, net: { uptime: 60, active_clients: 1 } })} onSection={() => {}} />)
        await screen.findByText('Riot VPN (Основной)')
        await waitFor(() => expect(window.localStorage.getItem('splify2:subs')).toBeTruthy())

        const saved = JSON.parse(window.localStorage.getItem('splify2:subs') || '[]')
        expect(saved.map((s: { name: string }) => s.name)).toEqual(['main', 'sub2'])
        // Числа во второй копии разошлись бы с первой на первом же обновлении блока.
        expect(saved.every((s: { quota?: unknown }) => s.quota === undefined)).toBe(true)
    })

    it('роутер перечня не знает — запомненное снимается, а не остаётся на экране', async () => {
        window.localStorage.setItem('splify2:subs', JSON.stringify(ROWS))
        vi.spyOn(rpc, 'subList').mockRejectedValue(new Error('Method not found'))
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', path: '/etc/steer/sub.txt', present: false } as never)
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ ok: true, kind: 'none', asked: false } as never)

        render(<Home live={live({ status: STATUS, net: { uptime: 60, active_clients: 1 } })} onSection={() => {}} />)
        await waitFor(() => expect(screen.queryByText(/🌨️ VPN/)).toBeNull())
        expect(JSON.parse(window.localStorage.getItem('splify2:subs') || '[]')).toEqual([])
    })
})
