import { describe, expect, it } from 'vitest'
import { toCatalog } from '@/lib/model'

// Порядок каталога. Он всегда повторял манифест: сначала адресные категории, потом
// доменные списки — и доменный список оказывался в хвосте за двумя десятками CDN, даже
// когда искать его человек будет наверху. Издатель называет соседа полем `after`, и это
// поле интерфейс обязан соблюсти: без него разделение GitHub на «CDN адресами» и «GitHub
// доменами» отправляет вторую половину в конец списка.

const M = {
    version: '1',
    base_url: 'https://x/',
    categories: [
        { id: 'telegram', name_ru: 'Telegram', file: 'telegram.lst', count: 10 },
        { id: 'youtube', name_ru: 'YouTube', file: 'youtube.lst', count: 10 },
        { id: 'github_cdn', name_ru: 'GitHub CDN', file: 'github_cdn.lst', count: 10 },
    ],
    domain_lists: [
        { id: 'own_github', kind: 'domains', name_ru: 'GitHub', file: 'domains/own_github.lst', count: 19, after: 'telegram' },
        { id: 'svc_youtube', kind: 'domains', name_ru: 'YouTube домены', file: 'domains/svc_youtube.lst', count: 5, same_as_ip: ['youtube'] },
    ],
}

const names = (m: unknown) => toCatalog(m as never).services.map((s) => s.name)

describe('порядок каталога', () => {
    it('доменный список встаёт сразу за названным соседом', () => {
        expect(names(M).slice(0, 2)).toEqual(['Telegram', 'GitHub'])
    })

    it('без `after` порядок прежний: категории, потом доменные списки', () => {
        const plain = { ...M, domain_lists: [{ ...M.domain_lists[0], after: undefined }] }
        expect(names(plain)).toEqual(['Telegram', 'YouTube', 'GitHub CDN', 'GitHub'])
    })

    it('ссылка в никуда не роняет каталог и не двигает запись', () => {
        const bad = { ...M, domain_lists: [{ ...M.domain_lists[0], after: 'ничего-такого-нет' }] }
        expect(names(bad)).toEqual(['Telegram', 'YouTube', 'GitHub CDN', 'GitHub'])
    })

    it('сервис из двух половин встаёт по адресной: домены YouTube не уводят его в хвост', () => {
        expect(names(M)).toEqual(['Telegram', 'GitHub', 'YouTube', 'GitHub CDN'])
    })
})
