import { useRef, useState } from 'react'
import { type VlessProbe } from '@/lib/model'

/** Проверка узлов подписки — таблица результатов и очередь пачки, общие для любого экрана,
 *  где узлы выбирают.
 *
 *  ЗАЧЕМ ОТДЕЛЬНО. Проверка жила в панели подписки, которую раздел VPN перестал показывать,
 *  когда выбор локации переехал в состав выхода (см. VlessScreen: «локация — свойство выхода»).
 *  Кнопка за выбором не поехала, и мерить узлы стало негде: человек собирал выход из
 *  тридцати локаций вслепую (владелец: «негде проверить vless выходы»). Логика здесь — та
 *  же, что была в панели, только без привязки к одной подписке: ключ — «подписка:номер».
 *
 *  ПРЕДЕЛ ОДНОВРЕМЕННЫХ ПРОВЕРОК — ТРИ, и это не «побольше, чтобы быстрее»: каждая проверка
 *  поднимает через движок настоящее соединение до узла и меряет по нему время ответа, а
 *  роутер однопроцессорный и с одним каналом наружу. По одному — тридцать нажатий с
 *  ожиданием; все сразу — замер собственной очереди на том же процессоре, а не задержки
 *  узла. Движок при этом не меняется: один узел за вызов сделано намеренно, проверка
 *  упирается в таймаут, а вызов ubus столько не живёт. */
export const PROBE_LIMIT = 3

/** Что происходит со строкой узла: 'queued' — стоит в очереди пачки, до неё ещё не дошли,
 *  'running' — проверяется прямо сейчас. Различать обязательно: показать у строки из очереди
 *  пустое место значит соврать, что узел не проверяется, а «идёт проверка» — что замер уже
 *  начался, хотя вызова ещё не было. */
export type ProbePhase = 'queued' | 'running'

export type ProbeReply = { results?: VlessProbe[]; error?: string }

export const probeKey = (sub: string, index: number) => `${sub}:${index}`

export function useNodeProbe(ask: (sub: string, index: number) => Promise<ProbeReply>) {
    const [probes, setProbes] = useState<Record<string, VlessProbe>>({})
    const [fails, setFails] = useState<Record<string, string>>({})
    const [phase, setPhase] = useState<Record<string, ProbePhase>>({})
    /** Подписка, по которой идёт пачка; пусто — пачки нет. */
    const [batchSub, setBatchSub] = useState('')
    /** Номер пачки. Ответы вызовов, отправленных при другом номере, выбрасываются: отмена,
     *  новая пачка и размонтирование иначе дописывали бы в таблицу то, чего уже не просили. */
    const batch = useRef(0)

    function mark(key: string, p: ProbePhase | null) {
        setPhase((prev) => {
            const next = { ...prev }
            if (p) next[key] = p
            else delete next[key]
            return next
        })
    }

    /** Одна проверка одного узла — и для кнопки в строке, и как шаг пачки. Результат кладётся
     *  в таблицу сразу, как пришёл, поэтому пачка заполняет её постепенно, а не одним прыжком
     *  в конце. */
    async function probeOne(sub: string, index: number, token = batch.current) {
        const key = probeKey(sub, index)
        mark(key, 'running')
        try {
            const r = await ask(sub, index)
            if (batch.current !== token) return
            if (r.error) throw new Error(r.error)
            setProbes((prev) => {
                const next = { ...prev }
                for (const res of r.results || []) next[probeKey(sub, res.index)] = res
                return next
            })
            setFails((prev) => {
                if (!(key in prev)) return prev
                const next = { ...prev }
                delete next[key]
                return next
            })
        } catch (e) {
            if (batch.current !== token) return
            /* Отказ — в строке узла, а не всплывашкой: на проверке всех это тридцать
             * всплывашек подряд, и ни одна не говорит, к какому узлу относится. */
            setFails((prev) => ({ ...prev, [key]: String(e instanceof Error ? e.message : e) }))
        } finally {
            if (batch.current === token) mark(key, null)
        }
    }

    /** Отмена пачки: номер сдвигается, ответы уже отправленных вызовов перестают считаться,
     *  пометки со строк снимаются. Сами вызовы не отзываются — ubus этого не умеет, — но и
     *  состояния они больше не трогают. */
    function stopAll() {
        batch.current += 1
        setPhase({})
        setBatchSub('')
    }

    /** Проверить все узлы подписки. Повторное нажатие — отмена: пачка на слабом роутере идёт
     *  долго, и без отмены единственный выход — ждать, пока она добежит до конца. */
    async function probeAll(sub: string, indexes: number[]) {
        if (batchSub) { stopAll(); return }
        if (indexes.length === 0) return
        const token = ++batch.current
        const queue = indexes.slice()
        setFails((prev) => {
            const next = { ...prev }
            for (const i of queue) delete next[probeKey(sub, i)]
            return next
        })
        setPhase(Object.fromEntries(queue.map((i) => [probeKey(sub, i), 'queued' as ProbePhase])))
        setBatchSub(sub)
        let head = 0
        const worker = async () => {
            while (batch.current === token) {
                const index = queue[head++]
                if (index === undefined) return
                await probeOne(sub, index, token)
            }
        }
        /* Ровно PROBE_LIMIT воркеров тянут из общей очереди — так предел держится и на
         * подписке из тридцати узлов, а не только на первой волне. */
        await Promise.all(Array.from({ length: Math.min(PROBE_LIMIT, queue.length) }, worker))
        if (batch.current !== token) return
        setPhase({})
        setBatchSub('')
    }

    /** Сколько ещё не проверено в идущей пачке — для подписи кнопки отмены. */
    const left = Object.values(phase).length

    return { probes, fails, phase, batchSub, left, probeOne, probeAll, stopAll }
}

/** Цвет отклика: до 150 мс — хорошо, до 400 — обычно, дальше — заметно. */
export function latencyTone(ms: number): 'good' | 'ok' | 'slow' {
    return ms < 150 ? 'good' : ms < 400 ? 'ok' : 'slow'
}
