import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC } from '@/lib/model'

// «Сохранено» — единственное, что осталось взамен кнопки «Сохранить»: другого способа
// узнать, уехала правка или нет, у человека нет. Поэтому вспышка обязана означать
// ЗАПИСЬ, а не набор текста.
//
// Отказ здесь — не редкость, а штатная ветка: spec_set отвергает спеку целиком, если
// dry-run компилятора её не принял (правило с MAC и адресом вместе, выход без
// устройства, несклачавшийся список). В такие моменты интерфейс успевал показать
// галочку «Сохранено» и лишь потом — тост с причиной.

const SPEC = { ...EMPTY_SPEC, outputs: { wg: { name: 'wg', kind: 'interface' as const, devices: ['wg0'] } } }

describe('вспышка «Сохранено» означает запись, а не правку', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        pending.saved = null
        pending.applied = null
        pending.dirty = false
        pending.savedFlash = false
    })

    it('пока правка не уехала — галочки нет', () => {
        vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
        pending.edit(SPEC)
        expect(pending.savedFlash).toBe(false)
    })

    it('успешная запись показывает галочку', async () => {
        vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
        pending.edit(SPEC)
        await pending.flush()
        expect(pending.savedFlash).toBe(true)
    })

    it('отвергнутая спека галочки не даёт: человек увидел бы «Сохранено» и потерял правку', async () => {
        vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: false, error: 'канал ведёт в несуществующий выход' })
        pending.edit(SPEC)
        await pending.flush()
        expect(pending.savedFlash).toBe(false)
        // И правка остаётся неотправленной — следующая попытка обязана её дописать.
        expect(pending.hasUnsaved()).toBe(true)
    })
})
