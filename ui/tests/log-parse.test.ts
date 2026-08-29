import { describe, expect, it } from 'vitest'
import { parseLog } from '@/lib/log'

// «Логи можно и обрабатывать, а не выводить в виде ошибок» — из разбора живого экрана.
// Строка logread состоит из полезного (время и текст) и оформления syslog, причём средство в
// нём ВРЁТ: движок пишет в stderr, а syslog метит stderr как daemon.err, поэтому обычные
// сообщения выглядели ошибками. Уровень берётся только из собственной пометки движка.

describe('разбор строки журнала', () => {
    it('снимает оформление syslog и оставляет время с текстом', () => {
        const l = parseLog(
            'Sat Aug 29 10:23:23 2026 daemon.err steer[2562]: steer[info]: узлов 29 (пропущено 0, чужих 0)',
        )
        expect(l).toEqual({ time: '10:23:23', level: 'info', text: 'узлов 29 (пропущено 0, чужих 0)' })
    })

    it('daemon.err обычное сообщение ошибкой НЕ делает', () => {
        const l = parseLog('Sat Aug 29 10:23:24 2026 daemon.err steer[2562]: steer[info]: tunnel: vless привязан к таблице 300')
        expect(l.level).toBe('info')
    })

    it('предупреждение берётся из пометки движка', () => {
        const l = parseLog(
            'Sat Aug 29 10:23:24 2026 daemon.err steer[2562]: steer[warn]: apply: output vless: cannot route via vless',
        )
        expect(l.level).toBe('warn')
        expect(l.text).toBe('apply: output vless: cannot route via vless')
    })

    it('чужая строка без пометки остаётся как есть, но время всё равно снимается', () => {
        const l = parseLog('Sat Aug 29 10:24:02 2026 daemon.info sh[26424]: steer: выход vless -> vless')
        expect(l.time).toBe('10:24:02')
        expect(l.level).toBe('info')
        expect(l.text).toBe('steer: выход vless -> vless')
    })

    it('строка не в том формате не теряется — отдаётся целиком', () => {
        const l = parseLog('что-то совсем другое')
        expect(l).toEqual({ time: '', level: 'info', text: 'что-то совсем другое' })
    })

    it('пустой хвост не съедает строку', () => {
        const raw = 'Sat Aug 29 10:24:02 2026 daemon.info sh[26424]:'
        expect(parseLog(raw).text).toBe(raw)
    })
})
