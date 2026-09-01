import { render, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RulesTab from '@/components/tabs/RulesTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { type ServiceEntry, type Spec } from '@/lib/model'
import { live } from './fixtures'

// I-018: эффекты «просьба извне» писали в spec, от которого сами же зависят.
//
// Оба эффекта раздела — «завести правило для записи каталога» (wanted) и «завести пустое
// правило» (addNow) — заканчиваются вызовом edit(), то есть setSpec. spec стоит у них в
// зависимостях, значит эффект просыпается ещё раз на своей же записи. Единственное, что
// удерживало от второго правила, — гашение признака оболочкой: onWantedUsed / onAddUsed
// возвращают наверх, и там признак снимают.
//
// То есть верность держалась на ЧУЖОМ и притом асинхронном шаге. Оболочка гасит признак
// своим setState, и попади её перерисовка после нашей — просьба исполнится дважды: два
// одинаковых правила, второе поверх первого, и человек удаляет лишнее руками. В Preact на
// сегодняшней раскладке это не воспроизводится, но конструкция ломается от смены рантайма,
// от StrictMode и от любой правки порядка обновлений — то есть от того, чего в этом файле
// не видно вовсе.
//
// Стенд поэтому НЕ гасит признак: он проверяет само свойство «одна просьба — одно правило»,
// а не то, успевает ли оболочка. onWantedUsed передан пустышкой намеренно.

const OUT = { name: 'awg', kind: 'interface' as const, devices: ['awg0'], on_fail: 'drop' as const }
const BASE: Spec = { schema: 1, outputs: { awg: OUT }, channels: [] } as unknown as Spec

const ENTRY: ServiceEntry = {
    id: 'yt',
    name: 'YouTube',
    prefixes: ['youtube.lst'],
    domains: [],
} as unknown as ServiceEntry

function mount(props: Record<string, unknown>) {
    vi.spyOn(rpc, 'manifest').mockResolvedValue({} as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: {} } as never)
    vi.spyOn(pending, 'load').mockResolvedValue(BASE as never)
    const edits: Spec[] = []
    vi.spyOn(pending, 'edit').mockImplementation(((s: Spec) => { edits.push(s) }) as never)
    render(<RulesTab live={live({ status: { outputs: BASE.outputs } as never })} {...props} />)
    return edits
}

describe('просьба извне исполняется один раз', () => {
    beforeEach(() => { vi.restoreAllMocks() })

    it('запись каталога заводит РОВНО одно правило, даже если признак не погасили', async () => {
        const edits = mount({ wanted: ENTRY, onWantedUsed: () => {} })
        await waitFor(() => expect(edits.length).toBeGreaterThan(0))
        // Немного времени на лишние витки эффекта: они и есть находка.
        await new Promise((r) => setTimeout(r, 50))
        const last = edits[edits.length - 1]
        expect(last.channels.length).toBe(1)
        expect(edits.length).toBe(1)
    })

    it('«Добавить правило» с главной заводит РОВНО одно правило', async () => {
        const edits = mount({ addNow: true, onAddUsed: () => {} })
        await waitFor(() => expect(edits.length).toBeGreaterThan(0))
        await new Promise((r) => setTimeout(r, 50))
        const last = edits[edits.length - 1]
        expect(last.channels.length).toBe(1)
        expect(edits.length).toBe(1)
    })
})
