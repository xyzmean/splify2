import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PoolEditor from '@/components/PoolEditor'
import { rpc } from '@/lib/rpc'
import { type Spec } from '@/lib/model'
import { live } from './fixtures'

// Проверка узлов подписки — в редакторе выхода, там, где узлы выбирают.
//
// Владелец: «негде проверить vless выходы». Панель подписки с кнопками проверки перестала
// показываться, когда выбор локации переехал в состав выхода, а кнопки за выбором не поехали.
// Сторожится:
//   1. У каждой локации своя кнопка, замер встаёт напротив имени; спрашивается у ПОДПИСКИ
//      (её файлом), а не у выхода, которого может ещё не быть.
//   2. «Проверить все» идёт пачкой не шире трёх: роутер однопроцессорный, и все разом мерили
//      бы собственную очередь.
//   3. Бэкенд постарше пути не знает — тогда через выход, уже стоящий на этой подписке.

const SUB = { name: 'main', title: 'Riot', path: '/etc/steer/sub.txt', present: true, kind: 'url' }
const NODES = [0, 1, 2, 3, 4].map((i) => ({ index: i, name: `🇳🇱 Узел ${i + 1}` }))
const EMPTY: Spec = { schema: 1, outputs: {}, channels: [] }
const withPools = live({
    status: { schema: 1, features: ['lan_devices', 'nodes', 'pool'], outputs: {}, channels: [] },
})
/** Кнопка проверки в строке локации: подпись у всех одна, строка находится по имени узла. */
const probeButton = (node: string) =>
    screen.getByRole('button', { name: new RegExp(node) }).closest('li')!
        .querySelector('button[aria-label="проверить отклик"]') as HTMLButtonElement

const probeOk = (index: number, ms: number) => ({
    results: [{ index, name: `n${index}`, type: 'tcp', ok: true, handshake_ms: ms - 20, ttfb_ms: ms, why: '' }],
})

describe('проверка узлов в составе выхода', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        document.body.innerHTML = ''
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subList').mockResolvedValue({ subs: [SUB] } as never)
        vi.spyOn(rpc, 'vlessNodesOfSub').mockResolvedValue({
            output: '', sub_file: SUB.path, node: -1, chosen: [], usable: 5, skipped: 0, foreign: 0, nodes: NODES,
        } as never)
    })

    it('кнопка у локации проверяет её у подписки, замер встаёт напротив имени', async () => {
        const probe = vi.spyOn(rpc, 'vlessProbeOfSub').mockResolvedValue(probeOk(1, 87) as never)
        render(<PoolEditor spec={EMPTY} live={withPools} onSave={() => {}} onCancel={() => {}} />)
        await screen.findByRole('button', { name: /Узел 2/ })
        fireEvent.click(probeButton('Узел 2'))
        await waitFor(() => expect(probe).toHaveBeenCalledWith(SUB.path, 1))
        await waitFor(() => expect(screen.getByText('87 мс')).toBeInTheDocument())
        // Выход для этого не нужен: спека пуста, а проверка прошла.
        expect(rpc.vlessProbe).toBeDefined()
    })

    it('«проверить все» — не шире трёх одновременно, и все пять получают числа', async () => {
        let inflight = 0
        let peak = 0
        const probe = vi.spyOn(rpc, 'vlessProbeOfSub').mockImplementation((async (_s: string, i: number) => {
            inflight++
            peak = Math.max(peak, inflight)
            await new Promise((r) => setTimeout(r, 15))
            inflight--
            return probeOk(i, 100 + i)
        }) as never)
        render(<PoolEditor spec={EMPTY} live={withPools} onSave={() => {}} onCancel={() => {}} />)
        fireEvent.click(await screen.findByRole('button', { name: /проверить все/ }))
        await waitFor(() => expect(probe).toHaveBeenCalledTimes(5))
        await waitFor(() => expect(screen.getByText('104 мс')).toBeInTheDocument())
        expect(peak).toBeLessThanOrEqual(3)
        expect(peak).toBeGreaterThan(1)
    })

    it('бэкенд постарше не знает подписку — проверяется через выход на ней', async () => {
        const spec: Spec = {
            schema: 1,
            outputs: { vpn: { name: 'vpn', kind: 'vless', sub_file: SUB.path, node: 0 } },
            channels: [],
        }
        vi.spyOn(rpc, 'vlessProbeOfSub').mockRejectedValue(new Error('не указан выход'))
        const byOut = vi.spyOn(rpc, 'vlessProbe').mockResolvedValue(probeOk(2, 150) as never)
        render(<PoolEditor spec={spec} live={withPools} onSave={() => {}} onCancel={() => {}} />)
        await screen.findByRole('button', { name: /Узел 3/ })
        fireEvent.click(probeButton('Узел 3'))
        await waitFor(() => expect(byOut).toHaveBeenCalledWith('vpn', 2))
        await waitFor(() => expect(screen.getByText('150 мс')).toBeInTheDocument())
    })

    it('отказ узла назван причиной в его строке, а не всплывашкой', async () => {
        vi.spyOn(rpc, 'vlessProbeOfSub').mockResolvedValue({
            results: [{ index: 0, name: 'n0', type: 'tcp', ok: false, handshake_ms: -1, ttfb_ms: -1, why: 'рукопожатие TLS не удалось' }],
        } as never)
        render(<PoolEditor spec={EMPTY} live={withPools} onSave={() => {}} onCancel={() => {}} />)
        await screen.findByRole('button', { name: /Узел 1/ })
        fireEvent.click(probeButton('Узел 1'))
        await waitFor(() => expect(screen.getByText('рукопожатие TLS не удалось')).toBeInTheDocument())
    })
})
