import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

// «В VPN нельзя отметить несколько локаций подписки, галочка просто перепрыгивает» — с живого
// стенда. Список локаций понимает не всякий движок: старый берёт ровно одну (`node`), и
// интерфейс на нём правильно делает, что не пишет пул, — незнакомый ключ движок пропустит
// молча и повезёт трафик через узел, которого никто не выбирал. Неправдой была ФОРМА отметки:
// квадратная галочка обещает набор, а нажатие переносило её на другую локацию.
//
// Здесь проверяется, что форма отметки следует за движком: круг — выбор одной из, квадрат —
// набор.

const SPEC = {
    schema: 1 as const,
    outputs: {
        vl: { name: 'vl', kind: 'vless' as const, sub_file: '/etc/steer/sub.txt', node: -1, on_fail: 'drop' as const },
    },
    channels: [],
}

const marker = (name: RegExp) => {
    const btn = screen.getByRole('button', { name })
    return (btn.querySelector('span[aria-hidden="true"]') as HTMLElement).className
}

describe('локации подписки: форма отметки не обещает лишнего', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        pending.saved = SPEC
        pending.applied = SPEC
        vi.spyOn(rpc, 'specGet').mockResolvedValue(SPEC)
        vi.spyOn(rpc, 'appliedGet').mockResolvedValue(SPEC)
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

    const engine = (pools: boolean) =>
        live({
            status: {
                schema: 1 as const,
                outputs: {
                    vl: {
                        name: 'vl', kind: 'vless' as const, device: 'vl', up: true,
                        ...(pools ? { nodes: [] } : {}),
                    },
                },
                channels: [],
            },
        })

    it('движок без пула: отметка круглая, и выбор переезжает, а не «перепрыгивает» галочка', async () => {
        const { default: PoolEditor } = await import('@/components/PoolEditor')
        render(
            <PoolEditor spec={pending.saved!} name="vl" live={engine(false)} onCancel={() => {}} onSave={() => {}} />,
        )
        await screen.findByRole('button', { name: /Мобильный #7/ })
        // Форма — та же, что у «любой рабочей»: одна из, а не набор.
        expect(marker(/Мобильный #7/)).toMatch(/rounded-full/)
        expect(marker(/Мобильный #7/)).not.toMatch(/rounded border/)

        screen.getByRole('button', { name: /Мобильный #7/ }).click()
        await new Promise((r) => setTimeout(r, 20))
        expect(marker(/Мобильный #7/)).toMatch(/border-\[5px\]/)

        screen.getByRole('button', { name: /Мобильный #2/ }).click()
        await new Promise((r) => setTimeout(r, 20))
        // Выбрана ровно одна, и видно какая: прежняя вернулась в общий вид.
        expect(marker(/Мобильный #2/)).toMatch(/border-\[5px\]/)
        expect(marker(/Мобильный #7/)).not.toMatch(/border-\[5px\]/)
        // Порядка предпочтения на таком движке нет вовсе — обещать его нечем.
        expect(screen.queryByRole('button', { name: /строка 1 выше/ })).toBeNull()
    })

    it('движок с пулом: отметка квадратная, и локации набираются', async () => {
        const { default: PoolEditor } = await import('@/components/PoolEditor')
        render(
            <PoolEditor spec={pending.saved!} name="vl" live={engine(true)} onCancel={() => {}} onSave={() => {}} />,
        )
        await screen.findByRole('button', { name: /Мобильный #7/ })
        expect(marker(/Мобильный #7/)).toMatch(/rounded border/)

        screen.getByRole('button', { name: /Мобильный #7/ }).click()
        await new Promise((r) => setTimeout(r, 20))
        screen.getByRole('button', { name: /Мобильный #2/ }).click()
        await new Promise((r) => setTimeout(r, 20))
        // Обе остались выбранными — и у выбранных есть порядок.
        expect(screen.getByRole('button', { name: /убрать строку 1/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /убрать строку 2/ })).toBeInTheDocument()
    })
})
