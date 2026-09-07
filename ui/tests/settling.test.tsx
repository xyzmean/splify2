import { render, screen, waitFor, act } from '@testing-library/preact'
import { renderHook } from '@testing-library/preact'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useLive } from '@/lib/live'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import Home from '@/components/sections/Home'
import { live } from './fixtures'

// Переходные состояния — применение и загрузка — не выдаются за поломку.
//
// Владелец: «пока splify2 применяет конфигурацию или загружается — может писать про ошибки,
// так не должно быть». Сторожатся три свойства:
//
//   1. Один промолчавший круг — ещё не «Движок не отвечает»: между нажатием «Применить» и
//      подъёмом клиента туннеля проходят секунды, и всё это время status честно отвечает
//      «выход не поднят». Приговором молчание становится с третьего круга подряд.
//   2. Пока идёт применение (и его хвост), молчание не считается вовсе, а экран говорит
//      «Применяется…» серой точкой и без находок.
//   3. Служба движка включена, но ещё не работает — это загрузка роутера, слово ей
//      «Запускается…», а не красный заголовок.

const FAIL = { ok: false, error: 'движок не ответил' }

/** Ещё один круг опроса без ожидания пяти секунд: возврат на вкладку опрашивает сразу. */
async function poll() {
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await new Promise((r) => setTimeout(r, 30))
    })
}

describe('переход — не поломка', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        pending.appliedAt = 0
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true, enabled: true, running: true } as never)
        vi.spyOn(rpc, 'steerVersions').mockResolvedValue({} as never)
        vi.spyOn(rpc, 'splify2Versions').mockResolvedValue({} as never)
    })
    afterEach(() => { pending.appliedAt = 0 })

    it('первый промолчавший круг — ещё не беда, третий подряд — беда', async () => {
        const call = vi.spyOn(rpc, 'live').mockResolvedValue(FAIL as never)
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(call).toHaveBeenCalled())
        expect(result.current.error).toBeNull()
        for (let i = 0; i < 3 && result.current.error === null; i++) await poll()
        await waitFor(() => expect(result.current.error).toBe('движок не ответил'))
        expect(call.mock.calls.length).toBeGreaterThanOrEqual(3)
        expect(result.current.phase).toBeNull()
    })

    it('ответ пришёл — счёт молчания начинается заново', async () => {
        const call = vi.spyOn(rpc, 'live')
            .mockResolvedValueOnce(FAIL as never)
            .mockResolvedValueOnce({ status: { schema: 1, outputs: {}, channels: [] } } as never)
            .mockResolvedValue(FAIL as never)
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(call.mock.calls.length).toBeGreaterThanOrEqual(2))
        await poll()
        await poll()
        // Промолчал, ответил, промолчал дважды — приговора нет: подряд было только два.
        expect(result.current.error).toBeNull()
    })

    it('во время применения молчание не считается, а экран говорит «Применяется…»', async () => {
        pending.appliedAt = Date.now()
        const call = vi.spyOn(rpc, 'live').mockResolvedValue(FAIL as never)
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(call).toHaveBeenCalled())
        await poll(); await poll(); await poll(); await poll()
        expect(result.current.error).toBeNull()
        expect(result.current.phase).toBe('applying')
    })

    it('служба включена, но не поднялась — «Запускается…», а не поломка', async () => {
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true, enabled: true, running: false } as never)
        vi.spyOn(rpc, 'live').mockResolvedValue(FAIL as never)
        const { result } = renderHook(() => useLive())
        for (let i = 0; i < 4 && result.current.phase !== 'starting'; i++) await poll()
        await waitFor(() => expect(result.current.phase).toBe('starting'))
    })

    it('главная во время применения: нейтральный заголовок и никаких находок', () => {
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', present: false } as never)
        render(
            <Home
                live={live({
                    phase: 'applying',
                    status: { schema: 1, outputs: {}, channels: [] },
                    diag: { warn: 0, fail: 2, checks: [] },
                })}
                onSection={() => {}}
                onAddRule={() => {}}
            />,
        )
        expect(screen.getByRole('heading', { name: /Применяется/ })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: /Есть поломки/ })).toBeNull()
        // Находки этих секунд — стройплощадка: полосы «проверок с отказом» нет.
        expect(screen.queryByText(/проверок с отказом/)).toBeNull()
    })

    it('главная при загрузке роутера: «Запускается…» вместо «Движок не отвечает»', () => {
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'subInfo').mockResolvedValue({ kind: 'none', present: false } as never)
        render(
            <Home
                live={live({ phase: 'starting', error: 'движок не ответил' })}
                onSection={() => {}}
                onAddRule={() => {}}
            />,
        )
        expect(screen.getByRole('heading', { name: /Запускается/ })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: /не отвечает/ })).toBeNull()
    })
})
