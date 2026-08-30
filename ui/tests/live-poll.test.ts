import { renderHook, waitFor, act } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLive } from '@/lib/live'
import { rpc } from '@/lib/rpc'

// Круг опроса: сколько раз в пять секунд интерфейс беспокоит роутер и о чём спрашивает.
//
// Замерено на стенде 10.8.1.87 (mipsel 24kc, 880 МГц, OpenWrt 25.12). Круг стоил пяти
// вызовов — status, dev_stats, engine_state, diag, net_info, — и это 1232 мс работы роутера
// каждые пять секунд. Из них 630 мс не давали НИЧЕГО: каждый вызов ubus запускает скрипт
// объекта заново, а busybox ash разбирает его 126 мс, при том что сам ответ считается 30-90 мс.
// LuCI к тому же складывает вызовы одного такта в ОДИН запрос и выполняет их подряд, поэтому
// это была и задержка на экране: числа обновлялись через 1,2-1,5 с после начала круга.
//
// Одним вызовом — 240 мс; с проверками движка — 432 мс, поэтому проверки спрашиваются не
// каждый круг. Здесь закреплено и то, и другое: без этих утверждений «оптимизация» проверяется
// только глазами, а вернуть пять вызовов может любая правка соседней строки.

const STATUS = { schema: 1, outputs: {}, channels: [] }
const DEVICES = { wg0: { rx: '10', tx: '20', rx_packets: '1', tx_packets: '2' } }
const NET = { uptime: 42, active_clients: 3 }
const DIAG = { checks: [], warn: 0, fail: 1 }

function mockLive() {
    return vi.spyOn(rpc, 'live').mockResolvedValue({
        status: STATUS, devices: DEVICES, net: NET, diag: DIAG,
    } as never)
}

describe('круг опроса: один вызов вместо пяти', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
    })
    afterEach(() => { vi.useRealTimers() })

    it('спрашивает роутер ОДНИМ вызовом, а не пятью', async () => {
        const live = mockLive()
        const status = vi.spyOn(rpc, 'status')
        const devStats = vi.spyOn(rpc, 'devStats')
        const netInfo = vi.spyOn(rpc, 'netInfo')
        const diag = vi.spyOn(rpc, 'diag')
        const engineState = vi.spyOn(rpc, 'engineState')
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true } as never)
        vi.spyOn(rpc, 'steerVersions').mockResolvedValue({} as never)
        vi.spyOn(rpc, 'splify2Versions').mockResolvedValue({} as never)

        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.status).not.toBeNull())

        expect(live).toHaveBeenCalledTimes(1)
        for (const gone of [status, devStats, netInfo, diag]) expect(gone).not.toHaveBeenCalled()
        // Журнал движка круга больше не касается вовсе: его читает экран диагностики, пока
        // открыт. На стенде это 350 мс каждые пять секунд ради строк, которых на экране нет.
        expect(engineState).not.toHaveBeenCalled()
    })

    it('числа из ответа доезжают до экрана целиком', async () => {
        mockLive()
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.status).not.toBeNull())
        expect(result.current.devs).toEqual(DEVICES)
        expect(result.current.net).toEqual(NET)
        expect(result.current.diag).toEqual(DIAG)
        // Первый ответ роутера — конец «прошлого»: дальше на экране живое.
        expect(result.current.stale).toBe(false)
    })

    it('проверки движка — первым кругом и раз в двадцать секунд, а не каждые пять', async () => {
        const live = mockLive()
        /* Здесь время поддельное: круги идут раз в пять секунд, и ждать их взаправду значило
         * бы держать стенд полминуты. Ответы приходят промисами, поэтому первый круг
         * досчитывается прокруткой очереди микрозадач, а не таймером. */
        vi.useFakeTimers()
        renderHook(() => useLive())
        await act(async () => { await Promise.resolve() })
        expect(live).toHaveBeenLastCalledWith(true)

        // Три круга подряд идут без проверок: приговор меняется, когда что-то применили или
        // туннель упал, — про первое интерфейс знает сам, второе видно по полю `up` выхода.
        for (const round of [1, 2, 3]) {
            await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
            expect(live, `круг ${round}`).toHaveBeenLastCalledWith(false)
        }
        // Двадцать секунд прошло — спрашиваем снова.
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(live).toHaveBeenLastCalledWith(true)
    })

    it('объект старее интерфейса: круг идёт прежними вызовами, а экран не пустеет', async () => {
        // Пакет обновили, rpcd не перезапустили — метода `live` в объекте нет. Это не отказ
        // роутера и человеку показывать нечего: переходим на прежние вызовы молча.
        vi.spyOn(rpc, 'live').mockRejectedValue(new Error('Method not found'))
        const status = vi.spyOn(rpc, 'status').mockResolvedValue(STATUS as never)
        const devStats = vi.spyOn(rpc, 'devStats').mockResolvedValue({ devices: DEVICES } as never)
        const netInfo = vi.spyOn(rpc, 'netInfo').mockResolvedValue(NET as never)
        const diag = vi.spyOn(rpc, 'diag').mockResolvedValue(DIAG as never)

        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.status).not.toBeNull())
        expect(status).toHaveBeenCalled()
        expect(devStats).toHaveBeenCalled()
        expect(netInfo).toHaveBeenCalled()
        expect(diag).toHaveBeenCalled()
        expect(result.current.devs).toEqual(DEVICES)
        expect(result.current.error).toBeNull()
    })

    it('беда приезжает успешным ответом — и остаётся бедой', async () => {
        // Бэкенд по контракту отвечает на ошибку объектом {ok:false,error} и кодом нуль.
        // Принять его за состояние значит нарисовать «Работает» зелёной точкой на роутере,
        // где движок не отвечает.
        vi.spyOn(rpc, 'live').mockResolvedValue({ ok: false, error: 'движок не ответил' } as never)
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.error).toBe('движок не ответил'))
        expect(result.current.status).toBeNull()
    })
})
