import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Doh from '@/components/sections/Doh'
import { rpc } from '@/lib/rpc'
import { type Live } from '@/lib/live'

// DoH — первая ступень обхода, а не «дополнительная настройка»: провайдер видит имена сайтов
// раньше всего остального, и по DNS же и блокирует, подменяя ответ. Поэтому здесь сторожатся
// не оформление, а три свойства, каждое из которых уже было бы поломкой:
//
//   1. Чужой резолвер (вписан руками, взят из версии менеджера новее нашей) показывается
//      СВОЕЙ ССЫЛКОЙ, а не как «не настроено»: иначе выбор кажется потерянным.
//   2. Про force_dns сказано вслух там, где у движка есть свой резолвер доменных каналов.
//      Два перенаправления порта 53 в одной точке дают гонку, и проигравший резолвер молча
//      перестаёт видеть запросы — правила по доменам действуют «через раз».
//   3. «DoH через туннель» назван тем, чем он является: правилом для САМОГО РОУТЕРА.

const live = { status: undefined } as unknown as Live

const base = {
    installed: true,
    running: true,
    enabled: true,
    active: 'cloudflare',
    urls: ['https://cloudflare-dns.com/dns-query'],
    providers: [
        { id: 'default', title: 'По умолчанию (Cloudflare + Google)' },
        { id: 'cloudflare', title: 'Cloudflare' },
        { id: 'comss', title: 'Comss.one' },
    ],
    via_tunnel: false,
    out: 'vless',
    needs_dnsd: false,
    force_dns: '1',
}

describe('вкладка DoH', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        document.body.innerHTML = ''
    })

    it('без пакета говорит про пакет, а не показывает пустой список', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue({ ...base, installed: false, active: '', urls: [] })
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText(/https-dns-proxy не установлен/)).toBeInTheDocument())
    })

    it('выбранный резолвер отмечен', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue(base)
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText('Cloudflare')).toBeInTheDocument())
        // Отметка — на кнопке выбранного пункта, и она одна: две отметки означали бы, что
        // сравнение идёт по одной ссылке, а у пункта «по умолчанию» их две.
        const marks = document.querySelectorAll('[data-icon="Check"]')
        expect(marks.length).toBe(1)
    })

    it('выбор уезжает на роутер и состояние перечитывается', async () => {
        const state = vi.spyOn(rpc, 'dohState').mockResolvedValue(base)
        const set = vi.spyOn(rpc, 'dohSet').mockResolvedValue({ ok: true, active: 'comss' })
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText('Comss.one')).toBeInTheDocument())
        fireEvent.click(screen.getByText('Comss.one'))
        await waitFor(() => expect(set).toHaveBeenCalledWith('comss'))
        // Перечитывание обязательно: force_dns и активный пункт считает бэкенд, и рисовать
        // вместо них своё представление значило бы показать не то, что стоит на роутере.
        await waitFor(() => expect(state.mock.calls.length).toBeGreaterThan(1))
    })

    it('отказ показывается, а не проглатывается', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue(base)
        vi.spyOn(rpc, 'dohSet').mockResolvedValue({ ok: false, error: 'нет такого резолвера в каталоге' })
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText('Comss.one')).toBeInTheDocument())
        fireEvent.click(screen.getByText('Comss.one'))
        await waitFor(() =>
            expect(screen.getByText(/нет такого резолвера в каталоге/)).toBeInTheDocument())
    })

    it('чужая ссылка показывается ссылкой, а не «не настроено»', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue({
            ...base, active: '', urls: ['https://dns.example/dns-query'],
        })
        render(<Doh live={live} />)
        await waitFor(() =>
            expect(screen.getByText(/dns\.example/)).toBeInTheDocument())
    })

    it('про force_dns сказано, когда движку нужен свой резолвер', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue({ ...base, needs_dnsd: true, force_dns: '0' })
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText(/force_dns = 0/)).toBeInTheDocument())
    })

    it('и НЕ сказано, когда доменных правил нет — лишнее предупреждение учит не читать их', async () => {
        vi.spyOn(rpc, 'dohState').mockResolvedValue(base)
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByText('Cloudflare')).toBeInTheDocument())
        expect(screen.queryByText(/force_dns/)).toBeNull()
    })

    it('туннель включается и называет выход', async () => {
        vi.spyOn(rpc, 'dohState')
            .mockResolvedValueOnce(base)
            .mockResolvedValue({ ...base, via_tunnel: true })
        const set = vi.spyOn(rpc, 'dohTunnelSet').mockResolvedValue({ ok: true, on: true, out: 'vless' })
        render(<Doh live={live} />)
        await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(set).toHaveBeenCalledWith(true))
        await waitFor(() => expect(screen.getByText(/идут через выход/)).toBeInTheDocument())
    })

    it('сказано, что туннель касается только роутера', async () => {
        // Тот же довод, что у фикса Zapret Manager: правило живёт в цепочке output, то есть
        // трафика устройств сети не касается вовсе, и человек должен это видеть.
        vi.spyOn(rpc, 'dohState').mockResolvedValue({ ...base, via_tunnel: true })
        render(<Doh live={live} />)
        await waitFor(() =>
            expect(screen.getByText(/только самого роутера/)).toBeInTheDocument())
    })
})
