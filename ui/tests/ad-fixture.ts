import { vi } from 'vitest'
import { rpc } from '@/lib/rpc'
import type { AllowDomains } from '@/lib/model'

/** Каталог второго издателя для стендов вкладки.
 *
 *  Отдельным файлом, потому что его мокают пять разных стендов, и пятая копия формы ответа
 *  разошлась бы с методом на первом же добавленном поле — а стенды при этом остались бы
 *  зелёными: они мокают ровно то, что сами и написали.
 *
 *  Пути повторяют раскладку роутера (`ad_rel`): доменные в `itdog/domains/`, адресные рядом.
 *  Вкладка ищет скачанное ПО ПУТИ, поэтому разойтись здесь — значит показать скачанное
 *  нескачанным. */
export const adCatalog = (
    services: { id: string; name: string; kinds: ('domains' | 'prefixes')[] }[],
    extra: Partial<AllowDomains> = {},
): AllowDomains => ({
    ok: true,
    id: 'itdog',
    repo: 'itdoginfo/allow-domains',
    tag: '2026-08-31_16-18',
    tag_default: '2026-08-31_16-18',
    base_url: 'https://github.com/itdoginfo/allow-domains/releases/download',
    services,
    ...extra,
})

export const adPath = (id: string, kind: 'domains' | 'prefixes') =>
    kind === 'domains' ? `itdog/domains/${id}.lst` : `itdog/${id}.lst`

/** Обычная обвязка вкладки: каталог, пустая спека и то, что лежит на диске. */
export function mockCatalog(
    services: { id: string; name: string; kinds: ('domains' | 'prefixes')[] }[],
    local: Record<string, { count: number; mtime: number }> = {},
    extra: Partial<AllowDomains> = {},
) {
    vi.spyOn(rpc, 'allowDomains').mockResolvedValue(adCatalog(services, extra) as never)
    vi.spyOn(rpc, 'specGet').mockResolvedValue({ channels: [] } as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: local } as never)
}
