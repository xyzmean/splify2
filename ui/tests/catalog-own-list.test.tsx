import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'

// R-072: рядом с зеркальным доменным списком у издателя появился СВОЙ, который
// синхронизация не затирает, — и манифест научился говорить об этом две вещи.
//
//  1. `maintained_here` — по форме тот же `upstream`, но `editable_locally: true` и
//     ссылки ведут в наш репозиторий. Пока каталог знал только про `upstream`, у нашей
//     записи не было НИКАКОЙ пометки об источнике: человек видел строку без признака и
//     не мог отличить её от зеркала, которое дописать нельзя.
//  2. `complements` / `complemented_by` — симметричная связь нашего списка с зеркалом.
//     Без неё включивший «Для взрослых» получает только зеркало и снова не получает
//     домена, ради которого всё затевалось (splify2#7): наше дополнение лежит соседней
//     строкой, и догадаться, что включать надо обе, неоткуда.
//
// Оба поля НЕОБЯЗАТЕЛЬНЫЕ — на установленных роутерах лежит манифест без них, и вкладка
// обязана выглядеть как раньше. Это последний describe.

function mockBase(manifest: unknown, files: Record<string, { count: number; mtime: number }> = {}) {
    vi.spyOn(rpc, 'manifest').mockResolvedValue(manifest as never)
    vi.spyOn(rpc, 'specGet').mockResolvedValue({ channels: [] } as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue({ files } as never)
}

/** Ровно то, что публикует ru-bypass-ipsets: наш список и зеркало, которое он дополняет.
 *  Записи РАЗНЫЕ (адресной категории у обеих нет, `same_as_ip` их не связывает), поэтому
 *  в каталоге они видны двумя строками — и связь между ними надо назвать вслух. */
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

describe('каталог: наш доменный список рядом с зеркалом (R-072)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(OWN_AND_MIRROR)
    })

    it('наша запись помечена «список наш», а не оставлена без признака источника', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/^список наш$/)
        fireEvent.mouseEnter(note.parentElement as HTMLElement)
        const tip = await waitFor(() => screen.getByRole('tooltip'))
        // Подсказка стала короткой: техническое объяснение убрано с экрана целиком, осталось
        // то, после чего человек делает следующий шаг.
        expect(tip.textContent).toMatch(/предложите его в наш список/)
        // Пометка зеркала на своей строке осталась: признак ровно один на список.
        expect(screen.getByText(/список внешний/)).toBeInTheDocument()
    })

    it('«предложить домен» у нашей записи ведёт в наш репозиторий, у зеркала — к апстриму', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const links = await screen.findAllByRole('link', { name: /предложить домен/ })
        expect(links.map((l) => l.getAttribute('href'))).toEqual([
            'https://github.com/xyzmean/ru-bypass-ipsets/issues/new',
            'https://github.com/itdoginfo/allow-domains/issues',
        ])
    })

    it('на строке зеркала названо наше дополнение — иначе включат только зеркало', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/рядом наш список «Для взрослых — наш список»/)
        expect(note.textContent).toMatch(/включайте оба/)
        fireEvent.mouseEnter(note.parentElement as HTMLElement)
        const tip = await waitFor(() => screen.getByRole('tooltip'))
        expect(tip.textContent).toMatch(/дополняет/)
        expect(tip.textContent).toMatch(/не заменяет/)
    })

    it('на нашей строке названо зеркало, которое она дополняет', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const note = await screen.findByText(/дополняет «Для взрослых» — включайте оба/)
        expect(note).toBeInTheDocument()
    })
})

/** Издатель волен объявить связь с записью, которой в этом манифесте нет (список выключен,
 *  манифест урезан), и признак источника — без ссылки на предложение. Ничего не выдумываем:
 *  показывается только то, что заявлено и разрешилось. */
const PARTIAL = {
    version: '2026-08-20',
    base_url: 'https://x/lists/',
    domain_lists: [
        {
            id: 'own_news',
            kind: 'domains' as const,
            name_ru: 'Новости — наш список',
            file: 'domains/own_news.lst',
            count: 3,
            maintained_here: { repo: 'xyzmean/ru-bypass-ipsets', editable_locally: true },
            complements: ['news'],
        },
    ],
}

describe('каталог: связь и признак, разрешившиеся не полностью', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(PARTIAL)
    })

    it('связь с отсутствующей записью молчит, пометка «список наш» остаётся', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/^список наш$/)).toBeInTheDocument()
        expect(screen.queryByText(/включайте оба/)).not.toBeInTheDocument()
        // Ссылки нет в данных — нет и в разметке, своей интерфейс не придумывает.
        expect(screen.queryByRole('link', { name: /предложить домен/ })).not.toBeInTheDocument()
    })
})

/** То, что лежит на уже установленных роутерах: манифест без обоих полей. */
const OLD = {
    version: '2026-01-01',
    base_url: 'https://x/lists/',
    domain_lists: [
        {
            id: 'porn',
            kind: 'domains' as const,
            name_ru: 'Для взрослых',
            file: 'domains/porn.lst',
            count: 51,
            source: 'itdoginfo/allow-domains/Categories',
        },
    ],
}

describe('каталог: старый манифест без maintained_here и complements', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase(OLD)
    })

    it('вкладка выглядит как раньше: ни признака «наш», ни связи', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText('Для взрослых')).toBeInTheDocument()
        expect(screen.queryByText(/список наш/)).not.toBeInTheDocument()
        expect(screen.queryByText(/включайте оба/)).not.toBeInTheDocument()
        expect(screen.queryByText(/рядом наш список/)).not.toBeInTheDocument()
        expect(screen.queryByText(/дополняет/)).not.toBeInTheDocument()
        expect(screen.queryByText(/список внешний/)).not.toBeInTheDocument()
    })
})
