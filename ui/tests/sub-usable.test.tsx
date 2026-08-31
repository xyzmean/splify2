import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// «Подписка скачалась» ничего не обещает, и это отказ ровно того тихого вида, которого в
// проекте не должно быть: файл на месте, размер осмысленный, а туннель не поднимется никогда.
//
// Причин две, и обе видны только по СОДЕРЖИМОМУ. Панель с привязкой к устройствам отдаёт
// незнакомому клиенту заглушку — пару законных ссылок на 0.0.0.0:1, где сообщение спрятано в
// имя узла. И панель может отдать формат, в котором ссылок vless:// нет вовсе.
//
// Число пригодных узлов теперь считает движок — тем же кодом, которым читает подписку при
// подъёме туннеля, — и отдаёт его полем `usable` в ответе на «Добавить»/«Обновить». То есть
// это обещание, а не оценка, и сказать о нём человеку надо сразу: иначе он идёт искать
// причину в панели, в сети и в настройке, а причина уже названа.

const h = vi.hoisted(() => ({
    subList: vi.fn(),
    subInfo: vi.fn(),
    subSet: vi.fn(),
    subDel: vi.fn(),
    notify: vi.fn(),
}))

vi.mock('@/lib/rpc', () => ({
    rpc: { subList: h.subList, subInfo: h.subInfo, subSet: h.subSet, subDel: h.subDel },
}))
vi.mock('@/lib/notify', () => ({ notify: h.notify }))

const { default: VlessScreen } = await import('@/components/VlessScreen')

const ROW = {
    name: 'main', title: 'Панель', kind: 'url' as const,
    url: 'https://panel.example/sub', path: '/etc/steer/sub.txt', present: true,
}

async function mount() {
    h.subList.mockResolvedValue({ subs: [ROW], hwid: 'splify2-0123456789abcdef0123' })
    const r = render(<VlessScreen />)
    await waitFor(() => expect(h.subList).toHaveBeenCalled())
    return r
}

async function add(answer: Record<string, unknown>) {
    h.subSet.mockResolvedValue(answer)
    await mount()
    fireEvent.input(screen.getByLabelText('ссылка подписки'), {
        target: { value: 'https://panel.example/other' },
    })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(h.subSet).toHaveBeenCalled())
}

describe('пригодных узлов нет — сказано сразу', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
    })

    it('подписка скачалась, а узлов в ней нет — предупреждение', async () => {
        await add({ ok: true, kind: 'url', usable: 0 })
        expect(h.notify).toHaveBeenCalledWith(
            expect.stringContaining('пригодных узлов'),
            'warning',
        )
    })

    it('узлы есть — молчим: сообщение на исправной подписке учит не читать сообщения', async () => {
        await add({ ok: true, kind: 'url', usable: 9 })
        expect(h.notify).not.toHaveBeenCalled()
    })

    it('слово панели про устройство важнее числа: оно объясняет ПРИЧИНУ', async () => {
        // Заглушка панели даёт и ноль узлов, и заголовок про устройство. Сказать оба значило бы
        // два предупреждения об одном событии, причём второе (число) без первого (причины)
        // бесполезно: человеку надо освободить слот, а не искать другую подписку.
        await add({
            ok: true, kind: 'url', usable: 0,
            warn: 'панель считает, что устройств уже больше, чем позволено подпиской: освободите слот у поставщика',
        })
        expect(h.notify).toHaveBeenCalledTimes(1)
        expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('освободите слот'), 'warning')
    })

    it('движок постарее числа не считает — и выдумывать его нечем', async () => {
        // Поля нет вовсе: объект или движок старее. Это не «узлов ноль», и предупреждать не о
        // чем — иначе интерфейс объявлял бы исправную подписку пустой на каждом обновлении.
        await add({ ok: true, kind: 'url' })
        expect(h.notify).not.toHaveBeenCalled()
    })

    it('отказ остаётся отказом, а не «узлов нет»', async () => {
        await add({ ok: false, error: 'подписка не скачалась' })
        expect(h.notify).toHaveBeenCalledTimes(1)
        expect(h.notify).toHaveBeenCalledWith('подписка не скачалась', 'error')
    })
})

describe('обновление уже заведённой подписки', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
    })

    it('обновилась, а узлов не стало — сказано тем же словом', async () => {
        // Подписка, из которой поставщик убрал узлы, выглядит рабочей: файл прежний, кнопка
        // отработала. Обновление обязано говорить об этом так же, как заведение.
        h.subSet.mockResolvedValue({ ok: true, kind: 'url', usable: 0 })
        await mount()
        fireEvent.click(screen.getByText('Обновить'))
        await waitFor(() => expect(h.subSet).toHaveBeenCalledWith(
            'https://panel.example/sub', 'main', 'Панель',
        ))
        expect(h.notify).toHaveBeenCalledWith(
            expect.stringContaining('пригодных узлов'),
            'warning',
        )
    })
})
