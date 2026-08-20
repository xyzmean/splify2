import { useEffect, useState } from 'react'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { EMPTY_SPEC, type Spec } from '@/lib/model'

/** Автосохранение и счётчик неприменённого — одно место на весь экран.
 *
 *  Правка уходит в spec_set сама, через полсекунды тишины: кнопок «Сохранить» больше
 *  нет. Применение остаётся отдельным шагом (перекомпиляция наборов), и его единственная
 *  кнопка — плавающая пилюля «Применить · N», где N — сколько правил и выходов
 *  ОТЛИЧАЕТСЯ от применённого. Не счётчик кликов: изменил и вернул обратно — ноль.
 *
 *  «Применённое» приходит от бэкенда (applied_get — снимок спеки в момент apply), а не
 *  запоминается интерфейсом: перезагрузка страницы не должна обнулять счётчик. */

type Listener = () => void

class PendingStore {
    saved: Spec | null = null
    applied: Spec | null = null
    applying = false
    /** Полторы секунды зелёной галочки после успешного apply. */
    justApplied = false
    /** Короткая вспышка «Сохранено» у вкладок. */
    savedFlash = false

    private listeners = new Set<Listener>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private writing: Promise<void> = Promise.resolve()
    dirty = false
    /** Запись НА ЛЕТУ. Отдельно от dirty потому, что flush снимает dirty ещё до ответа
     *  роутера: без этого признака страховка на выгрузку считала бы уехавшим то, что как раз
     *  сейчас в полёте, и браузер имел бы полное право оборвать запрос молча. */
    inflight = false
    private flashTimer: ReturnType<typeof setTimeout> | null = null

    subscribe(fn: Listener) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
    }
    private emit() { for (const fn of this.listeners) fn() }

    /** Первая загрузка. Кто пришёл раньше — тот и загрузил; остальные получают то же. */
    async load(): Promise<Spec> {
        if (this.saved) return this.saved
        const [saved, applied] = await Promise.all([
            rpc.specGet().catch(() => EMPTY_SPEC),
            /* Старый бэкенд метода не знает — тогда считаем применённым сохранённое:
             * счётчик стартует с нуля, что не хуже прежнего поведения. */
            rpc.appliedGet().catch(() => null),
        ])
        if (!this.saved) {
            this.saved = saved
            this.applied = applied ?? saved
            this.emit()
        }
        return this.saved
    }

    /** Правка: сразу в память (и всем подписчикам), на диск — через 500 мс тишины.
     *  Дебаунс не косметика: набор имени правила — это десяток onChange, и каждый
     *  spec_set гоняет dry-run компилятора на роутере с 64 МБ. */
    edit(next: Spec) {
        this.saved = next
        this.dirty = true
        this.emit()
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.flush(), 500)
    }

    /** Галочка «Сохранено» — на полторы секунды и только по факту записи.
     *
     *  Прежде она вспыхивала прямо в edit(), то есть за 500 мс до того, как запрос
     *  вообще отправлялся. Отказ здесь не редкость, а штатная ветка: spec_set отвергает
     *  спеку целиком, если её не принял dry-run компилятора. Порядок событий получался
     *  обратный смыслу — сначала «✓ Сохранено», потом тост с причиной, — а взамен
     *  кнопки «Сохранить» эта галочка единственная, по чему человек судит, уехала
     *  правка или нет. */
    private flash() {
        if (this.flashTimer) clearTimeout(this.flashTimer)
        this.savedFlash = true
        this.flashTimer = setTimeout(() => { this.savedFlash = false; this.emit() }, 1800)
        this.emit()
    }

    /** Дописать на роутер всё, что ещё не уехало. Последовательно: два spec_set
     *  вперегонки — это гонка, в которой побеждает случайный. */
    async flush() {
        if (!this.dirty || !this.saved) return
        this.dirty = false
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        const spec = this.saved
        this.inflight = true
        this.writing = this.writing.then(async () => {
            try {
                const r = await rpc.specSet(JSON.stringify(spec))
                    .catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }))
                if (!r.ok) {
                    /* Отказ dry-run — это не «потеряно»: спека осталась в памяти, человек
                     * видит причину и правит дальше; следующая правка попробует снова. */
                    notify(('error' in r && r.error) || 'не удалось сохранить', 'error')
                    this.dirty = true
                    this.emit()
                } else {
                    /* Записано — теперь и только теперь галочка. */
                    this.flash()
                    if ('warn' in r && r.warn)
                        /* Сохранение прошло, но список не скачался — значит его канал не
                         * поднимется. Молчать нельзя: человек выбрал сервис, интерфейс мигнул
                         * «Сохранено», а работать оно не будет, и связь между этими событиями
                         * восстановить нечем. */
                        notify(String(r.warn), 'error')
                }
            } finally {
                /* В finally, а не в трёх ветках: признак «в полёте» обязан сниматься при любом
                 * исходе, включая исключение, — иначе страховка на выгрузку начнёт спрашивать
                 * про несохранённое там, где всё давно записано. */
                this.inflight = false
            }
        })
        await this.writing
    }

    /** Есть ли правка, которая ещё НЕ уехала на роутер: либо ждёт своих 500 мс, либо
     *  прошлая запись отказала. Нужен снаружи — по нему страховка на выгрузку решает,
     *  спрашивать ли человека. */
    hasUnsaved(): boolean {
        return this.dirty || this.inflight
    }

    /** Сколько правил и выходов отличается от применённого. Позиционно по каналам:
     *  порядок — это приоритет, перестановка тоже изменение. */
    count(): number {
        const a = this.applied
        const s = this.saved
        if (!a || !s) return 0
        let n = 0
        const names = new Set([...Object.keys(a.outputs || {}), ...Object.keys(s.outputs || {})])
        for (const name of names)
            if (JSON.stringify(a.outputs?.[name]) !== JSON.stringify(s.outputs?.[name])) n++
        const len = Math.max(a.channels.length, s.channels.length)
        for (let i = 0; i < len; i++)
            if (JSON.stringify(a.channels[i]) !== JSON.stringify(s.channels[i])) n++
        return n
    }

    async apply() {
        if (this.applying) return
        this.applying = true
        this.emit()
        try {
            await this.flush()
            const r = await rpc.apply()
            notify(r.output?.trim() || (r.ok ? 'Применено' : 'сбой применения'), r.ok ? 'info' : 'error')
            if (r.ok) {
                this.applied = this.saved
                this.justApplied = true
                this.emit()
                setTimeout(() => { this.justApplied = false; this.emit() }, 1800)
            }
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            this.applying = false
            this.emit()
        }
    }
}

export const pending = new PendingStore()

/* СТРАХОВКА НА УХОД СО СТРАНИЦЫ. Правка живёт в браузере до 500 мс — столько ждёт дебаунс, —
 * и этого хватает, чтобы её потерять: человек создаёт правило и сразу обновляет страницу.
 * Именно так и пришло сообщение об ошибке (splify2#11: «после создания правила и перезагрузки
 * страницы пропадает правило»). С прежней кнопкой «Сохранить» такого случиться не могло:
 * человек знал, отправил он что-нибудь или нет.
 *
 * Два крюка, и они делают разное. `visibilitychange`/`pagehide` — попытка ДОПИСАТЬ: браузер
 * ещё разрешает начатый запрос, и в большинстве случаев этого достаточно. `beforeunload` —
 * последняя черта: если правка всё ещё не уехала, человека СПРАШИВАЮТ, а не теряют её молча.
 * Спрашивается только при действительно несохранённом (окно дебаунса или отказ прошлой
 * записи), поэтому в обычной работе диалога не видно. */
if (typeof window !== 'undefined') {
    const flushNow = () => {
        if (pending.hasUnsaved()) void pending.flush()
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow()
    })
    window.addEventListener('pagehide', flushNow)
    window.addEventListener('beforeunload', (e) => {
        if (!pending.hasUnsaved()) return
        /* Текст сообщения браузеры давно не показывают — важен сам факт отмены события. */
        e.preventDefault()
        e.returnValue = ''
    })
}

/** Подписка для компонентов: пилюли, вкладок, индикатора «Сохранено». */
export function usePending() {
    const [, force] = useState(0)
    useEffect(() => pending.subscribe(() => force((n) => n + 1)), [])
    return {
        count: pending.count(),
        applying: pending.applying,
        justApplied: pending.justApplied,
        savedFlash: pending.savedFlash,
        applied: pending.applied,
        apply: () => void pending.apply(),
    }
}
