import { describe, expect, it } from 'vitest'
import { toCatalog } from '@/lib/model'

/* РАЗБОР МАНИФЕСТА ПЕРВОГО ИЗДАТЕЛЯ — на уровне модели, а не вкладки.
 *
 * Почему переехало. Каталог на экране теперь показывает только itdoginfo/allow-domains
 * (решение владельца), и три вещи, которые манифест умеет говорить, со страницы ушли вместе
 * с ним: совпадающие побайтово списки адресов (R-024), признак «список наш / список внешний»
 * (R-065, splify2#7) и связь «зеркало плюс дополняющий его свой список» (R-072).
 *
 * КОД ЭТОТ НИКУДА НЕ ДЕЛСЯ: `toCatalog` разбирает манифест по-прежнему, его зовут те, кто
 * работает с прежним издателем, и вернуть его на экран — вопрос одного решения. Удалить
 * проверки вместе с вкладочными стендами значило бы оставить живой разбор без сторожа;
 * поэтому они здесь, и проверяют то же самое, теми же фикстурами, но по РЕЗУЛЬТАТУ разбора,
 * а не по надписям на экране.
 */

const OWN_AND_MIRROR = {
    version: '2026-08-20',
    base_url: 'https://x/lists/',
    domain_lists: [
        {
            id: 'own_porn',
            kind: 'domains' as const,
            name_ru: 'Для взрослых — наш список',
            file: 'domains/own_porn.lst',
            count: 1,
            source: 'xyzmean/ru-bypass-ipsets/sources/domains',
            maintained_here: {
                repo: 'xyzmean/ru-bypass-ipsets',
                folder: 'sources/domains',
                file: 'sources/domains/porn.lst',
                url: 'https://github.com/xyzmean/ru-bypass-ipsets/blob/HEAD/sources/domains/porn.lst',
                suggest_url: 'https://github.com/xyzmean/ru-bypass-ipsets/issues/new',
                editable_locally: true,
            },
            complements: ['porn'],
        },
        {
            id: 'porn',
            kind: 'domains' as const,
            name_ru: 'Для взрослых',
            file: 'domains/porn.lst',
            count: 51,
            source: 'itdoginfo/allow-domains/Categories',
            upstream: {
                repo: 'itdoginfo/allow-domains',
                folder: 'Categories',
                file: 'Categories/porn.lst',
                url: 'https://github.com/itdoginfo/allow-domains/blob/HEAD/Categories/porn.lst',
                suggest_url: 'https://github.com/itdoginfo/allow-domains/issues',
                editable_locally: false,
            },
            complemented_by: ['own_porn'],
        },
    ],
}


const SAME_PREFIXES = {
    version: '2026-08-19',
    base_url: 'https://x/lists/',
    categories: [
        {
            id: 'youtube',
            name_ru: 'YouTube',
            file: 'youtube.lst',
            count: 58,
            same_prefixes_as: ['google'],
            same_prefixes_reason_ru: 'общая автономная система AS15169 (Google)',
        },
        {
            id: 'google',
            name_ru: 'Google (Meet/Play/AI)',
            file: 'google.lst',
            count: 58,
            same_prefixes_as: ['youtube'],
            same_prefixes_reason_ru: 'общая автономная система AS15169 (Google)',
        },
    ],
}


describe('манифест: побайтово совпадающие списки адресов (R-024)', () => {
    const svc = toCatalog(SAME_PREFIXES as never).services

    it('пара названа с обеих сторон, а не с одной', () => {
        expect(svc.find((s) => s.id === 'youtube')?.same_prefixes?.names).toEqual([
            'Google (Meet/Play/AI)',
        ])
        expect(svc.find((s) => s.id === 'google')?.same_prefixes?.names).toEqual(['YouTube'])
    })

    it('причина берётся у издателя дословно — своей формулировки у нас тут быть не должно', () => {
        expect(svc[0].same_prefixes?.reason).toBe('общая автономная система AS15169 (Google)')
    })
})

describe('манифест: свой список рядом с зеркалом (R-065, R-072, splify2#7)', () => {
    const svc = toCatalog(OWN_AND_MIRROR as never).services
    const ours = svc.find((s) => s.id === 'own_porn')
    const mirror = svc.find((s) => s.id === 'porn')

    it('у нашего списка признак «ведётся здесь», у зеркала — «внешний»', () => {
        expect(ours?.maintained?.editable_locally).toBe(true)
        expect(mirror?.upstream?.editable_locally).toBe(false)
    })

    it('домен предлагать в разные места: наш репозиторий и апстрим', () => {
        expect(ours?.maintained?.suggest_url).toBe(
            'https://github.com/xyzmean/ru-bypass-ipsets/issues/new',
        )
        expect(mirror?.upstream?.suggest_url).toBe('https://github.com/itdoginfo/allow-domains/issues')
    })

    it('связь названа С ОБЕИХ сторон, и стороны различимы', () => {
        expect(ours?.complement).toEqual({ names: ['Для взрослых'], ours: true })
        expect(mirror?.complement).toEqual({ names: ['Для взрослых — наш список'], ours: false })
    })
})

describe('манифест без новых полей: разбор молчит, а не выдумывает', () => {
    const old = {
        version: '1',
        base_url: 'https://x/',
        categories: [{ id: 'youtube', name_ru: 'YouTube', file: 'youtube.lst', count: 1 }],
    }
    const svc = toCatalog(old as never).services

    it('ни признака источника, ни связи, ни совпадения адресов', () => {
        expect(svc[0].same_prefixes).toBeUndefined()
        expect(svc[0].upstream).toBeUndefined()
        expect(svc[0].maintained).toBeUndefined()
        expect(svc[0].complement).toBeUndefined()
    })
})
