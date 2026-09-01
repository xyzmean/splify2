import { describe, expect, it, vi, beforeEach } from 'vitest'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { type Spec } from '@/lib/model'

// Счётчик пилюли «Применить · N» считает РАЗНИЦУ ПО СМЫСЛУ, а не по тексту JSON.
//
// Поймано живым проходом по интерфейсу на роутере: выключить правило и включить обратно
// оставляло вечное «Применить · 1». Интерфейс дописывает умолчания ЯВНО (`"enabled": true`),
// а в снимке применённого их не было — и посимвольное сравнение считало это правкой. Хуже
// того, висящая пилюля перехватывала клики по строкам под собой: она плавающая, по центру
// внизу, и под ней оказывался то резолвер DoH, то стратегия обхода.

const SPEC = (over: Partial<Spec> = {}): Spec => ({
    schema: 1,
    outputs: { direct: { name: 'direct', kind: 'direct' } },
    channels: [],
    ...over,
} as Spec)

/** Счётчик считается по двум снимкам внутри pending, а положить их туда можно только через
 *  load() (применённое) и edit() (сохранённое). Поэтому оба вызова заглушены. */
async function count(applied: Spec, saved: Spec): Promise<number> {
    vi.spyOn(rpc, 'specGet').mockResolvedValue(saved)
    vi.spyOn(rpc, 'appliedGet').mockResolvedValue(applied)
    vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
    // @ts-expect-error — сброс внутреннего состояния между проверками
    pending.saved = null; pending.applied = null; pending.dirty = false
    await pending.load()
    return pending.count()
}

describe('счётчик непримененных правок', () => {
    beforeEach(() => { vi.restoreAllMocks() })

    it('одинаковые спеки — нечего применять', async () => {
        expect(await count(SPEC(), SPEC())).toBe(0)
    })

    it('явное enabled:true не считается правкой против опущенного', async () => {
        // Ровно то, что оставляла кнопка «выключить правило» после включения обратно.
        const ch = { name: 'Youtube', out: 'vless', match: { prefixes_files: ['/a.lst'] } }
        const applied = SPEC({ channels: [ch] } as Partial<Spec>)
        const saved = SPEC({ channels: [{ ...ch, enabled: true }] } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(0)
    })

    it('а enabled:false — считается: правило перестало действовать', async () => {
        const ch = { name: 'Youtube', out: 'vless', match: { prefixes_files: ['/a.lst'] } }
        const applied = SPEC({ channels: [ch] } as Partial<Spec>)
        const saved = SPEC({ channels: [{ ...ch, enabled: false }] } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(1)
    })

    it('порядок полей не считается правкой', async () => {
        const applied = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', on_fail: 'drop' } } } as Partial<Spec>)
        const saved = SPEC({ outputs: { vl: { on_fail: 'drop', kind: 'vless', name: 'vl' } } } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(0)
    })

    it('явное on_fail:drop не считается правкой против опущенного', async () => {
        // Интерфейс пишет его всегда (PoolEditor), движок и архивы — как получилось.
        const applied = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless' } } } as Partial<Spec>)
        const saved = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', on_fail: 'drop' } } } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(0)
    })

    it('а on_fail:direct — считается: обещание выхода стало другим', async () => {
        const applied = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless' } } } as Partial<Spec>)
        const saved = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', on_fail: 'direct' } } } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(1)
    })

    it('пустой список узлов равен отсутствию выбора', async () => {
        const applied = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless' } } } as Partial<Spec>)
        const saved = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', nodes: [], node: -1 } } } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(0)
    })

    it('настоящая правка по-прежнему видна', async () => {
        const applied = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', node: 3 } } } as Partial<Spec>)
        const saved = SPEC({ outputs: { vl: { name: 'vl', kind: 'vless', node: 7 } } } as Partial<Spec>)
        expect(await count(applied, saved)).toBe(1)
    })
})
