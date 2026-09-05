import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TelemetryCard from '@/components/TelemetryCard'
import { rpc } from '@/lib/rpc'

// Согласие на телеметрию. Контракт — docs/TELEMETRY.md.
//
// ГЛАВНОЕ ПРАВИЛО, КОТОРОЕ СТОРОЖИТ ЭТОТ СТЕНД: отправляем везде, кроме явного отказа.
// Согласие подразумевается фактом использования splify2, поэтому отсутствие ключа настройки
// («не спрашивали») для решения «отправлять ли» равно «включено», а единственное явное
// действие здесь — ВЫКЛЮЧИТЬ. Прочитать `unset` как «выключено» — самая дешёвая ошибка в
// карточке: экран выглядит рабочим, но показывает человеку состояние, которого на роутере
// нет, и человек, ничего не трогавший, видит «ничего не отправляется», пока отчёт уезжает.
//
// Отсюда четыре обещания, каждое из которых легко нарушить незаметно:
//
// 1. `unset` И `on` НА ЭКРАНЕ ОДИНАКОВЫ — переключатель включён в обоих. Состояний по-прежнему
//    три, но третье нужно, только чтобы отличить «по умолчанию» от «включил сам»; на решение
//    об отправке оно не влияет.
// 2. ПРАВИЛО ЗАПИСАНО ОДИН РАЗ. Если отрисовка считает `unset` включённым, а обработчик
//    нажатия — выключенным, то нажатие на включённый переключатель включит его ещё раз. Ловим
//    это тем, что нажатие при `unset` обязано звать `telemetrySet(false)`.
// 3. МОЛЧАНИЕ БЭКЕНДА НЕ ВЫКЛЮЧАЕТ ТЕЛЕМЕТРИЮ. Не ответивший rpcd — не повод рисовать
//    «выключено»: на роутере в этот момент включено.
// 4. ПРЕДПРОСМОТР ПОКАЗЫВАЕТ ТЕ ЖЕ БАЙТЫ и его отказ виден текстом. Проверяется по следствию,
//    а не по вызову: в ответ подсовывается пакет с редкой строкой, и она обязана найтись на
//    экране дословно; и наоборот — полей, которых в ответе не было, на экране быть не должно.
//    Карточка, рисующая пакет по своим представлениям о нём, отменяет весь смысл кнопки.

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

    it('«не спрашивали» — переключатель ВКЛЮЧЁН: молчание значит да', async () => {
        // Главная проверка новой модели. Бэкенд при `unset` сам считает `on: true`; карточка
        // обязана согласиться с ним, а не пересчитать по старому правилу.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: true, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        expect(screen.queryByText(/Ничего не отправляется/)).toBeNull()
    })

    it('зовущего текста нет ни в одном состоянии', async () => {
        // Звать больше некуда: телеметрия уже работает. Текст «помогите сделать лучше»
        // означал бы, что по умолчанию выключено, — это неправда.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: true, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.queryByText(/Помогите сделать splify2 лучше/)).toBeNull()
        expect(screen.queryByText(/По умолчанию выключено/)).toBeNull()
    })

    it('отказ — переключатель выключен и сказано, что ничего не уходит', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'off', on: false, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.getByRole('switch')).not.toBeChecked()
        expect(screen.getByText(/Ничего не отправляется/)).toBeInTheDocument()
        // Карточка при этом на месте и спокойна: выключатель есть, вернуть согласие можно.
        expect(screen.getByRole('switch')).toBeInTheDocument()
        expect(screen.queryByText(/Помогите сделать splify2 лучше/)).toBeNull()
    })

    it('включил сам — переключатель включён', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-0123456789abcdef0123456789abcdef',
            last_at: HOUR_AGO, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    })

    it('нажатие при «не спрашивали» ВЫКЛЮЧАЕТ, а не включает', async () => {
        // Ловит расхождение правила между отрисовкой и обработчиком: переключатель нарисован
        // включённым, значит нажатие на него может означать только отказ.
        const state = vi.spyOn(rpc, 'telemetryState')
            .mockResolvedValueOnce({ consent: 'unset', on: true, id: '', last_at: 0, last_error: '' })
            .mockResolvedValue({ consent: 'off', on: false, id: '', last_at: 0, last_error: '' })
        const set = vi.spyOn(rpc, 'telemetrySet').mockResolvedValue({ ok: true, consent: 'off' })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(false))
        // Перечитывание обязательно: на роутере отказ мог не записаться, и тогда экран
        // показывал бы выключенным то, что продолжает отправляться.
        await waitFor(() => expect(state).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    })

    it('нажатие при отказе включает обратно и перечитывает состояние', async () => {
        const state = vi.spyOn(rpc, 'telemetryState')
            .mockResolvedValueOnce({ consent: 'off', on: false, id: '', last_at: 0, last_error: '' })
            .mockResolvedValue({ consent: 'on', on: true, id: 'sp-x', last_at: HOUR_AGO, last_error: '' })
        const set = vi.spyOn(rpc, 'telemetrySet').mockResolvedValue({ ok: true, consent: 'on' })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(true))
        await waitFor(() => expect(state).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    })

    it('бэкенд не ответил — переключатель не рисуется выключенным', async () => {
        // Состояния «выключено» на роутере в этот момент нет: там работает значение по
        // умолчанию, то есть отправка. Нарисовать «выключено» — соврать в успокаивающую
        // сторону, а это худший вид вранья в карточке про сбор данных.
        vi.spyOn(rpc, 'telemetryState').mockRejectedValue(new Error('нет ответа'))
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument())
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        expect(screen.queryByText(/Ничего не отправляется/)).toBeNull()
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
    })

    it('включено, а прошлая отправка не удалась — причина видна', async () => {
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'on', on: true, id: 'sp-0123456789abcdef0123456789abcdef',
            last_at: HOUR_AGO, last_error: 'панель ответила 429',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(screen.getByText(/панель ответила 429/)).toBeInTheDocument())
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
            consent: 'unset', on: true, id: '', last_at: 0, last_error: '',
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
        // Согласие, которого не спрашивают, держится только на том, что написано, на что оно
        // распространяется. Поэтому оба перечня — на экране.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: true, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.getByText(/Уезжает/)).toBeInTheDocument()
        expect(screen.getByText(/Не уезжает/)).toBeInTheDocument()
        expect(screen.getByText(/ни одного IP-адреса/)).toBeInTheDocument()
    })

    it('сказано, что текст журнала не уезжает — в том числе при падении', async () => {
        // Внеплановый отчёт о падении — единственное место, где журнал напрашивается сам
        // собой. Раз он не уезжает, это должно быть написано, а не подразумеваться.
        vi.spyOn(rpc, 'telemetryState').mockResolvedValue({
            consent: 'unset', on: true, id: '', last_at: 0, last_error: '',
        })
        render(<TelemetryCard />)
        await waitFor(() => expect(rpc.telemetryState).toHaveBeenCalled())
        expect(screen.getByText(/ни одной строки журнала/)).toBeInTheDocument()
        expect(screen.getByText(/в том числе в отчёте о падении/)).toBeInTheDocument()
    })
})
