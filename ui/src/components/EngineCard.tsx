import { useEffect, useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { t } from '@/lib/i18n'

// Установка движка из интерфейса.
//
// Зачем это здесь, а не в установочном скрипте (он тоже есть). Движок — отдельный пакет, и
// какой из двух вариантов нужен, зависит от того, поднимает ли туннель сам движок. Это выбор
// ЧЕЛОВЕКА, а не пакетного менеджера: зависимость apk умеет только «нужен steer», и угадав
// за него, мы либо кладём лишнее, либо не кладём нужное — и тогда человек получает «выход
// vless не работает» без всякого объяснения, уже настроив всё остальное.
//
// Поэтому объяснение стоит РЯДОМ с выбором, а не в документации: тот, кто открыл интерфейс,
// в документацию не пошёл.

interface Props {
    /** Что сейчас установлено. null — ещё не спросили. */
    engine: { present: boolean; vless: boolean; arch?: string; version?: string } | null
    onInstalled: () => void
}

export default function EngineCard({ engine, onInstalled }: Props) {
    const [versions, setVersions] = useState<string[] | null>(null)
    const [ver, setVer] = useState('')
    const [ext, setExt] = useState(true)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.steerVersions()
            .then((r) => {
                setVersions(r.versions || [])
                // Первая в списке — самая свежая: релизы отдаются от новых к старым.
                if (r.versions?.length) setVer(r.versions[0])
            })
            .catch(() => setVersions([]))
    }, [])

    async function install() {
        if (!ver) { notify(t('Выберите версию'), 'warning'); return }
        setBusy(true)
        try {
            const r = await rpc.steerInstall(ver, ext)
            if (!r.ok) throw new Error(r.error || t('не установилось'))
            notify(`${t('Движок установлен')}: ${r.installed}`)
            onInstalled()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    /** Заголовок говорит, что не так, ДО того как человек начнёт настраивать. Три разных
     *  случая, и путать их нельзя: нет движка вовсе, стоит базовый (а нужен расширенный),
     *  или всё на месте и это просто обновление. */
    const title = !engine?.present
        ? t('Движок не установлен')
        : !engine.vless
          ? t('Установлен базовый движок')
          : t('Движок')

    return (
        <Card className={engine?.present && engine.vless ? '' : 'border-sp-destructive'}>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {engine?.present && (
                    <p className="text-xs text-sp-muted-foreground">
                        {t('Сейчас')}: steer {engine.version || '?'}
                        {engine.vless ? ` (${t('расширенный')})` : ` (${t('базовый')})`}
                        {engine.arch ? ` · ${engine.arch}` : ''}
                    </p>
                )}
                {!engine?.present && (
                    <p className="text-sm">
                        {t('Без него маршрутизировать нечем: splify2 только показывает и настраивает, а решает, куда идёт трафик, движок.')}
                    </p>
                )}
                {engine?.present && !engine.vless && (
                    <p className="text-sm">
                        {t('Базовый умеет всё, кроме одного: поднимать туннель VLESS сам. Для подписки нужен расширенный.')}
                    </p>
                )}

                {/* Вариант — двумя объяснёнными строками, а не выпадающим списком из двух
                    непонятных слов: выбор здесь содержательный, и человек должен видеть, чем
                    один отличается от другого, не уходя со страницы. */}
                <div className="space-y-2">
                    {[
                        {
                            on: true,
                            name: t('Расширенный'),
                            why: t('Поднимает туннель сам: вставили ссылку подписки — и всё. Больше на ~250 КБ.'),
                        },
                        {
                            on: false,
                            name: t('Базовый'),
                            why: t('Только маршрутизация. Туннель поднимаете вы: wireguard, amneziawg — что уже работает.'),
                        },
                    ].map((o) => (
                        <button
                            key={String(o.on)}
                            type="button"
                            aria-pressed={ext === o.on}
                            onClick={() => setExt(o.on)}
                            className={[
                                'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                                ext === o.on ? 'border-sp-primary bg-sp-primary/10' : 'border-sp-border',
                            ].join(' ')}
                        >
                            <span
                                className={[
                                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                    ext === o.on
                                        ? 'border-sp-primary bg-sp-primary text-sp-primary-foreground'
                                        : 'border-sp-border',
                                ].join(' ')}
                                aria-hidden="true"
                            >
                                {ext === o.on && <Check className="h-3 w-3" />}
                            </span>
                            <span>
                                <span className="font-medium">{o.name}</span>
                                <span className="block text-xs text-sp-muted-foreground">{o.why}</span>
                            </span>
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <select
                        value={ver}
                        onChange={(e) => setVer(e.target.value)}
                        aria-label={t('Версия движка')}
                        className="rounded-lg border border-sp-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sp-ring"
                    >
                        {versions === null && <option value="">{t('загрузка…')}</option>}
                        {versions?.length === 0 && <option value="">{t('релизов не найдено')}</option>}
                        {versions?.map((v, i) => (
                            <option key={v} value={v}>
                                {v}
                                {i === 0 ? ` — ${t('свежая')}` : ''}
                            </option>
                        ))}
                    </select>
                    <Button onClick={install} disabled={busy || !ver}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        {engine?.present ? t('Переустановить') : t('Установить')}
                    </Button>
                </div>

                {versions?.length === 0 && (
                    <p className="text-xs text-sp-muted-foreground">
                        {t('Список версий не пришёл — проверьте интернет на роутере. Можно поставить пакет вручную:')}{' '}
                        <a
                            href="https://github.com/xyzmean/steer/releases"
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted"
                        >
                            github.com/xyzmean/steer/releases
                        </a>
                    </p>
                )}
            </CardContent>
        </Card>
    )
}
