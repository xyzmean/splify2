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

    it('узлы вставлены ссылками vless:// — остатка не существует, и о нём ни слова', async () => {
        // Остаток приезжает заголовком ответа на запрос подписки. У вставленных ссылок такого
        // ответа нет вовсе, поэтому здесь нечего не только показывать, но и объяснять: строка
        // «панель не сообщает остаток» рядом со ссылками читалась как поломка панели.
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'links', quota: undefined }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(<SubscriptionCard />)
        await waitFor(() => expect(rpc.subInfo).toHaveBeenCalled())
        expect(screen.queryByText(/остаток|осталось|∞/)).toBeNull()
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

    it('объём не назван, срок назван — знак бесконечности, а не «осталось 0 из 0»', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota({ total: '' }) }))
        render(<SubscriptionCard />)
        expect(await screen.findByText('∞')).toBeInTheDocument()
        expect(screen.getByText(/панель назвала только срок/)).toBeInTheDocument()
        expect(screen.queryByText(/осталось/)).toBeNull()
    })

    it('отказ метода — не то же, что молчание панели: причина видна дословно', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: undefined }))
        vi.spyOn(rpc, 'subQuota').mockRejectedValue(new Error('Access denied'))
        render(<SubscriptionCard />)
        expect(await screen.findByText(/Access denied/)).toBeInTheDocument()
    })
})

// Три правки от владельца по этой карточке, и все три — про честность блока:
//   1. остаток считается ТОЛЬКО у подписки (см. выше про вставленные ссылки);
//   2. пояснение про то, чьи это числа, убрано совсем — оно занимало треть карточки и
//      объясняло то, о чём не спрашивают;
//   3. в этот же блок переехала локация, а у WireGuard вместо числа стоит бесконечность:
//      объём там не считает никто, и прочерк соврал бы про «неизвестно».
const OUT_VLESS = { vl: { name: 'vl', kind: 'vless' as const, device: 'vl', up: true } }
const OUT_WG = { wg0: { name: 'wg0', kind: 'interface' as const, device: 'wg0', up: true } }

const nodes = (name: string) =>
    ({ output: 'vl', sub_file: '/etc/steer/sub.txt', node: 1, usable: 2, skipped: 0, foreign: 0,
       nodes: [{ index: 0, name: 'Авто', host: 'a.example', port: 443 },
               { index: 1, name, host: 'b.example', port: 443 }] }) as never

describe('локация и туннель без подписки', () => {
    beforeEach(() => vi.restoreAllMocks())

    it('локация названа в том же блоке, что и остаток', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(await screen.findByText(/Германия №2/)).toBeInTheDocument()
        expect(screen.getByText('локация')).toBeInTheDocument()
    })

    it('показан ТОТ узел, который выбран движком, а не первый в подписке', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇵🇱 Польша №2'))
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/Польша №2/)).toBeInTheDocument()
        expect(screen.queryByText(/Авто/)).toBeNull()
    })

    it('WireGuard: бесконечность вместо числа, и наружу никто не идёт', async () => {
        const sub = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'none', present: false }))
        const ask = vi.spyOn(rpc, 'subQuota')
        const nod = vi.spyOn(rpc, 'vlessNodes')
        render(<SubscriptionCard outputs={OUT_WG} />)
        await waitFor(() => expect(sub).toHaveBeenCalled())
        expect(await screen.findByText('∞')).toBeInTheDocument()
        // Блок называется по тому, о чём он: подписки здесь нет.
        expect(screen.getByText('Туннель')).toBeInTheDocument()
        expect(screen.queryByText('Подписка')).toBeNull()
        expect(ask).not.toHaveBeenCalled()
        // Узлов у WireGuard не бывает — спрашивать их незачем.
        expect(nod).not.toHaveBeenCalled()
    })

    it('WireGuard при живой ссылке подписки: всё равно бесконечность', async () => {
        // Ссылка подписки может лежать в uci с прошлой попытки, а трафик идти через
        // WireGuard. Остаток той подписки — число не про этот роутер, и показывать его рядом
        // с работающим WireGuard значит отвечать не на заданный вопрос.
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(<SubscriptionCard outputs={OUT_WG} />)
        expect(await screen.findByText('∞')).toBeInTheDocument()
        expect(screen.queryByText(/68,0 ГБ|осталось/)).toBeNull()
        // И кнопки «обновить» нет: спрашивать панель о подписке, которой никто не
        // пользуется, — обращение наружу впустую.
        expect(screen.queryByRole('button', { name: /обновить/i })).toBeNull()
        expect(ask).not.toHaveBeenCalled()
    })

    it('ни подписки, ни туннеля — карточки по-прежнему нет', async () => {
        const sub = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'none', present: false }))
        const { container } = render(<SubscriptionCard outputs={{}} />)
        await waitFor(() => expect(sub).toHaveBeenCalled())
        await waitFor(() => expect(container.textContent).toBe(''))
    })

    it('пояснения про то, чьи это числа, в карточке больше нет', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(screen.queryByText(/панель продавца|обнуляются при перезагрузке/i)).toBeNull()
    })
})
