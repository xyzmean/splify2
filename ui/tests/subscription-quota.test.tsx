import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubBlock, TunnelBlock } from '@/components/OutputCards'
import Home from '@/components/sections/Home'
import { rpc, type SubQuota } from '@/lib/rpc'
import { live } from './fixtures'
import type { OutputStatus, Status } from '@/lib/model'

// Остаток трафика подписки — то, чего в интерфейсе не было вовсе, а спрашивают про него
// первым: «сколько мне ещё осталось». Панель называет его заголовком ответа
// (`subscription-userinfo`), в теле подписки этих чисел нет, поэтому узнать их можно только
// обращением к панели — а обращаться к ней в общем опросе страницы нельзя.
//
// Отсюда три вещи, которые здесь и проверяются:
//   1. свежие числа читаются из sub_info, БЕЗ запроса наружу;
//   2. устаревшие обновляются один раз, при открытии;
//   3. молчание панели названо словами и НЕ подменяется прежними числами.
//
// Правая колонка главной разделена на два блока, и это разделение тоже проверяется здесь:
// у подписки остаток есть и его называет панель, у своего туннеля (WireGuard, AmneziaWG,
// xsteer) объёма не считает никто — там знак бесконечности и НИ ОДНОГО числа трафика.

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

const VLESS: OutputStatus = { name: 'vl', kind: 'vless', device: 'vl', up: true }
const WG: OutputStatus = { name: 'wg0', kind: 'interface', device: 'wg0', devices: ['wg0'], up: true }

/** Блок подписки с одним поднятым выходом — обычный случай. */
const sub = (p: { st?: OutputStatus; facts?: Parameters<typeof SubBlock>[0]['outs'][0]['facts'] } = {}) => (
    <SubBlock outs={[{ name: 'vl', st: p.st ?? VLESS, facts: p.facts }]} />
)

const nodes = (name: string) =>
    ({ output: 'vl', sub_file: '/etc/steer/sub.txt', node: 1, usable: 2, skipped: 0, foreign: 0,
       nodes: [{ index: 0, name: 'Авто', host: 'a.example', port: 443 },
               { index: 1, name, host: 'b.example', port: 443 }] }) as never

describe('блок «Подписка»: остаток трафика (Andromeda 26.9)', () => {
    /* Блок помнит прошлое состояние в localStorage и рисует его до первого ответа — иначе на
     * открытии несколько секунд пусто. Между проверками память чистится: без этого каждая
     * следующая начинала бы с чужого состояния, и порядок проверок стал бы значимым. */
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
    })

    it('свежие числа берутся из sub_info и наружу никто не идёт', async () => {
        const si = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(sub())
        await waitFor(() => expect(si).toHaveBeenCalled())
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
        render(sub())
        await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(/48,0 ГБ/)).toBeInTheDocument()
    })

    it('измеренный темп показан вместе с прогнозом', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        render(sub())
        // 32 ГБ за двое суток — 16 ГБ в сутки; остатка 68 ГБ хватит на четыре дня.
        expect(await screen.findByText('в среднем в сутки')).toBeInTheDocument()
        expect(screen.getByText('хватит при таком темпе')).toBeInTheDocument()
        expect(screen.getByText('на 4 дня')).toBeInTheDocument()
    })

    it('трафик не кончится до сброса — бесконечность вместо числа суток', async () => {
        // 100 МБ за двое суток на остатке в 68 ГБ — это больше тысячи дней, а сброс через
        // пятнадцать. «На 1 392 дня» здесь не срок, а способ сказать «не кончится».
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(
            info({ quota: quota({ since_used: String(132 * GB - 100 * 1024 ** 2) }) }),
        )
        render(sub())
        expect(await screen.findByText('хватит при таком темпе')).toBeInTheDocument()
        expect(screen.getByLabelText('до конца периода с запасом')).toBeInTheDocument()
        expect(screen.queryByText(/^на \d+ дн/)).toBeNull()
    })

    it('темп ещё не измерен — строк про темп нет вовсе, а остаток есть', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(
            info({ quota: quota({ since: now() - 600, since_used: String(131 * GB) }) }),
        )
        render(sub())
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(screen.queryByText('в среднем в сутки')).toBeNull()
        expect(screen.queryByText('хватит при таком темпе')).toBeNull()
    })

    it('кончится раньше сброса — сказано словами и с последствием', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        render(sub())
        expect(await screen.findByText(/кончится раньше сброса/)).toBeInTheDocument()
        expect(screen.getByText(/узел перестанет подниматься/)).toBeInTheDocument()
    })

    it('панель молчит — так и сказано, прежних чисел не выдумывается', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: undefined }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({
            ok: true, kind: 'url', asked: true, why: 'панель не сообщила остаток трафика',
        })
        render(sub())
        expect(await screen.findByText('Панель не сообщает остаток')).toBeInTheDocument()
        expect(screen.queryByText(/осталось/)).toBeNull()
    })

    it('узлы вставлены ссылками vless:// — остатка не существует, и о нём ни слова', async () => {
        // Остаток приезжает заголовком ответа на запрос подписки. У вставленных ссылок такого
        // ответа нет вовсе, поэтому здесь нечего не только показывать, но и объяснять: строка
        // «панель не сообщает остаток» рядом со ссылками читалась как поломка панели.
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'links', quota: undefined }))
        const ask = vi.spyOn(rpc, 'subQuota')
        render(sub())
        await waitFor(() => expect(rpc.subInfo).toHaveBeenCalled())
        expect(screen.queryByText(/остаток|осталось|∞/)).toBeNull()
        expect(screen.queryByRole('button', { name: /обновить/i })).toBeNull()
        // Спрашивать некого — и метод для этого не зовётся вовсе.
        expect(ask).not.toHaveBeenCalled()
    })

    it('источника узлов нет вовсе — ни чисел, ни объяснений про панель', async () => {
        // Выход есть, а подписки за ним нет: файл не скачан или ссылку ещё не вводили.
        // Остаток тут не «неизвестен» — его не существует, и говорить о нём нечего.
        const si = vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ kind: 'none', present: false }))
        render(sub())
        await waitFor(() => expect(si).toHaveBeenCalled())
        expect(screen.queryByText(/осталось|Панель не сообщает/)).toBeNull()
    })

    it('объём не назван, срок назван — бесконечность, а не «осталось 0 из 0»', async () => {
        // И рядом с бесконечностью — сколько трафика через неё уже прошло: «ограничения нет»
        // отвечает только на половину вопроса, вторая половина — «сколько я скачал».
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota({ total: '' }) }))
        render(sub())
        expect(await screen.findByText('132,0 ГБ')).toBeInTheDocument()
        expect(screen.getByText('из ∞ израсходовано')).toBeInTheDocument()
        expect(screen.getByText(/по счёту панели/)).toBeInTheDocument()
        expect(screen.queryByText(/осталось/)).toBeNull()
    })

    it('панель назвала объём НУЛЁМ — это безлимит, а не исчерпанная подписка', async () => {
        // Так отвечают живые панели (замерено на sub.skytunnel.pw): `upload=0; download=0;
        // total=0; expire=…`. Ноль в total — принятое обозначение безлимита, и прочитанный
        // буквально он рисовал «0 Б из 0 Б осталось» с пустой полосой.
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(
            info({ quota: quota({ up: '0', down: '0', total: '0' }) }),
        )
        render(sub())
        expect(await screen.findByText('∞')).toBeInTheDocument()
        expect(screen.getByText(/объём не ограничен/)).toBeInTheDocument()
        expect(screen.queryByText(/из 0 Б|осталось/)).toBeNull()
    })

    it('отказ метода — не то же, что молчание панели: причина видна дословно', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: undefined }))
        vi.spyOn(rpc, 'subQuota').mockRejectedValue(new Error('Access denied'))
        render(sub())
        expect(await screen.findByText(/Access denied/)).toBeInTheDocument()
    })

    it('пояснения про то, чьи это числа, в блоке больше нет', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        render(sub())
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(screen.queryByText(/панель продавца|обнуляются при перезагрузке/i)).toBeNull()
    })
})

describe('локации подписки: по строке на выход, с откликом и закрытым адресом', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
    })

    it('локация названа в том же блоке, что и остаток', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(sub())
        expect(await screen.findByText(/68,0 ГБ/)).toBeInTheDocument()
        // Строка выхода — «страна + имя выхода», как в дизайн-паке: «vless-nl · Нидерланды».
        // Имя узла от продавца сюда не идёт, оно живёт на экране VLESS.
        expect(await screen.findByText('Германия')).toBeInTheDocument()
        expect(screen.getByText('vl')).toBeInTheDocument()
    })

    it('страна берётся у ТОГО узла, который выбран движком, а не у первого в подписке', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇵🇱 Польша №2'))
        render(sub())
        expect(await screen.findByText('Польша')).toBeInTheDocument()
        expect(screen.queryByText(/Авто/)).toBeNull()
    })

    it('измеренная страна старше подписи продавца', async () => {
        // Подпись продавца намеренно ДРУГАЯ: узел переехал, и верить надо измерению.
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(sub({ facts: { geo: { cc: 'NL', ip: '1.2.3.4' } } }))
        expect(await screen.findByText(/Нидерланды/)).toBeInTheDocument()
        expect(screen.queryByText(/Германия/)).toBeNull()
    })

    it('отклик стоит рядом с локацией', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 Нидерланды'))
        render(sub({ facts: { geo: { cc: 'NL' }, ping: { ms: 42, state: 'ok' } } }))
        expect(await screen.findByText('42 мс')).toBeInTheDocument()
    })

    it('узел не ответил — так и сказано, а не «0 мс»', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 Нидерланды'))
        render(sub({ facts: { geo: { cc: 'NL' }, ping: { ms: -1, state: 'нет ответа' } } }))
        expect(await screen.findByText('нет ответа')).toBeInTheDocument()
    })

    it('две локации одной подписки различимы по имени выхода', async () => {
        // Пул собирается из локаций: правило ведёт в пул, а не в узел. Свести две страны в
        // одну строку значило бы назвать одну там, где их две.
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 Нидерланды'))
        render(
            <SubBlock
                outs={[
                    { name: 'vl', st: VLESS, facts: { geo: { cc: 'NL' } } },
                    { name: 'vl2', st: { ...VLESS, name: 'vl2' }, facts: { geo: { cc: 'DE' } } },
                ]}
            />,
        )
        expect(await screen.findByText(/Нидерланды/)).toBeInTheDocument()
        expect(screen.getByText(/Германия/)).toBeInTheDocument()
    })

    it('соединение работает — внешний адрес назван рядом с локацией', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
        render(sub({ facts: { geo: { cc: 'DE', ip: '1.2.3.4' } } }))
        expect(await screen.findByText(/Германия/)).toBeInTheDocument()
        expect(screen.getByText('внешний адрес')).toBeInTheDocument()
        expect(screen.getByText('1.2.3.4')).toBeInTheDocument()
    })

    it('внешний адрес закрыт, пока его не открыли глазом', async () => {
        // Главную открывают при людях и снимают с экрана. Адрес выхода — то, чем роутер виден
        // снаружи, и показывать его постоянно незачем: смотрят на него раз в месяц.
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
        render(sub({ facts: { geo: { cc: 'DE', ip: '1.2.3.4' } } }))
        const ip = await screen.findByText('1.2.3.4')
        // Адрес остаётся в строке — открытие не должно двигать соседние строки, — но
        // прочитать его нельзя и выделить мышью тоже.
        expect(ip).toHaveStyle({ filter: 'blur(4px)', userSelect: 'none' })
        fireEvent.click(screen.getByRole('button', { name: 'показать внешний адрес' }))
        expect(screen.getByText('1.2.3.4')).not.toHaveStyle({ filter: 'blur(4px)' })
        // И обратно: глаз закрывает адрес, а не только открывает.
        fireEvent.click(screen.getByRole('button', { name: 'скрыть внешний адрес' }))
        expect(screen.getByText('1.2.3.4')).toHaveStyle({ filter: 'blur(4px)' })
    })
})

// «Если соединения нет — не нужно писать остаток трафика, а писать о проблеме; укажи внешний
// IP, если соединение работает нормально».
//
// Смысл в том, на какой вопрос отвечает строка локации. Пока туннель не поднят, страна и
// адрес от прошлого измерения читаются как «всё в порядке», а у человека не работает.

const DOWN: OutputStatus = { ...VLESS, up: false }
const PROBING: OutputStatus = {
    ...VLESS, up: false, probe: { state: 'probing', node: 3, total: 29 },
}
const FAILED: OutputStatus = { ...VLESS, up: false, probe: { state: 'failed', total: 29 } }

describe('соединения нет — строка про беду, а не про страну', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
    })

    it('выход не поднят: сказано о беде', async () => {
        render(sub({ st: DOWN, facts: { geo: { cc: 'DE', ip: '1.2.3.4' } } }))
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.getByText(/трафик этого выхода никуда не идёт/)).toBeInTheDocument()
    })

    it('и прошлый внешний адрес рядом со сломанным туннелем не показывается', async () => {
        render(sub({ st: DOWN, facts: { geo: { cc: 'DE', ip: '1.2.3.4' } } }))
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.queryByText(/1\.2\.3\.4/)).toBeNull()
    })

    it('перебор узлов — это не отказ, а «подключается»', async () => {
        render(sub({ st: PROBING }))
        expect(await screen.findByText('Подключается…')).toBeInTheDocument()
        expect(screen.getByText(/3 из 29/)).toBeInTheDocument()
        expect(screen.queryByText('Нет соединения')).toBeNull()
    })

    it('узлы перебрали и ни один не ответил — сказано именно это', async () => {
        render(sub({ st: FAILED }))
        expect(await screen.findByText('Нет соединения')).toBeInTheDocument()
        expect(screen.getByText(/ни один узел подписки не ответил/)).toBeInTheDocument()
    })
})

describe('блок своего туннеля: бесконечность без единого числа трафика', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })

    it('локация, отклик и знак бесконечности — и ничего про объём', () => {
        const sq = vi.spyOn(rpc, 'subQuota')
        const si = vi.spyOn(rpc, 'subInfo')
        const nod = vi.spyOn(rpc, 'vlessNodes')
        render(<TunnelBlock name="wg0" st={WG} facts={{ geo: { cc: 'SE' }, ping: { ms: 61, state: 'ok' } }} />)
        expect(screen.getByText('wg0')).toBeInTheDocument()
        expect(screen.getByText(/Швеция/)).toBeInTheDocument()
        expect(screen.getByText('61 мс')).toBeInTheDocument()
        expect(screen.getByText('объём не ограничен')).toBeInTheDocument()
        // Ни счёта панели, ни счёта роутера: объём здесь не считает никто, и число рядом с
        // остатком подписки читалось бы как остаток.
        expect(screen.queryByText(/ГБ|израсходовано|осталось/)).toBeNull()
        // И наружу за подпиской никто не идёт: у туннеля её нет.
        expect(si).not.toHaveBeenCalled()
        expect(sq).not.toHaveBeenCalled()
        expect(nod).not.toHaveBeenCalled()
    })

    it('внешнего адреса в блоке туннеля нет: спрашивают только локацию и отклик', () => {
        render(<TunnelBlock name="wg0" st={WG} facts={{ geo: { cc: 'SE', ip: '5.6.7.8' } }} />)
        expect(screen.queryByText('5.6.7.8')).toBeNull()
    })

    it('туннель не поднят — беда вместо страны', () => {
        render(<TunnelBlock name="wg0" st={{ ...WG, up: false }} facts={{ geo: { cc: 'SE' } }} />)
        expect(screen.getByText('Нет соединения')).toBeInTheDocument()
        expect(screen.queryByText(/Швеция/)).toBeNull()
    })
})

// Три претензии владельца к открытию страницы, и все три — про ожидание:
//   «обновлять остатки при открытии», «старый статус должен храниться, чтобы данные сразу
//   появлялись», «обновление с анимацией», «задержка в 4-5 секунд напрягает».

describe('открытие страницы: запомненное сразу, свежее следом', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2'))
    })

    it('числа прошлого открытия видны ДО первого ответа роутера', () => {
        window.localStorage.setItem(
            'splify2:card',
            JSON.stringify({ kind: 'url', quota: quota() }),
        )
        // Роутер молчит вовсе: ни один ответ не придёт за время проверки.
        vi.spyOn(rpc, 'subInfo').mockReturnValue(new Promise(() => {}) as never)
        vi.spyOn(rpc, 'subQuota').mockReturnValue(new Promise(() => {}) as never)
        render(sub())
        // Без await: числа обязаны быть в первом же кадре, иначе блок снова пустой.
        expect(screen.getByText(/68,0 ГБ/)).toBeInTheDocument()
    })

    it('панель спрашивается при открытии, даже когда запомненное свежее', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota({ at: now() }) }))
        const ask = vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        render(sub())
        await waitFor(() => expect(ask).toHaveBeenCalled())
    })

    it('и спрашивается ровно один раз за открытие', async () => {
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        const ask = vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        render(sub())
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
        render(sub())
        expect(screen.getByText(/68,0 ГБ/)).toBeInTheDocument()
        expect(await screen.findByText(/18,0 ГБ/)).toBeInTheDocument()
    })
})

// Локация и отклик МЕРЯЮТСЯ, и меряет их главная — одним заходом на всю страницу. Два блока,
// спрашивающих порознь, показали бы два разных мгновения об одном роутере, а строка правила
// слева и строка выхода справа называют одну и ту же страну.

const status = (outputs: Status['outputs']): Status => ({ schema: 1, outputs, channels: [] })
const BUILD = { present: true, vless: true, version: '1.1.2', enabled: true, running: true }

describe('локация меряется сама, а не читается из подписки', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [{ name: 'wg0', up: true, kind: 'wireguard' }] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
        vi.spyOn(rpc, 'outboundProbe').mockResolvedValue({ output: 'vl', state: 'ok', ms: 42, how: 'engine' })
    })

    it('страна берётся из измерения через выход', async () => {
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'NL', ip: '1.2.3.4' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(<Home live={live({ build: BUILD, status: status({ vl: VLESS }) })} onSection={() => {}} />)
        expect(await screen.findByText(/Нидерланды/)).toBeInTheDocument()
        expect(screen.queryByText(/Германия/)).toBeNull()
    })

    it('WireGuard: локация тоже меряется — узлов у него нет вовсе', async () => {
        const geo = vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'wg0', cc: 'SE' })
        render(<Home live={live({ build: BUILD, status: status({ wg0: WG }), devs: { wg0: { rx: '0', tx: '0' } } })} onSection={() => {}} />)
        expect(await screen.findByText(/Швеция/)).toBeInTheDocument()
        expect(geo).toHaveBeenCalledWith('wg0', false)
    })

    it('измерения нет — страна берётся из подписи продавца, а не пустота', async () => {
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', why: 'выход не поднят' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇩🇪 Германия №2 — Riot VPN'))
        render(<Home live={live({ build: BUILD, status: status({ vl: VLESS }) })} onSection={() => {}} />)
        expect(await screen.findByText('Германия')).toBeInTheDocument()
    })

    it('выход мигнул — проверка НЕ запускается по кругу', async () => {
        // На роутере это выглядело как «меряем…», которое не гаснет: мигающий выход менял
        // ключ проверки каждые пять секунд, и замер стартовал заново до бесконечности.
        const geo = vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'NL' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 NL-2'))
        const { rerender } = render(
            <Home live={live({ build: BUILD, status: status({ vl: VLESS }) })} onSection={() => {}} />,
        )
        await screen.findAllByText(/Нидерланды/)
        const once = geo.mock.calls.length

        for (const up of [false, true, false, true])
            rerender(
                <Home
                    live={live({ build: BUILD, status: status({ vl: { ...VLESS, up } }) })}
                    onSection={() => {}}
                />,
            )
        await new Promise((r) => setTimeout(r, 50))
        expect(geo.mock.calls.length).toBe(once)
    })

    // «При смене профиля подписки локация должна быть обновлена» — с живого экрана: человек
    // выбрал польский узел, а в карточке осталась Эстония. Измерение снимается через устройство
    // выхода, а при смене узла движок пересоздаёт его — значит прежнее измерение относится уже
    // к другому месту. Бэкенд такое измерение не отдаёт вовсе (сверяет устройство), а интерфейс
    // обязан спросить заново.
    it('движок пересоздал устройство — измерение спрашивается заново', async () => {
        const geo = vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'EE' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇪🇪 Эстония №3'))
        const { rerender } = render(
            <Home live={live({ build: BUILD, status: status({ vl: VLESS }) })} onSection={() => {}} />,
        )
        expect(await screen.findByText(/Эстония/)).toBeInTheDocument()

        // Движок пересоздал туннель под другой узел: сначала выход падает…
        geo.mockResolvedValue({ output: 'vl', cc: 'PL' })
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue({
            output: 'vl', sub_file: '/etc/steer/sub.txt', node: 4, usable: 2, skipped: 0, foreign: 0,
            nodes: [{ index: 4, name: '🇵🇱 Польша №2', host: 'p.example', port: 443 }],
        } as never)
        // Устройство туннеля создаётся заново под другой узел — прежнее измерение относится
        // уже к другому месту, и бэкенд его не отдаёт вовсе (сверяет устройство).
        rerender(
            <Home
                live={live({ build: BUILD, status: status({ vl: { ...VLESS, device: 'steer1' } }) })}
                onSection={() => {}}
            />,
        )
        expect(await screen.findByText(/Польша/)).toBeInTheDocument()
        expect(screen.queryByText(/Эстония/)).toBeNull()
    })
})

// «Ну и чего страну перестало показывать» — с живого роутера. Измерение через выход бэкенд
// помнит пятнадцать минут, и ПУСТОЙ ответ он помнит так же: пока он не устарел, страны нет
// вовсе. Раньше её место занимал эмодзи-флаг из имени узла, набранный продавцем, — а он
// рисуется шрифтом и в Windows выглядит двумя буквами. Теперь код страны вычитается из этого
// же флага и рисуется нашей картинкой.
describe('страна из имени узла, когда измерения нет', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'subInfo').mockResolvedValue(info({ quota: quota() }))
        vi.spyOn(rpc, 'subQuota').mockResolvedValue({ quota: quota(), kind: 'url' } as never)
    })

    it('измерения нет — страна берётся из флага в имени узла', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 Мобильный #6'))
        render(sub())
        expect(await screen.findByText('Нидерланды')).toBeInTheDocument()
    })

    it('измерение есть — оно старше подписи продавца', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('🇳🇱 Мобильный #6'))
        render(sub({ facts: { geo: { cc: 'DE' } } }))
        expect(await screen.findByText('Германия')).toBeInTheDocument()
        expect(screen.queryByText('Нидерланды')).toBeNull()
        // Имени узла в строке нет вовсе: оно спорило бы с измерением.
        expect(screen.queryByText(/Мобильный/)).toBeNull()
    })

    it('ни измерения, ни флага — остаётся имя узла', async () => {
        vi.spyOn(rpc, 'vlessNodes').mockResolvedValue(nodes('Мобильный #6'))
        render(sub())
        expect(await screen.findByText('Мобильный #6')).toBeInTheDocument()
    })
})
