import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogTab from '@/components/tabs/CatalogTab'
import EngineCard from '@/components/EngineCard'
import SelfUpdateCard from '@/components/SelfUpdateCard'
import { rpc } from '@/lib/rpc'

// splify2#15: у части аудитории провайдер закрыл githubusercontent.com — и закрыл целиком,
// потому что raw., objects. и release-assets. стоят на одних адресах Fastly. Бэкенд теперь
// достаёт файл обходом: с хостов самого GitHub или через туннель роутера, — и говорит об
// этом полем `via`.
//
// Зачем показывать. Обход медленнее прямого пути: contents API — ещё один запрос, архив
// ветки — мегабайт вместо одного файла, туннель — ещё и правило маршрутизации на время
// скачивания. Без строки на экране всё это выглядит как беспричинно затянувшееся ожидание,
// и человек второй раз жмёт ту же кнопку. Поэтому проверяется не факт успеха, а то, что
// названный бэкендом путь доехал до человека — и что на прямом пути лишних слов нет.

const VIA = 'прямой адрес не отдал — взято через api.github.com (xyzmean/ru-bypass-ipsets, ветка main)'
const noop = () => {}

const MANIFEST = {
    version: '1',
    base_url: 'https://x/',
    categories: [{ id: 'youtube', name_ru: 'YouTube', file: 'youtube.lst', count: 100 }],
}

// Всплывашка живёт четыре секунды и висит прямо в body, а не в контейнере рендера,
// поэтому уборка testing-library её не трогает: без этой строки следующая проверка
// находит слова предыдущей.
function clearToasts() {
    document.body.innerHTML = ''
}

function mockCatalog() {
    vi.spyOn(rpc, 'manifest').mockResolvedValue(MANIFEST as never)
    vi.spyOn(rpc, 'specGet').mockResolvedValue({ channels: [] } as never)
    // Список уже на роутере: кнопка «Обновить» есть только у скачанного — у остального
    // в этой колонке стоит «скачается сам».
    vi.spyOn(rpc, 'localLists').mockResolvedValue(
        { files: { 'youtube.lst': { count: 100, mtime: 1 } } } as never,
    )
}

describe('каталог называет путь, которым приехал список (splify2#15)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        clearToasts()
        mockCatalog()
    })

    it('обход назван рядом с «обновлено»', async () => {
        vi.spyOn(rpc, 'listFetch').mockResolvedValue({ ok: true, count: 100, via: VIA })
        render(<CatalogTab onUseInRule={noop} />)
        fireEvent.click(await screen.findByLabelText('Обновить YouTube'))
        await waitFor(() => expect(screen.getByText(/api\.github\.com/)).toBeInTheDocument())
        expect(screen.getByText(/обновлено/)).toBeInTheDocument()
    })

    it('прямой путь лишних слов не добавляет', async () => {
        vi.spyOn(rpc, 'listFetch').mockResolvedValue({ ok: true, count: 100 })
        render(<CatalogTab onUseInRule={noop} />)
        fireEvent.click(await screen.findByLabelText('Обновить YouTube'))
        await waitFor(() => expect(rpc.listFetch).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByText(/обновлено/)).toBeInTheDocument())
        expect(screen.queryByText(/github\.com/)).toBeNull()
    })
})

describe('установка называет путь, которым приехал пакет (splify2#15)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        clearToasts()
    })

    it('движок: обход назван рядом с «установлен»', async () => {
        vi.spyOn(rpc, 'steerInstall').mockResolvedValue({
            ok: true,
            installed: 'steer-extended-1.2.1-1_mipsel_24kc.apk',
            restarted: true,
            via: 'прямой адрес не отдал — взято через api.github.com (xyzmean/steer, ветка dist)',
        })
        render(
            <EngineCard
                engine={{ present: true, vless: true, version: '1.2.0', arch: 'mipsel_24kc' }}
                releases={{ arch: 'mipsel_24kc', versions: ['1.2.1', '1.2.0'] }}
                onInstalled={noop}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: /Обновить до 1\.2\.1/ }))
        await waitFor(() => expect(screen.getByText(/ветка dist/)).toBeInTheDocument())
    })

    it('интерфейс: обход назван рядом с «обновлён»', async () => {
        vi.spyOn(rpc, 'splify2Install').mockResolvedValue({
            ok: true,
            installed: 'luci-app-splify2-1.2.1-1_all.ipk',
            via: 'прямой адрес не отдал — взято архивом через codeload.github.com (xyzmean/splify2, ветка dist)',
        })
        render(<SelfUpdateCard info={{ current: '1.2.0', versions: ['1.2.1'] }} onInstalled={noop} />)
        fireEvent.click(screen.getByRole('button', { name: /Обновить до 1\.2\.1/ }))
        await waitFor(() => expect(screen.getByText(/codeload\.github\.com/)).toBeInTheDocument())
    })
})
