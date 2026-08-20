import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isCidr4, isDomain, isHttpUrl, isIfaceName, isIp4, isPositiveInt } from '@/lib/validate'
import type { Output, VlessProbe } from '@/lib/model'

// Проверка всей подписки сразу, свёртка списка узлов (R-019) и проверка ссылки на
// подписку до вызова (R-011, из обращения splify2#3).
//
// Что было. Узлы проверялись по одному: подписка на три десятка узлов — это тридцать
// нажатий, каждое с ожиданием таймаута, и список при этом занимал весь экран, потому что
// не сворачивался. Ссылка уходила в sub_set как есть, и «example.com/sub» без схемы
// возвращалось отказом роутера через несколько секунд и словами про код возврата wget.
//
// Что проверяется здесь — не вёрстка, а те свойства, которых легко лишиться при правке:
//
//   1. предел одновременности соблюдается НА ВСЮ очередь, а не только на первой волне:
//      параллельные проверки грузят однопроцессорный роутер и искажают тот самый замер
//      задержки, ради которого проверка и делается;
//   2. таблица заполняется постепенно — результат виден, как только пришёл, а не после
//      последнего узла;
//   3. строки, до которых очередь ещё не дошла, помечены честно («в очереди»), а не
//      выглядят непроверенными или уже проверяемыми;
//   4. отмена (повторное нажатие) и размонтирование останавливают пачку и не дают
//      поздним ответам трогать состояние снятого компонента;
//   5. свёрнутый список не прячет сам выбор узла;
//   6. негодная ссылка объясняется рядом с полем и до вызова rpc.

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

/** Узел подписки в том виде, в каком его отдаёт движок. */
function node(i: number) {
    return {
        index: i, name: `NL-${i}`, host: `10.0.0.${i}`, port: 443,
        type: 'tcp', security: 'reality', vision: true,
    }
}

/** Проверки, которые не отвечают, пока их не отпустят: только так видно, сколько их
 *  висит одновременно и в каком порядке заполняется таблица. */
function gatedProbes() {
    const gate = new Map<number, (r: unknown) => void>()
    let inFlight = 0
    let peak = 0
    h.vlessProbe.mockImplementation((_name: string, index: number) => new Promise((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        gate.set(index, (val) => { inFlight -= 1; resolve(val) })
    }))
    return {
        peak: () => peak,
        pending: () => [...gate.keys()],
        answer(index: number, extra: Partial<VlessProbe> = {}) {
            const release = gate.get(index)
            if (!release) throw new Error(`узел ${index} не проверяется`)
            gate.delete(index)
            release({
                results: [{
                    index, name: `NL-${index}`, type: 'tcp', ok: true,
                    handshake_ms: 40, ttfb_ms: 100 + index, why: '', ...extra,
                }],
            })
        },
        fail(index: number, error: string) {
            const release = gate.get(index)
            if (!release) throw new Error(`узел ${index} не проверяется`)
            gate.delete(index)
            release({ error })
        },
    }
}

function mount(count: number) {
    h.subInfo.mockResolvedValue({ present: true, bytes: 4096, url: 'https://p/sub' })
    h.vlessNodes.mockResolvedValue({
        output: 'vl', sub_file: '/etc/steer/sub.txt', node: -1,
        usable: count, skipped: 0, foreign: 0,
        nodes: Array.from({ length: count }, (_, i) => node(i)),
    })
    return render(<VlessPanel name="vl" output={OUT} onChange={() => {}} saved />)
}

const probeAllButton = () => screen.getByRole('button', { name: /Проверить все/ })

// Счётчики вызовов здесь — сама проверка (сколько проверок ушло и сколько висит
// одновременно), поэтому между тестами они обязаны обнуляться: иначе «ровно три» второго
// теста видит ещё и вызовы первого.
beforeEach(() => { vi.clearAllMocks() })

describe('проверка всей подписки', () => {
    it('держит предел одновременности на всей очереди, а не на первой волне', async () => {
        const g = gatedProbes()
        mount(8)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))

        // Первая волна — ровно предел, дальше очередь ждёт.
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(3))
        expect(g.pending()).toEqual([0, 1, 2])

        // Отпускаем узлы по одному: на каждый освободившийся слот встаёт следующий, и
        // одновременных проверок по-прежнему не больше трёх.
        for (let i = 0; i < 8; i++) {
            g.answer(i)
            await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(Math.min(8, i + 4)))
            expect(g.pending().length).toBeLessThanOrEqual(3)
        }
        expect(h.vlessProbe).toHaveBeenCalledTimes(8)
        expect(g.peak()).toBe(3)
        // Кнопка вернулась в исходное состояние — пачка закончилась ровно один раз.
        expect(await screen.findByRole('button', { name: /Проверить все/ })).toBeInTheDocument()
    })

    it('заполняет таблицу по мере готовности, а не всё в конце', async () => {
        const g = gatedProbes()
        mount(6)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(3))

        g.answer(1, { ttfb_ms: 111 })
        // Результат первого ответившего узла виден, пока остальные ещё идут: именно это и
        // значит «постепенно», а не «все в конце».
        expect(await screen.findByText('ответ 111 мс')).toBeInTheDocument()
        expect(screen.getAllByText('идёт проверка').length).toBeGreaterThan(0)
        expect(screen.getAllByText('в очереди').length).toBeGreaterThan(0)
    })

    it('честно помечает строки: идущие — «идёт проверка», ждущие — «в очереди»', async () => {
        gatedProbes()
        mount(5)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        await waitFor(() => expect(screen.getAllByText('идёт проверка')).toHaveLength(3))
        // Пять узлов, три слота: два остатка не выглядят непроверенными.
        expect(screen.getAllByText('в очереди')).toHaveLength(2)
        // И их кнопки не приглашают нажать второй раз поверх уже поставленной проверки.
        expect(screen.getAllByRole('button', { name: /В очереди/ })).toHaveLength(2)
    })

    it('повторное нажатие отменяет пачку, и поздний ответ таблицу не трогает', async () => {
        const g = gatedProbes()
        mount(9)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(3))

        fireEvent.click(screen.getByRole('button', { name: /Остановить/ }))
        // Пометки сняты сразу: пачки больше нет, и говорить «в очереди» было бы неправдой.
        await waitFor(() => expect(screen.queryByText('в очереди')).toBeNull())
        expect(screen.queryByText('идёт проверка')).toBeNull()

        // Ответ уже отправленного вызова приходит после отмены — и не попадает в таблицу
        // и не запускает следующий узел из очереди.
        g.answer(0, { ttfb_ms: 123 })
        await Promise.resolve()
        await waitFor(() => expect(screen.queryByText('ответ 123 мс')).toBeNull())
        expect(h.vlessProbe).toHaveBeenCalledTimes(3)
    })

    it('уход со вкладки останавливает пачку: очередь не продолжается после размонтирования', async () => {
        const g = gatedProbes()
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { unmount } = mount(9)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(3))

        unmount()
        for (const i of [0, 1, 2]) g.answer(i)
        await Promise.resolve()
        await Promise.resolve()
        // Ни одного нового вызова: воркеры остановились, а не дожёвывают очередь в фоне,
        // обновляя состояние снятого компонента.
        expect(h.vlessProbe).toHaveBeenCalledTimes(3)
        expect(spy).not.toHaveBeenCalled()
        spy.mockRestore()
    })

    it('отказ проверки виден в строке узла, а не всплывашкой на каждый узел', async () => {
        const g = gatedProbes()
        mount(3)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledTimes(3))
        g.fail(0, 'узел не отвечает')
        g.answer(1)
        g.answer(2)
        expect(await screen.findByText('узел не отвечает')).toBeInTheDocument()
    })

    it('одиночная проверка узла работает по-прежнему', async () => {
        const g = gatedProbes()
        mount(3)
        const rows = await screen.findAllByRole('button', { name: /Проверить$/ })
        fireEvent.click(rows[1])
        await waitFor(() => expect(h.vlessProbe).toHaveBeenCalledWith('vl', 1))
        expect(await screen.findByText('идёт проверка')).toBeInTheDocument()
        g.answer(1, { ttfb_ms: 77 })
        expect(await screen.findByText('ответ 77 мс')).toBeInTheDocument()
    })
})

describe('свёртка списка узлов', () => {
    it('короткий список открыт: сворачивать нечего', async () => {
        mount(4)
        expect(await screen.findByText('NL-0')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Свернуть список узлов \(4\)/ })).toBeInTheDocument()
    })

    it('длинный список свёрнут, но выбранный узел и кнопки остаются видны', async () => {
        mount(26)
        const toggle = await screen.findByRole('button', { name: /Показать узлы \(26\)/ })
        expect(screen.queryByText('NL-0')).toBeNull()
        // Свёрнутая панель не прячет сам выбор: «первый рабочий» на месте, и видно, что
        // выбрано именно оно.
        expect(screen.getByText('Первый рабочий')).toBeInTheDocument()
        expect(screen.getByText(/выбран: первый рабочий/)).toBeInTheDocument()
        expect(probeAllButton()).toBeInTheDocument()

        fireEvent.click(toggle)
        expect(await screen.findByText('NL-0')).toBeInTheDocument()
        expect(screen.getByText('NL-25')).toBeInTheDocument()
    })

    it('«проверить все» разворачивает список: проверять невидимое незачем', async () => {
        gatedProbes()
        mount(26)
        fireEvent.click(await screen.findByRole('button', { name: /Проверить все/ }))
        expect(await screen.findByText('NL-0')).toBeInTheDocument()
    })
})

describe('ссылка на подписку проверяется до вызова', () => {
    it('строка без схемы объясняется рядом с полем, и sub_set не вызывается', async () => {
        mount(2)
        const field = await screen.findByLabelText('Ссылка на подписку')
        fireEvent.input(field, { target: { value: 'example.com/sub/xxxx' } })
        const err = await screen.findByRole('alert')
        expect(err).toHaveTextContent(/Нужна ссылка вида https/)
        expect(field).toHaveAttribute('aria-invalid', 'true')
        expect(field).toHaveAttribute('aria-describedby', err.id)

        fireEvent.click(screen.getByRole('button', { name: /Обновить|Загрузить/ }))
        expect(h.subSet).not.toHaveBeenCalled()
    })

    it('пустое поле объясняется в форме, а не молчаливым бездействием', async () => {
        mount(2)
        const field = await screen.findByLabelText('Ссылка на подписку')
        fireEvent.input(field, { target: { value: '   ' } })
        fireEvent.click(screen.getByRole('button', { name: /Обновить|Загрузить/ }))
        // Именно в форме и именно у поля: всплывашка (так было до R-011) уезжает через
        // четыре секунды и ничем с полем не связана.
        const err = await screen.findByRole('alert')
        expect(err).toHaveTextContent(/Вставьте ссылку на подписку/)
        expect(field).toHaveAttribute('aria-describedby', err.id)
        expect(h.subSet).not.toHaveBeenCalled()
    })

    it('годная ссылка уходит в sub_set обрезанной по краям', async () => {
        h.subSet.mockResolvedValue({ ok: true, bytes: 2048, kind: 'url' })
        mount(2)
        const field = await screen.findByLabelText('Ссылка на подписку')
        fireEvent.input(field, { target: { value: '  https://p.example/sub/abc  ' } })
        expect(screen.queryByText(/Нужна ссылка вида https/)).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /Обновить|Загрузить/ }))
        await waitFor(() => expect(h.subSet).toHaveBeenCalledWith('https://p.example/sub/abc'))
    })
})

// Пограничные случаи регулярок validate.ts: до этого запуска на них не было ни одного
// теста, а регулярка — то место, где «почти правильно» и «правильно» различаются одним
// символом, и цена ошибки — молча отвергнутый годный ввод.
describe('validate.ts: границы регулярок', () => {
    it('isHttpUrl: пустое — не ошибка, схема обязательна, пробелов внутри нет', () => {
        expect(isHttpUrl('')).toBe(true)          // пустое поле = «выключено»
        expect(isHttpUrl('   ')).toBe(true)
        expect(isHttpUrl('http://a')).toBe(true)
        expect(isHttpUrl('https://a')).toBe(true)
        expect(isHttpUrl('HTTPS://A.EXAMPLE/sub')).toBe(true)
        expect(isHttpUrl('  https://a.example/sub  ')).toBe(true)
        expect(isHttpUrl('https://a.example/sub?token=x#frag')).toBe(true)
        expect(isHttpUrl('https://')).toBe(false)  // схема без хоста
        expect(isHttpUrl('http:/a')).toBe(false)   // одна косая
        expect(isHttpUrl('example.com/sub')).toBe(false)
        expect(isHttpUrl('ftp://a.example/sub')).toBe(false)
        expect(isHttpUrl('vless://uuid@a:443')).toBe(false)
        expect(isHttpUrl('https://a example/sub')).toBe(false)
        expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    })

    it('isIp4: октет 0..255 без ведущих нулей и без лишних частей', () => {
        expect(isIp4('0.0.0.0')).toBe(true)
        expect(isIp4('255.255.255.255')).toBe(true)
        expect(isIp4(' 10.0.0.1 ')).toBe(true)
        expect(isIp4('256.0.0.1')).toBe(false)
        expect(isIp4('1.2.3')).toBe(false)
        expect(isIp4('1.2.3.4.5')).toBe(false)
        expect(isIp4('01.2.3.4')).toBe(false)     // ведущий нуль: inet_aton прочтёт как 8-ричное
        expect(isIp4('1.2.3.4/32')).toBe(false)
        expect(isIp4('')).toBe(false)
    })

    it('isCidr4: длина префикса 0..32, и адрес без неё не проходит', () => {
        expect(isCidr4('10.0.0.0/8')).toBe(true)
        expect(isCidr4('0.0.0.0/0')).toBe(true)
        expect(isCidr4('192.168.1.1/32')).toBe(true)
        expect(isCidr4('10.0.0.0/33')).toBe(false)
        expect(isCidr4('10.0.0.0/08')).toBe(false)
        expect(isCidr4('10.0.0.0')).toBe(false)
        expect(isCidr4('10.0.0.0/')).toBe(false)
    })

    it('isDomain: намеренно щедрая — режет только явно не-имена', () => {
        expect(isDomain('example.com')).toBe(true)
        expect(isDomain('*.example.com')).toBe(true)
        expect(isDomain('рф.example')).toBe(true)          // IDN не отвергаем
        expect(isDomain('router')).toBe(true)              // одна метка = локальная зона
        expect(isDomain('a b.com')).toBe(false)
        expect(isDomain('http://example.com')).toBe(false) // схема — это уже не имя
        expect(isDomain('user@example.com')).toBe(false)
        expect(isDomain('')).toBe(false)
    })

    it('isPositiveInt и isIfaceName: ноль, знак, длина имени устройства', () => {
        expect(isPositiveInt('1')).toBe(true)
        expect(isPositiveInt(' 42 ')).toBe(true)
        expect(isPositiveInt('0')).toBe(false)
        expect(isPositiveInt('-1')).toBe(false)
        expect(isPositiveInt('1.5')).toBe(false)
        expect(isPositiveInt('')).toBe(false)

        expect(isIfaceName('wg0')).toBe(true)
        expect(isIfaceName('br-lan.100')).toBe(true)
        expect(isIfaceName('steer_tun0')).toBe(true)
        expect(isIfaceName('')).toBe(false)
        expect(isIfaceName('a'.repeat(15))).toBe(true)      // IFNAMSIZ - 1
        expect(isIfaceName('a'.repeat(16))).toBe(false)
        expect(isIfaceName('wg 0')).toBe(false)
        expect(isIfaceName('wg/0')).toBe(false)
    })
})
