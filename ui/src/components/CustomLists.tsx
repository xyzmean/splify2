import { useRef, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { customServices } from '@/lib/model'

// Свои списки доменов и адресов.
//
// Вопрос задан снаружи: маршрутизировать можно было только то, что опубликовал издатель.
// Движок сопоставляет исключительно по файлам, а каталог рисуется из манифеста, поэтому
// свой .lst, положенный в /etc/steer/lists руками, был виден local_lists — и не
// предлагался ни одному правилу.
//
// Три способа ввода, и все три сводятся к одному методу rpcd. Файл читается в браузере и
// уходит порциями через append: cgi-io означал бы второй путь загрузки со своими правами
// и своей проверкой формата, а проверка формата здесь не косметическая — непринятая
// строка это молча пустой канал.

/** По сколько строк отправлять файл. ubus не резиновый, и целиком большой список в один
 *  вызов не помещается; тысяча строк — это порядка 20 КБ, с запасом. */
const CHUNK = 1000

export default function CustomLists({
    local,
    onChanged,
}: {
    local: Record<string, { count: number; mtime: number }>
    onChanged: () => void | Promise<void>
}) {
    const [name, setName] = useState('')
    const [kind, setKind] = useState<'domains' | 'prefixes'>('domains')
    const [text, setText] = useState('')
    const [url, setUrl] = useState('')
    const [busy, setBusy] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)

    const mine = customServices(local)
    const nameOk = /^[A-Za-z0-9_-]+$/.test(name)

    /** Общий хвост всех трёх способов: сообщить, сколько принято и сколько отброшено, и
     *  перечитать список. Отброшенные строки называются числом всегда — молчаливая потеря
     *  здесь была бы худшим из возможных поведений. */
    async function done(count: number, dropped: number) {
        await onChanged()
        notify(
            dropped
                ? `Список «${name}»: строк ${count}, отброшено ${dropped} — формат не подошёл`
                : `Список «${name}»: строк ${count}`,
            dropped ? 'warning' : 'info',
        )
        setText('')
        setUrl('')
        if (fileRef.current) fileRef.current.value = ''
    }

    async function putText() {
        if (!nameOk) { notify('Имя списка: латиница, цифры, дефис и подчёркивание', 'warning'); return }
        if (!text.trim()) { notify('Список пуст', 'warning'); return }
        setBusy(true)
        try {
            const r = await rpc.listPut({ name, kind, text })
            if (!r.ok) throw new Error(r.error || 'не сохранилось')
            await done(r.count ?? 0, r.dropped ?? 0)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    async function putUrl() {
        if (!nameOk) { notify('Имя списка: латиница, цифры, дефис и подчёркивание', 'warning'); return }
        if (!/^https?:\/\//.test(url.trim())) { notify('Ссылка должна начинаться с http:// или https://', 'warning'); return }
        setBusy(true)
        try {
            const r = await rpc.listPut({ name, kind, url: url.trim() })
            if (!r.ok) throw new Error(r.error || 'не скачалось')
            await done(r.count ?? 0, r.dropped ?? 0)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    async function putFile(file: File) {
        if (!nameOk) { notify('Имя списка: латиница, цифры, дефис и подчёркивание', 'warning'); return }
        setBusy(true)
        try {
            const lines = (await file.text()).split(/\r?\n/)
            let count = 0
            let dropped = 0
            // Первая порция ЗАМЕЩАЕТ, остальные дописываются. Иначе повторная загрузка
            // того же файла удваивала бы список, а не обновляла его.
            for (let i = 0; i < lines.length; i += CHUNK) {
                const r = await rpc.listPut({
                    name,
                    kind,
                    text: lines.slice(i, i + CHUNK).join('\n'),
                    append: i > 0,
                })
                if (!r.ok) throw new Error(r.error || 'не сохранилось')
                count = r.count ?? count
                dropped += r.dropped ?? 0
            }
            await done(count, dropped)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    async function remove(listName: string, listKind: 'domains' | 'prefixes') {
        setBusy(true)
        try {
            const r = await rpc.listRemoveCustom(listName, listKind)
            if (!r.ok) throw new Error(r.error || 'не удалось удалить')
            await onChanged()
            notify(`Список «${listName}» удалён`)
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className="rounded-md border border-border bg-card p-4">
            <h3 className="sp-sub">Свои списки</h3>
            <p className="mt-1 text-xs text-muted-foreground">
                Домены и подсети, которых нет у издателя. После добавления список появится в
                редакторе правил рядом с остальными — сам по себе он ничего не меняет.
            </p>

            {mine.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-sm">
                    {mine.map((sv) => (
                        <li key={sv.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">
                                {sv.name}
                                <span className="ml-2 text-xs text-muted-foreground">
                                    {sv.domains.length ? 'домены' : 'подсети'} · записей {sv.count}
                                </span>
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Удалить список ${sv.name}`}
                                onClick={() => remove(sv.name, sv.domains.length ? 'domains' : 'prefixes')}
                            >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        placeholder="имя списка"
                        aria-label="Имя списка"
                        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <select
                        value={kind}
                        onChange={(e) => setKind(e.currentTarget.value as 'domains' | 'prefixes')}
                        aria-label="Вид списка"
                        className="rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        <option value="domains">домены</option>
                        <option value="prefixes">подсети</option>
                    </select>
                </div>
                {name && !nameOk && (
                    <p className="text-xs text-destructive">
                        имя пойдёт в имя файла на роутере: только латиница, цифры, дефис и подчёркивание
                    </p>
                )}

                <div>
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.currentTarget.value)}
                        rows={4}
                        aria-label="Записи списка"
                        placeholder={
                            kind === 'domains'
                                ? 'по одному имени на строку:\nexample.org\nsub.example.net'
                                : 'по одной подсети на строку:\n10.0.0.0/8\n192.0.2.1'
                        }
                        className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button onClick={putText} disabled={busy || !nameOk || !text.trim()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                            Сохранить
                        </Button>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".lst,.txt,text/plain"
                            aria-label="Файл со списком"
                            disabled={busy || !nameOk}
                            onChange={(e) => {
                                const f = e.currentTarget.files?.[0]
                                if (f) void putFile(f)
                            }}
                            className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
                        />
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.currentTarget.value)}
                        placeholder="https://… — скачает роутер"
                        aria-label="Ссылка на список"
                        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <Button variant="secondary" onClick={putUrl} disabled={busy || !nameOk || !url.trim()}>
                        Скачать
                    </Button>
                </div>
                {/* Сказать сразу: обновления по расписанию у своего списка нет. Ждать его
                    молча — то же самое, что показывать устаревшие данные как свежие. */}
                <p className="text-xs text-muted-foreground">
                    Скачивается один раз. Обновлять придётся этой же кнопкой: расписание есть только
                    у списков издателя.
                </p>
            </div>
        </section>
    )
}
