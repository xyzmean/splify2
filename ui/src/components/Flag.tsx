import { useEffect, useState } from 'react'
import { KNOWN } from '@/lib/geo'

/** Флаг страны картинкой.
 *
 *  НЕ ЭМОДЗИ. Флаг-эмодзи — это пара региональных букв (🇪🇪 = E+E), и рисует его шрифт. В
 *  Windows такого шрифта нет: там, где мы ждали флаг, человек видит две мелкие буквы —
 *  владелец это и заметил на своём экране.
 *
 *  ОТДЕЛЬНЫМ ФАЙЛОМ, НО ВСТАВЛЕННЫМ В ДОКУМЕНТ. Спрайт всех сорока пяти флагов весит 55 КБ —
 *  столько же, сколько весь главный бандл, поэтому внутри бандла он удорожал бы КАЖДОЕ
 *  открытие страницы ради картинки, которой на неподнятом туннеле и не будет. Но и ссылаться
 *  на него как на внешний файл (`<use href="flags.svg#fl-ee">`) нельзя: Chrome внешние ссылки
 *  в `use` не поддерживает вовсе — проверено на роутере, вышел пустой список из двенадцати
 *  подписей без единого флага. Поэтому файл скачивается один раз и вставляется в документ, а
 *  дальше ссылки внутридокументные, которые работают везде.
 *
 *  Адрес выводится из уже загруженного стиля, а не зашивается: под LuCI ресурсы лежат в
 *  /luci-static/resources/splify2/, на стенде разработчика — в корне. Номер сборки оттуда же:
 *  иначе после обновления браузер отдал бы прежний спрайт.
 *
 *  Незнакомый код — пусто, а не заглушка: рядом всегда стоит название страны, и пустое место
 *  честнее квадратика с вопросом. */

const SPRITE_ID = 'splify2-flags'

function spriteUrl(): string {
    const css = document.querySelector('link[id^="splify2-app-css"]') as HTMLLinkElement | null
    if (!css?.href) return '/flags.svg'
    const u = new URL(css.href, location.href)
    u.pathname = u.pathname.replace(/[^/]+$/, 'flags.svg')
    return u.pathname + u.search
}

/** Один поход за спрайтом на всю страницу, сколько бы флагов её ни просило. Обещание живёт
 *  только пока запрос в пути: держать его навсегда значило бы, что спрайт, однажды не
 *  доехавший (или удалённый из документа), больше никогда не появится. */
let loading: Promise<void> | null = null

function ensureSprite(): Promise<void> {
    if (typeof document === 'undefined') return Promise.resolve()
    if (document.getElementById(SPRITE_ID)) return Promise.resolve()
    if (!loading) {
        loading = fetch(spriteUrl())
            .then((r) => (r.ok ? r.text() : ''))
            .then((svg) => {
                if (!svg || document.getElementById(SPRITE_ID)) return
                const host = document.createElement('div')
                host.id = SPRITE_ID
                host.setAttribute('aria-hidden', 'true')
                host.style.display = 'none'
                /* Содержимое — наш же файл со сборки, а не что-то пришедшее с роутера или из
                 * сети общего пользования: подставлять его разметкой безопасно. */
                host.innerHTML = svg
                document.body.appendChild(host)
            })
            .catch(() => { /* нет спрайта — останется одно название страны */ })
            .finally(() => { loading = null })
    }
    return loading
}

export default function Flag({ cc, className = '' }: { cc?: string; className?: string }) {
    const code = (cc || '').trim().toLowerCase()
    const known = KNOWN.has(code)
    const [ready, setReady] = useState(() => typeof document !== 'undefined' && !!document.getElementById(SPRITE_ID))
    useEffect(() => {
        if (!known || ready) return
        let stop = false
        void ensureSprite().then(() => { if (!stop) setReady(true) })
        return () => { stop = true }
    }, [known, ready])
    if (!known || !ready) return null
    return (
        <svg
            className={`inline-block h-[0.85em] w-[1.13em] shrink-0 rounded-[2px] align-[-0.1em] ${className}`}
            aria-hidden="true"
        >
            <use href={`#fl-${code}`} />
        </svg>
    )
}
