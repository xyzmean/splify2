import { describe, expect, it } from 'vitest'
import { DIRECT, EMPTY_SPEC, normalizeSpec, routedOutputs, type Spec } from '@/lib/model'

// ВЫХОД `direct` ЕСТЬ ВСЕГДА — вопрос владельца звучал так: «а опция direct пропала?».
//
// Пропала она не из интерфейса, а из спеки: выход заводился по требованию, первым
// правилом-исключением, и на свежем роутере в редакторе правила не было цели «мимо туннеля»
// вовсе. При этом «пустить напрямую» — не настройка роутера, а то, что роутер делает и без
// нас: выход этого вида не берёт ни метки, ни таблицы маршрутизации, он лишь называет место
// назначения, в которое можно привести правило.
//
// Ставится он на ВХОДЕ, в normalizeSpec, и это не деталь: через неё проходят и текущая спека,
// и снимок применённого, поэтому счётчик «Применить · N» от появления выхода не вздрагивает.
describe('постоянный выход «напрямую»', () => {
    const spec = (outputs: Spec['outputs']): Spec => ({ schema: 1, outputs, channels: [] })

    it('есть в пустой спеке', () => {
        expect(EMPTY_SPEC.outputs[DIRECT]?.kind).toBe('direct')
    })

    it('добавляется спеке, где его нет', () => {
        const s = normalizeSpec(spec({ vl: { name: 'vl', kind: 'vless' } }))
        expect(s.outputs[DIRECT]?.kind).toBe('direct')
        expect(s.outputs.vl).toBeDefined()
    })

    it('чужой выход того же вида НЕ заменяется вторым', () => {
        // Так писали спеки до этого правила: имя у выхода могло быть любым, и правила уже
        // ведут в него. Второй такой же означал бы два «напрямую» в списке целей, а
        // переименование увело бы правила в никуда.
        const s = normalizeSpec(spec({ mimo: { name: 'mimo', kind: 'direct' } }))
        expect(Object.keys(s.outputs)).toEqual(['mimo'])
    })

    it('в счётчиках выходов не участвует', () => {
        // «VPN · 1» на роутере без единого туннеля означало бы ровно обратное тому, что есть.
        const s = normalizeSpec(spec({ vl: { name: 'vl', kind: 'vless' } }))
        expect(routedOutputs(s.outputs).map(([n]) => n)).toEqual(['vl'])
        expect(routedOutputs(EMPTY_SPEC.outputs)).toHaveLength(0)
    })

    it('служебные части пулов выходами тоже не считаются', () => {
        const s = normalizeSpec(spec({
            pool: { name: 'pool', kind: 'interface', devices: ['loc1'] },
            loc1: { name: 'loc1', kind: 'vless', part_of: 'pool' },
        }))
        expect(routedOutputs(s.outputs).map(([n]) => n)).toEqual(['pool'])
    })
})
