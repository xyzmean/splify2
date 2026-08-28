import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SubscriptionCard from '@/components/SubscriptionCard'
import { rpc, type SubQuota } from '@/lib/rpc'

// Остаток трафика подписки — то, чего в интерфейсе не было вовсе, а спрашивают про него
// первым: «сколько мне ещё осталось». Панель называет его заголовком ответа
// (`subscription-userinfo`), в теле подписки этих чисел нет, поэтому узнать их можно только
// обращением к панели — а обращаться к ней в общем опросе страницы нельзя.
//
// Отсюда три вещи, которые здесь и проверяются:
//   1. свежие числа читаются из sub_info, БЕЗ запроса наружу;
//   2. устаревшие обновляются один раз, при открытии;
//   3. молчание панели названо словами и НЕ подменяется прежними числами.

const GB = 1024 ** 3
const now = () => Math.floor(Date.now() / 1000)

function quota(p: Partial<SubQuota> = {}): SubQuota {
    return {
        up: String(2 * GB),
        down: String(130 * GB),
        total: String(200 * GB),
        expire: now() + 15 * 86400,
        at: now(),
        since: now() - 2 * 86400,
        since_used: String(100 * GB),
        ...p,
    }
}

const info = (p: Record<string, unknown> = {}) =>
    ({ kind: 'url', path: '/etc/steer/sub.txt', present: true, ...p }) as never

describe('карточка «Подписка»: остаток трафика (Andromeda 26.9)', () => {
    beforeEach(() => vi.restoreAllMocks())

    it('свежие числа берутся из sub_info и наружу никто не идёт', async () => {
        const sub = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(<SubscriptionCard />)
        await waitFor(() => expect(sub).toHaveBeenCalled())
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(screen.getByText(/из 200,0 ГБ осталось/)).toBeInTheDocument()
        expect(ask).not.toHaveBeenCalled()
    })

    it('числам больше четверти часа — спрашиваем панель, и ровно один раз', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(
            info({ quota: quota({ at: now() - 40 * 60 }) }),
        )
        const ask = vi.spyOn(rpc, 'subQuota').mockResolvedValue({
            ok: true, kind: 'url', asked: true, quota: quota({ down: String(150 * GB) }),
        })
        render(<SubscriptionCard />)
        await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(/48,0 ГБ/)).toBeInTheDocument()
    })

    it('измеренный темп показан вместе с прогнозом', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        render(<SubscriptionCard />)
        // 32 ГБ за двое суток — 16 ГБ в сутки; остатка 68 ГБ хватит на четыре дня.
        expect(await screen.findByText('в среднем в сутки')).toBeInTheDocument()
        expect(screen.getByText('хватит при таком темпе')).toBeInTheDocument()
        expect(screen.getByText('на 4 дня')).toBeInTheDocument()
    })

    it('темп ещё не измерен — строк про темп нет вовсе, а остаток есть', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(
            info({ quota: quota({ since: now() - 600, since_used: String(131 * GB) }) }),
        )
        render(<SubscriptionCard />)
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(screen.queryByText('в среднем в сутки')).toBeNull()
        expect(screen.queryByText('хватит при таком темпе')).toBeNull()
    })

    it('кончится раньше сброса — сказано словами и с последствием', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        render(<SubscriptionCard />)
        expect(await screen.findByText(/кончится раньше сброса/)).toBeInTheDocument()
        expect(screen.getByText(/узел перестанет подниматься/)).toBeInTheDocument()
    })

    it('панель молчит — так и сказано, прежних чисел не выдумывается', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: undefined }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({
            ok: true, kind: 'url', asked: true, why: 'панель не сообщила остаток трафика',
        })
        render(<SubscriptionCard />)
        expect(await screen.findByText('Панель не сообщает остаток')).toBeInTheDocument()
        expect(screen.queryByText(/осталось/)).toBeNull()
    })

    it('узлы вставлены ссылками vless:// — обновлять нечего, кнопки нет', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'links', quota: undefined }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(<SubscriptionCard />)
        expect(await screen.findByText('Панель не сообщает остаток')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /обновить/i })).toBeNull()
        // Спрашивать некого — и метод для этого не зовётся вовсе.
        expect(ask).not.toHaveBeenCalled()
    })

    it('подписки нет вовсе — карточки нет: остатка у отсутствующей подписки не бывает', async () => {
        const sub = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'none', present: false }))
        const { container } = render(<SubscriptionCard />)
        await waitFor(() => expect(sub).toHaveBeenCalled())
        await waitFor(() => expect(container.textContent).toBe(''))
    })

    it('объём не назван, срок назван — не рисуем «осталось 0 из 0»', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota({ total: '' }) }))
        render(<SubscriptionCard />)
        expect(await screen.findByText('Без ограничения по объёму')).toBeInTheDocument()
        expect(screen.queryByText(/осталось/)).toBeNull()
    })

    it('отказ метода — не то же, что молчание панели: причина видна дословно', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: undefined }))
        vi.spyOn(rpc, 'subQuota').mockRejectedValue(new Error('Access denied'))
        render(<SubscriptionCard />)
        expect(await screen.findByText(/Access denied/)).toBeInTheDocument()
    })
})
