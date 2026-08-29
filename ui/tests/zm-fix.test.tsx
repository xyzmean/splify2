import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ZmFixCard from '@/components/ZmFixCard'
import { rpc } from '@/lib/rpc'

// Zapret Manager ставится и обновляется с GitHub, а у аудитории splify2 GitHub закрыт: человек
// упирается в это раньше, чем успевает что-нибудь настроить. Поэтому адреса GitHub уводятся в
// туннель сами, а переключатель — потому что правило появляется в ЕГО правилах, и он вправе
// его не хотеть.
//
// Главное свойство, которое здесь и сторожится: по умолчанию включено. Выключенным по
// умолчанию фикс не нужен никому — тот, кто знает про него, знает и как завести правило сам.

describe('фикс Zapret Manager', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('включён по умолчанию', async () => {
        vi.spyOn(rpc, 'zmFix').mockResolvedValue({ on: true, channel: 'zm_github' })
        render(<ZmFixCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    })

    it('старый бэкенд без этого поля считается включённым, а не выключенным', async () => {
        // Ответ без `on` — это «метода не знаю», а не «выключено». Выключенным по умолчанию
        // фикс не помог бы тем, ради кого сделан.
        vi.spyOn(rpc, 'zmFix').mockResolvedValue({})
        render(<ZmFixCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    })

    it('выключение уезжает на роутер', async () => {
        vi.spyOn(rpc, 'zmFix').mockResolvedValue({ on: true })
        const set = vi.spyOn(rpc, 'zmFixSet').mockResolvedValue({ ok: true, on: false })
        render(<ZmFixCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(false))
    })

    it('отказ записи возвращает прежнее положение', async () => {
        vi.spyOn(rpc, 'zmFix').mockResolvedValue({ on: true })
        vi.spyOn(rpc, 'zmFixSet').mockResolvedValue({ ok: false, error: 'нужно true или false' })
        render(<ZmFixCard />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(screen.getByText(/нужно true или false/)).toBeInTheDocument())
        expect(screen.getByRole('switch')).toBeChecked()
    })

    it('сказано, что фикс касается только роутера', async () => {
        // Это главное свойство новой версии: в 1.2.3 фикс распространялся на устройства сети
        // и висел в правилах. Человек должен видеть, что теперь это не так.
        vi.spyOn(rpc, 'zmFix').mockResolvedValue({ on: true })
        render(<ZmFixCard />)
        await waitFor(() => expect(screen.getByText(/только самого роутера/)).toBeInTheDocument())
    })
})
