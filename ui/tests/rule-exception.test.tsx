import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RulesTab from '@/components/tabs/RulesTab'
import { pending } from '@/lib/pending'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'

// Три вопроса из живых обращений, все про редактор правил.
//
// R-020 (splify2#3, «у меня Spotify без VPN работает лучше»). Исключение в продукте есть с
// самого начала — это канал в выход direct, стоящий ВЫШЕ туннельных, потому что метку
// раздаёт первое совпадение. Нигде так не называется, поэтому его никто не находит. И
// главное: то же исключение, поставленное НИЖЕ туннельного канала, не срабатывает молча —
// интерфейс обязан это сказать, иначе шаблон выглядит сломанным.
//
// R-055 (splify2#12, «невозможно выбрать Warp0»). Человек ищет в правиле УСТРОЙСТВО, а
// правило ведёт в выход. Поднятый туннель, которого нет ни в одном выходе, должен быть
// назван здесь же — иначе вывод «второй туннель не поддерживается» ничем не опровергнут.
//
// R-011. Валидаторы lib/validate.ts не были подключены ни к одной форме: опечатка в адресе
// не отвергается, а молча выпадает при сборке наборов nft.

const X = '/etc/steer/lists/spotify.lst'

const DEVS = [
    { name: 'awg0', up: true, kind: 'wireguard' },
    { name: 'warp0', up: true, kind: 'wireguard' },
]

const AWG = { name: 'awg', kind: 'interface' as const, devices: ['awg0'], on_fail: 'drop' as const }
const DIRECT = { name: 'direct', kind: 'direct' as const }

function spec(outputs: Record<string, unknown>, channels: unknown[]) {
    return { schema: 1, outputs, channels }
}

/** Спека и Live-снимок с одинаковыми выходами: движок уже применил то, что в спеке. */
function mount(s: ReturnType<typeof spec>) {
    vi.spyOn(rpc, 'specGet').mockResolvedValue(s as never)
    vi.spyOn(rpc, 'appliedGet').mockResolvedValue(s as never)
    return render(<RulesTab live={live({ status: { outputs: s.outputs } as never })} />)
}

// Ждём заголовок блока, а не строку с номером правила: строка с номером сама проверяется
// ниже, и опираться на неё в открывалке значило бы, что все проверки падают в одном месте.
async function openRule(n: number) {
    const edit = await screen.findAllByLabelText('Изменить правило')
    fireEvent.click(edit[n])
    await screen.findByText('Куда — пул VPN')
}

beforeEach(() => {
    vi.restoreAllMocks()
    // Хранилище неприменённого — модульный синглтон: без сброса второй тест работает со
    // спекой первого.
    pending.saved = null
    pending.applied = null
    pending.dirty = false
    vi.spyOn(rpc, 'manifest').mockResolvedValue({} as never)
    vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: {} })
    vi.spyOn(rpc, 'leases').mockResolvedValue({ leases: [] })
    vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: DEVS })
    vi.spyOn(rpc, 'specSet').mockResolvedValue({ ok: true })
})

describe('шаблон «Исключение» (R-020)', () => {
    it('заводит правило в direct и ставит его ВЫШЕ туннельного', async () => {
        mount(spec({ awg: AWG }, [{ name: 'весь трафик', out: 'awg', match: { any: true } }]))
        fireEvent.click(await screen.findByRole('button', { name: 'Исключение' }))

        // Открылось сразу и на первом месте: место в очереди и есть весь механизм.
        expect(await screen.findByText('Правило 1 из 2')).toBeInTheDocument()
        expect(screen.getByText(/Это исключение/)).toBeInTheDocument()

        // Выход direct заведён здесь же — иначе шаблон был бы инструкцией из двух шагов.
        expect(screen.getByText('мимо туннеля')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Все правила'))
        const rows = await screen.findAllByRole('row')
        expect(rows[1].textContent).toContain('исключение')
        expect(rows[2].textContent).toContain('весь трафик')
    })

    it('исключение НИЖЕ туннельного правила с теми же записями — говорит, что не сработает', async () => {
        mount(
            spec({ awg: AWG, direct: DIRECT }, [
                { name: 'через VPN', out: 'awg', match: { prefixes_files: [X] } },
                { name: 'исключение', out: 'direct', match: { prefixes_files: [X] } },
            ]),
        )
        await openRule(1)
        const warn = await screen.findByText(/Исключение перекрыто/)
        expect(warn.textContent).toContain('через VPN')
    })

    it('то же исключение выше туннельного — предупреждения нет', async () => {
        mount(
            spec({ awg: AWG, direct: DIRECT }, [
                { name: 'исключение', out: 'direct', match: { prefixes_files: [X] } },
                { name: 'через VPN', out: 'awg', match: { prefixes_files: [X] } },
            ]),
        )
        await openRule(0)
        expect(screen.getByText(/Это исключение/)).toBeInTheDocument()
        expect(screen.queryByText(/Исключение перекрыто/)).not.toBeInTheDocument()
    })

    it('выключенное туннельное правило выше исключение не перекрывает', async () => {
        mount(
            spec({ awg: AWG, direct: DIRECT }, [
                { name: 'через VPN', out: 'awg', enabled: false, match: { prefixes_files: [X] } },
                { name: 'исключение', out: 'direct', match: { prefixes_files: [X] } },
            ]),
        )
        await openRule(1)
        expect(screen.queryByText(/Исключение перекрыто/)).not.toBeInTheDocument()
    })
})

describe('поднятый туннель без выхода (R-055)', () => {
    it('называется в блоке «Куда — пул VPN», пока туннельный выход один', async () => {
        mount(spec({ awg: AWG }, [{ name: 'правило1', out: 'awg', match: {} }]))
        await openRule(0)
        expect(await screen.findByText(/Туннель warp0 поднят/)).toBeInTheDocument()
        // Занятое устройство подсказкой не становится.
        expect(screen.queryByText(/Туннель awg0 поднят/)).not.toBeInTheDocument()
    })

    it('выходов два и больше — молчит: свободное устройство там уже осознанный запас', async () => {
        mount(
            spec(
                {
                    awg: AWG,
                    second: { name: 'second', kind: 'interface', devices: [], on_fail: 'drop' },
                },
                [{ name: 'правило1', out: 'awg', match: {} }],
            ),
        )
        await openRule(0)
        await waitFor(() => expect(rpc.devices).toHaveBeenCalled())
        expect(screen.queryByText(/Туннель warp0 поднят/)).not.toBeInTheDocument()
    })

    it('опущенный туннель не предлагается — это не свидетельство намерения', async () => {
        vi.spyOn(rpc, 'devices').mockResolvedValue({
            devices: [DEVS[0], { name: 'warp0', up: false, kind: 'wireguard' }],
        })
        mount(spec({ awg: AWG }, [{ name: 'правило1', out: 'awg', match: {} }]))
        await openRule(0)
        await waitFor(() => expect(rpc.devices).toHaveBeenCalled())
        expect(screen.queryByText(/Туннель warp0 поднят/)).not.toBeInTheDocument()
    })
})

describe('адреса в «Кого касается» проверяются у поля (R-011)', () => {
    async function fromField(value: string) {
        mount(spec({ awg: AWG }, [{ name: 'правило1', out: 'awg', match: {} }]))
        await openRule(0)
        fireEvent.click(screen.getByText('Только выбранные'))
        const input = await screen.findByPlaceholderText(/192.168.1.50/)
        fireEvent.input(input, { target: { value } })
        return input
    }

    it('мусор назван по имени, а не принят молча', async () => {
        await fromField('192.168.1.500, 10.0.0.0/48')
        const msg = await screen.findByText(/Не адрес и не MAC/)
        expect(msg.textContent).toContain('192.168.1.500')
        expect(msg.textContent).toContain('10.0.0.0/48')
    })

    // По одному вводу на проверку: второй mount в том же тесте оставил бы в jsdom две
    // вкладки сразу, и запрос находил бы разметку первой.
    it('адрес и подсеть проходят', async () => {
        await fromField('192.168.1.50, 192.168.1.0/24')
        await waitFor(() => expect(screen.queryByText(/Не адрес и не MAC/)).not.toBeInTheDocument())
    })

    it('MAC проходит', async () => {
        await fromField('aa:bb:cc:dd:ee:ff')
        await waitFor(() => expect(screen.queryByText(/Не адрес и не MAC/)).not.toBeInTheDocument())
    })

    it('недописанный MAC не проходит: он совпадает с «есть двоеточие», но ни с одним пакетом', async () => {
        await fromField('aa:bb:cc')
        expect(await screen.findByText(/Не адрес и не MAC/)).toBeInTheDocument()
    })
})
