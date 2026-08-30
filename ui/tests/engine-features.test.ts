import { describe, expect, it } from 'vitest'
import { poolsSupported } from '@/lib/engine'
import type { Status } from '@/lib/model'

// Откуда интерфейс знает, что установленный движок понимает смешанный пул.
//
// Признак был косвенный: поле `nodes` у выхода kind=vless — движок постарше не печатает его
// вовсе. Беда в том, что на роутере без единого выхода подписки признака нет ни одного, а
// смешанный пул нужнее всего именно там: xsteer плюс wireguard. Там же и цена ошибки самая
// высокая — движок постарше принимает такую спеку МОЛЧА (незнакомых ключей в ней нет вовсе,
// она дословно совпадает с законной старой), проверяет локацию подписки пингом, которого через
// неё не бывает, и при on_fail=drop уводит канал в blackhole.
//
// steer 1.3.0 отвечает прямо: перечень умений верхним уровнем status. Здесь проверяется, что
// прямой ответ спрашивается первым, а косвенный остался для движков постарше.

const st = (s: Partial<Status>): Status =>
    ({ schema: 1, outputs: {}, channels: [], ...s }) as Status

describe('poolsSupported: поколение движка', () => {
    it('перечень умений называет pool — умеет, даже когда выхода подписки нет вовсе', () => {
        expect(
            poolsSupported(st({ features: ['lan_devices', 'nodes', 'pool', 'active_device'] })),
        ).toBe(true)
    })

    it('перечень есть, а pool в нём нет — не умеет, и косвенный признак не спорит', () => {
        expect(
            poolsSupported(
                st({
                    features: ['lan_devices'],
                    outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: true, nodes: [] } },
                } as Partial<Status>),
            ),
        ).toBe(false)
    })

    it('перечня нет (движок до 1.3.0): отвечает поле nodes у выхода подписки', () => {
        expect(
            poolsSupported(
                st({
                    outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: true, nodes: [] } },
                } as Partial<Status>),
            ),
        ).toBe(true)
        expect(
            poolsSupported(
                st({ outputs: { vl: { name: 'vl', kind: 'vless', device: 'vl', up: true } } } as Partial<Status>),
            ),
        ).toBe(false)
    })

    // Спросить нечем — отвечаем «не умеет». Цена ошибки несимметрична: сказав «умеет» зря, мы
    // дадим собрать пул, который молча повезёт трафик не туда; сказав «не умеет» зря, мы всего
    // лишь не покажем выбор.
    it('перечня нет и выхода подписки нет — не умеет', () => {
        expect(
            poolsSupported(
                st({ outputs: { wg: { name: 'wg', kind: 'interface', device: 'wg0', up: true } } } as Partial<Status>),
            ),
        ).toBe(false)
        expect(poolsSupported(null)).toBe(false)
    })
})
