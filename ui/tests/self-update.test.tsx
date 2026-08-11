import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import SelfUpdateCard from '@/components/SelfUpdateCard'

// R-042: интерфейс не умел обновлять сам себя.
//
// Пакеты проекта не лежат в feeds OpenWrt, поэтому `apk upgrade` их не видит, и обновить
// luci-app-splify2 можно было только по ssh — при том что движок из интерфейса ставится
// с первого дня. Асимметрия заметная: обновлять умели то, что реже меняется.
//
// Подпись здесь считается тем же правилом, что и у движка (I-038): обещать обновление,
// которого нет, нельзя ни в одной из двух карточек.

const noop = () => {}

describe('обновление интерфейса', () => {
    it('на устаревшей версии называет, до чего обновит (R-042)', () => {
        render(<SelfUpdateCard info={{ current: '0.7.6', versions: ['0.7.7', '0.7.6'] }} onInstalled={noop} />)
        expect(screen.getByRole('button', { name: 'Обновить до 0.7.7' })).toBeInTheDocument()
    })

    it('на свежей не зовёт обновляться (R-042)', () => {
        render(<SelfUpdateCard info={{ current: '0.7.7', versions: ['0.7.7', '0.7.6'] }} onInstalled={noop} />)
        expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Переустановить' })).toBeInTheDocument()
    })

    it('показывает установленную версию (R-042)', () => {
        render(<SelfUpdateCard info={{ current: '0.7.6', versions: ['0.7.7'] }} onInstalled={noop} />)
        expect(screen.getByText(/0\.7\.6/)).toBeInTheDocument()
    })

    it('пока список не пришёл, ничего не обещает (R-042)', () => {
        render(<SelfUpdateCard info={null} onInstalled={noop} />)
        expect(screen.queryByRole('button', { name: /Обновить до/ })).toBeNull()
    })

    it('предупреждает, что страницу придётся перезагрузить (R-042)', () => {
        render(<SelfUpdateCard info={{ current: '0.7.6', versions: ['0.7.7'] }} onInstalled={noop} />)
        expect(screen.getByText(/перезагруз/i)).toBeInTheDocument()
    })
})
