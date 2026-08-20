import { useRef, useState } from 'react'
import { Download, Loader2, Upload } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'

// Бекап и перенос настроек (R-005, splify2#4, пункт 4).
//
// Вопрос пришёл снаружи: перенести настройку на второй роутер или вернуть её после
// переустановки было нечем. Штатная резервная копия OpenWrt тоже не помогала — /etc/steer
// не объявлен ничьим, и sysupgrade его не берёт (I-037). Это карточка «файл туда, файл
// обратно», а не второй способ настраивать: восстановленное СОХРАНЯЕТСЯ, но не
// применяется, применение остаётся отдельным шагом человека (ApplyPill).
//
// Про размер архива. В нём настройки и СВОИ списки, но нет 284 КБ зеркал категорий
// издателя: роутер скачивает их сам, они одинаковы у всех и обновляются по расписанию.
// Обоснование целиком — в rpcd (backup_build) и в docs/rpcd-api.md.

/** По сколько байт отправлять архив. Ровно та же причина, что у порций своего списка:
 *  ubus не резиновый, и целиком архив в одно сообщение не помещается. */
export const BACKUP_CHUNK = 16384

/** Сколько кусков готовы прочитать, прежде чем сдаться. Страховка от бесконечного цикла:
 *  бэкенд, отдающий один и тот же `next`, иначе крутил бы запросы вечно. */
const MAX_CHUNKS = 128

/** Собрать архив из кусков. Смещение берётся ТО, ЧТО ПРИСЛАЛ роутер: он считает байты, а
 *  строка в браузере считается символами, и своя арифметика здесь разъехалась бы с
 *  бэкендом на первой же русской букве. */
export async function readBackup(): Promise<string> {
    let text = ''
    let offset = 0
    for (let i = 0; i < MAX_CHUNKS; i++) {
        const r = await rpc.backupGet(offset)
        if (!r.ok) throw new Error(r.error || 'не удалось собрать архив')
        text += r.text ?? ''
        if (r.eof) return text
        const next = r.next ?? 0
        // Роутер не двинулся — дальше читать нечего и незачем. Отказ, а не тихий возврат
        // половины: обрезанный архив выглядит как целый и не восстановится.
        if (next <= offset) throw new Error('архив прислан не полностью')
        offset = next
    }
    throw new Error('архив слишком велик для чтения по кускам')
}

/** Нарезать архив на куски для отправки.
 *
 *  Резать по границе символа, а не по индексу: половина суррогатной пары — не символ, и
 *  JSON.stringify поставил бы на её месте замену, то есть файл приехал бы на роутер
 *  искажённым. Имя узла в ссылке vless:// вполне бывает с эмодзи, так что случай не
 *  теоретический. */
export function cutChunks(text: string, size = BACKUP_CHUNK): string[] {
    const out: string[] = []
    let i = 0
    while (i < text.length) {
        let end = Math.min(i + size, text.length)
        const code = text.charCodeAt(end - 1)
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1
        out.push(text.slice(i, end))
        i = end
    }
    return out
}

/** Отдать строку файлом. Blob и `<a download>`, потому что отдавать её ссылкой было бы
 *  нечем: у бэкенда нет второго пути наружу, а заводить его ради одной кнопки — это
 *  вторые права и вторая проверка формата. */
function saveAsFile(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Отпускается не сразу: браузер начинает скачивание не мгновенно, и отозванный
    // сейчас же URL дал бы пустой файл.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function stamp(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function BackupCard({
    onRestored = () => location.reload(),
}: {
    /** Что делать после удачного восстановления. По умолчанию — перезагрузить страницу, и
     *  это не косметика: спека живёт в памяти страницы (lib/pending.ts), и следующая же
     *  правка записала бы ПРЕЖНЮЮ спеку поверх восстановленной. Параметр есть, чтобы это
     *  можно было проверить стендом, а не чтобы отключать перезагрузку. */
    onRestored?: () => void
}) {
    const [busy, setBusy] = useState<'' | 'export' | 'import'>('')
    const fileRef = useRef<HTMLInputElement>(null)
    const [ask, dialog] = useConfirm()

    async function exportAll() {
        setBusy('export')
        try {
            const text = await readBackup()
            saveAsFile(`splify2-backup-${stamp()}.txt`, text)
            notify(`Архив настроек сохранён: ${Math.round(text.length / 1024)} КБ`)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function importAll(file: File) {
        const ok = await ask({
            title: 'Восстановить настройки из файла?',
            body:
                'Правила, выходы, подписка и свои списки будут заменены на те, что в файле. ' +
                'Применение останется за вами: восстановленное появится как неприменённое.',
            confirmLabel: 'Восстановить',
        })
        if (!ok) {
            if (fileRef.current) fileRef.current.value = ''
            return
        }
        setBusy('import')
        try {
            // Дописать несохранённую правку ДО восстановления. Иначе она уедет после него:
            // страховка на уход со страницы (lib/pending.ts) допишет её при перезагрузке,
            // и прежняя спека ляжет поверх восстановленной.
            await pending.flush()
            const chunks = cutChunks(await file.text())
            if (chunks.length === 0) throw new Error('файл пуст')
            let last: Awaited<ReturnType<typeof rpc.backupPut>> = { ok: false }
            for (let i = 0; i < chunks.length; i++) {
                last = await rpc.backupPut({
                    text: chunks[i],
                    append: i > 0,
                    final: i === chunks.length - 1,
                })
                if (!last.ok) throw new Error(last.error || 'файл не принят')
            }
            const lists = last.lists ?? []
            const dropped = lists.reduce((n, l) => n + (l.dropped || 0), 0)
            notify(
                [
                    'Настройки восстановлены:',
                    last.spec ? 'правила и выходы,' : '',
                    last.sub ? 'подписка,' : '',
                    lists.length ? `свои списки (${lists.length}),` : '',
                    dropped ? `отброшено строк: ${dropped},` : '',
                    'применить — кнопкой «Применить».',
                ]
                    .filter(Boolean)
                    .join(' '),
            )
            if (last.warn) notify(String(last.warn), 'warning')
            onRestored()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
            if (fileRef.current) fileRef.current.value = ''
        }
    }

    return (
        <Card>
            {dialog}
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Бекап настроек</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                    Один файл: правила, выходы, подписка и свои списки. Категорий издателя в нём
                    нет — роутер скачивает их сам, и в архиве они были бы 284 КБ чужих данных,
                    устаревающих на следующий день.
                </p>
                {/* Сказать это до нажатия, а не после: в файле лежат ссылки vless:// с
                    ключами, то есть он секретен ровно как пароль от VPN. */}
                <p className="text-xs text-warning">
                    В файле есть ссылки vless:// с ключами. Храните его как пароль.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={exportAll} disabled={busy !== ''}>
                        {busy === 'export' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Download className="h-4 w-4" />
                        )}
                        Скачать архив
                    </Button>
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <Upload className="h-4 w-4" aria-hidden="true" />
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".txt,text/plain"
                            aria-label="Файл с настройками"
                            disabled={busy !== ''}
                            onChange={(e) => {
                                const f = e.currentTarget.files?.[0]
                                if (f) void importAll(f)
                            }}
                            className="text-xs file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
                        />
                    </label>
                </div>

                <p className="text-xs text-muted-foreground">
                    Восстановление ничего не применяет: файл проверяется, настройки сохраняются, а
                    маршрутизация меняется только после «Применить». Так восстановление из файла,
                    присланного в мессенджере, не может незаметно перенастроить роутер.
                </p>
            </CardContent>
        </Card>
    )
}
