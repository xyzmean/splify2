import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'

// R-024 / R-065: манифест ru-bypass-ipsets научился говорить две вещи, которых каталог
// не показывал.
//
//  1. `same_prefixes_as` + `same_prefixes_reason_ru` — у двух категорий ПОБАЙТОВО один и
//     тот же список адресов (meta = whatsapp, google = youtube: общая автономная
//     система). Человек видел два разных названия и считал одно из них узким: включив
//     «YouTube», он уводил в туннель все адреса Google.
//  2. `upstream` у доменных списков — они зеркало itdoginfo/allow-domains, перезаписываются
//     целиком, и дописать домен на нашей стороне нельзя. Из этого выросло splify2#7:
//     категория «18+» включена, нужного сайта в ней нет, и узнать почему было негде.
//
// Оба поля НЕОБЯЗАТЕЛЬНЫЕ: на установленных роутерах лежит манифест без них, и вкладка
// обязана работать с ним молча — это третий тест ниже.

function mockBase(manifest: unknown, files: Record<string, { count: number; mtime: number }> = {}) {
    vi.spyOn(rpc, 'manifest').mockResolvedValue(manifest as never)
    vi.spyOn(rpc, 'specGet').mockResolvedValue({ channels: [] } as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue({ files } as never)
}

/** google и youtube — РАЗНЫЕ записи каталога (их доменные списки смотрят каждый в свою
 *  категорию), и именно поэтому пара видна человеку двумя строками. */
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

describe('каталог: категории с тем же списком адресов (R-024)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(SAME_PREFIXES)
    })

    it('у YouTube стоит пометка «тот же список адресов, что у Google»', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/тот же список адресов, что у «Google \(Meet\/Play\/AI\)»/)
        expect(note).toBeInTheDocument()
        // Обратная сторона той же пары — на строке Google своя пометка про YouTube.
        expect(screen.getByText(/тот же список адресов, что у «YouTube»/)).toBeInTheDocument()
    })

    it('причина берётся из манифеста, и сказано, что второй выбор ничего не добавляет', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/тот же список адресов, что у «Google \(Meet\/Play\/AI\)»/)
        fireEvent.mouseEnter(note.parentElement as HTMLElement)
        const tip = await waitFor(() => screen.getByRole('tooltip'))
        expect(tip.textContent).toContain('общая автономная система AS15169 (Google)')
        expect(tip.textContent).toMatch(/не добавляет/)
    })
})

/** Доменный список из зеркала — без адресной категории рядом, ровно случай splify2#7. */
const UPSTREAM = {
    version: '2026-08-19',
    base_url: 'https://x/lists/',
    domain_lists: [
        {
            id: 'porn',
            kind: 'domains' as const,
            name_ru: '18+',
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
        },
    ],
}

describe('каталог: доменный список — зеркало чужого репозитория (R-065, splify2#7)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(UPSTREAM)
    })

    it('строка помечена «список внешний», в подсказке — что делать с недостающим доменом', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/список внешний/)
        fireEvent.mouseEnter(note.parentElement as HTMLElement)
        const tip = await waitFor(() => screen.getByRole('tooltip'))
        expect(tip.textContent).toMatch(/Добавить домен можно у апстрима/)
        expect(tip.textContent).toMatch(/своим списком/)
        expect(tip.textContent).toContain('itdoginfo/allow-domains')
    })

    it('ссылка suggest_url ведёт туда, куда предлагать домен', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const link = await screen.findByRole('link', { name: /предложить домен/ })
        expect(link).toHaveAttribute('href', 'https://github.com/itdoginfo/allow-domains/issues')
    })
})

/** То, что лежит на уже установленных роутерах: манифест без обоих полей. */
const OLD = {
    version: '2026-01-01',
    base_url: 'https://x/lists/',
    categories: [{ id: 'youtube', name_ru: 'YouTube', file: 'youtube.lst', count: 58 }],
    domain_lists: [
        {
            id: 'porn',
            kind: 'domains' as const,
            name_ru: '18+',
            file: 'domains/porn.lst',
            count: 51,
            source: 'itdoginfo/allow-domains/Categories',
        },
    ],
}

describe('каталог: старый манифест без новых полей', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(OLD)
    })

    it('вкладка рисуется, пометок нет — молча', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText('YouTube')).toBeInTheDocument()
        expect(screen.getByText('18+')).toBeInTheDocument()
        expect(screen.queryByText(/тот же список адресов/)).not.toBeInTheDocument()
        expect(screen.queryByText(/список внешний/)).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /предложить домен/ })).not.toBeInTheDocument()
    })
})
