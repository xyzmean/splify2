import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'
import { mockCatalog } from './ad-fixture'

/* КАТАЛОГ — ЭТО ВЫБРАННЫЙ ИСТОЧНИК, А НЕ ТАБЛИЦА В ПАКЕТЕ.
 *
 * Пока вкладка рисовала только зашитую таблицу второго издателя, смена источника списков
 * в настройках не меняла на экране ничего: человек вписывал адрес своего каталога и видел
 * прежние двадцать пять записей. Снято с живого роутера — «поэтому у меня каталог всё ещё
 * не содержит новых списков?».
 *
 * Запасной путь при этом остался и остаться обязан: каталог живёт в сети, а таблица в пакете
 * отвечает без неё. Но показанное надо называть — иначе «показана запасная таблица» и «ваш
 * источник пуст» выглядят одинаково. */

const manifest = {
    version: '2026-09-09_01-02',
    base_url: 'https://raw.githubusercontent.com/xyzmean/splify2-lists/main/lists',
    categories: [
        { id: 'itdoginfo:telegram', name_ru: 'Telegram', file: 'itdoginfo/telegram.srs.lst',
          format: 'srs', tag: '2026-09-07_14-23',
          url: 'https://github.com/itdoginfo/allow-domains/releases/download/2026-09-07_14-23/telegram.srs' },
        { id: 'b4geoip:valve', name_ru: 'Valve (Steam)', file: 'b4geoip/valve.srs.lst',
          format: 'srs', tag: '2026-09-08_00-03',
          url: 'https://github.com/Greeg0ry/b4geoip-forkop/releases/download/2026-09-08_00-03/valve.srs' },
    ],
    domain_lists: [
        { id: 'svc_itdoginfo_telegram', kind: 'domains', name_ru: 'Telegram',
          file: 'itdoginfo/domains/telegram.srs.lst', same_as_ip: ['itdoginfo:telegram'] },
    ],
}

describe('каталог: показывается выбранный источник', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockCatalog([{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }])
    })

    it('записи каталога — из манифеста, а не из таблицы в пакете', async () => {
        vi.spyOn(rpc, 'manifest').mockResolvedValue(manifest as never)
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText('Telegram')).toBeInTheDocument()
        expect(screen.getByText('Valve (Steam)')).toBeInTheDocument()
        // Зашитая таблица в этот момент не при чём: её единственная запись не показана.
        expect(screen.queryByText('YouTube')).toBeNull()
    })

    it('внизу названа версия каталога, а не тег зашитой таблицы', async () => {
        vi.spyOn(rpc, 'manifest').mockResolvedValue(manifest as never)
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText(/версия 2026-09-09_01-02/)).toBeInTheDocument()
        expect(screen.queryByText(/таблица из пакета/)).toBeNull()
    })

    it('каталог не скачался — показана таблица из пакета, и об этом сказано', async () => {
        vi.spyOn(rpc, 'manifest').mockRejectedValue(new Error('нет сети'))
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText('YouTube')).toBeInTheDocument()
        await waitFor(() =>
            expect(screen.getByText(/каталог источника скачать не вышло/i)).toBeInTheDocument())
    })

    it('пустой каталог источника — тоже повод показать запасную таблицу', async () => {
        // Пустой ответ бывает у форка, где ещё не завели ни одного списка. Оставить экран
        // пустым значило бы, что человек не может выбрать вообще ничего.
        vi.spyOn(rpc, 'manifest').mockResolvedValue({ categories: [], domain_lists: [] } as never)
        render(<CatalogTab onUseInRule={() => {}} />)
        expect(await screen.findByText('YouTube')).toBeInTheDocument()
    })
})
