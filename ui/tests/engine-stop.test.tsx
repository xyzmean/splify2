import { render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import StatusRail from '@/components/StatusRail'
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
const RUNNING = { present: true, vless: true, version: '0.9.6', enabled: true, running: true }
const STOPPED = { present: true, vless: true, version: '0.9.6', enabled: false, running: false }

describe('остановить всё', () => {
    it('на работающем движке предлагает остановить (R-017)', () => {
        render(<StatusRail live={live({ build: RUNNING })} onGoDiag={noop} />)
        expect(screen.getByRole('button', { name: /Остановить всё/ })).toBeInTheDocument()
    })

    it('на остановленном предлагает запустить (R-017)', () => {
        render(<StatusRail live={live({ build: STOPPED })} onGoDiag={noop} />)
        expect(screen.getByRole('button', { name: /Запустить/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Остановить всё/ })).toBeNull()
    })

    it('говорит словами, что автозапуск снят (R-017)', () => {
        render(<StatusRail live={live({ build: STOPPED })} onGoDiag={noop} />)
        expect(screen.getByText(/автозапуск снят|перезагрузк/i)).toBeInTheDocument()
    })

    it('без движка тумблера нет вовсе', () => {
        render(<StatusRail live={live({ build: { present: false, vless: false } })} onGoDiag={noop} />)
        expect(screen.queryByRole('button', { name: /Остановить всё|Запустить/ })).toBeNull()
    })

    it('остановка спрашивает подтверждение и без него ничего не делает (R-017)', async () => {
        const stop = vi.spyOn(rpc, 'engineStop').mockResolvedValue({ ok: true, enabled: false, running: false })
        render(<StatusRail live={live({ build: RUNNING })} onGoDiag={noop} />)

        screen.getByRole('button', { name: /Остановить всё/ }).click()
        // Диалог появился, но подтверждения не было — значит движок трогать нельзя.
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
        expect(stop).not.toHaveBeenCalled()
        stop.mockRestore()
    })
})
