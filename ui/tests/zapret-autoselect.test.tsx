import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Zapret from '@/components/sections/Zapret'
import { rpc } from '@/lib/rpc'

// Автоподбор стратегии обхода — сторона интерфейса.
//
// ЧТО ЗДЕСЬ СТОРОЖИТСЯ И ПОЧЕМУ ИМЕННО ЭТО. Правило выбора живёт в движке подбора и
// проверяется его стендом (splify2/tests/autoselmatch.sh) — здесь ни одна проверка не считает
// доли и не сравнивает стратегии. Сторожатся ровно те свойства страницы, ошибка в которых
// молчит:
//
//   1. ОТКАЗ — ЭТО ОТВЕТ. Победителя нет, а причина есть: «уже применена лучшая», «не лучше
//      работающей», «проверка не проходила» — три разных состояния, и по строке человек
//      решает, жать ли кнопку. Пустая карточка вместо строки выглядит как поломка.
//   2. КНОПКА ОТКАТА ПОЯВЛЯЕТСЯ ТОЛЬКО КОГДА ОТКАТ ВОЗМОЖЕН. Кнопка, отказывающая при
//      нажатии, хуже отсутствующей: она обещает то, чего нет.
//   3. РАСПИСАНИЕ ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ и это ВИДНО как выбор, а не как отсутствие выбора:
//      применение стратегии перезапускает обход и меняет то, что работает у всех клиентов.
//   4. Нажатое доезжает до того метода и с тем аргументом.

const game = { gv: '', xtreme: false, fake: '', fakes: [] as { name: string; present: boolean }[] }
const state = {
    installed: true, running: true, enabled: true, version: '72.20260307', curl: true,
    strategies: 3, updated: Math.floor(Date.now() / 1000) - 3600,
    active: 'v5', drifted: false, game,
}
const cat = {
    active: 'v5', updated: state.updated,
    strategies: [{ name: 'v5', family: 'v' as const }, { name: 'v9', family: 'v' as const }],
    outputs: [] as { name: string; strategy: string; queue: number; up: boolean }[],
}
const results = { at: Math.floor(Date.now() / 1000) - 600, targets: 54, baseline: 40, results: [] }
const idle = { state: 'idle' as const, running: false, results_at: results.at }

type Auto = Awaited<ReturnType<typeof rpc.zapretAutoselect>>
const autoOff: Auto = {
    every_days: 0, on: false, at: 0, can_undo: false, rank: [], running: false,
    note: 'рейтинга нет: проверка не проходила или ни одна стратегия не поднялась',
}

function mockAll(auto: Partial<Auto> = {}) {
    vi.spyOn(rpc, 'zapretState').mockResolvedValue(state)
    vi.spyOn(rpc, 'zapretStrategies').mockResolvedValue(cat)
    vi.spyOn(rpc, 'zapretResults').mockResolvedValue(results)
    vi.spyOn(rpc, 'zapretTest').mockResolvedValue(idle)
    return vi.spyOn(rpc, 'zapretAutoselect').mockResolvedValue({ ...autoOff, ...auto })
}

describe('автоподбор стратегии обхода', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('причина отказа показывается: пустая карточка выглядела бы как поломка', async () => {
        mockAll({ note: 'уже применена лучшая: v5 (50 из 54)' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/уже применена лучшая/)).toBeInTheDocument())
        // И победителя при этом не выдумывает: строки «лучшая по замеру» быть не должно.
        expect(screen.queryByText(/лучшая по замеру/)).not.toBeInTheDocument()
    })

    it('победитель назван вместе с числом — «v9» без числа не значит ничего', async () => {
        mockAll({
            note: '',
            winner: { name: 'v9', ok: 53, total: 54, set: 'general' },
            rank: [{ name: 'v9', ok: 53, total: 54, keys: 6, set: 'general' }],
        })
        render(<Zapret />)
        // Имя И число — В ОДНОЙ строке приговора, а не где-нибудь на странице: «v9» есть и в
        // списке стратегий, и в рейтинге, поэтому проверка ищет их вместе, внутри той самой
        // строки. Иначе она была бы зелена и при пустом приговоре.
        const verdict = await waitFor(() => screen.getByText(/лучшая по замеру/))
        expect(verdict.textContent).toMatch(/v9/)
        expect(verdict.textContent).toMatch(/53.*54/)
    })

    it('кнопки отката нет, пока откат невозможен', async () => {
        mockAll({ can_undo: false })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/Подобрать и применить/)).toBeInTheDocument())
        expect(screen.queryByRole('button', { name: /Вернуть как было/ })).not.toBeInTheDocument()
    })

    it('откат предлагается, когда он возможен, и зовёт свой метод', async () => {
        mockAll({
            can_undo: true, at: Math.floor(Date.now() / 1000) - 7200,
            applied: 'v9', applied_ok: 53, applied_total: 54, by: 'auto', prev: 'v5',
        })
        const undo = vi.spyOn(rpc, 'zapretAutoselectUndo').mockResolvedValue({ ok: true, active: 'v5' })
        render(<Zapret />)
        const btn = await screen.findByRole('button', { name: /Вернуть как было/ })
        // Заодно проверяется, что применённое подбором названо И что сказано, чем оно было
        // применено: через месяц это единственный способ понять, почему стратегия не та,
        // которую выбирали руками.
        expect(screen.getByText(/подобрано по расписанию/)).toBeInTheDocument()
        expect(screen.getByText(/было.*v5/)).toBeInTheDocument()
        fireEvent.click(btn)
        await waitFor(() => expect(undo).toHaveBeenCalled())
    })

    it('«подобрано вручную» и «по расписанию» — разные строки', async () => {
        mockAll({ at: Math.floor(Date.now() / 1000) - 60, applied: 'v9', by: 'manual' })
        render(<Zapret />)
        await waitFor(() => expect(screen.getByText(/подобрано вручную/)).toBeInTheDocument())
    })

    it('«Подобрать и применить» зовёт подбор, а не проверку', async () => {
        mockAll()
        const start = vi.spyOn(rpc, 'zapretAutoselectStart').mockResolvedValue({ ok: true, scope: 'all' })
        const test = vi.spyOn(rpc, 'zapretTestStart').mockResolvedValue({ ok: true })
        render(<Zapret />)
        fireEvent.click(await screen.findByRole('button', { name: /Подобрать и применить/ }))
        await waitFor(() => expect(start).toHaveBeenCalledWith('all'))
        expect(test).not.toHaveBeenCalled()
    })

    it('пока подбор идёт, кнопка занята и говорит об этом', async () => {
        mockAll({ running: true })
        render(<Zapret />)
        const btn = await screen.findByRole('button', { name: /подбираю/ })
        expect(btn).toBeDisabled()
    })

    it('выключенное расписание видно как ВЫБОР «не надо», а не как пустота', async () => {
        mockAll({ every_days: 0 })
        render(<Zapret />)
        const off = await screen.findByRole('button', { name: /не надо/ })
        // У выбранной кнопки вариант default, у остальных outline. Проверяется по классу
        // фона: имя варианта — внутреннее дело кнопки, а вот «выделена ли она» видит человек.
        expect(off.className).toMatch(/bg-primary/)
    })

    it('срок сохраняется тем числом, которое нажали', async () => {
        mockAll({ every_days: 0 })
        const set = vi.spyOn(rpc, 'zapretAutoselectSet').mockResolvedValue({ ok: true, every_days: 7 })
        render(<Zapret />)
        fireEvent.click(await screen.findByRole('button', { name: /раз в 7 сут/ }))
        await waitFor(() => expect(set).toHaveBeenCalledWith(7))
    })

    it('включённое расписание показано выбранным', async () => {
        mockAll({ every_days: 30, on: true })
        render(<Zapret />)
        const b = await screen.findByRole('button', { name: /раз в 30 сут/ })
        expect(b.className).toMatch(/bg-primary/)
    })

    it('без curl подбор не предлагается: мерить нечем', async () => {
        vi.spyOn(rpc, 'zapretState').mockResolvedValue({ ...state, curl: false })
        vi.spyOn(rpc, 'zapretStrategies').mockResolvedValue(cat)
        vi.spyOn(rpc, 'zapretResults').mockResolvedValue(results)
        vi.spyOn(rpc, 'zapretTest').mockResolvedValue(idle)
        vi.spyOn(rpc, 'zapretAutoselect').mockResolvedValue(autoOff)
        render(<Zapret />)
        const btn = await screen.findByRole('button', { name: /Подобрать и применить/ })
        expect(btn).toBeDisabled()
    })
})
