import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TelemetryCard from '@/components/TelemetryCard'
import { rpc } from '@/lib/rpc'

// Согласие на телеметрию. Контракт — docs/TELEMETRY.md.
//
// Проверяется не «карточка рисуется», а четыре обещания, каждое из которых легко нарушить
// незаметно:
//
// 1. СОСТОЯНИЙ ТРИ, А НЕ ДВА. «Не спрашивали» даёт право предложить один раз; «отказался» не
//    даёт никогда. Свести их в один булев `on` — значит показывать предложение человеку,
//    который уже сказал «нет», при каждом открытии страницы. Ошибка эта тихая: экран выглядит
//    работающим, и заметить её может только тот, кто отказался.
// 2. ПЕРЕКЛЮЧЕНИЕ ДОЕЗЖАЕТ ДО РОУТЕРА и состояние перечитывается — иначе на экране остаётся
//    согласие, которого на роутере нет.
// 3. ПРЕДПРОСМОТР ПОКАЗЫВАЕТ ТЕ ЖЕ БАЙТЫ. Проверяется по следствию, а не по вызову: в ответ
//    подсовывается пакет с редкой строкой, и она обязана найтись на экране дословно; и
//    наоборот — полей, которых в ответе не было, на экране быть не должно. Карточка, рисующая
//    пакет по своим представлениям о нём, отменяет весь смысл кнопки «показать пакет».
// 4. ОТКАЗ ПРЕДПРОСМОТРА ВИДЕН ТЕКСТОМ. Пустое окно человек прочтёт как «ничего не уезжает» —
//    то есть молчание здесь врёт в самую опасную сторону.

/** Редкая строка: такого в разметке карточки нет и быть не может, поэтому её появление на
 *  экране означает ровно одно — показано то, что приехало с роутера. */
const RARE = 'zrenjanin-tridcat-tri-korovy'

const PKT = {
    v: 1,
    id: 'sp-0123456789abcdef0123456789abcdef',
    at: 1750000000,
    dev: { model: RARE },
    subs: [{ i: 0, host: 'example.org', deep: false, usable: 7 }],
}

const HOUR_AGO = Math.floor(Date.now() / 1000) - 3600

function pre(): HTMLElement | null {
    return document.querySelector('pre')
}

describe('согласие на телеметрию (docs/TELEMETRY.md)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('«не спрашивали» — карточка предлагает включить', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: false, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByText(/Помогите сделать splify2 лучше/)).toBeInTheDocument())
        expect(screen.getByRole('switch')).not.toBeChecked()
    })

    it('отказ — предложение не показывается больше никогда', async () => {
        // Единственное состояние, где уместен зовущий текст, — «не спрашивали». Человек,
        // сказавший «нет», не должен получать то же предложение при каждом открытии.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'off', on: false, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.queryByText(/Помогите сделать splify2 лучше/)).toBeNull()
        expect(screen.getByRole('switch')).not.toBeChecked()
        // Карточка при этом на месте и спокойна: выключатель есть, вернуть согласие можно.
        expect(screen.getByRole('switch')).toBeInTheDocument()
    })

    it('включено — показано время последней отправки', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-0123456789abcdef0123456789abcdef',
            last_at: HOUR_AGO, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        expect(screen.getByText(/Последняя отправка/)).toBeInTheDocument()
        expect(screen.getByText(/ч назад/)).toBeInTheDocument()
        expect(screen.queryByText(/Помогите сделать splify2 лучше/)).toBeNull()
    })

    it('включено, а прошлая отправка не удалась — причина видна', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-0123456789abcdef0123456789abcdef',
            last_at: HOUR_AGO, last_error: 'панель ответила 429',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByText(/панель ответила 429/)).toBeInTheDocument())
    })

    it('включение зовёт telemetry_set с согласием и перечитывает состояние', async () => {
        const state = vi.spyOn(rpc, 'telemetryState')
            .mockResolvedValueOnce({ consent: 'unset', on: false, id: '', last_at: 0, last_error: '' })
            .mockResolvedValue({ consent: 'on', on: true, id: 'sp-x', last_at: HOUR_AGO, last_error: '' })
        const set = vi.spyOn(rpc, 'telemetrySet').mockResolvedValue({ ok: true, consent: 'on' })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByText(/Помогите сделать splify2 лучше/)).toBeInTheDocument())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(true))
        // Перечитывание обязательно: на роутере согласие могло не записаться, и тогда экран
        // показывал бы включённым то, что выключено.
        await waitFor(() => expect(state).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    })

    it('выключение зовёт telemetry_set с отказом', async () => {
        vi.spyOn(rpc, 'telemetryState')
            .mockResolvedValueOnce({ consent: 'on', on: true, id: 'sp-x', last_at: HOUR_AGO, last_error: '' })
            .mockResolvedValue({ consent: 'off', on: false, id: '', last_at: 0, last_error: '' })
        const set = vi.spyOn(rpc, 'telemetrySet').mockResolvedValue({ ok: true, consent: 'off' })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(false))
    })

    it('«показать пакет» показывает ровно то, что вернул роутер', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-x', last_at: HOUR_AGO, last_error: '',
        })
        vi.spyOn(rpc, 'telemetryPreview').mockResolvedValue(PKT)
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: /Показать пакет/ }))
        // Редкая строка из ответа — на экране дословно.
        await waitFor(() => expect(screen.getByText(new RegExp(RARE))).toBeInTheDocument())
        // И весь пакет целиком: отступы допустимы, подмена значений — нет.
        expect(pre()?.textContent).toBe(JSON.stringify(PKT, null, 2))
    })

    it('карточка не рисует пакет по своим представлениям о нём', async () => {
        // В ответе только два поля. Если на экране появилось что-то ещё из схемы — значит
        // показан не ответ роутера, а собранная заново картинка, и кнопка «показать пакет»
        // перестала что-либо доказывать.
        const thin = { v: 1, id: 'sp-0123456789abcdef0123456789abcdef' }
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-x', last_at: HOUR_AGO, last_error: '',
        })
        vi.spyOn(rpc, 'telemetryPreview').mockResolvedValue(thin)
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: /Показать пакет/ }))
        await waitFor(() => expect(pre()).not.toBeNull())
        expect(pre()?.textContent).toBe(JSON.stringify(thin, null, 2))
        const shown = document.body.textContent || ''
        for (const absent of ['uptime', 'geo', 'zapret', 'subs', 'boot', 'diag', 'lists']) {
            expect(shown).not.toContain(absent)
        }
    })

    it('предпросмотр работает и при выключенной телеметрии', async () => {
        // Иначе посмотреть, что уедет, можно было бы только ПОСЛЕ согласия — то есть после
        // того, как оно уже уехало.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'off', on: false, id: '', last_at: 0, last_error: '',
        })
        const prev = vi.spyOn(rpc, 'telemetryPreview').mockResolvedValue(PKT)
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        const btn = screen.getByRole('button', { name: /Показать пакет/ })
        expect(btn).toBeEnabled()
        fireEvent.click(btn)
        await waitFor(() => expect(prev).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByText(new RegExp(RARE))).toBeInTheDocument())
    })

    it('предпросмотр не собрался — причина видна текстом, а не пустым окном', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: false, id: '', last_at: 0, last_error: '',
        })
        vi.spyOn(rpc, 'telemetryPreview').mockResolvedValue({
            ok: false,
            error: 'пакет не собрался: идентификатор считает движок, а его нет или он не ответил',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: /Показать пакет/ }))
        await waitFor(() => expect(screen.getByText(/пакет не собрался/)).toBeInTheDocument())
        // Пустой блок пакета человек прочтёт как «ничего не уезжает» — его быть не должно.
        expect(pre()).toBeNull()
    })

    it('вызов предпросмотра сорвался — это тоже видно текстом', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'off', on: false, id: '', last_at: 0, last_error: '',
        })
        vi.spyOn(rpc, 'telemetryPreview').mockRejectedValue(new Error('нет ответа'))
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: /Показать пакет/ }))
        await waitFor(() => expect(screen.getByText(/нет ответа/)).toBeInTheDocument())
        expect(pre()).toBeNull()
    })

    it('сказано и что уезжает, и чего в пакете нет', async () => {
        // Согласие, у которого не написано, на что оно даётся, согласием не является.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: false, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.getByText(/Уезжает/)).toBeInTheDocument()
        expect(screen.getByText(/Не уезжает/)).toBeInTheDocument()
        expect(screen.getByText(/ни одного IP-адреса/)).toBeInTheDocument()
    })
})
