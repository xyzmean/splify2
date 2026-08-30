import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { human } from '@/lib/live'
import { isSubSource } from '@/lib/validate'
import { agoText } from '@/lib/quota'
import { subsRemember, subsRemembered } from '@/lib/subs'

/** VLESS: откуда берутся узлы.
 *
 *  ПОДПИСОК НЕСКОЛЬКО. Их и правда бывает несколько — у человека две панели, — и раньше это
 *  не выражалось ничем: файл узлов был один на роутер жёстко. Теперь у каждой своё имя, свой
 *  файл и свой остаток, а выход выбирает подписку, из которой берёт локацию.
 *
 *  Локации здесь НЕ выбираются: локация — свойство выхода, и выбирают её там, где выход
 *  собирают. Два места, назначающие узел, разошлись бы на первом же переключении. */

interface Sub {
    name: string
    title?: string
    url?: string
    kind?: 'url' | 'links' | 'none'
    path: string
    present: boolean
    bytes?: number
    mtime?: number
    used?: number
}

export default function VlessScreen() {
    /* Перечень рисуется С ЗАПОМНЕННОГО: пока `sub_list` идёт (а уходит он после загрузки
     * LuCI, загрузчика и бандла), экран показывал «Загрузка…» и затем разом выкладывал
     * карточки. Запомнены только имена и пути — числа у каждой подписки свои, см.
     * lib/subs.ts. */
    const [subs, setSubs] = useState<Sub[] | null>(() => subsRemembered())
    const [hwid, setHwid] = useState('')
    const [name, setName] = useState('')
    const [url, setUrl] = useState('')
    const [busy, setBusy] = useState('')

    const load = useCallback(async () => {
        try {
            const r = await rpc.subList()
            setSubs(r.subs || [])
            setHwid(r.hwid || '')
            subsRemember(r.subs)
        } catch {
            /* Бэкенд постарше перечня не знает: тогда подписка одна, и спросить о ней можно
             * только прежним способом. */
            try {
                const one = await rpc.subInfo()
                const only = [
                    {
                        name: 'main',
                        url: one.url,
                        kind: one.kind,
                        path: one.path,
                        present: one.present,
                        bytes: one.bytes,
                        mtime: one.mtime,
                    },
                ]
                setSubs(only)
                setHwid(one.hwid || '')
                subsRemember(only)
            } catch {
                setSubs([])
                /* Роутер не ответил ни на перечень, ни на прежний вопрос об одной подписке.
                 * Запомненное снимается: рисовать по нему карточки, которых роутер не
                 * подтверждает, значит обещать кнопки «обновить» и «удалить» для того, чего
                 * может уже не быть. */
                subsRemember([])
            }
        }
    }, [])

    useEffect(() => { void load() }, [load])

    async function add() {
        const src = url.trim()
        if (!isSubSource(src)) {
            notify('Нужна ссылка подписки (http:// или https://) либо ссылка vless://', 'warning')
            return
        }
        /* Имя файла узлов — латиница и цифры, и придумывать его человек не обязан: название
         * подписки называет сама панель заголовком profile-title, а здесь достаточно
         * различить файлы. Занятое имя не переиспользуем — иначе новая подписка молча
         * затёрла бы старую (ровно это и случилось на стенде). */
        let n = (name.trim() || 'sub').replace(/[^A-Za-z0-9_-]/g, '') || 'sub'
        if (!name.trim() || subs?.some((x) => x.name === n)) {
            let i = subs?.length ? subs.length + 1 : 1
            const busyNames = new Set((subs || []).map((x) => x.name))
            while (busyNames.has(`sub${i}`)) i++
            n = `sub${i}`
        }
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(n)) {
            notify('Имя: латиница, цифры, дефис или подчёркивание', 'warning')
            return
        }
        setBusy(n)
        try {
            const r = await rpc.subSet(src, n, name.trim())
            if (!r.ok) { notify(r.error || 'подписка не сохранилась', 'error'); return }
            if (r.warn) notify(r.warn, 'warning')
            setName('')
            setUrl('')
            await load()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function refresh(s: Sub) {
        if (!s.url) return
        setBusy(s.name)
        try {
            const r = await rpc.subSet(s.url, s.name, s.title || '')
            if (!r.ok) notify(r.error || 'подписка не скачалась', 'error')
            await load()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function remove(s: Sub) {
        setBusy(s.name)
        try {
            const r = await rpc.subDel(s.name)
            if (!r.ok) { notify(r.error || 'подписка не удалилась', 'warning'); return }
            await load()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    if (subs === null) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    return (
        <div className="space-y-3">
            {subs.map((s) => (
                <Card key={s.name}>
                    <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-x-2 gap-y-1 space-y-0">
                        <CardTitle>{s.title || s.name}</CardTitle>
                        <div className="flex items-center gap-3 text-xs">
                            {s.kind === 'url' && (
                                <button
                                    type="button"
                                    onClick={() => void refresh(s)}
                                    disabled={busy === s.name}
                                    className="sp-row flex items-center gap-1.5 bg-transparent p-0 text-primary underline decoration-dotted disabled:opacity-60"
                                >
                                    {busy === s.name ? (
                                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                    )}
                                    Обновить
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => void remove(s)}
                                disabled={busy === s.name}
                                aria-label={`удалить ${s.title || s.name}`}
                                className="sp-row flex items-center gap-1.5 bg-transparent p-0 text-destructive underline decoration-dotted disabled:opacity-60"
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Удалить
                            </button>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-1 text-[13px]">
                        <div className="truncate font-mono text-xs text-subtle">
                            {s.kind === 'links' ? 'ссылки vless://' : s.url || '—'}
                        </div>
                        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                            {s.present ? (
                                <>
                                    <span>{human(s.bytes || 0)}</span>
                                    {s.mtime ? <span>обновлена {agoText(Date.now() - s.mtime * 1000)}</span> : null}
                                </>
                            ) : (
                                <span className="text-warning-fg">не скачана</span>
                            )}
                            <span>выходов: {s.used ?? 0}</span>
                        </div>
                    </CardContent>
                </Card>
            ))}

            <Card>
                <CardHeader>
                    <CardTitle>Добавить подписку</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    <input
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        placeholder="имя (необязательно)"
                        aria-label="имя подписки"
                        className="h-[38px] w-[10.5rem] rounded-lg border border-border bg-background px-3 text-sm"
                    />
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === 'Enter' && add()}
                        placeholder="ссылка подписки или vless://"
                        aria-label="ссылка подписки"
                        className="h-[38px] min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-[13px]"
                    />
                    <Button onClick={add} disabled={!!busy}>
                        <Plus className="h-4 w-4" aria-hidden="true" /> Добавить
                    </Button>
                </CardContent>
            </Card>

            {hwid && (
                <div className="flex items-baseline justify-between gap-2 px-1 text-xs">
                    <span className="text-subtle">HWID</span>
                    <span className="font-mono text-muted-foreground">{hwid}</span>
                </div>
            )}
        </div>
    )
}
