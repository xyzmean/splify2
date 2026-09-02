import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Zapret from '@/components/sections/Zapret'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'

// Вкладка обхода DPI. Сторожатся ровно те свойства, ради которых она и написана иначе, чем
// меню Zapret Manager:
//
//   1. Проверка идёт В ФОНЕ: страница показывает ход из файла, который пишет чужой процесс, и
//      опрашивает его, только пока он жив. Опрос «навсегда» означал бы вызов ubus каждые две
//      секунды до конца жизни вкладки.
//   2. Признак «идёт» берётся у ПРОЦЕССА, а не из файла хода: файл переживает убитую проверку
//      (снятие питания, OOM), и страница показывала бы «идёт» вечно, не давая запустить новую.
//   3. Число проверки стоит НАПРОТИВ стратегии, и рядом с ним — сколько открылось БЕЗ обхода:
//      без этого числа «30 из 54» не значит ничего.
//   4. У стратегии два места применения — весь роутер и выход kind=zapret, — и применяется
//      она в то, которое выбрано.
//   5. Список сложен СЕМЕЙСТВАМИ под спойлеры, и проверяется ровно то, что названо: кнопка у
//      семейства проверяет семейство, кнопка у стратегии — её одну. Прежний ряд «все ·
//      Flowseal · v · YouTube» стоял дважды — фильтром списка и набором проверки, — и человек,
//      нажав «Flowseal» в списке, получал проверку всех 58 (снято с живого роутера).

const state = {
    installed: true, running: true, enabled: true, version: '72.20260307', curl: true,
    strategies: 3, updated: Math.floor(Date.now() / 1000) - 3600,
    active: 'v5', drifted: false,
}

const cat = {
    active: 'v5',
    updated: state.updated,
    strategies: [
        { name: 'v5', family: 'v' as const },
        { name: 'general (ALT)', family: 'flowseal' as const },
        { name: 'Yv01', family: 'yv' as const },
    ],
    outputs: [{ name: 'yt', strategy: 'Yv01', queue: 8300, up: true }],
}

const results = {
    at: Math.floor(Date.now() / 1000) - 600,
    targets: 54, baseline: 40, scope: 'all',
    results: [{ name: 'v5', ok: 50 }, { name: 'general (ALT)', ok: 38 }, { name: 'Yv01', ok: -1 }],
}

/** Развернуть семейство по имени: свёрнутое семейство своих стратегий не показывает. */
function openFamily(name: string) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`развернуть ${name}`) }))
}

const idle = { state: 'idle' as const, running: false, results_at: results.at }

function mockAll(over: Partial<{
    st: typeof state; cat: typeof cat; res: typeof results
    test: Awaited<ReturnType<typeof rpc.zapretTest>>
}> = {}) {
    vi.spyOn(rpc, 'zapretState').mockResolvedValue({ ...state, ...(over.st || {}) })
    vi.spyOn(rpc, 'zapretStrategies').mockResolvedValue({ ...cat, ...(over.cat || {}) })
    vi.spyOn(rpc, 'zapretResults').mockResolvedValue({ ...results, ...(over.res || {}) })
    return vi.spyOn(rpc, 'zapretTest').mockResolvedValue(over.test || idle)
}

describe('вкладка Zapret', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })
    afterEach(() => { vi.useRealTimers() })

    it('без пакета предлагает установить, а не показывает пустой список', async () => {
        mockAll({ st: { ...state, installed: false } })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/Установить обход DPI/)).toBeInTheDocument())
    })

    it('установка уезжает на роутер', async () => {
        mockAll({ st: { ...state, installed: false } })
        const inst = vi.spyOn(rpc, 'zapretInstall').mockResolvedValue({ ok: true, version: '72' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/Установить обход DPI/)).toBeInTheDocument())
        fireEvent.click(screen.getByText(/Установить обход DPI/))
        await waitFor(() => expect(inst).toHaveBeenCalled())
    })

    it('семейства сложены под спойлеры, открыто то, где применённая стратегия', async () => {
        mockAll()
        render(<Zapret />)
        // Активная — v5, значит семейство v развёрнуто само; остальные свёрнуты, и их
        // стратегий на экране нет — но заголовки с числом есть.
        await waitFor(() => expect(screen.getByRole('button', { name: 'v5' })).toBeInTheDocument())
        expect(screen.queryByText('general (ALT)')).toBeNull()
        expect(screen.getByRole('button', { name: /развернуть Flowseal/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /развернуть YouTube/ })).toBeInTheDocument()
        openFamily('Flowseal')
        expect(screen.getByText('general (ALT)')).toBeInTheDocument()
    })

    it('стратегии перечислены, активная отмечена', async () => {
        mockAll()
        render(<Zapret />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'v5' })).toBeInTheDocument())
        openFamily('YouTube')
        // Yv01 встречается ДВАЖДЫ, и это не дубликат: один раз в списке стратегий, второй —
        // как то, что уже применено у выхода yt в карточке «Куда применить». Проверять
        // getByText здесь нельзя именно поэтому.
        expect(screen.getAllByText('Yv01').length).toBe(2)
        // Отметка одна: применённой считается стратегия ВЫБРАННОГО места, а по умолчанию
        // выбран весь роутер. Две отметки означали бы, что список путает роутер с выходом.
        expect(document.querySelectorAll('[data-icon="Check"]').length).toBe(1)
    })

    it('число проверки стоит напротив стратегии, и назван результат без обхода', async () => {
        mockAll()
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('50/54')).toBeInTheDocument())
        openFamily('Flowseal')
        expect(screen.getByText('38/54')).toBeInTheDocument()
        // Без этого числа результат не значит ничего: может, у этого провайдера и без
        // обхода открывается сорок.
        expect(screen.getByText(/без обхода открылось/)).toBeInTheDocument()
    })

    it('стратегия, которая не поднялась, названа отдельно, а не выброшена из списка', async () => {
        // Молча выбросить её значило бы оставить человека гадать, почему в списке дырка.
        mockAll()
        render(<Zapret />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'v5' })).toBeInTheDocument())
        openFamily('YouTube')
        expect(screen.getByText('не идёт')).toBeInTheDocument()
    })

    it('применение идёт ВСЕМУ РОУТЕРУ, пока не выбран выход', async () => {
        mockAll()
        const ap = vi.spyOn(rpc, 'zapretApply').mockResolvedValue({ ok: true, name: 'Yv01' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'v5' })).toBeInTheDocument())
        openFamily('YouTube')
        // Последняя строка списка — Yv01; место применения не выбрано, значит уехать должно
        // пустое имя выхода, то есть «весь роутер».
        const rows = screen.getAllByText('Применить')
        fireEvent.click(rows[rows.length - 1])
        await waitFor(() => expect(ap).toHaveBeenCalledWith('Yv01', ''))
    })

    // «Как мне отключить стратегию на весь роутер?» — владелец, со скрина вкладки: строка
    // «Весь роутер» показывала стратегию и не давала её выключить. Выключается СЛУЖБА, а не
    // стирается стратегия: отметка остаётся (Zapret Manager видит своё), выходы обхода работают.
    it('обход на весь роутер выключается кнопкой в строке «Весь роутер»', async () => {
        mockAll()
        const en = vi.spyOn(rpc, 'zapretEnable').mockResolvedValue({ ok: true, enabled: false, running: false })
        render(<Zapret />)
        const btn = await screen.findByRole('button', { name: 'Выключить обход' })
        fireEvent.click(btn)
        await waitFor(() => expect(en).toHaveBeenCalledWith(false))
        // Стратегия при этом не «снята»: applyи не звались.
        expect(screen.queryByText('Включить обход')).toBeNull() // до перечитывания состояния
    })

    it('выключенный обход назван выключенным, а не сломанным, и включается обратно', async () => {
        mockAll({ st: { ...state, running: false, enabled: false } })
        const en = vi.spyOn(rpc, 'zapretEnable').mockResolvedValue({ ok: true, enabled: true, running: true })
        render(<Zapret />)
        const btn = await screen.findByRole('button', { name: 'Включить обход' })
        // В шапке — «выключен», не «не запущен»: это решение человека, а не поломка.
        expect(screen.getAllByText('выключен').length).toBeGreaterThan(0)
        expect(screen.queryByText('не запущен')).toBeNull()
        // Стратегия по-прежнему названа в строке: она не стёрта.
        expect(screen.getAllByText('v5').length).toBeGreaterThan(0)
        // И сказано, что выходы обхода продолжают работать.
        expect(document.body.textContent).toMatch(/выходы обхода ниже работают/)
        fireEvent.click(btn)
        await waitFor(() => expect(en).toHaveBeenCalledWith(true))
    })

    it('и ВЫХОДУ, когда выход выбран', async () => {
        mockAll()
        const ap = vi.spyOn(rpc, 'zapretApply').mockResolvedValue({ ok: true, name: 'v5', out: 'yt' })
        render(<Zapret />)
        // Строка выхода, а не любое слово «выход»: рядом теперь есть и поле «имя нового
        // выхода», и кнопка «Завести выход», и подсказка про то, что такое выход.
        await waitFor(() => expect(screen.getByText('выход yt')).toBeInTheDocument())
        fireEvent.click(screen.getByText('выход yt'))
        // Теперь у выхода применена Yv01, значит отмечена должна быть она, а «Применить» у
        // v5 стать доступной. Семейство v у этого места применения свёрнуто — открываем.
        await waitFor(() => expect(screen.getByText(/для выхода/)).toBeInTheDocument())
        openFamily('v')
        const rows = screen.getAllByText('Применить')
        fireEvent.click(rows[0])
        await waitFor(() => expect(ap).toHaveBeenCalledWith('v5', 'yt'))
    })

    it('общая «Проверить» проверяет все, кнопка семейства — семейство', async () => {
        mockAll()
        const start = vi.spyOn(rpc, 'zapretTestStart').mockResolvedValue({ ok: true, scope: 'all' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('Проверить')).toBeInTheDocument())
        fireEvent.click(screen.getByText('Проверить'))
        await waitFor(() => expect(start).toHaveBeenCalledWith('all'))
        // Пока запуск в полёте, кнопки семейств заперты — вторая проверка поделила бы с первой
        // очередь и диапазон портов. Дождаться, пока отпустит.
        const fam = screen.getByRole('button', { name: /проверить семейство Flowseal/ })
        await waitFor(() => expect(fam).not.toBeDisabled())
        fireEvent.click(fam)
        await waitFor(() => expect(start).toHaveBeenCalledWith('flowseal'))
    })

    it('развёрнутая стратегия показывает ключи и открывшиеся цели, и проверяется одна', async () => {
        mockAll({
            res: {
                ...results,
                sets: {
                    general: {
                        baseline: 1, total: 3, targets: ['a.ru', 'b.ru', 'c.ru'], opened: ['a.ru'],
                    },
                },
                results: [{ name: 'v5', ok: 2, total: 3, set: 'general', opened: ['a.ru', 'b.ru'] }],
            } as never,
        })
        const one = vi.spyOn(rpc, 'zapretStrategy').mockResolvedValue({
            name: 'v5', family: 'v', opts: ['--filter-tcp=443', '--dpi-desync=fake'],
        })
        const start = vi.spyOn(rpc, 'zapretTestStart').mockResolvedValue({ ok: true, scope: 'one:v5' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('2/3')).toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'v5' }))
        // Ключи — по запросу и дословно.
        await waitFor(() => expect(one).toHaveBeenCalledWith('v5'))
        await waitFor(() => expect(screen.getByText(/--dpi-desync=fake/)).toBeInTheDocument())
        // Все три цели названы; та, что открывается и без обхода, помечена.
        expect(screen.getByText('a.ru')).toBeInTheDocument()
        expect(screen.getByText('c.ru')).toBeInTheDocument()
        expect(screen.getAllByText('и без обхода').length).toBe(1)
        fireEvent.click(screen.getByText('проверить эту стратегию'))
        await waitFor(() => expect(start).toHaveBeenCalledWith('one:v5'))
    })

    it('пока проверка идёт, показан ход и кнопка «Остановить»', async () => {
        mockAll({
            test: {
                state: 'running', running: true, done: 7, total: 49, targets: 54,
                current: 'general (ALT3)', results_at: results.at,
            },
        })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/general \(ALT3\)/)).toBeInTheDocument())
        expect(screen.getByText('Остановить')).toBeInTheDocument()
        expect(screen.queryByText('Проверить')).toBeNull()
    })

    it('файл хода без живого процесса не выдаётся за идущую проверку', async () => {
        // Ровно то, что остаётся после снятия питания посреди проверки: state=running в
        // файле, а процесса нет. Верить файлу здесь значило бы навсегда запретить запуск
        // новой проверки.
        mockAll({
            test: { state: 'running', running: false, done: 7, total: 49, results_at: results.at },
        })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('Проверить')).toBeInTheDocument())
    })

    it('расхождение каталога с активной стратегией названо, но ничего не подменяет', async () => {
        // Ночное обновление активную стратегию НЕ трогает — это требование владельца.
        // Значит единственный способ узнать о новой версии — увидеть здесь.
        mockAll({ st: { ...state, drifted: true } })
        render(<Zapret />)
        await waitFor(() =>
            expect(screen.getByText(/в каталоге изменилась/)).toBeInTheDocument())
    })

    it('без curl проверка не предлагается', async () => {
        mockAll({ st: { ...state, curl: false } })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/нет curl/)).toBeInTheDocument())
        expect(screen.getByText('Проверить')).toBeDisabled()
    })

    it('выход обхода заводится здесь и уходит в ЧЕРНОВИК, а не применяется сам', async () => {
        // Здесь, а не в общем редакторе выходов: тот знает два вида выхода (локация подписки
        // и свои туннели), а у выхода обхода устройства нет вовсе. И в черновик: это правка
        // МАРШРУТИЗАЦИИ, применяет её та же плавающая пилюля, что и остальные правки спеки —
        // второй способ применять спеку означал бы два места, которые могут разойтись.
        mockAll()
        const spec = { outputs: { direct: { name: 'direct', kind: 'direct' as const } }, channels: [] }
        vi.spyOn(pending, 'load').mockResolvedValue(spec as never)
        const edit = vi.spyOn(pending, 'edit').mockImplementation(() => undefined)
        render(<Zapret />)
        await waitFor(() => expect(screen.getByLabelText('имя нового выхода')).toBeInTheDocument())
        fireEvent.input(screen.getByLabelText('имя нового выхода'), { target: { value: 'yt2' } })
        fireEvent.click(screen.getByText('Завести выход'))
        await waitFor(() => expect(edit).toHaveBeenCalled())
        const next = edit.mock.calls[0][0] as { outputs: Record<string, { kind: string; on_fail: string }> }
        expect(next.outputs.yt2.kind).toBe('zapret')
        // Умолчание общее для всех выходов — «остановить трафик»: канал заводят ради обхода,
        // и молча вернуть трафик на открытый путь в момент, когда обход умер, — значит
        // нарушить единственное обещание выхода ровно тогда, когда это важнее всего.
        expect(next.outputs.yt2.on_fail).toBe('drop')
        expect(next.outputs.direct).toBeTruthy()
    })

    it('негодное имя выхода не заводится', async () => {
        mockAll()
        const edit = vi.spyOn(pending, 'edit').mockImplementation(() => undefined)
        render(<Zapret />)
        await waitFor(() => expect(screen.getByLabelText('имя нового выхода')).toBeInTheDocument())
        fireEvent.input(screen.getByLabelText('имя нового выхода'), { target: { value: 'ютуб!' } })
        fireEvent.click(screen.getByText('Завести выход'))
        await waitFor(() => expect(screen.getByText(/латиница, цифры/)).toBeInTheDocument())
        expect(edit).not.toHaveBeenCalled()
    })

    it('сказано, что проверка не трогает пользовательский трафик', async () => {
        mockAll()
        render(<Zapret />)
        await waitFor(() =>
            expect(screen.getByText(/Пользовательского трафика проверка не касается/)).toBeInTheDocument())
    })
})
