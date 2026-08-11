import type { Live } from '@/lib/live'

/** Пустой Live: всё, чего тест не задал, отсутствует, а не выдумано.
 *
 *  Так проверка не может случайно опереться на фикстуру вместо кода — если поле важно,
 *  тест обязан назвать его сам. */
export function live(patch: Partial<Live> = {}): Live {
    return {
        status: null,
        net: null,
        build: null,
        releases: null,
        selfUpdate: null,
        error: null,
        diag: null,
        diagOld: false,
        devs: null,
        engine: null,
        speed: { ch: {}, dev: {} },
        refresh: () => {},
        ...patch,
    } as Live
}
