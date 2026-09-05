import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Проверка СОБРАННОГО бандла, а не исходников.
 *
 *  ЗАЧЕМ ОТДЕЛЬНЫЙ СТЕНД НА dist. На роутере разделы VPN и «Настройки» открывались и через
 *  мгновение гасли — на их месте снова оказывалась главная. Исходниками это не
 *  воспроизводилось вовсе, и не могло: причина живёт в РАЗБИЕНИИ НА КУСКИ. Ленивый кусок
 *  раздела импортирует общие модули из точки входа, ссылка внутри куска несёт свой `?v=`, и
 *  при расхождении адреса браузер заводит второй экземпляр точки входа. Тот при исполнении
 *  монтировал приложение заново поверх живого — состояние раздела при этом сбрасывалось на
 *  начальное.
 *
 *  Барьер грузит ровно то, что уезжает на роутер, монтирует и ходит по разделам. Без сборки
 *  проверять нечего — тогда стенд пропускается.
 *
 *  ПОЧЕМУ ПУТЬ К БАНДЛУ ИДЁТ ПЕРЕМЕННОЙ, А НЕ СТРОКОЙ В import(). Пропуск ниже — РАЗБОРА
 *  ВРЕМЕНИ ИСПОЛНЕНИЯ, а vite:import-analysis разрешает адреса на ПРЕОБРАЗОВАНИИ файла, то
 *  есть раньше, чем исполнится хоть одна строка. Со строковым литералом файл не преобразуется
 *  вовсе («Failed to resolve import ../dist/splify-index.js»), skipIf не получает хода, и
 *  весь ui-harness краснеет на чистой выкачке — там, где обещан пропуск. Переменная плюс
 *  @vite-ignore уводят разрешение в исполнение, где файл уже либо есть, либо стенд пропущен. */

/** jsdom подменяет базовый адрес модуля на http://localhost, поэтому путь считается от
 *  корня проекта, а не от import.meta.url. */
const DIST = join(process.cwd(), 'dist', 'splify-index.js')

const SPEC = {
    schema: 1,
    outputs: {
        vpn: { name: 'vpn', kind: 'interface', device: 'wg0', devices: ['wg0'], on_fail: 'drop' },
        vl: { name: 'vl', kind: 'vless', sub_file: '/etc/steer/sub.txt', node: -1, on_fail: 'drop' },
    },
    channels: [{ name: 'youtube', out: 'vpn', match: { domains_files: ['a.lst'] } }],
}

const ANSWER: Record<string, unknown> = {
    status: {
        schema: 1,
        outputs: {
            vpn: { name: 'vpn', kind: 'interface', device: 'wg0', devices: ['wg0'], up: true },
            vl: { name: 'vl', kind: 'vless', device: 'steer0', up: true },
        },
        channels: [{ name: 'youtube', out: 'vpn', live: true, bytes: 1024 }],
    },
    spec_get: SPEC,
    applied_get: SPEC,
    diag: { checks: [], warn: 0, fail: 0 },
    net_info: { uptime: 60, active_clients: 2 },
    engine: { present: true, vless: true, version: '1.2.3', enabled: true, running: true },
    devices: { devices: [{ name: 'wg0', up: true, kind: 'wireguard' }] },
    dev_stats: { devices: {} },
    engine_state: { instances: {}, log: [] },
    local_lists: { files: {} },
    lists: { categories: [], services: [] },
    sub_info: { kind: 'url', path: '/etc/steer/sub.txt', present: true },
    client_nets: { nets: [] },
    leases: { leases: [] },
    vless_nodes: { output: 'vl', sub_file: '', node: -1, usable: 0, skipped: 0, foreign: 0, nodes: [] },
    outbound_probe: { output: '', state: 'ok', ms: 42, how: 'ping' },
    outbound_geo: { output: '', cc: 'NL', ip: '1.2.3.4' },
    zm_fix: { on: false },
    fetch_mode: { mode: 'auto', out: '' },
    steer_versions: { arch: 'x', versions: [] },
    splify2_versions: { current: '1.2.5', versions: [] },
}

describe.skipIf(!existsSync(DIST))('собранный бандл', () => {
    it('разделы открываются и не гаснут', async () => {
        const errors: unknown[] = []
        window.addEventListener('error', (e) => errors.push((e as ErrorEvent).error))
        window.addEventListener('unhandledrejection', (e) => errors.push((e as PromiseRejectionEvent).reason))
        const realError = console.error
        console.error = (...a: unknown[]) => { errors.push(a[0]); realError(...a) }
        ;(window as never as Record<string, unknown>).luci_rpc = {
            declare: (o: { method: string }) => () =>
                Promise.resolve(ANSWER[o.method] ?? {}),
        }
        const root = document.createElement('div')
        root.id = 'splify-root'
        root.className = 'splify-react-root'
        document.body.appendChild(root)

        await import(/* @vite-ignore */ DIST)
        const mount = (window as never as Record<string, (el: Element) => void>).__splifyMount
        mount(root)
        await new Promise((r) => setTimeout(r, 250))
        expect(root.textContent).toMatch(/Маршрутизация работает|Загрузка/)

        const click = (re: RegExp) => {
            const b = [...root.querySelectorAll('button')].find((x) => re.test(x.textContent || ''))
            if (!b) throw new Error(`нет кнопки ${re}: ${root.textContent?.slice(0, 300)}`)
            b.click()
        }

        click(/^\s*VPN/)
        await new Promise((r) => setTimeout(r, 900))
        // Раздел обязан остаться открытым: именно здесь он гас и подменялся главной.
        expect(root.querySelector('main')?.textContent).toMatch(/VLESS/)
        expect(root.querySelector('main')?.textContent).not.toMatch(/Маршрутизация работает/)

        click(/^\s*Настройки/)
        await new Promise((r) => setTimeout(r, 900))
        console.log('SETTINGS:', root.querySelector('main')?.textContent?.slice(0, 400))
        click(/^\s*VPN/)
        await new Promise((r) => setTimeout(r, 40))
        console.log('AFTER 40ms:', root.querySelector('main')?.textContent?.slice(0, 120))
        console.log('ERRORS SO FAR:', errors.map((e) => String((e as Error)?.stack || e).slice(0, 300)))
        await new Promise((r) => setTimeout(r, 900))
        console.log('VPN AGAIN:', root.querySelector('main')?.textContent?.slice(0, 400))

        expect(errors).toEqual([])
    })
})
