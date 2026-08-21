import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import SelfUpdateCard from '@/components/SelfUpdateCard'
import { rpc } from '@/lib/rpc'

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

// Отдельно — про слова установщика. post-install пакета печатает единственное, чего
// интерфейс знать не может: что netifd держит прежний набор опций протокола и новые не
// действуют до `/etc/init.d/network restart`. Печатает он это в stdout менеджера пакетов,
// то есть в поле `output` ответа; пока поле выбрасывалось, просьба существовала только для
// того, кто ставит пакет по ssh.
describe('сказанное установщиком', () => {
    const info = { current: '0.7.6', versions: ['0.7.7'] }

    it('показывается на экране, а не всплывашкой (её бы не дождались)', async () => {
        vi.spyOn(rpc, 'splify2Install').mockResolvedValue({
            ok: true,
            installed: 'luci-app-splify2-0.7.7-1_all.ipk',
            output: 'splify2: набор опций протокола xsteer изменился.\n    /etc/init.d/network restart',
        })
        render(<SelfUpdateCard info={info} onInstalled={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Обновить до 0.7.7' }))
        await waitFor(() => expect(screen.getByText(/Установщик сказал/)).toBeInTheDocument())
        expect(screen.getByText(/init\.d\/network restart/)).toBeInTheDocument()
    })

    it('на штатной установке блока нет: сказать нечего', async () => {
        vi.spyOn(rpc, 'splify2Install').mockResolvedValue({
            ok: true,
            installed: 'luci-app-splify2-0.7.7-1_all.ipk',
            output: '',
        })
        render(<SelfUpdateCard info={info} onInstalled={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Обновить до 0.7.7' }))
        await waitFor(() => expect(rpc.splify2Install).toHaveBeenCalled())
        expect(screen.queryByText(/Установщик сказал/)).toBeNull()
    })
})
