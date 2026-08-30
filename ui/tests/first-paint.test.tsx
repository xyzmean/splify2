import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from '@/components/sections/Home'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

// «И даже на твоём скрине всё ещё надпись загрузка» — претензия владельца к открытию
// страницы. Замерено на роутере, откуда она бралась: страница живёт внутри LuCI, и до первого
// ответа ubus проходит секунда с лишним только на загрузку самой LuCI, загрузчика и бандла. А
// первый пакет вызовов ubus содержал два похода на api.github.com за списком релизов — LuCI
// складывает вызовы одного такта в ОДИН запрос и выполняет их подряд, поэтому обзор ждал
// интернета, чтобы нарисовать состояние движка, готовое за четверть секунды. Пакет занимал
// 5,7 с.
//
// Отсюда две вещи, которые здесь и проверяются. Первая: состояние прошлого открытия рисуется
// сразу и НЕ выдаётся за живое — иначе это уже не задержка, а неправда. Вторая: пока роутер
// не ответил, на экране нет слова «Загрузка» — оно и было тем, на что жаловались.

const OK = {
    status: { schema: 1, outputs: {}, channels: [] },
    diag: { fail: 0, warn: 0, checks: [] },
    net: { uptime: 120, active_clients: 3 },
}

describe('первая отрисовка: прошлое как прошлое (Andromeda)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', present: false } as never)
    })

    it('пока роутер не ответил — «Обновление…», а не «Загрузка…» и не прежний вердикт', () => {
        render(<Home live={live({ ...OK, stale: true })} onSection={() => {}} onAddRule={() => {}} />)
        expect(screen.getByRole('heading', { name: /Обновление/ })).toBeInTheDocument()
        expect(screen.queryByText(/Загрузка/)).toBeNull()
        // Прежний вердикт не выдаётся за сегодняшний: «работает» скажем, когда ответят.
        expect(screen.queryByRole('heading', { name: /Маршрутизация работает/ })).toBeNull()
    })

    it('числа из снимка при этом видны сразу — ради них страницу и открывают', () => {
        render(<Home live={live({ ...OK, stale: true })} onSection={() => {}} onAddRule={() => {}} />)
        expect(screen.getByText(/устройств в сети: 3/)).toBeInTheDocument()
    })

    it('пришёл ответ роутера — обычный вердикт', () => {
        render(<Home live={live({ ...OK, stale: false })} onSection={() => {}} onAddRule={() => {}} />)
        expect(screen.getByRole('heading', { name: /Маршрутизация работает/ })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: /Обновление/ })).toBeNull()
    })

    it('снимка нет вовсе — «Загрузка…» остаётся: выдумывать состояние нечем', () => {
        render(<Home live={live({ stale: false })} onSection={() => {}} onAddRule={() => {}} />)
        expect(screen.getByRole('heading', { name: /Загрузка/ })).toBeInTheDocument()
    })

    it('поломка из снимка видна сразу, а не через три секунды', async () => {
        render(
            <Home
                live={live({
                    ...OK,
                    diag: { fail: 1, warn: 0, checks: [] },
                    stale: true,
                })}
                onSection={() => {}}
                onAddRule={() => {}}
            />,
        )
        // Вердикт пока «Обновление…» — роутер не ответил, — но найденное в прошлый раз уже
        // на экране: ради него страницу и открывают.
        expect(screen.getByRole('heading', { name: /Обновление/ })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByText(/проверок с отказом: 1/)).toBeInTheDocument())
    })
})
