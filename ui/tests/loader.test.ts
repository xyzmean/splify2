import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Загрузчик LuCI (luci/htdocs/luci-static/resources/view/splify2/home.js) — единственный наш
// код, который исполняется ДО бандла, и потому единственное место, где можно что-то сделать с
// задержкой открытия. Замерено на роутере: цепочка стояла ступеньками — загрузчик, потом
// build-id.txt (223 мс), потом бандл, потом его общий чанк (184 мс). Полторы секунды до первой
// строки нашего кода.
//
// Здесь проверяется, что ступенек больше нет: номер прошлой сборки помнится, бандл уходит в
// загрузку сразу, а build-id.txt лишь сверяется. И что расплата за это предусмотрена: если
// пакет обновили и номер разошёлся, правильная сборка всё равно подключается.
//
// Файл исполняется НАСТОЯЩИЙ. Он написан как модуль LuCI (`'require view'` сверху и `return`
// на верхнем уровне), поэтому оборачивается в функцию с заглушками вместо глобалей LuCI —
// тот же приём, что у стендов движка, включающих исходник.

const SRC = readFileSync(
    resolve(__dirname, '../../luci/htdocs/luci-static/resources/view/splify2/home.js'),
    'utf8',
)

type View = { load: () => Promise<string>; render: (id: string) => HTMLElement }

function loadView(): View {
    const view = { extend: (o: unknown) => o }
    const L = {
        resource: (p: string) => '/luci-static/resources/' + p,
        env: { rpctimeout: 20 },
    }
    const E = (tag: string, attrs: Record<string, string>) => {
        const el = document.createElement(tag)
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k === 'class' ? 'class' : k, v)
        return el
    }
    const fn = new Function('view', 'rpc', 'ui', 'L', 'E', SRC)
    return fn(view, {}, {}, L, E) as View
}

const scripts = () =>
    [...document.head.querySelectorAll('script[type=module]')].map((s) => s.getAttribute('src') || '')

describe('загрузчик: бандл уходит в загрузку, не дожидаясь build-id.txt', () => {
    beforeEach(() => {
        document.head.innerHTML = ''
        window.localStorage.clear()
        // Ответ build-id.txt намеренно НЕ разрешается сразу: проверяем то, что происходит,
        // пока он в пути.
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
        delete (window as unknown as Record<string, unknown>).__splifyBuildId
        delete (window as unknown as Record<string, unknown>).__splifyMount
    })

    it('первое открытие: помнить нечего, и раньше времени ничего не грузится', () => {
        loadView()
        expect(scripts()).toEqual([])
    })

    it('следующее открытие: сборка прошлого номера уходит в загрузку сразу', () => {
        window.localStorage.setItem('splify2:build-id', '26.9.10')
        loadView()
        expect(scripts()).toEqual(['/luci-static/resources/splify2/splify-index.js?v=26.9.10'])
        // Общий чанк — тем же заходом: его находит только разбор splify-index.js, то есть ещё
        // через один поход в сеть.
        const pre = document.head.querySelector('link[rel=modulepreload]')
        expect(pre?.getAttribute('href')).toBe('/luci-static/resources/splify2/splify-x.js?v=26.9.10')
        // И оформление того же номера: разные номера означали бы разметку одной сборки и
        // стили другой.
        const css = document.head.querySelector('link[rel=stylesheet]')
        expect(css?.getAttribute('href')).toBe('/luci-static/resources/splify2/splify-index.css?v=26.9.10')
    })

    it('номер совпал — второй раз тот же бандл не подключается', () => {
        window.localStorage.setItem('splify2:build-id', '26.9.10')
        const v = loadView()
        v.render('26.9.10')
        expect(scripts()).toEqual(['/luci-static/resources/splify2/splify-index.js?v=26.9.10'])
    })

    it('пакет обновили, номер разошёлся — подключается правильная сборка', () => {
        window.localStorage.setItem('splify2:build-id', '26.9.10')
        const v = loadView()
        v.render('27.0.0')
        expect(scripts()).toEqual([
            '/luci-static/resources/splify2/splify-index.js?v=26.9.10',
            '/luci-static/resources/splify2/splify-index.js?v=27.0.0',
        ])
        // И номер запоминается — следующее открытие начнётся уже с него.
        expect(window.localStorage.getItem('splify2:build-id')).toBe('27.0.0')
    })

    it('готовый бандл монтируется в свежий контейнер, а не грузится заново', () => {
        window.localStorage.setItem('splify2:build-id', '26.9.10')
        const mount = vi.fn()
        ;(window as unknown as Record<string, unknown>).__splifyMount = mount
        const v = loadView()
        const el = v.render('26.9.10')
        expect(mount).toHaveBeenCalledWith(el)
        expect(el.id).toBe('splify-root')
    })
})
