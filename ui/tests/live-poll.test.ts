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

        // ОДИН МЕТОД вместо пяти — вот что здесь проверяется. Кругов при открытии два
        // (быстрый по памяти движка и догоняющий за свежим), но оба спрашивают один `live`, а
        // не пять отдельных вызовов, каждый из которых заново разбирает 250-килобайтный
        // скрипт объекта.
        expect(live.mock.calls.length).toBeLessThanOrEqual(2)
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
        // Первый круг — быстрый, и проверок он НЕ просит: память движка отдаётся мгновенно, а
        // `steer diag` считается заново (201 мс против 91 мс на стенде), то есть вместе они
        // вернули бы то ожидание, ради снятия которого память и заведена. Приговор на экране
        // при этом есть — из снимка прошлого открытия, помеченный как прошлое.
        expect(live.mock.calls[0]).toEqual([false, true])

        // Догоняющий круг за быстрым спрашивает их сразу же.
        expect(live.mock.calls[1]).toEqual([true, false])
        // Три круга подряд идут без проверок: приговор меняется, когда что-то применили или
        // туннель упал, — про первое интерфейс знает сам, второе видно по полю `up` выхода.
        for (const round of [1, 2, 3]) {
            await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
            expect(live, `круг ${round}`).toHaveBeenLastCalledWith(false, false)
        }
        // Двадцать секунд прошло — спрашиваем снова. Память при этом НЕ просится: она нужна
        // ровно первому кругу, тому, что рисует экран, а дальше страница и так опрашивает
        // роутер каждые пять секунд — там память была бы не ускорением, а враньём.
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(live).toHaveBeenLastCalledWith(true, false)
    })

    // ---- память движка на первом круге ------------------------------------------------
    //
    // Движок помнит свой последний полный ответ и умеет отдать его немедленно
    // (`steer status --fast`, снимок в состоянии). Полный ответ стоит 91 мс на стенде и нужен
    // ПЕРВЫМ при открытии окна — то есть человек ждёт его на пустом экране вместе со всем
    // остальным, что страница спрашивает в тот же миг.
    //
    // Опасность здесь не в скорости, а в честности: запомненный ответ описывает прошлое, и
    // нарисовать его живым значит поставить «Работает» на туннеле, который к этому моменту
    // упал. Поэтому проверяется не только «спросили память», но и всё, что из этого следует.
    it('первый круг просит память движка, а следующий — нет', async () => {
        const live = mockLive()
        vi.useFakeTimers()
        renderHook(() => useLive())
        await act(async () => { await Promise.resolve() })
        // Второй аргумент — просьба отдать запомненное.
        expect(live.mock.calls[0]?.[1]).toBe(true)
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        for (const [i, call] of live.mock.calls.slice(1).entries())
            expect(call[1], `круг ${i + 2}`).toBe(false)
    })

    it('запомненный ответ помечен прошлым и тут же догоняется свежим', async () => {
        // Первый ответ — память движка (`cached`), второй — измерение.
        const live = vi.spyOn(rpc, 'live').mockImplementation(((_d: boolean, fast: boolean) =>
            Promise.resolve({
                status: fast ? { ...STATUS, cached: true, at: 1000 } : STATUS,
                devices: DEVICES, net: NET, diag: DIAG,
            })) as never)
        const { result } = renderHook(() => useLive())

        // Свежий круг выпускается СРАЗУ за памятью, а не через пять секунд: просить память
        // имеет смысл только затем, чтобы нарисовать экран немедленно, а оставить её на
        // экране на пять секунд значило бы показывать прошлое там, где до сих пор стояло
        // «Загрузка…».
        await waitFor(() => expect(live).toHaveBeenCalledTimes(2))
        // И проверки просит он: на быстром круге их не спрашивали, а приговор нужен экрану.
        expect(live).toHaveBeenLastCalledWith(true, false)
        await waitFor(() => expect(result.current.stale).toBe(false))
        expect(result.current.status?.cached).toBeUndefined()
    })

    it('скорость по запомненному ответу не считается вовсе', async () => {
        // Счётчики в памяти движка — те, что он видел до пяти минут назад. Взяв их точкой
        // отсчёта, следующий круг поделил бы разницу за пять минут на свои доли секунды и
        // показал бы скорость в сотню раз больше настоящей.
        const CH = [{ name: 'ru', out: 'wg', kind: 'prefixes', live: true, bytes: 1_000_000, lists: 1, channels: [] }]
        vi.spyOn(rpc, 'live').mockImplementation(((_d: boolean, fast: boolean) =>
            Promise.resolve({
                status: fast
                    ? { ...STATUS, cached: true, at: 1000, channels: CH }
                    : { ...STATUS, channels: [{ ...CH[0], bytes: 1_000_000 }] },
                devices: DEVICES, net: NET, diag: DIAG,
            })) as never)
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.stale).toBe(false))
        // Ни одной строки скорости: точку отсчёта поставил свежий круг, и первая скорость
        // появится на следующем опросе — там же, где появлялась всегда.
        expect(result.current.speed.ch.ru).toBeUndefined()
    })

    it('движок старее ключа: состояние живое сразу, а проверки — догоняющим кругом', async () => {
        // Бэкенд, спросив память у движка, который её не умеет, молча спрашивает состояние
        // по-старому — и отвечает БЕЗ `cached`. Прошлого на экране тогда нет вовсе, и это
        // видно сразу. А вот проверок быстрый круг не просил, поэтому догоняющий круг нужен и
        // здесь: без него исправный роутер остался бы без приговора до двадцатой секунды.
        const live = mockLive()
        const { result } = renderHook(() => useLive())
        await waitFor(() => expect(result.current.diag).not.toBeNull())
        expect(result.current.stale).toBe(false)
        expect(live.mock.calls.map((c) => c[1])).toEqual([true, false])
        expect(live).toHaveBeenLastCalledWith(true, false)
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
