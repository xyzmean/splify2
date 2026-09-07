/** Адрес файла из сборки — шрифта, логотипа — рядом с уже загруженным стилем.
 *
 *  Под LuCI ресурсы лежат в /luci-static/resources/splify2/, на стенде разработчика — в корне,
 *  поэтому путь не зашивается, а выводится из адреса стиля, который загрузчик уже поставил на
 *  страницу. Номер сборки (?v=) берётся оттуда же: иначе после обновления браузер отдал бы
 *  прежний файл. */
export function assetUrl(name: string): string {
    const css = document.querySelector('link[id^="splify2-app-css"]') as HTMLLinkElement | null
    if (!css?.href) return `/${name}`
    const u = new URL(css.href, location.href)
    u.pathname = u.pathname.replace(/[^/]+$/, name)
    return u.pathname + u.search
}

/** Номер сборки страницы — `?v=` у адреса стиля, который поставил загрузчик. Пусто на стенде.
 *  Нужен памяти браузера: запомненное одной сборкой не должно переживать установку другой. */
export function buildId(): string {
    const css = document.querySelector('link[id^="splify2-app-css"]') as HTMLLinkElement | null
    if (!css?.href) return ''
    return new URL(css.href, location.href).searchParams.get('v') || ''
}
