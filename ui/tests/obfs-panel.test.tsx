import { render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import ObfsPanel from '@/components/ObfsPanel'
import type { Output } from '@/lib/model'

// «WireGuard поверх TCP»: обфускация транспорта у выхода kind=interface.
//
// Проверяется не вёрстка, а те два места, где ошибка молчалива и дорога:
//
//   1. локальный адрес не спрашивается и всегда 127.0.0.1 — на этот порт приходит
//      трафик, ещё не зашифрованный WireGuard'ом, и выставить его в сеть нельзя;
//   2. имя вместо адреса отвергается ДО сохранения — движок имена не разрешает
//      (резолвить пришлось бы через DNS, который сам может идти в этот туннель),
//      и без ранней подсказки человек получил бы отказ движка после «Применить».

const IFACE: Output = { name: 'wg', kind: 'interface', devices: ['wg0'], on_fail: 'drop' }
const WITH_OBFS: Output = {
    ...IFACE,
    obfs: { mode: 'wg-over-tcp', server: '203.0.113.10:4567', listen: '127.0.0.1:51820' },
}

describe('обфускация транспорта', () => {
    it('по умолчанию выключена и полей не показывает', () => {
        render(<ObfsPanel output={IFACE} onChange={() => {}} />)
        expect(screen.getByLabelText('WireGuard поверх TCP')).not.toBeChecked()
        expect(screen.queryByLabelText('Адрес сервера обфускации')).toBeNull()
    })

    it('включённая показывает адрес и порты из спеки', () => {
        render(<ObfsPanel output={WITH_OBFS} onChange={() => {}} />)
        expect(screen.getByLabelText('WireGuard поверх TCP')).toBeChecked()
        expect(screen.getByLabelText('Адрес сервера обфускации')).toHaveValue('203.0.113.10')
        expect(screen.getByLabelText('Порт сервера обфускации')).toHaveValue('4567')
        expect(screen.getByLabelText('Локальный порт обфускатора')).toHaveValue('51820')
    })

    it('локальный адрес не спрашивается: у него один правильный ответ', () => {
        render(<ObfsPanel output={WITH_OBFS} onChange={() => {}} />)
        expect(screen.queryByLabelText(/Локальный адрес/)).toBeNull()
        expect(screen.getByText(/127\.0\.0\.1:51820/)).toBeInTheDocument()
    })

    it('выключение убирает obfs из выхода целиком, а не оставляет пустой', () => {
        const onChange = vi.fn()
        render(<ObfsPanel output={WITH_OBFS} onChange={onChange} />)
        screen.getByLabelText('WireGuard поверх TCP').click()
        expect(onChange).toHaveBeenCalled()
        const next = onChange.mock.calls[0][0] as Output
        expect('obfs' in next).toBe(false)
    })

    it('имя вместо адреса объясняется до сохранения', () => {
        const named: Output = {
            ...IFACE,
            obfs: { mode: 'wg-over-tcp', server: 'vpn.example.com:4567', listen: '127.0.0.1:51820' },
        }
        render(<ObfsPanel output={named} onChange={() => {}} />)
        expect(screen.getByText(/Нужен адрес, а не имя/)).toBeInTheDocument()
    })

    it('говорит про Endpoint пира: это единственное место, где две настройки знают друг о друге', () => {
        render(<ObfsPanel output={WITH_OBFS} onChange={() => {}} />)
        expect(screen.getByText(/Endpoint/)).toBeInTheDocument()
    })
})
