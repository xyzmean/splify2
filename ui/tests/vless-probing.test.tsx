import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OutboundsTab from '@/components/tabs/OutboundsTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Spec, Status } from '@/lib/model'

// I-100: устройство туннеля vless появляется только ПОСЛЕ перебора узлов подписки, а при
// `node: -1` перебор идёт с таймаутом восемь секунд на узел. Пока он идёт, `up` ложно — то же
// значение, что при настоящем отказе, — и раздел выходов показывал «нет устройства» в обоих
// случаях. На трёх десятках нерабочих узлов исправная настройка минутами выглядела сломанной.
//
// Движок теперь рассказывает, что делает (поле `probe` в status). Проверяется, что интерфейс
// различает три случая и что отсутствие поля возвращает прежний вид: «не знаем» не должно
// читаться как «плохо».

const SPEC: Spec = {
    schema: 1,
    outputs: { vl: { name: 'vl', kind: 'vless', sub_file: '/etc/steer/sub.txt', node: -1, on_fail: 'drop' } },
    channels: [],
}

const status = (probe?: Status['outputs'][string]['probe']): Status => ({
    schema: 1,
    outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: false, probe } },
    channels: [],
})

describe('подъём выхода vless виден словами (I-100)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        pending.saved = SPEC
        pending.applied = SPEC
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
        vi.spyOn(rpc, 'engine').mockResolvedValue({ present: true, vless: true })
        vi.spyOn(rpc, 'vlessNodes').mockRejectedValue(new Error('не спрашиваем'))
        // Отклик приходит тем же вызовом, что и страна: запрос идёт через устройство выхода.
        vi.spyOn(rpc, 'outboundGeo').mockResolvedValue({ output: 'vl', cc: 'NL', ip: '1.2.3.4', ms: 42 } as never)
    })

    it('идёт перебор — назван номер узла и сколько их всего', async () => {
        render(<OutboundsTab live={live({ status: status({ state: 'probing', node: 3, total: 26 }) })} />)
        expect(await screen.findByText('проверяю узлы: 3 из 26')).toBeInTheDocument()
        expect(screen.queryByText('нет устройства')).toBeNull()
    })

    it('перебор не спрашивают об отклике: устройства ещё нет, мерить нечего', async () => {
        render(<OutboundsTab live={live({ status: status({ state: 'probing', node: 1, total: 26 }) })} />)
        await screen.findByText('проверяю узлы: 1 из 26')
        await waitFor(() => expect(rpc.engine).toHaveBeenCalled())
        expect(rpc.outboundGeo).not.toHaveBeenCalled()
    })

    it('ни один узел не ответил — это отказ, а не «нет устройства»', async () => {
        render(<OutboundsTab live={live({ status: status({ state: 'failed', total: 26 }) })} />)
        expect(await screen.findByText('ни один узел не ответил')).toBeInTheDocument()
    })

    it('узлов в подписке нет — сказано именно это', async () => {
        render(<OutboundsTab live={live({ status: status({ state: 'failed', total: 0 }) })} />)
        expect(await screen.findByText('в подписке нет узлов')).toBeInTheDocument()
    })

    it('номер узла вне подписки — своя строка с двумя числами', async () => {
        // Снято с живого роутера: у выхода стоял `node: 31`, а в подписке было 29 узлов.
        // Движок писал «failed, total 0», и интерфейс говорил «в подписке нет узлов» — то
        // есть отправлял перекачивать подписку и менять поставщика там, где надо поправить
        // одно число. Оба числа обязаны быть на экране: порознь они ничего не значат.
        render(<OutboundsTab live={live({ status: status({ state: 'no_such_node', node: 31, total: 29 }) })} />)
        expect(await screen.findByText('узла 31 нет: их 29')).toBeInTheDocument()
        expect(screen.queryByText('в подписке нет узлов')).toBeNull()
        expect(screen.queryByText('ни один узел не ответил')).toBeNull()
    })

    it('и отклик у него не спрашивают: устройства нет', async () => {
        render(<OutboundsTab live={live({ status: status({ state: 'no_such_node', node: 31, total: 29 }) })} />)
        await screen.findByText('узла 31 нет: их 29')
        await waitFor(() => expect(rpc.engine).toHaveBeenCalled())
        expect(rpc.outboundGeo).not.toHaveBeenCalled()
    })

    it('и у «ни один не ответил» тоже не спрашивают, пока устройства нет', async () => {
        // Тот же довод: приговор вынесен, устройства нет, а запрос идёт ЧЕРЕЗ устройство —
        // значит он может только истечь по таймауту, отняв время у остальных выходов.
        render(<OutboundsTab live={live({ status: status({ state: 'failed', total: 26 }) })} />)
        await screen.findByText('ни один узел не ответил')
        await waitFor(() => expect(rpc.engine).toHaveBeenCalled())
        expect(rpc.outboundGeo).not.toHaveBeenCalled()
    })

    it('поля нет — прежний вид, а не догадка', async () => {
        // Движок старее интерфейса, состояние устарело, писавший процесс мёртв — всё это
        // «не знаем», и менять из-за этого приговор нельзя.
        render(<OutboundsTab live={live({ status: status(undefined) })} />)
        await waitFor(() => expect(rpc.outboundGeo).toHaveBeenCalled())
        expect(await screen.findByText('42 мс')).toBeInTheDocument()
    })

    it('поднятый выход про перебор не говорит', async () => {
        const up: Status = {
            schema: 1,
            outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: true } },
            channels: [],
        }
        render(<OutboundsTab live={live({ status: up })} />)
        await waitFor(() => expect(rpc.outboundGeo).toHaveBeenCalled())
        expect(screen.queryByText(/проверяю узлы/)).toBeNull()
    })
})
