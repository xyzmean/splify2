import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PoolEditor from '@/components/PoolEditor'
import PoolList from '@/components/PoolList'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { type Output, type Spec } from '@/lib/model'
import { live } from './fixtures'

// «Никак не могу набрать в пул 2 конфигурации из одной подписки, 3 из другой и ещё wg» —
// владелец, с живого экрана. Редактор предлагал выбор «либо одна подписка, либо свои
// туннели», а движок разнородный пул собирает давно: выход kind=interface, в devices которого
// названы устройства выходов kind=vless (контракт steer, §выходы). Редактор теперь собирает
// эту форму сам: локации одной подписки — служебный выход kind=vless с признаком part_of,
// сам выход — пул из их устройств и своих туннелей.
//
// Сторожится здесь:
//   1. Из двух подписок и туннеля получается ОДИН выход для человека и верная форма для
//      движка: части с part_of, пул с их устройствами по порядку.
//   2. Открытый заново пул раскладывается на те же строки — обратная операция верна.
//   3. Перестановка строк меняет порядок devices, но НЕ имена частей: переименование
//      устройства перезапускало бы живой туннель.
//   4. Части не показываются как выходы: ни в списке выходов, ни целью для правила.

const SUBS = [
    { name: 'main', title: 'Riot', path: '/etc/steer/sub.txt', present: true, kind: 'url' },
    { name: 'blue', title: 'Blue', path: '/etc/steer/subs/blue.txt', present: true, kind: 'url' },
]
const NODES: Record<string, { index: number; name: string }[]> = {
    '/etc/steer/sub.txt': [
        { index: 0, name: '🇩🇪 Германия №3' },
        { index: 1, name: '🇩🇪 Германия №4' },
        { index: 2, name: '🇵🇱 Польша №2' },
    ],
    '/etc/steer/subs/blue.txt': [
        { index: 0, name: '🇳🇱 Амстердам' },
        { index: 1, name: '🇫🇮 Хельсинки' },
    ],
}

const EMPTY: Spec = { schema: 1, outputs: {}, channels: [] }

const withPools = live({
    status: { schema: 1, features: ['lan_devices', 'nodes', 'pool'], outputs: {}, channels: [] },
})

const click = async (name: RegExp | string) => {
    ;(await screen.findByRole('button', { name })).click()
    await new Promise((r) => setTimeout(r, 10))
}

describe('пул из двух подписок и своего туннеля', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        document.body.innerHTML = ''
        vi.spyOn(rpc, 'devices').mockResolvedValue({
            devices: [{ name: 'wg0', up: true, kind: 'wireguard' }],
        })
        vi.spyOn(rpc, 'subList').mockResolvedValue({ subs: SUBS } as never)
        vi.spyOn(rpc, 'vlessNodesOfSub').mockImplementation(
            (async (path: string) => ({
                output: '', sub_file: path, node: -1, chosen: [], usable: 0, skipped: 0, foreign: 0,
                nodes: NODES[path] || [],
            })) as never,
        )
    })

    async function build(spec: Spec, name?: string) {
        let saved: Spec | null = null
        render(
            <PoolEditor
                spec={spec}
                name={name}
                live={withPools}
                onCancel={() => {}}
                onSave={(next) => { saved = next }}
            />,
        )
        return () => saved
    }

    it('собирается в пул с частями по подпискам, и части несут part_of', async () => {
        const saved = await build(EMPTY)
        const title = screen.getByLabelText('имя выхода') as HTMLInputElement
        title.value = 'vpn'
        title.dispatchEvent(new Event('input', { bubbles: true }))

        await click(/Германия №3/)
        await click(/Германия №4/)
        await click(/Амстердам/)
        await click(/wg0/)
        // Три строки в порядке выбора: Riot, Blue, wg0. Локации Riot — внутри своей строки.
        expect(screen.getByRole('button', { name: 'убрать строку 3' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'убрать локацию 2' })).toBeInTheDocument()
        await click(/Сохранить выход/)

        const out = saved()!.outputs
        expect(out.vpn.kind).toBe('interface')
        expect(out.vpn.devices).toEqual(['vpn-1', 'vpn-2', 'wg0'])
        expect(out.vpn.device).toBe('vpn-1')
        expect(out['vpn-1']).toMatchObject({
            kind: 'vless', sub_file: '/etc/steer/sub.txt', nodes: [0, 1], part_of: 'vpn', on_fail: 'drop',
        })
        // Одна локация — короткой формой node, как и у обычного выхода подписки.
        expect(out['vpn-2']).toMatchObject({
            kind: 'vless', sub_file: '/etc/steer/subs/blue.txt', node: 0, part_of: 'vpn',
        })
        expect(out['vpn-2'].nodes).toBeUndefined()
    })

    const POOL: Spec = {
        schema: 1,
        outputs: {
            vpn: { name: 'vpn', kind: 'interface', devices: ['vpn-1', 'vpn-2', 'wg0'], device: 'vpn-1', on_fail: 'drop' },
            'vpn-1': { name: 'vpn-1', kind: 'vless', sub_file: '/etc/steer/sub.txt', nodes: [0, 1], on_fail: 'drop', part_of: 'vpn' },
            'vpn-2': { name: 'vpn-2', kind: 'vless', sub_file: '/etc/steer/subs/blue.txt', node: 0, on_fail: 'drop', part_of: 'vpn' },
        },
        channels: [{ name: 'всё', match: { any: true }, out: 'vpn' }],
    }

    it('открытый заново пул раскладывается на те же строки, перестановка не переименовывает части', async () => {
        const saved = await build(POOL, 'vpn')
        // Три строки и две локации в первой — как было записано.
        expect(await screen.findByRole('button', { name: 'убрать строку 3' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'убрать локацию 2' })).toBeInTheDocument()
        // Слева взятое отмечено.
        await screen.findByRole('button', { name: /Германия №4/ })
        expect(screen.getByRole('button', { name: /Германия №4/ }).className).toMatch(/text-primary/)
        expect(screen.getByRole('button', { name: /Польша №2/ }).className).not.toMatch(/text-primary/)

        // wg0 — наверх: порядок предпочтения теперь wg0, Riot, Blue.
        await click('строка 3 выше')
        await click('строка 2 выше')
        await click(/Сохранить выход/)
        const out = saved()!.outputs
        expect(out.vpn.devices).toEqual(['wg0', 'vpn-1', 'vpn-2'])
        expect(out.vpn.device).toBe('wg0')
        // Имена частей те же — устройства не переименованы, туннели не перезапустятся.
        expect(out['vpn-1'].sub_file).toBe('/etc/steer/sub.txt')
        expect(out['vpn-2'].sub_file).toBe('/etc/steer/subs/blue.txt')
        // Правило по-прежнему ведёт в пул.
        expect(saved()!.channels[0].out).toBe('vpn')
    })

    it('убранная подписка уносит свою часть, оставшаяся одна — обычный выход подписки', async () => {
        const saved = await build(POOL, 'vpn')
        await screen.findByRole('button', { name: 'убрать строку 3' })
        await click('убрать строку 3') // wg0
        await click('убрать строку 2') // Blue
        await click(/Сохранить выход/)
        const out = saved()!.outputs
        // Осталась одна подписка — это выход kind=vless без частей, под своим именем.
        expect(out.vpn).toMatchObject({ kind: 'vless', sub_file: '/etc/steer/sub.txt', nodes: [0, 1] })
        expect(out['vpn-1']).toBeUndefined()
        expect(out['vpn-2']).toBeUndefined()
    })

    it('удаление пула уносит его части', async () => {
        const spec: Spec = { ...POOL, channels: [] }
        const saved = await build(spec, 'vpn')
        await click(/Удалить/)
        expect(Object.keys(saved()!.outputs)).toEqual([])
    })

    it('в списке выходов части не показываются, а пул назван подписками', async () => {
        pending.saved = POOL
        pending.applied = POOL
        vi.spyOn(rpc, 'outboundGeo').mockRejectedValue(new Error('нет'))
        render(<PoolList live={withPools} />)
        await waitFor(() => expect(screen.getByText('vpn')).toBeInTheDocument())
        expect(screen.queryByText('vpn-1')).toBeNull()
        expect(screen.queryByText('vpn-2')).toBeNull()
        expect(screen.getByText(/подписка → подписка → wg0/)).toBeInTheDocument()
    })

    it('на движке без пула смешанный состав не записывается, а объясняется', async () => {
        const old = live({
            status: {
                schema: 1,
                outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: true } as Output },
                channels: [],
            },
        })
        let saved: Spec | null = null
        render(<PoolEditor spec={EMPTY} live={old} onCancel={() => {}} onSave={(n) => { saved = n }} />)
        await click(/Германия №3/)
        await click(/wg0/)
        // Вторая строка не добавилась: движок такой пул молча исполнил бы не так.
        expect(screen.queryByRole('button', { name: 'убрать строку 2' })).toBeNull()
        expect(document.body.textContent).toMatch(/не умеет смешанный пул/)
        expect(saved).toBeNull()
    })
})
