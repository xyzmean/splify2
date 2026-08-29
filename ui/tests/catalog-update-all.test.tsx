import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import { rpc } from '@/lib/rpc'

// Кнопка «Обновить списки» в каталоге. До неё обновить всё разом можно было только
// расписанием (или по одной записи), то есть человек, добавивший правило, ждал ночи или
// жал по каждой записи отдельно.
//
// Сторожится здесь ровно то, что ломается молча: кнопка обязана звать ТОТ ЖЕ прогон, что
// и расписание, и отчитываться по его ответу, а не безусловным успехом — ровно на этом
// уже обжигалось удаление (R-033).

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

describe('каталог: обновление всех списков', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        mockBase()
    })

    it('нажатие зовёт общий прогон и называет число обновлённых', async () => {
        const upd = vi.spyOn(rpc, 'listsUpdate').mockResolvedValue({ ok: true, updated: 3 })
        render(<CatalogTab onUseInRule={() => {}} />)
        fireEvent.click(await screen.findByText(/Обновить списки/))
        await waitFor(() => expect(upd).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByText(/Обновлено списков: 3/)).toBeInTheDocument())
    })

    it('прогон без изменений — не ошибка', async () => {
        vi.spyOn(rpc, 'listsUpdate').mockResolvedValue({ ok: true, updated: 0 })
        render(<CatalogTab onUseInRule={() => {}} />)
        fireEvent.click(await screen.findByText(/Обновить списки/))
        await waitFor(() => expect(screen.getByText(/уже свежие/)).toBeInTheDocument())
    })

    it('отказ доходит до человека, а не тонет в успехе', async () => {
        vi.spyOn(rpc, 'listsUpdate').mockResolvedValue({ ok: false, updated: 0, failed: 2 })
        render(<CatalogTab onUseInRule={() => {}} />)
        fireEvent.click(await screen.findByText(/Обновить списки/))
        await waitFor(() =>
            expect(screen.getByText(/Не обновилось списков: 2/)).toBeInTheDocument(),
        )
    })

    it('пока прогон идёт, кнопка заперта: два прогона разом скрипт не пустит', async () => {
        let release: (v: { ok: boolean; updated: number }) => void = () => {}
        vi.spyOn(rpc, 'listsUpdate').mockReturnValue(
            new Promise((res) => {
                release = res
            }) as never,
        )
        render(<CatalogTab onUseInRule={() => {}} />)
        const btn = await screen.findByText(/Обновить списки/)
        fireEvent.click(btn)
        await waitFor(() => expect(btn.closest('button')).toBeDisabled())
        release({ ok: true, updated: 1 })
        await waitFor(() => expect(btn.closest('button')).not.toBeDisabled())
    })
})
