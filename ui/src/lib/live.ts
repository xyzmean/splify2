import { useEffect, useRef, useState } from 'react'
import { rpc } from './rpc'
import { type Releases, type SelfUpdateInfo } from './engine'
import { type Status } from './model'

/** Живые данные экрана — ОДИН опрос на всё.
 *
 *  Раньше их читала только страница состояния. Теперь они нужны и закреплённой колонке, и
 *  вкладке логов, а два независимых опроса значили бы два разных мгновения на одном экране:
 *  колонка говорит «работает», таблица рядом показывает нули, и оба правы. Здесь снимок один,
 *  и его видят все.
 *
 *  Скорость считается из разницы двух снимков — именно её человек и высматривает, глядя на
 *  счётчики: «сколько всего» отвечает на другой вопрос. Поэтому и снимок обязан быть один:
 *  разница по значениям, снятым в разные моменты, делится на неверное время и показывает
 *  скорость, которой не было. */

export interface DiagCheck {
    id: string
    /** `note` — совет, а не находка: верен всегда и в счётчики движка не идёт. Без него советы
     *  считались предупреждениями, и «работает, но есть о чём знать» горело постоянно — то есть
     *  тревога стояла на исправном роутере и учила не смотреть на неё вовсе. */
    verdict: 'ok' | 'note' | 'warn' | 'fail'
    what: string
    why: string
}

export interface Diag {
    checks: DiagCheck[]
    warn: number
    fail: number
}

export interface EngineState {
    instances: Record<string, { running: boolean; pid: number }>
    log: string[]
}

export interface Build {
    present: boolean
    vless: boolean
    arch?: string
    version?: string
    /** Поднимется ли движок после перезагрузки. Именно это снимает «Остановить всё», и
     *  именно поэтому подпись тумблера читает состояние, а не помнит своё: между двумя
     *  открытиями страницы движок могли остановить из консоли. */
    enabled?: boolean
    /** Работает ли хоть один экземпляр прямо сейчас. */
    running?: boolean
}

export interface Live {
    status: Status | null
    /** Время работы движка в секундах и сколько устройств сейчас ходит в сеть. */
    net: { uptime: number; active_clients: number } | null
    /** Что установлено: версия, вариант, архитектура. Спрашивается ОДИН раз, а не по кругу:
     *  ответ добывается запуском движка, и делать это каждые пять секунд на роутере с 64 МБ
     *  значит платить процессом за неменяющееся число. Перечитывается по refresh() — то есть
     *  после установки, когда оно и меняется. */
    build: Build | null
    /** Что можно поставить: архитектура пакетов и релизы от новых к старым. Спрашивается
     *  так же редко, как build, и по той же причине — запрос уходит наружу. */
    releases: Releases | null
    /** Версии самого интерфейса. Спрашивается там же и так же редко, как releases. */
    selfUpdate: SelfUpdateInfo | null
    /** Ошибка движка. Отдельно от `status === null`, потому что «ещё не пришло» и «не
     *  отвечает» требуют разного: первое — подождать, второе — показать причину. */
    error: string | null
    diag: Diag | null
    /** Движок старее проверок состояния. Не ошибка страницы, а отдельное сообщение: иначе
     *  выглядело бы как поломка интерфейса на исправном роутере. */
    diagOld: boolean
    devs: Record<string, { rx: string; tx: string }> | null
    engine: EngineState | null
    /** Скорость прямо сейчас, готовыми строками. Пусто до второго опроса и когда трафика
     *  нет: нуль там был бы неправдой — мы его не измеряли. */
    speed: {
        ch: Record<string, { up: string | null; down: string | null }>
        dev: Record<string, { rx: string | null; tx: string | null }>
    }
    /** Перечитать сейчас, не дожидаясь следующего круга. Нужно после «Применить»: без этого
     *  человек видит прежние числа и не понимает, подействовало ли. */
    refresh: () => void
}

/** Байты человеческим размером. Точность до десятой доли: «223,4 МБ» отвечает на вопрос,
 *  а «234085837» требует считать разряды глазами. */
export function human(n: number) {
    if (!isFinite(n) || n <= 0) return '0 Б'
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
    let i = 0
    let v = n
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${i === 0 ? v : v.toFixed(1).replace('.', ',')} ${u[i]}`
}

/** Скорость из разницы двух опросов. Отрицательная разница значит, что счётчики начались
 *  заново (перезагрузка) — такую не показываем вовсе. */
export function rate(bytes: number, ms: number) {
    if (!(ms > 0) || !(bytes > 0)) return null
    const bits = (bytes * 8 * 1000) / ms
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1).replace('.', ',')} Мбит/с`
    if (bits >= 1e3) return `${Math.round(bits / 1e3)} кбит/с`
    return `${Math.round(bits)} бит/с`
}

const PERIOD_MS = 5000

export function useLive(): Live {
    const [status, setStatus] = useState<Status | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [diag, setDiag] = useState<Diag | null>(null)
    const [diagOld, setDiagOld] = useState(false)
    const [devs, setDevs] = useState<Record<string, { rx: string; tx: string }> | null>(null)
    const [engine, setEngine] = useState<EngineState | null>(null)
    const [speed, setSpeed] = useState<Live['speed']>({ ch: {}, dev: {} })
    const [build, setBuild] = useState<Build | null>(null)
    const [releases, setReleases] = useState<Releases | null>(null)
    const [selfUpdate, setSelfUpdate] = useState<SelfUpdateInfo | null>(null)
    const [net, setNet] = useState<{ uptime: number; active_clients: number } | null>(null)
    const prev = useRef<{
        t: number
        ch: Record<string, { up: number; down: number }>
        dev: Record<string, { rx: number; tx: number }>
    } | null>(null)
    /** Счётчик «перечитай сейчас». Меняется — эффект перезапускается. */
    const [nonce, setNonce] = useState(0)

    useEffect(() => {
        let stop = false
        /* Перекрывающиеся опросы. Круг на медленном роутере может не уложиться в пять
         * секунд, и тогда два load() гонялись бы за prev.current: скорость считалась бы
         * из разницы снимков, снятых с неверным интервалом (I-013). Опоздавший круг не
         * ставится в очередь — следующий тик всё равно принесёт свежее. */
        let inflight = false
        const load = async () => {
            if (inflight) return
            inflight = true
            try {
            /* allSettled, а не all: отказ одного источника не должен уносить остальные.
             * Проверок состояния нет у старого движка, и это не повод гасить экран. */
            const [s, d, e, g, ni] = await Promise.allSettled([
                rpc.status(), rpc.devStats(), rpc.engineState(), rpc.diag(), rpc.netInfo(),
            ])
            if (stop) return
            /* Беда приезжает УСПЕШНЫМ промисом. Бэкенд по контракту (docs/rpcd-api.md)
             * отвечает на любую ошибку объектом {ok:false, error} и кодом возврата нуль,
             * поэтому промис резолвится, и проверка одного лишь status === 'rejected'
             * такую беду не замечает вовсе.
             *
             * Цена была ровно обратной задуманному: движок не отвечает (спека битая,
             * файла списка нет, движок откатили) → status отдаёт {ok:false,...} →
             * setError(null) и объект ошибки в состоянии → StatusRail печатает «Работает»
             * зелёной точкой, а заголовок диагностики — «Всё в порядке». Ветка «Проверка
             * состояния недоступна», написанная ровно под этот случай, была недостижима.
             * В самом бэкенде про это сказано прямо: «честная ошибка, а не пустой объект,
             * который интерфейс покажет как „всё в порядке“». */
            const failure = (v: unknown): string | null => {
                if (!v || typeof v !== 'object') return null
                const o = v as { ok?: unknown; error?: unknown }
                if (o.ok === false || o.ok === 0)
                    return typeof o.error === 'string' && o.error ? o.error : 'бэкенд вернул ошибку'
                return null
            }
            const rejected = (r: { reason?: unknown }): string =>
                String(r.reason instanceof Error ? r.reason.message : r.reason)

            if (s.status === 'fulfilled' && !failure(s.value)) { setStatus(s.value); setError(null) }
            else setError(s.status === 'fulfilled' ? failure(s.value)! : rejected(s))
            const devices = d.status === 'fulfilled' && !failure(d.value) ? d.value.devices || {} : null
            if (devices) setDevs(devices)
            if (e.status === 'fulfilled' && !failure(e.value)) setEngine(e.value)
            if (g.status === 'fulfilled' && !failure(g.value)) { setDiag(g.value); setDiagOld(false) }
            else setDiagOld(true)
            if (ni.status === 'fulfilled' && !failure(ni.value)) setNet(ni.value)

            const now = Date.now()
            const ch: Record<string, { up: number; down: number }> = {}
            if (s.status === 'fulfilled' && !failure(s.value))
                for (const c of s.value.channels || [])
                    ch[c.name] = { up: c.bytes ?? 0, down: c.down_bytes ?? 0 }
            const dev: Record<string, { rx: number; tx: number }> = {}
            if (devices)
                for (const [n, v] of Object.entries(devices))
                    dev[n] = { rx: Number(v.rx), tx: Number(v.tx) }
            const p = prev.current
            if (p) {
                const ms = now - p.t
                const chs: Live['speed']['ch'] = {}
                for (const [n, v] of Object.entries(ch))
                    chs[n] = {
                        up: p.ch[n] ? rate(v.up - p.ch[n].up, ms) : null,
                        down: p.ch[n] ? rate(v.down - p.ch[n].down, ms) : null,
                    }
                const devs2: Live['speed']['dev'] = {}
                for (const [n, v] of Object.entries(dev))
                    devs2[n] = {
                        rx: p.dev[n] ? rate(v.rx - p.dev[n].rx, ms) : null,
                        tx: p.dev[n] ? rate(v.tx - p.dev[n].tx, ms) : null,
                    }
                setSpeed({ ch: chs, dev: devs2 })
            }
            prev.current = { t: now, ch, dev }
            } finally {
                inflight = false
            }
        }
        void load()
        /* Опрос ЗАМИРАЕТ, пока вкладка скрыта, и догоняет одним кругом при возврате.
         *
         * Круг стоит роутеру пяти запусков shell-скрипта плюс двух запусков движка, и на
         * 880 МГц это порядка секунды процессора на каждые пять секунд. Пока паузы не было,
         * забытая в фоне вкладка на телефоне стучалась в роутер двенадцать раз в минуту
         * вечно — то есть постоянная нагрузка от страницы, которую никто не смотрит. Это
         * самая дорогая работа во всём интерфейсе именно потому, что она не прекращается.
         *
         * Догоняющий круг обязателен: без него вернувшийся человек видит снимок той
         * давности, когда он ушёл, а счётчики скорости считаются из разницы двух снимков и
         * дали бы среднее за всё время отсутствия. prev сбрасывается по той же причине —
         * интервал между снимками не пять секунд, и скорость из него бессмысленна. */
        const tick = () => { if (!document.hidden) void load() }
        const id = setInterval(tick, PERIOD_MS)
        const onVisible = () => {
            if (document.hidden) return
            prev.current = null
            void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
            stop = true
            clearInterval(id)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [nonce])

    /* Отдельным эффектом: этот ответ добывается запуском движка, и в общем круге он стоил бы
     * процесса каждые пять секунд. */
    useEffect(() => {
        let stop = false
        rpc.engine()
            .then((b) => { if (!stop) setBuild(b) })
            .catch(() => { if (!stop) setBuild(null) })
        return () => { stop = true }
    }, [nonce])

    /* Список релизов — тоже раз на круг обновления, а не в пятисекундном опросе: запрос
     * уходит на GitHub с двадцатисекундным таймаутом, и держать его в общем цикле значило
     * бы ходить в интернет двенадцать раз в минуту с роутера.
     *
     * Здесь, а не в карточке движка, потому что ответ нужен ДВУМ местам сразу: карточке —
     * чтобы заполнить список версий, левой колонке — чтобы подпись кнопки перестала обещать
     * обновление, которого нет (I-038). Пока запрос жил в карточке, колонка о нём не знала. */
    useEffect(() => {
        let stop = false
        rpc.steerVersions()
            .then((r) => { if (!stop) setReleases(r) })
            .catch(() => { if (!stop) setReleases(null) })
        rpc.splify2Versions()
            .then((r) => { if (!stop) setSelfUpdate(r) })
            .catch(() => { if (!stop) setSelfUpdate(null) })
        return () => { stop = true }
    }, [nonce])

    return {
        status, error, diag, diagOld, devs, engine, speed, build, net, releases, selfUpdate,
        refresh: () => setNonce((n) => n + 1),
    }
}
