import { render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import Rail from '@/components/Rail'
import { live } from './fixtures'
import { rpc } from '@/lib/rpc'

// R-017: «жизненно необходима кнопка Остановить, причём всё — и сервис, и движок»
// (публичный тест, splify2#4 п.5). До неё вернуть роутер в состояние «как будто не
// установлено» можно было только по ssh.
//
// Решение владельца: stop + disable, то есть перезагрузка состояние не возвращает.
// Значит обратное действие обязано быть рядом, и подпись обязана читать состояние —
// снятый автозапуск сам не вернётся, и «Остановить» на остановленном движке было бы
// кнопкой в никуда.

const noop = () => {}

/** Тумблер живёт в подвале рельса: он про роутер целиком, а не про раздел, и человек ищет
 *  его тогда же, когда смотрит «работает ли». Прежде он стоял в закреплённой колонке. */
const rail = (l: Parameters<typeof Rail>[0]['live']) => (
    <Rail live={l} section="overview" onSection={noop} counts={{}} />
)
const RUNNING = { present: true, vless: true, version: '0.9.6', enabled: true, running: true }
const STOPPED = { present: true, vless: true, version: '0.9.6', enabled: false, running: false }

describe('остановить всё', () => {
    it('на работающем движке предлагает остановить (R-017)', () => {
        render(rail(live({ build: RUNNING })))
        expect(screen.getByRole('button', { name: /Остановить всё/ })).toBeInTheDocument()
    })

    it('на остановленном предлагает запустить (R-017)', () => {
        render(rail(live({ build: STOPPED })))
        expect(screen.getByRole('button', { name: /Запустить/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Остановить всё/ })).toBeNull()
    })

    it('говорит словами, что автозапуск снят (R-017)', () => {
        render(rail(live({ build: STOPPED })))
        expect(screen.getByText(/автозапуск снят|перезагрузк/i)).toBeInTheDocument()
    })

    it('без движка тумблера нет вовсе', () => {
        render(rail(live({ build: { present: false, vless: false } })))
        expect(screen.queryByRole('button', { name: /Остановить всё|Запустить/ })).toBeNull()
    })

    it('остановка спрашивает подтверждение и без него ничего не делает (R-017)', async () => {
        const stop = vi.spyOn(rpc, 'engineStop').mockResolvedValue({ ok: true, enabled: false, running: false })
        render(rail(live({ build: RUNNING })))

        screen.getByRole('button', { name: /Остановить всё/ }).click()
        // Диалог появился, но подтверждения не было — значит движок трогать нельзя.
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
        expect(stop).not.toHaveBeenCalled()
        stop.mockRestore()
    })
})
