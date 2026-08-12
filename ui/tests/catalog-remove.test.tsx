import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'

// R-033: каталог отчитывался об удалении безусловным успехом, а не по ответу rpcd,
// и держал один флаг занятости на всю таблицу.

const MANIFEST = {
    version: '1',
    base_url: 'https://x/',
    categories: [{ id: 'youtube', name_ru: 'YouTube', file: 'youtube.lst', count: 100 }],
}

function mockBase() {
    vi.spyOn(rpc, 'manifest').mockResolvedValue(MANIFEST as never)
    vi.spyOn(rpc, 'specGet').mockResolvedValue({ channels: [] } as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue(
        { files: { 'youtube.lst': { count: 100, mtime: 1 } } } as never,
    )
}

describe('каталог: удаление отчитывается по ответу (I-042, R-033)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase()
    })

    it('отказ list_remove доходит до человека, а не «удалён с роутера»', async () => {
        // fail() в rpcd завершается кодом 0 и отдаёт {ok:false, error}. Раньше цикл
        // глотал ответ (`.catch(()=>{})`) и печатал успех безусловно.
        vi.spyOn(rpc, 'listRemove').mockResolvedValue({
            ok: false,
            error: 'список используется каналом «tv»',
        })
        render(<CatalogTab onUseInRule={() => {}} />)
        fireEvent.click(await screen.findByLabelText(/Удалить YouTube с роутера/))
        await waitFor(() =>
            expect(screen.getByText(/используется каналом/)).toBeInTheDocument(),
        )
        expect(screen.queryByText(/удал[её]н с роутера/)).not.toBeInTheDocument()
    })
})
