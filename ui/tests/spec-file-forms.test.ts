import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDomains, selectedIds } from '@/components/tabs/RuleEditor'
import type { Channel, ServiceEntry, Spec } from '@/lib/model'

// I-041: контракт v1 публикует два равноправных написания одного поля —
// `prefixes_files` / `prefixes_file` и `domains_files` / `domains_file`
// (steer/docs/contract-v1.md:43-44). Движок реализует оба (spec.c:271-281), тесты самого
// движка пишут короткую форму девять раз, а интерфейс читал только длинную во всех четырёх
// местах, где смотрит на `match`. Правило, написанное по документированной короткой форме,
// выглядело правилом без списков — и первое же сохранение из интерфейса дописывало рядом
// длинную форму, после чего маршрут списка решался порядком ключей в файле.
//
// Проверки идут через rpc.specGet, а не через помощник напрямую: приведение к одной форме
// стоит именно на этом шве (вариант «б», splicicd#7), и вызов, убранный из specGet, обязан
// ронять стенд.

type Bridge = NonNullable<typeof window.luci_rpc>

/** Спека, как её отдаёт rpcd: `spec_get` — это дословный `cat` файла (rpcd:219-221),
 *  поэтому написание в ответе ровно то, которое выбрал человек. */
async function specThroughRpc(stored: unknown): Promise<Spec> {
    const bridge: Bridge = {
        declare: ({ method }) => async () => {
            if (method !== 'spec_get') throw new Error(`неожиданный метод ${method}`)
            return JSON.parse(JSON.stringify(stored))
        },
    }
    window.luci_rpc = bridge
    vi.resetModules()
    const { rpc } = await import('@/lib/rpc')
    return rpc.specGet()
}

const YOUTUBE: ServiceEntry = {
    id: 'youtube',
    name: 'YouTube',
    prefixes: ['youtube.lst'],
    domains: ['domains/youtube.lst'],
    count: 1,
    parts: [{ id: 'youtube', kind: 'prefixes', name: 'YouTube', file: 'youtube.lst', count: 1 }],
}

function spec(match: Record<string, unknown>): Spec {
    return {
        schema: 1,
        outputs: { vpn: { name: 'vpn', kind: 'direct' } },
        channels: [{ name: 'c1', match, out: 'vpn' } as unknown as Channel],
    } as Spec
}

afterEach(() => {
    delete window.luci_rpc
    vi.resetModules()
})

describe('единственная форма *_file на входе интерфейса (I-041)', () => {
    it('правило по короткой форме видно редактору выбранным', async () => {
        const s = await specThroughRpc(spec({ prefixes_file: '/etc/steer/lists/youtube.lst' }))
        expect(selectedIds(s.channels[0], [YOUTUBE])).toEqual(['youtube'])
    })

    it('доменная короткая форма делает правило доменным', async () => {
        const s = await specThroughRpc(spec({ domains_file: '/etc/steer/lists/domains/youtube.lst' }))
        expect(s.channels[0].match.domains_files).toEqual(['/etc/steer/lists/domains/youtube.lst'])
        expect(isDomains(s.channels[0])).toBe(true)
    })

    // Ключевая половина: пока короткий ключ доживал до `pick()`, спред `{...ch.match}` уносил
    // его обратно в файл рядом с длинным, и в спеке оказывались ОБА написания одного поля.
    it('до обратной записи короткий ключ не доживает', async () => {
        const s = await specThroughRpc(spec({ prefixes_file: '/etc/steer/lists/youtube.lst' }))
        expect(Object.keys(s.channels[0].match)).toEqual(['prefixes_files'])
    })

    // Спор двух написаний разрешается так же, как в движке: разбор `match` последовательный
    // (spec.c:271-281), поэтому берёт верх тот ключ, который в документе ПОЗЖЕ. Правило
    // «длинная форма всегда сильнее» разошлось бы с движком ровно на этих спеках.
    it('при обоих написаниях побеждает то, что в документе позже — как у движка', async () => {
        const later = await specThroughRpc(
            spec({ prefixes_file: '/etc/steer/lists/a.lst', prefixes_files: ['/etc/steer/lists/b.lst'] }),
        )
        expect(later.channels[0].match.prefixes_files).toEqual(['/etc/steer/lists/b.lst'])

        const earlier = await specThroughRpc(
            spec({ prefixes_files: ['/etc/steer/lists/b.lst'], prefixes_file: '/etc/steer/lists/a.lst' }),
        )
        expect(earlier.channels[0].match.prefixes_files).toEqual(['/etc/steer/lists/a.lst'])
    })

    // Урок I-012: поле, которого форма не знает, обязано пережить приведение. Иначе «весь
    // трафик» превращается в «только выбранное» без единого слова.
    it('соседние поля match не трогаются', async () => {
        const s = await specThroughRpc(
            spec({ any: true, mode: 'fakeip', domains_file: '/etc/steer/lists/domains/youtube.lst' }),
        )
        expect(s.channels[0].match.any).toBe(true)
        expect(s.channels[0].match.mode).toBe('fakeip')
    })

    // Значение не-строка движок не примет (js_str откажет, spec.c:58), значит и списком оно
    // здесь не становится — но и остаться коротким ключом не должно.
    it('нестроковое значение короткого ключа не превращается в список', async () => {
        const s = await specThroughRpc(spec({ prefixes_file: 42 }))
        expect(s.channels[0].match.prefixes_files).toBeUndefined()
        expect('prefixes_file' in s.channels[0].match).toBe(false)
    })

    it('спека без короткой формы проходит как есть', async () => {
        const stored = spec({ prefixes_files: ['/etc/steer/lists/youtube.lst'], mode: 'fakeip' })
        const s = await specThroughRpc(stored)
        expect(s).toEqual(stored)
    })
})
