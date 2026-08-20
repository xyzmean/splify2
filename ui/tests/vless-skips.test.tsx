import { render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import type { Output } from '@/lib/model'

// Почему узлы подписки не попали в список (splicicd#16, находка I-065).
//
// Движок с самого начала знал причину — `skip_reason` заполняется в sub.c для каждого
// непригодного узла, — но наружу шли только два числа. Человек с подпиской из tls-узлов
// видел «узлов пригодно 0, пропущено 26» и делал единственный возможный вывод: «splify2
// не подключается». Причина при этом лежала в структуре на стеке: «security=tls не
// поддержан».
//
// Проверяется здесь не вёрстка, а то, ради чего поле заведено: причина ВИДНА, она
// названа словами движка (интерфейс её не пересказывает и не переводит — как и строки
// журнала), одинаковые причины схлопнуты в строку со счётчиком, а движок без этого поля
// (пакет обновляют не в один день с интерфейсом) не ломает панель и не рисует пустой
// список.

const h = vi.hoisted(() => ({ subInfo: vi.fn(), vlessNodes: vi.fn() }))

vi.mock('@/lib/rpc', () => ({
    rpc: {
        subInfo: h.subInfo,
        vlessNodes: h.vlessNodes,
        vlessProbe: vi.fn(),
        subSet: vi.fn(),
    },
}))

const { default: VlessPanel } = await import('@/components/VlessPanel')

const OUT: Output = { name: 'vl', kind: 'vless', sub_file: '/etc/steer/sub.txt', on_fail: 'drop' }

function mount(nodes: Record<string, unknown>) {
    h.subInfo.mockResolvedValue({ present: true, bytes: 2048, url: 'https://p/sub' })
    h.vlessNodes.mockResolvedValue({
        output: 'vl', sub_file: '/etc/steer/sub.txt', node: -1, nodes: [], ...nodes,
    })
    render(<VlessPanel name="vl" output={OUT} onChange={() => {}} saved />)
}

describe('причины непригодности узлов подписки', () => {
    it('называет причину словами движка и схлопывает одинаковые', async () => {
        mount({
            usable: 0, skipped: 26, foreign: 0,
            skipped_reasons: [{ reason: 'security=tls не поддержан', count: 26, example: 'NL-1' }],
        })
        expect(await screen.findByText(/security=tls не поддержан/)).toBeInTheDocument()
        // Счётчик и пример — в той же строке: причина без числа не отвечает на «сколько
        // из моих узлов», а без примера её не привязать к узлу в подписке.
        expect(screen.getByText(/узлов 26/)).toBeInTheDocument()
        expect(screen.getByText(/NL-1/)).toBeInTheDocument()
    })

    it('перечисляет разные причины по отдельности — это разные действия владельца подписки', async () => {
        mount({
            usable: 2, skipped: 3, foreign: 1,
            skipped_reasons: [
                { reason: 'транспорт ws не поддержан', count: 2, example: 'WS-1' },
                { reason: 'reality без pbk или sni', count: 1, example: '' },
            ],
        })
        expect(await screen.findByText(/транспорт ws не поддержан/)).toBeInTheDocument()
        expect(screen.getByText(/reality без pbk или sni/)).toBeInTheDocument()
        // Единственное число, когда узел один: «узлов 1» читается как опечатка.
        expect(screen.getByText(/узел 1/)).toBeInTheDocument()
        // Пустой пример не превращается в «например «»».
        expect(screen.queryByText(/например «»/)).toBeNull()
    })

    it('пропущенные без причины остаются числом, а не пропадают', async () => {
        mount({
            usable: 0, skipped: 9, foreign: 0,
            skipped_reasons: [{ reason: 'security=s1 не поддержан', count: 1, example: 'n1' }],
            skipped_other: 8,
        })
        expect(await screen.findByText(/прочие причины — узлов 8/)).toBeInTheDocument()
    })

    it('движок без этого поля панель не ломает и пустого списка не рисует', async () => {
        mount({ usable: 1, skipped: 4, foreign: 0 })
        // Счётчик по-прежнему на месте — по нему и видно, что панель отрисовалась.
        expect(await screen.findByText(/пропущено 4/)).toBeInTheDocument()
        expect(screen.queryByRole('list')).toBeNull()
    })
})
