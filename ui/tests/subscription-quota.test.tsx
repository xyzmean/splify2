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
    /* Карточка помнит прошлое состояние в localStorage и рисует его до первого ответа —
     * иначе на открытии несколько секунд пусто. Между проверками память чистится: без этого
     * каждая следующая начинала бы с чужого состояния, и порядок проверок стал бы значимым. */
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })

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
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })

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

// Три претензии владельца к открытию страницы, и все три — про ожидание:
//   «обновлять остатки при открытии», «старый статус должен храниться, чтобы данные сразу
//   появлялись», «обновление с анимацией», «задержка в 4-5 секунд напрягает».
//
// Отсюда и проверки: карточка обязана рисовать запомненное СРАЗУ (до первого ответа ubus),
// обязана всё равно сходить к панели, и локацию обязана определять сама — измерением через
// выход, а не подписью продавца.

describe('открытие страницы: запомненное сразу, свежее следом', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })

    it('числа прошлого открытия видны ДО первого ответа роутера', () => {
        window.localStorage.setItem(
            'splify2:card',
            JSON.stringify({ kind: 'url', quota: quota() }),
        )
        // Роутер молчит вовсе: ни один ответ не придёт за время проверки.
        vi.spyOn(rpc, 'subInfo').mockReturnValue(new Promise(() => {}) as never)
        vi.spyOn(rpc, 'subQuota').mockReturnValue(new Promise(() => {}) as never)
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        // Без await: числа обязаны быть в первом же кадре, иначе карточка снова пустая.
        expect(screen.getByText(/68,0 ГБ/)).toBeInTheDocument()
    })

    it('панель спрашивается при открытии, даже когда запомненное свежее', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota({ at: now() }) }))
        const ask = vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        await waitFor(() => expect(ask).toHaveBeenCalled())
    })

    it('и спрашивается ровно один раз за открытие', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        const ask = vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        await waitFor(() => expect(ask).toHaveBeenCalled())
        await new Promise((r) => setTimeout(r, 60))
        expect(ask).toHaveBeenCalledTimes(1)
    })

    it('приехавшие числа заменяют запомненные', async () => {
        window.localStorage.setItem(
            'splify2:card',
            JSON.stringify({ kind: 'url', quota: quota() }),
        )
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({
            quota: quota({ down: String(180 * GB) }),
            kind: 'url',
        } as never)
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(screen.getByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(await screen.findByText(/18,0 ГБ/)).toBeInTheDocument()
    })
})

describe('локация меряется сама, а не читается из подписки', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })

    it('страна берётся из измерения через выход', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'NL', ip: '1.2.3.4' })
        // Подпись продавца намеренно ДРУГАЯ: узел переехал, и верить надо измерению.
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/Нидерланды/)).toBeInTheDocument()
        expect(screen.queryByText(/Германия/)).toBeNull()
    })

    it('WireGuard: локация тоже меряется — узлов у него нет вовсе', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'none', present: false }))
        const geo = vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'wg0', cc: 'SE' })
        render(<SubscriptionCard outputs={OUT_WG} />)
        expect(await screen.findByText(/Швеция/)).toBeInTheDocument()
        expect(geo).toHaveBeenCalledWith('wg0', false)
    })

    it('измерения нет — остаётся подпись продавца, а не пустота', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', why: 'выход не поднят' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/Германия №2/)).toBeInTheDocument()
    })
})

// «Если соединения нет — не нужно писать остаток трафика, а писать о проблеме; укажи внешний
// IP, если соединение работает нормально».
//
// Смысл в том, на какой вопрос отвечает блок. Пока туннель не поднят, «осталось 800 ГБ» — не
// ответ, а издевательство: у человека не работает, а карточка рассказывает, сколько он не
// потратил. И наоборот: когда всё работает, внешний адрес — то, чем проверяют, что трафик
// действительно уходит через туннель, а не мимо.

const DOWN = { vl: { name: 'vl', kind: 'vless' as const, device: 'vl', up: false } }
const PROBING = {
    vl: {
        name: 'vl', kind: 'vless' as const, device: 'vl', up: false,
        probe: { state: 'probing' as const, node: 3, total: 29 },
    },
}
const FAILED = {
    vl: {
        name: 'vl', kind: 'vless' as const, device: 'vl', up: false,
        probe: { state: 'failed' as const, total: 29 },
    },
}

describe('соединения нет — карточка про беду, а не про гигабайты', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'DE', ip: '1.2.3.4' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
    })

    it('выход не поднят: сказано о беде, остатка нет', async () => {
        render(<SubscriptionCard outputs={DOWN} />)
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.queryByText(/осталось|∞/)).toBeNull()
        expect(screen.getByText(/трафик этого выхода никуда не идёт/)).toBeInTheDocument()
    })

    it('и прошлый внешний адрес рядом со сломанным туннелем не показывается', async () => {
        render(<SubscriptionCard outputs={DOWN} />)
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.queryByText(/1\.2\.3\.4/)).toBeNull()
    })

    it('перебор узлов — это не отказ, а «подключается»', async () => {
        render(<SubscriptionCard outputs={PROBING} />)
        expect(await screen.findByText('Подключается…')).toBeInTheDocument()
        expect(screen.getByText(/3 из 29/)).toBeInTheDocument()
        expect(screen.queryByText('Нет соединения')).toBeNull()
    })

    it('узлы перебрали и ни один не ответил — сказано именно это', async () => {
        render(<SubscriptionCard outputs={FAILED} />)
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.getByText(/ни один узел подписки не ответил/)).toBeInTheDocument()
    })

    it('соединение работает — внешний адрес назван рядом с локацией', async () => {
        render(<SubscriptionCard outputs={OUT_VLESS} />)
        expect(await screen.findByText(/Германия/)).toBeInTheDocument()
        expect(screen.getByText('внешний адрес')).toBeInTheDocument()
        expect(screen.getByText('1.2.3.4')).toBeInTheDocument()
    })
})
