import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Console from '@/components/Console'
import { pending } from '@/lib/pending'
import { live } from './fixtures'
import { rpc } from '@/lib/rpc'
import type { Status } from '@/lib/model'

const STATUS: Status = {
    schema: 1,
    outputs: {
        vpn: { name: 'vpn', kind: 'interface', device: 'wg0', devices: ['wg0'], up: true },
        vl: { name: 'vl', kind: 'vless', device: 'steer0', up: true, sub_file: '/etc/steer/sub.txt', node: -1 },
    },
    channels: [{ name: 'youtube', out: 'vpn', live: true, bytes: 1024 }],
}

describe('вкладки не гаснут после первого опроса', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'status').mockResolvedValue(STATUS)
        vi.spyOn(rpc, 'diag').mockResolvedValue({ warn: 0, fail: 0, checks: [] })
        vi.spyOn(rpc, 'netInfo').mockResolvedValue({ uptime: 60, active_clients: 2 })
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true, version: '1.2.3', enabled: true, running: true })
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [{ name: 'wg0', up: true, kind: 'wireguard' }] })
        vi.spyOn(rpc, 'devStats').mockResolvedValue({ devices: {} })
        vi.spyOn(rpc, 'engineState').mockResolvedValue({ instances: {}, log: [] })
        vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: {} })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', path: '', present: false } as never)
    })

    const nav = (name: RegExp) => screen.getAllByRole('button', { name })[0]

    it('VPN: список входов остаётся после ответов роутера', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        nav(/VPN/).click()
        // Имя «VLESS» есть и у входа, и у кнопки создания выхода ниже — берём первое.
        expect((await screen.findAllByRole('button', { name: /VLESS/ }))[0]).toBeInTheDocument()
        await new Promise((r) => setTimeout(r, 300))
        expect(screen.getAllByRole('button', { name: /VLESS/ })[0]).toBeInTheDocument()
        expect(screen.getAllByRole('button', { name: /XSTEER/ })[0]).toBeInTheDocument()
    })

    it('Настройки: список входов остаётся после ответов роутера', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        nav(/Настройки/).click()
        expect(await screen.findByRole('button', { name: /Каталог/ })).toBeInTheDocument()
        await new Promise((r) => setTimeout(r, 300))
        expect(screen.getByRole('button', { name: /Каталог/ })).toBeInTheDocument()
    })

    it('переход VPN → Настройки → VPN ничего не гасит', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        nav(/VPN/).click()
        await screen.findByRole('button', { name: /VLESS/ })
        nav(/Настройки/).click()
        await screen.findByRole('button', { name: /Каталог/ })
        nav(/VPN/).click()
        expect(await screen.findByRole('button', { name: /VLESS/ })).toBeInTheDocument()
    })

    it('вход в подпункт и обратно', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        nav(/Настройки/).click()
        ;(await screen.findByRole('button', { name: /Общее/ })).click()
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Общее' })).toBeInTheDocument())
        screen.getAllByRole('button', { name: /Настройки/ }).at(-1)!.click()
        expect(await screen.findByRole('button', { name: /Каталог/ })).toBeInTheDocument()
    })
})

// Выходы во вкладке VPN — список пулов, а не редактор по одному выходу: со списка спрашивают
// «куда ведёт и работает ли», а не «как устроен».
describe('выходы: список и состав', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'status').mockResolvedValue(STATUS)
        vi.spyOn(rpc, 'diag').mockResolvedValue({ warn: 0, fail: 0, checks: [] })
        vi.spyOn(rpc, 'netInfo').mockResolvedValue({ uptime: 60, active_clients: 2 })
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true, version: '1.2.3', enabled: true, running: true })
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [{ name: 'wg0', up: true, kind: 'wireguard' }, { name: 'awg0', up: false, kind: 'amneziawg' }] })
        vi.spyOn(rpc, 'devStats').mockResolvedValue({ devices: {} })
        vi.spyOn(rpc, 'engineState').mockResolvedValue({ instances: {}, log: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'url', path: '/etc/steer/sub.txt', present: true } as never)
        vi.spyOn(rpc, 'subList').mockResolvedValue({
            subs: [{ name: 'main', title: 'Riot', path: '/etc/steer/sub.txt', present: true, kind: 'url', used: 1 }],
        } as never)
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vpn', cc: 'NL', ms: 42 } as never)
        vi.spyOn(rpc, 'vlessNodes').mockRejectedValue(new Error('не спрашиваем'))
        // Список выходов читается из СПЕКИ: он редактор, а не табло.
        const SPEC = {
            schema: 1 as const,
            outputs: {
                vpn: { name: 'vpn', kind: 'interface' as const, devices: ['wg0'], device: 'wg0', on_fail: 'drop' as const },
            },
            channels: [{ name: 'youtube', out: 'vpn', match: {} }],
        }
        vi.spyOn(rpc, 'specGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue(SPEC)
        /* Хранилище спеки — одно на модуль и загружается один раз за жизнь страницы:
         * без этой строки следующий стенд достался бы спеке предыдущего. */
        pending.saved = SPEC
        pending.applied = SPEC
    })

    it('список показывает выход, его состав и страну', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        screen.getAllByRole('button', { name: /VPN/ })[0].click()
        expect(await screen.findByText('vpn')).toBeInTheDocument()
        expect(await screen.findByText(/Нидерланды/)).toBeInTheDocument()
    })

    it('состав выхода открывается и предлагает свои туннели и подписки', async () => {
        render(<Console />)
        await screen.findByRole('heading', { name: 'Маршрутизация работает' })
        screen.getAllByRole('button', { name: /VPN/ })[0].click()
        ;(await screen.findByRole('button', { name: /Добавить выход/ })).click()
        expect(await screen.findByText('Что можно взять')).toBeInTheDocument()
        expect(screen.getByText('Свои туннели')).toBeInTheDocument()
        expect(await screen.findByText('Riot')).toBeInTheDocument()
        expect(screen.getByText('Порядок предпочтения')).toBeInTheDocument()
        expect(screen.getByText('остановить трафик')).toBeInTheDocument()
    })
})

// «И как мне выбрать несколько?» — с живого экрана. Локаций в выходе может быть несколько, и
// порядок между ними — это предпочтение, как у устройств. В спеку уезжают ОБА поля: `node` с
// первой выбранной и `nodes` со всем списком. Движок, который про список ещё не знает,
// незнакомый ключ пропускает молча и берёт первую выбранную — то есть выбор человека виден на
// любом движке, и ни одна его локация не подменяется чужой.
describe('несколько локаций в одном выходе', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        const SPEC = {
            schema: 1 as const,
            outputs: {
                vl: {
                    name: 'vl', kind: 'vless' as const, sub_file: '/etc/steer/sub.txt',
                    node: -1, on_fail: 'drop' as const,
                },
            },
            channels: [],
        }
        pending.saved = SPEC
        pending.applied = SPEC
        vi.spyOn(rpc, 'specGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subList').mockResolvedValue({
            subs: [{ name: 'main', title: 'Riot', path: '/etc/steer/sub.txt', present: true, kind: 'url' }],
        } as never)
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue({
            output: 'vl', sub_file: '/etc/steer/sub.txt', node: -1, usable: 3, skipped: 0, foreign: 0,
            nodes: [
                { index: 0, name: '🇳🇱 Мобильный #2' },
                { index: 1, name: '🇵🇱 Мобильный #7' },
                { index: 2, name: '🇩🇪 Мобильный #9' },
            ],
        } as never)
    })

    /** Признак поколения движка: у выхода kind=vless поле nodes печатается ВСЕГДА, в том
     *  числе пустым. Движок постарше не печатает его вовсе. */
    const withPools = (nodes?: number[]) =>
        live({
            status: {
                schema: 1 as const,
                outputs: { vl: { name: 'vl', kind: 'vless' as const, device: 'vl', up: true, nodes: nodes ?? [] } },
                channels: [],
            },
        })
    const oldEngine = live({
        status: {
            schema: 1 as const,
            outputs: { vl: { name: 'vl', kind: 'vless' as const, device: 'vl', up: true } },
            channels: [],
        },
    })

    it('локации выбираются пачкой и уезжают списком в поле nodes', async () => {
        const { default: PoolEditor } = await import('@/components/PoolEditor')
        let saved: unknown = null
        render(
            <PoolEditor
                spec={pending.saved!}
                name="vl"
                live={withPools()}
                onCancel={() => {}}
                onSave={(next) => { saved = next }}
            />,
        )
        ;(await screen.findByRole('button', { name: /Мобильный #7/ })).click()
        await new Promise((r) => setTimeout(r, 20))
        ;(await screen.findByRole('button', { name: /Мобильный #2/ })).click()
        await new Promise((r) => setTimeout(r, 20))
        screen.getByRole('button', { name: /Сохранить выход/ }).click()
        const out = (saved as { outputs: Record<string, { node?: number; nodes?: number[] }> })
            .outputs.vl
        expect(out.nodes).toEqual([1, 0])
        // ОБЕ формы разом движок отвергает целиком — пишем ровно одну.
        expect(out.node).toBeUndefined()
    })

    it('движок постарше: локация одна, и уезжает полем node', async () => {
        // Незнакомый ключ движок пропускает МОЛЧА: список, записанный в старый движок, дал бы
        // применённую спеку и трафик через узел, которого человек не выбирал.
        const { default: PoolEditor } = await import('@/components/PoolEditor')
        let saved: unknown = null
        render(
            <PoolEditor
                spec={pending.saved!}
                name="vl"
                live={oldEngine}
                onCancel={() => {}}
                onSave={(next) => { saved = next }}
            />,
        )
        ;(await screen.findByRole('button', { name: /Мобильный #7/ })).click()
        await new Promise((r) => setTimeout(r, 20))
        ;(await screen.findByRole('button', { name: /Мобильный #2/ })).click()
        await new Promise((r) => setTimeout(r, 20))
        screen.getByRole('button', { name: /Сохранить выход/ }).click()
        const out = (saved as { outputs: Record<string, { node?: number; nodes?: number[] }> })
            .outputs.vl
        expect(out.node).toBe(0)
        expect(out.nodes).toBeUndefined()
    })

    it('ничего не выбрано — «любая рабочая», и это node: -1', async () => {
        const { default: PoolEditor } = await import('@/components/PoolEditor')
        let saved: unknown = null
        render(
            <PoolEditor
                spec={pending.saved!}
                name="vl"
                live={withPools()}
                onCancel={() => {}}
                onSave={(next) => { saved = next }}
            />,
        )
        await screen.findByRole('button', { name: /любая рабочая/ })
        screen.getByRole('button', { name: /Сохранить выход/ }).click()
        const out = (saved as { outputs: Record<string, { node?: number; nodes?: number[] }> })
            .outputs.vl
        expect(out.node).toBe(-1)
        expect(out.nodes).toBeUndefined()
    })
})
