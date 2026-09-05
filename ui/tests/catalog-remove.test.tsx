import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'
import { adPath, mockCatalog } from './ad-fixture'

// R-033: каталог отчитывался об удалении безусловным успехом, а не по ответу rpcd,
// и держал один флаг занятости на всю таблицу.

function mockBase() {
    mockCatalog(
        [{ id: 'youtube', name: 'YouTube', kinds: ['domains'] }],
        { [adPath('youtube', 'domains')]: { count: 100, mtime: 1 } },
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


describe('каталог: занятость — по строке, а не на всю таблицу (I-043, R-033)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockCatalog(
            [
                { id: 'aaa', name: 'AAA', kinds: ['prefixes'] },
                { id: 'bbb', name: 'BBB', kinds: ['prefixes'] },
            ],
            {
                [adPath('aaa', 'prefixes')]: { count: 1, mtime: 1 },
                [adPath('bbb', 'prefixes')]: { count: 1, mtime: 1 },
            },
        )
    })

    it('операция над одной записью не разблокирует незаконченную над другой', async () => {
        // list_remove обеих записей не завершается — обе операции «в полёте».
        vi.spyOn(rpc, 'listRemove').mockReturnValue(new Promise(() => {}))
        render(<CatalogTab onUseInRule={() => {}} />)
        const delA = await screen.findByLabelText(/Удалить AAA с роутера/)
        const delB = await screen.findByLabelText(/Удалить BBB с роутера/)

        fireEvent.click(delA)
        await waitFor(() => expect(delA).toBeDisabled())

        fireEvent.click(delB)
        await waitFor(() => expect(delB).toBeDisabled())

        // С одиночным слотом busy начало работы над B стирало отметку A и
        // включало её кнопку, пока её собственный вызов ещё висит.
        expect(delA).toBeDisabled()
    })
})
