import { beforeEach, describe, expect, it, vi } from 'vitest'

// «Движок не отвечает: ubus is unavailable outside LuCI (splify.status)» — с экрана
// владельца, и ловилось это через раз. Гонка: загрузчик стал стартовать бандл, не дожидаясь
// build-id.txt, поэтому модуль мог исполниться раньше, чем LuCI отдаст мост к ubus
// (window.luci_rpc выставляется в render()). Мост читался при объявлении методов — и все
// сорок методов навсегда становились заглушкой с этой ошибкой.
//
// Проверяется главное свойство: мост берётся в момент ВЫЗОВА. Появился после загрузки модуля
// — работает; не появился вовсе (стенд, отдельный запуск) — честный отказ, а не выдуманные
// данные.

describe('мост к ubus', () => {
    beforeEach(() => {
        vi.resetModules()
        delete (window as unknown as Record<string, unknown>).luci_rpc
    })

    it('появился ПОСЛЕ загрузки модуля — вызовы работают', async () => {
        const { rpc } = await import('@/lib/rpc')
        const call = vi.fn(async () => ({ schema: 1, outputs: {}, channels: [] }))
        ;(window as unknown as Record<string, unknown>).luci_rpc = {
            declare: vi.fn(() => call),
        }
        await expect(rpc.status()).resolves.toEqual({ schema: 1, outputs: {}, channels: [] })
        expect(call).toHaveBeenCalled()
    })

    it('мост объявляется один раз на метод, а не на каждый вызов', async () => {
        const { rpc } = await import('@/lib/rpc')
        const declare = vi.fn(() => async () => ({}))
        ;(window as unknown as Record<string, unknown>).luci_rpc = { declare }
        await rpc.status()
        await rpc.status()
        expect(declare).toHaveBeenCalledTimes(1)
    })

    it('моста нет вовсе — отказ с причиной, а не выдуманные данные', async () => {
        const { rpc } = await import('@/lib/rpc')
        await expect(rpc.status()).rejects.toThrow(/ubus is unavailable/)
    })
})
