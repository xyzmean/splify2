import { render, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import Flag from '@/components/Flag'
import { country } from '@/lib/geo'
import { KNOWN } from '@/lib/geo'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// «Флагов тоже почему-то нет» — с экрана владельца. Причина не в нашем коде: флаг-эмодзи
// рисует шрифт, а в Windows шрифта с флагами нет, и вместо флага видны две мелкие буквы.
// Поэтому флаг стал картинкой из спрайта, собранного на машине сборки.
//
// Проверяется то, чего легко лишиться при правке: что список названий стран и список флагов
// не разъехались (иначе где-то из двух будет пусто), и что незнакомый код не рисует заглушку.

describe('флаг страны', () => {
    const sprite = readFileSync(resolve(__dirname, '../public/flags.svg'), 'utf8')

    beforeEach(() => {
        document.body.innerHTML = ''
        document.head.querySelectorAll('link[id^="splify2-app-css"]').forEach((l) => l.remove())
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => sprite })))
    })

    it('рисуется картинкой из спрайта, а не буквами', async () => {
        const { container } = render(<Flag cc="EE" />)
        await waitFor(() => expect(container.querySelector('use')).not.toBeNull())
        // Ссылка ВНУТРИДОКУМЕНТНАЯ: внешние ссылки в <use> Chrome не поддерживает вовсе —
        // проверено на роутере, вышел список подписей без единого флага.
        expect(container.querySelector('use')?.getAttribute('href')).toBe('#fl-ee')
        expect(document.getElementById('splify2-flags')).not.toBeNull()
    })

    it('спрайт качается один раз на страницу, сколько бы флагов её ни просило', async () => {
        render(<Flag cc="EE" />)
        render(<Flag cc="DE" />)
        render(<Flag cc="NL" />)
        await waitFor(() => expect(document.getElementById('splify2-flags')).not.toBeNull())
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('адрес спрайта берётся оттуда же, откуда стиль — вместе с номером сборки', async () => {
        const css = document.createElement('link')
        css.id = 'splify2-app-css-26.9.15'
        css.rel = 'stylesheet'
        css.href = 'http://router/luci-static/resources/splify2/splify-index.css?v=26.9.15'
        document.head.appendChild(css)
        render(<Flag cc="SE" />)
        await waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(fetch).toHaveBeenCalledWith('/luci-static/resources/splify2/flags.svg?v=26.9.15')
        css.remove()
    })

    it('незнакомый код — пусто, а не квадратик с вопросом', () => {
        const { container } = render(<Flag cc="ZZ" />)
        expect(container.querySelector('svg')).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
    })

    it('спрайта нет — остаётся одно название страны, без пустого места и без падения', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })))
        const { container } = render(<Flag cc="EE" />)
        await waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(container.querySelector('svg')).toBeNull()
    })

    it('у каждой названной страны есть флаг, и наоборот', () => {
        // Названия и флаги собираются из одного списка (tools/flags.py читает geo.ts).
        // Разъехались — значит на экране будет либо флаг без названия, либо название без
        // флага, и заметить это можно только глазами на нужной стране.
        for (const cc of KNOWN) {
            expect(sprite, `в спрайте нет флага ${cc}`).toContain(`id="fl-${cc}"`)
            expect(country(cc), `нет названия для ${cc}`).not.toBe('')
            expect(country(cc), `${cc} названа кодом, а не по-русски`).not.toBe(cc.toUpperCase())
        }
    })
})
