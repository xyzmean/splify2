/** Разбор строки системного журнала в то, что человеку стоит прочитать.
 *
 *  ЗАЧЕМ РАЗБИРАТЬ. Строка приходит от logread целиком:
 *
 *      Sat Aug 29 10:23:23 2026 daemon.err steer[2562]: steer[info]: узлов 29
 *
 *  Полезного в ней — время и хвост. Всё остальное — оформление syslog: день недели, год,
 *  средство и номер процесса. Хуже того, средство здесь врёт: движок пишет в stderr, а syslog
 *  метит stderr как `daemon.err`, поэтому обычные сообщения выглядели ошибками. Владелец
 *  назвал это прямо: логи можно и обрабатывать, а не выводить в виде ошибок.
 *
 *  ЧТО СЧИТАЕТСЯ УРОВНЕМ. Только собственная пометка движка (`steer[warn]` / `steer[info]`) —
 *  это формат, а не проза: меняться будет текст, а не префикс. Средству syslog не верим
 *  вовсе. Строка без пометки — от более старого движка: показывается как есть, уровнем
 *  считается обычный.
 *
 *  Ничего не выбрасывается молча: если строка не разобралась, отдаётся целиком. Пропавшая
 *  строка журнала хуже некрасивой. */
export type LogLine = { time: string; level: 'info' | 'warn'; text: string }

/* Sat Aug 29 10:23:23 2026 daemon.err steer[2562]: <хвост> */
const HEAD = /^\w{3}\s+\w{3}\s+\d+\s+(\d{2}:\d{2}:\d{2})\s+\d{4}\s+(\S+)\s+([^:]+):\s*/
/* Пометка самого движка внутри хвоста. */
const MARK = /^steer\[(warn|info)\]:\s*/

export function parseLog(line: string): LogLine {
    const head = HEAD.exec(line)
    let time = ''
    let text = line
    if (head) {
        time = head[1]
        text = line.slice(head[0].length)
    }
    let level: LogLine['level'] = 'info'
    const mark = MARK.exec(text)
    if (mark) {
        level = mark[1] as LogLine['level']
        text = text.slice(mark[0].length)
    }
    return { time, level, text: text.trim() || line }
}
