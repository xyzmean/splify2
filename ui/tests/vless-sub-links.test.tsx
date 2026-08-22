import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isSubSource } from '@/lib/validate'
import type { Output } from '@/lib/model'

// Источник узлов: ссылка на подписку ЛИБО сами ссылки vless://.
//
// Бэкенд принимает обе формы и различает их по схеме — `sub_set` в rpcd-скрипте разбирает
// `https://*` скачиванием и `vless://*` записью строк в файл подписки, и там же записано,
// зачем: «человек с одним сервером от знакомого не мог сделать вообще ничего». А проверка в
// интерфейсе осталась прежней, `isHttpUrl`, и не пускала vless:// до вызова rpc — причём
// сообщение об ошибке утверждало «других схем он не умеет», то есть говорило неправду о
// собственном бэкенде. Снаружи это выглядело как «панель не принимает мою ссылку».
//
// Отсюда два свойства, которые проверяются здесь: годная форма доходит до бэкенда без
// изменений, а негодная по-прежнему отсекается рядом с полем и ДО вызова.

const h = vi.hoisted(() => ({
    subInfo: vi.fn(),
    vlessNodes: vi.fn(),
    vlessProbe: vi.fn(),
    subSet: vi.fn(),
}))

vi.mock('@/lib/rpc', () => ({
    rpc: { subInfo: h.subInfo, vlessNodes: h.vlessNodes, vlessProbe: h.vlessProbe, subSet: h.subSet },
}))

const { default: VlessPanel } = await import('@/components/VlessPanel')

const OUT: Output = { name: 'vl', kind: 'vless', sub_file: '/etc/steer/sub.txt', on_fail: 'drop' }

// Ссылка панели, которая привела к находке: идентификатор не UUID, транспорт xhttp, имя с
// эмодзи и скобками. Ровно она обязана доехать до бэкенда дословно.
const LINK = 'vless://TMG_74317ba5f91@203.0.113.7:443?type=xhttp&encryption=none'
    + '&path=%2FdRh-l74-MZE3z&host=amazon.com&mode=auto&security=reality&fp=firefox'
    + '&pbk=VwXrCHYcBJ24nBKIETbj0gMlsPCr-X8sYF5hMZ04rR0&sni=amazon.com&sid=9392&spx=%2F'
    + '#TMG_74317ba5f91-🇩🇪Германия(Франкфурт)'

function mount() {
    h.subInfo.mockResolvedValue({ present: false })
    h.vlessNodes.mockResolvedValue({ output: 'vl', nodes: [], usable: 0, skipped: 0, foreign: 0 })
    return render(<VlessPanel name="vl" output={OUT} onChange={() => {}} saved />)
}

const submit = () => screen.getByRole('button', { name: /Обновить|Загрузить/ })

beforeEach(() => { vi.clearAllMocks() })

describe('источник узлов принимает ссылки vless://', () => {
    it('ссылка vless:// доходит до бэкенда дословно, вместе с эмодзи и скобками в имени', async () => {
        h.subSet.mockResolvedValue({ ok: true, bytes: 512, kind: 'links' })
        mount()
        const field = await screen.findByLabelText(/Ссылка на подписку|Источник узлов/)
        fireEvent.input(field, { target: { value: LINK } })
        expect(screen.queryByText(/Нужна ссылка/)).toBeNull()
        fireEvent.click(submit())
        await waitFor(() => expect(h.subSet).toHaveBeenCalledWith(LINK))
    })

    it('несколько ссылок через пробел уходят как есть: делит их бэкенд, а не поле ввода', async () => {
        h.subSet.mockResolvedValue({ ok: true, bytes: 1024, kind: 'links' })
        mount()
        const field = await screen.findByLabelText(/Ссылка на подписку|Источник узлов/)
        const two = `${LINK} vless://u@10.0.0.2:443?security=reality&sni=a.com#второй`
        fireEvent.input(field, { target: { value: two } })
        fireEvent.click(submit())
        await waitFor(() => expect(h.subSet).toHaveBeenCalledWith(two))
    })

    it('негодная строка по-прежнему отсекается до вызова и объясняется у поля', async () => {
        mount()
        const field = await screen.findByLabelText(/Ссылка на подписку|Источник узлов/)
        fireEvent.input(field, { target: { value: 'example.com/sub' } })
        fireEvent.click(submit())
        expect(await screen.findByText(/Нужна ссылка/)).toBeTruthy()
        expect(h.subSet).not.toHaveBeenCalled()
    })
})

describe('validate.ts: isSubSource — две формы одного поля', () => {
    it('принимает ровно то, что принимает sub_set, и ничего сверх', () => {
        // Подписка по ссылке.
        expect(isSubSource('https://p.example/sub/abc')).toBe(true)
        expect(isSubSource('http://p.example/sub')).toBe(true)
        expect(isSubSource('  https://p.example/sub  ')).toBe(true)
        // Ссылки узлов: одна, несколько через пробел, несколько строками.
        expect(isSubSource(LINK)).toBe(true)
        expect(isSubSource('vless://u@a:443#x vless://u@b:443#y')).toBe(true)
        expect(isSubSource('vless://u@a:443#x\nvless://u@b:443#y')).toBe(true)
        expect(isSubSource('VLESS://u@a:443#x')).toBe(true)   // схема без учёта регистра
        // Пустое — это «ещё не ввели», а не ошибка формы: пустоту панель проверяет отдельно.
        expect(isSubSource('')).toBe(true)
        expect(isSubSource('   ')).toBe(true)
        // Негодное.
        expect(isSubSource('example.com/sub')).toBe(false)
        expect(isSubSource('ftp://a.example/sub')).toBe(false)
        expect(isSubSource('javascript:alert(1)')).toBe(false)
        expect(isSubSource('vless://')).toBe(false)           // схема без узла
        // Смесь форм: бэкенд идёт по ОДНОЙ ветке case и вторую форму молча потеряет.
        expect(isSubSource('https://p.example/sub vless://u@a:443#x')).toBe(false)
    })
})

// Панели, привязывающие подписку к устройствам (Remnawave и родня), отвечают клиенту без
// идентификатора НЕ отказом, а заглушкой: HTTP 200 и пара законных ссылок vless:// на
// 0.0.0.0:1, где сообщение человеку спрятано в ИМЯ узла («Неправильный клиент»). Снаружи это
// выглядит как «подписка скачалась, туннель не работает», то есть как поломка на нашей
// стороне — поэтому и идентификатор роутера, и сказанное панелью обязаны быть на экране.
describe('устройство в панели подписки', () => {
    it('идентификатор роутера показан рядом с подпиской', async () => {
        h.subInfo.mockResolvedValue({
            present: true, kind: 'url', bytes: 15039, hwid: 'splify2-6202c56e402d4e29c012',
        })
        h.vlessNodes.mockResolvedValue({ output: 'vl', nodes: [], usable: 0, skipped: 0, foreign: 0 })
        render(<VlessPanel name="vl" output={OUT} onChange={() => {}} saved />)
        expect(await screen.findByText('splify2-6202c56e402d4e29c012')).toBeInTheDocument()
        // Про MAC сказано прямо: человек имеет право знать, что уходит наружу, а что нет.
        expect(screen.getByText(/MAC порта/)).toBeInTheDocument()
    })

    it('вставленным руками ссылкам панель не нужна — идентификатора нет', async () => {
        h.subInfo.mockResolvedValue({
            present: true, kind: 'links', bytes: 90, hwid: 'splify2-6202c56e402d4e29c012',
        })
        h.vlessNodes.mockResolvedValue({ output: 'vl', nodes: [], usable: 1, skipped: 0, foreign: 0 })
        render(<VlessPanel name="vl" output={OUT} onChange={() => {}} saved />)
        await screen.findByText(/Файл на роутере/)
        expect(screen.queryByText('splify2-6202c56e402d4e29c012')).toBeNull()
    })

    it('сказанное панелью держится на экране, а не всплывашкой', async () => {
        h.subSet.mockResolvedValue({
            ok: true, bytes: 556, kind: 'url',
            warn: 'панель не увидела идентификатора устройства и отдала заглушку вместо узлов',
        })
        mount()
        const field = await screen.findByLabelText(/Ссылка на подписку|Источник узлов/)
        fireEvent.input(field, { target: { value: 'https://panel.invalid/sub/abc' } })
        fireEvent.click(submit())
        expect(await screen.findByText(/заглушку вместо узлов/)).toBeInTheDocument()
    })
})
