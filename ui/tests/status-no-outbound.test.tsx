import { render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StatusRail from '@/components/StatusRail'
import { rpc } from '@/lib/rpc'
import { live } from './fixtures'
import type { Status } from '@/lib/model'

// R-064 (splify2#5, DenisDubinin1973): «поставил обе apk руками, интерфейс работает, правила
// есть, счётчики есть — а геосайты не открываются совсем». Причина одна из двух: выхода
// kind=interface нет ни одного, либо устройство, названное выходом, в системе отсутствует.
// В интерфейсе это состояние не было названо никак — настройка выглядела исправной, из
// которой просто не выходит ни один пакет.
//
// Здесь же проверяется вторая половина требования — что предупреждение НЕ становится ещё
// одним постоянным значком: при поднятом туннеле, при неизвестном списке устройств и до
// первого ответа движка колонка молчит.
//
// R-030 (I-039, splify2#4 п.2): «Что за совет?» — счётчик «советов: N» был вопросом, а не
// ответом. Последний тест проверяет, что строка несёт содержание и ведёт на диагностику.

const BUILD = { present: true, vless: true, version: '0.9.6', enabled: true, running: true }

/** Состояние движка с одним выходом. Имя выхода — КЛЮЧ, как в `steer status`. */
function status(outputs: Status['outputs']): Status {
    return { schema: 1, outputs, channels: [] }
}

/** Счётчики устройств из общего опроса: полный список интерфейсов системы. */
const devs = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { rx: '0', tx: '0' }]))

describe('«трафику некуда идти»: выходов нет или устройства нет в системе (R-064)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        // Отклик спрашивается при появлении выходов — без заглушки проверка ушла бы в
        // отказ ubus и утащила в вывод чужую ошибку.
        vi.spyOn(rpc, 'outboundProbe').mockResolvedValue({ ms: 12, state: 'ok' } as never)
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
    })

    it('выходов нет вовсе — говорит, что трафику некуда идти', async () => {
        render(
            <StatusRail
                live={live({ build: BUILD, status: status({}), devs: devs('br-lan', 'wan') })}
                onGoDiag={() => {}}
            />,
        )
        expect(await screen.findByText(/Трафику некуда идти/)).toBeInTheDocument()
        expect(screen.getByText(/Выходов нет/)).toBeInTheDocument()
    })

    it('единственный выход — direct: он трафик не уводит, значит выходов по-прежнему нет', async () => {
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({ home: { name: 'home', kind: 'direct' } }),
                    devs: devs('br-lan'),
                })}
                onGoDiag={() => {}}
            />,
        )
        expect(await screen.findByText(/Выходов нет/)).toBeInTheDocument()
    })

    it('устройства выхода нет в системе — называет и выход, и устройство', async () => {
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({ vpn: { name: 'vpn', kind: 'interface', devices: ['awg0'] } }),
                    devs: devs('br-lan', 'wan'),
                })}
                onGoDiag={() => {}}
            />,
        )
        // Смотрим внутрь самой карточки: имя выхода и устройства встречается и в списке
        // Outbounds выше, и совпадение там ничего не доказывало бы.
        const card = (await screen.findByText(/Трафику некуда идти/)).parentElement as HTMLElement
        expect(card).toHaveTextContent(/Выход vpn не поднят/)
        expect(card).toHaveTextContent(/awg0/)
        expect(card).toHaveTextContent(/нет в системе/)
    })

    it('выходу не назначено устройство — тоже названо словами', async () => {
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({ vpn: { name: 'vpn', kind: 'interface' } }),
                    devs: devs('br-lan'),
                })}
                onGoDiag={() => {}}
            />,
        )
        expect(await screen.findByText(/устройство ему не назначено/)).toBeInTheDocument()
    })

    it('устройство есть — предупреждения нет (не превращать в постоянный значок)', async () => {
        vi.spyOn(rpc, 'devices').mockResolvedValue({
            devices: [{ name: 'awg0', up: true, kind: 'wireguard' }],
        })
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({
                        vpn: { name: 'vpn', kind: 'interface', device: 'awg0', devices: ['awg0'], up: true },
                    }),
                    devs: devs('br-lan', 'awg0'),
                })}
                onGoDiag={() => {}}
            />,
        )
        await waitFor(() => expect(rpc.devices).toHaveBeenCalled())
        expect(screen.queryByText(/Трафику некуда идти/)).toBeNull()
    })

    it('устройство не туннельное, но в системе есть — молчим: «нет в системе» было бы неправдой', async () => {
        // rpc.devices() отбирает только туннельные устройства, поэтому мост в него не попадает.
        // Полный список интерфейсов (live.devs) о нём знает — и это тот случай, когда
        // предупреждение соврало бы.
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({ vpn: { name: 'vpn', kind: 'interface', devices: ['br-vpn'] } }),
                    devs: devs('br-lan', 'br-vpn'),
                })}
                onGoDiag={() => {}}
            />,
        )
        await waitFor(() => expect(rpc.devices).toHaveBeenCalled())
        expect(screen.queryByText(/Трафику некуда идти/)).toBeNull()
    })

    it('список устройств не получен — молчим, а не тревожим на исправном роутере', async () => {
        vi.spyOn(rpc, 'devices').mockRejectedValue(new Error('ubus is unavailable'))
        render(
            <StatusRail
                live={live({
                    build: BUILD,
                    status: status({ vpn: { name: 'vpn', kind: 'interface', devices: ['awg0'] } }),
                    devs: devs('br-lan'),
                })}
                onGoDiag={() => {}}
            />,
        )
        await waitFor(() => expect(rpc.devices).toHaveBeenCalled())
        expect(screen.queryByText(/Трафику некуда идти/)).toBeNull()
    })

    it('состояние ещё не пришло — пустой список выходов это «не знаем», а не «выходов нет»', () => {
        render(<StatusRail live={live({ build: BUILD })} onGoDiag={() => {}} />)
        expect(screen.queryByText(/Трафику некуда идти/)).toBeNull()
    })

    it('движок не отвечает — причина уже названа сверху, второй раз не пишем', () => {
        render(
            <StatusRail
                live={live({ build: BUILD, status: status({}), devs: devs('br-lan'), error: 'движок не ответил' })}
                onGoDiag={() => {}}
            />,
        )
        expect(screen.getByText(/движок не ответил/)).toBeInTheDocument()
        expect(screen.queryByText(/Трафику некуда идти/)).toBeNull()
    })
})

describe('совет виден содержанием и ведёт на диагностику (R-030, I-039)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(rpc, 'devices').mockResolvedValue({ devices: [] })
    })

    const DIAG = (n: number) => ({
        warn: 0,
        fail: 0,
        checks: Array.from({ length: n }, (_, i) => ({
            id: `note${i}`,
            verdict: 'note' as const,
            what: i === 0 ? 'клиент может обходить DNS роутера' : `совет номер ${i}`,
            why: 'браузер с DoH резолвит сам',
        })),
    })

    /** Один выход на месте: иначе сработала бы строка R-064 и тест смотрел бы не туда. */
    const OK = {
        build: BUILD,
        status: status({ vpn: { name: 'vpn', kind: 'interface' as const, device: 'awg0', devices: ['awg0'], up: true } }),
        devs: devs('awg0'),
    }

    it('единственный совет показан текстом, а не числом', () => {
        render(<StatusRail live={live({ ...OK, diag: DIAG(1) })} onGoDiag={() => {}} />)
        expect(screen.getByText(/клиент может обходить DNS роутера/)).toBeInTheDocument()
    })

    it('нажатие на строку совета уводит на диагностику', () => {
        const go = vi.fn()
        render(<StatusRail live={live({ ...OK, diag: DIAG(1) })} onGoDiag={go} />)
        screen.getByRole('button', { name: /клиент может обходить DNS роутера/ }).click()
        expect(go).toHaveBeenCalledTimes(1)
    })

    it('советов несколько — счётчик остаётся, но с первым советом рядом', () => {
        render(<StatusRail live={live({ ...OK, diag: DIAG(3) })} onGoDiag={() => {}} />)
        const line = screen.getByRole('button', { name: /советов: 3/ })
        expect(line).toHaveTextContent(/клиент может обходить DNS роутера/)
    })

    it('вердикт и цвет от совета не меняются', () => {
        render(<StatusRail live={live({ ...OK, diag: DIAG(2) })} onGoDiag={() => {}} />)
        expect(screen.getByRole('heading', { name: 'Работает' })).toBeInTheDocument()
    })

    it('советов нет — строки нет вовсе', () => {
        render(<StatusRail live={live({ ...OK, diag: { warn: 0, fail: 0, checks: [] } })} onGoDiag={() => {}} />)
        expect(screen.queryByText(/совет/)).toBeNull()
    })
})
