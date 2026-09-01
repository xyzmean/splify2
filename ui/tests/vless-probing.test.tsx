import { render, screen } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubBlock } from '@/components/OutputCards'
import { rpc } from '@/lib/rpc'
import type { OutputStatus } from '@/lib/model'

// I-100: устройство туннеля vless появляется только ПОСЛЕ перебора узлов подписки, а при
// `node: -1` перебор идёт с таймаутом восемь секунд на узел. Пока он идёт, `up` ложно — то же
// значение, что при настоящем отказе, — и раздел выходов показывал «нет устройства» в обоих
// случаях. На трёх десятках нерабочих узлов исправная настройка минутами выглядела сломанной.
//
// Движок рассказывает, что делает (поле `probe` в status), а блок подписки на главной
// различает четыре случая словами. Проверяется, что отсутствие поля возвращает прежний вид:
// «не знаем» не должно читаться как «плохо».

const st = (probe?: OutputStatus['probe']): OutputStatus =>
    ({ name: 'vl', kind: 'vless', device: 'vl', up: false, probe }) as OutputStatus

const block = (s: OutputStatus) =>
    render(<SubBlock outs={[{ name: 'vl', st: s, facts: { ping: { ms: 42, state: 'ok' } } }]} />)

describe('подъём выхода vless виден словами (I-100)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        window.localStorage.clear()
        document.body.innerHTML = ''
        vi.spyOn(rpc, 'subQuota').mockRejectedValue(new Error('не спрашиваем'))
        vi.spyOn(rpc, 'vlessNodes').mockRejectedValue(new Error('не спрашиваем'))
    })

    it('идёт перебор — назван номер узла и сколько их всего', async () => {
        block(st({ state: 'probing', node: 3, total: 26 }))
        expect(await screen.findByText('проверяем узлы подписки: 3 из 26')).toBeInTheDocument()
        expect(screen.queryByText(/Нет соединения/)).toBeNull()
    })

    it('ни один узел не ответил — это отказ, а не «нет устройства»', async () => {
        block(st({ state: 'failed', total: 26 }))
        expect(await screen.findByText(/ни один узел подписки не ответил/)).toBeInTheDocument()
    })

    it('узлов в подписке нет — сказано именно это', async () => {
        block(st({ state: 'failed', total: 0 }))
        expect(await screen.findByText(/в подписке нет пригодных узлов/)).toBeInTheDocument()
    })

    it('номер узла вне подписки — своя строка с двумя числами', async () => {
        // Снято с живого роутера: у выхода стоял `node: 31`, а в подписке было 29 узлов.
        // Движок писал «failed, total 0», и интерфейс говорил «в подписке нет узлов» — то
        // есть отправлял перекачивать подписку и менять поставщика там, где надо поправить
        // одно число. Оба числа обязаны быть на экране: порознь они ничего не значат.
        block(st({ state: 'no_such_node', node: 31, total: 29 }))
        expect(await screen.findByText(/выбран узел 31, а пригодных в подписке 29/)).toBeInTheDocument()
        expect(screen.queryByText(/в подписке нет пригодных узлов/)).toBeNull()
        expect(screen.queryByText(/ни один узел подписки не ответил/)).toBeNull()
    })

    it('поля нет — прежний вид, а не догадка', async () => {
        // Движок старее интерфейса, состояние устарело, писавший процесс мёртв — всё это
        // «не знаем», и менять из-за этого приговор нельзя.
        block(st(undefined))
        expect(await screen.findByText(/выход vl не поднят: устройства нет/)).toBeInTheDocument()
    })

    it('поднятый выход про перебор не говорит', async () => {
        block({ name: 'vl', kind: 'vless', device: 'vl', up: true } as OutputStatus)
        expect(await screen.findByText('42 мс')).toBeInTheDocument()
        expect(screen.queryByText(/проверяем узлы/)).toBeNull()
    })
})
