import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Zapret from '@/components/sections/Zapret'
import { rpc } from '@/lib/rpc'

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

const state = {
    installed: true, running: true, version: '72.20260307', curl: true,
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

    it('стратегии перечислены, активная отмечена', async () => {
        mockAll()
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('general (ALT)')).toBeInTheDocument())
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
        expect(screen.getByText('38/54')).toBeInTheDocument()
        // Без этого числа результат не значит ничего: может, у этого провайдера и без
        // обхода открывается сорок.
        expect(screen.getByText(/без обхода открылось/)).toBeInTheDocument()
    })

    it('стратегия, которая не поднялась, названа отдельно, а не выброшена из списка', async () => {
        // Молча выбросить её значило бы оставить человека гадать, почему в списке дырка.
        mockAll()
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('не идёт')).toBeInTheDocument())
    })

    it('применение идёт ВСЕМУ РОУТЕРУ, пока не выбран выход', async () => {
        mockAll()
        const ap = vi.spyOn(rpc, 'zapretApply').mockResolvedValue({ ok: true, name: 'Yv01' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getAllByText('Yv01').length).toBe(2))
        // Последняя строка списка — Yv01; место применения не выбрано, значит уехать должно
        // пустое имя выхода, то есть «весь роутер».
        const rows = screen.getAllByText('Применить')
        fireEvent.click(rows[rows.length - 1])
        await waitFor(() => expect(ap).toHaveBeenCalledWith('Yv01', ''))
    })

    it('и ВЫХОДУ, когда выход выбран', async () => {
        mockAll()
        const ap = vi.spyOn(rpc, 'zapretApply').mockResolvedValue({ ok: true, name: 'v5', out: 'yt' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/выход/)).toBeInTheDocument())
        fireEvent.click(screen.getByText(/выход/))
        // Теперь у выхода применена Yv01, значит отмечена должна быть она, а «Применить» у
        // v5 стать доступной.
        await waitFor(() => expect(screen.getByText(/для выхода/)).toBeInTheDocument())
        const rows = screen.getAllByText('Применить')
        fireEvent.click(rows[0])
        await waitFor(() => expect(ap).toHaveBeenCalledWith('v5', 'yt'))
    })

    it('проверка запускается с выбранным набором', async () => {
        mockAll()
        const start = vi.spyOn(rpc, 'zapretTestStart').mockResolvedValue({ ok: true, scope: 'v' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText('Проверить')).toBeInTheDocument())
        fireEvent.click(screen.getAllByText('v')[0])
        fireEvent.click(screen.getByText('Проверить'))
        await waitFor(() => expect(start).toHaveBeenCalledWith('v'))
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

    it('сказано, что проверка не трогает пользовательский трафик', async () => {
        mockAll()
        render(<Zapret />)
        await waitFor(() =>
            expect(screen.getByText(/Пользовательского трафика проверка не касается/)).toBeInTheDocument())
    })
})
