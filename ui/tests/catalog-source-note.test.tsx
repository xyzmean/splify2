import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { mockCatalog } from './ad-fixture'

/* Каталог = itdoginfo/allow-domains (решение владельца: «оставляем только allow domains»).
 *
 * Что здесь сторожится. Из splify2#7 вырос вопрос, на который человеку негде было получить
 * ответ: категория включена, нужного сайта в ней нет — почему и что делать. Ответ — признак
 * источника: список ВНЕШНИЙ, дописанное на роутере исчезнет при обновлении, а домен есть куда
 * предложить. Со сменой единственного издателя вопрос не исчез, а стал общим для всего
 * каталога: теперь ВСЕ записи внешние.
 *
 * Прежние проверки этой вкладки жили на манифесте первого издателя (тот умел говорить и про
 * совпадающие списки адресов, и про «наш список рядом с зеркалом»). Со вкладки это ушло
 * вместе с самим манифестом; сам разбор манифеста остался и проверяется теперь на уровне
 * модели (catalog-manifest-model.test.ts) — код без сторожа не оставлен. */

describe('каталог: признак источника у записей второго издателя', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }])
    })

    it('строка помечена «список внешний», а не оставлена без признака источника', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/список внешний/)).toBeInTheDocument()
    })

    it('«предложить домен» ведёт к издателю, а не в наш репозиторий', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        const link = await screen.findByText(/предложить домен/)
        expect(link.closest('a')?.getAttribute('href')).toContain('itdoginfo/allow-domains')
    })

    it('внизу назван издатель и ТЕГ, которым версия зафиксирована', async () => {
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/itdoginfo\/allow-domains/)).toBeInTheDocument()
        expect(await screen.findByText('2026-08-31_16-18')).toBeInTheDocument()
    })

    it('негодная настройка тега сказана вслух, а не отбита молча', async () => {
        vi.restoreAllMocks()
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }], {}, {
            tag_warn: 'тег latest не принят: состав списков менялся бы сам собой',
        })
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/latest не принят/)).toBeInTheDocument()
    })

    it('переопределённый настройкой тег назван переопределённым', async () => {
        vi.restoreAllMocks()
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }], {}, {
            tag: '2026-08-24_09-23',
        })
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/переопредел[её]н настройкой/)).toBeInTheDocument()
    })
})

/* ВТОРАЯ ПОЛОВИНА СМЕНЫ ИЗДАТЕЛЯ, и без неё она была бы потерей: файлы, на которые правила
 * уже ссылаются, из каталога исчезли — но не из работы. Промолчать значило бы, что человек
 * видит в правиле список, которого нет ни на одном экране, и снять его негде. */
describe('каталог: то, что правила используют, а каталог больше не предлагает', () => {
    beforeEach(() => vi.restoreAllMocks())

    it('файл прежнего издателя назван, и названо правило, которое его держит', async () => {
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }])
        vi.spyOn(await import('@/lib/rpc').then((m) => m.rpc), 'specGet').mockResolvedValue({
            channels: [
                { name: 'tv', out: 'vpn', match: { domains_files: ['/etc/steer/lists/domains/porn.lst'] } },
            ],
        } as never)
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/каталог их больше не предлагает/)).toBeInTheDocument()
        expect(await screen.findByText(/domains\/porn\.lst/)).toBeInTheDocument()
        expect(await screen.findByText(/tv/)).toBeInTheDocument()
    })

    it('своих списков в этой строке нет — у них своя карточка и свой способ снять', async () => {
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }])
        vi.spyOn(await import('@/lib/rpc').then((m) => m.rpc), 'specGet').mockResolvedValue({
            channels: [
                { name: 'my', out: 'vpn', match: { domains_files: ['/etc/steer/lists/domains/custom/mine.lst'] } },
            ],
        } as never)
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(screen.queryByText(/каталог их больше не предлагает/)).not.toBeInTheDocument()
    })
})
