import { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { rpc } from '@/lib/rpc'
import { cmpVersion, type SelfUpdateInfo, releaseName } from '@/lib/engine'
import { t } from '@/lib/i18n'

// Обновление самого интерфейса.
//
// Зачем это вообще нужно. Ни один пакет проекта не лежит в feeds OpenWrt, поэтому
// `apk upgrade` их не видит: движок из интерфейса ставился с первого дня, а сам
// интерфейс обновляли по ssh. Обновлять умели ровно то, что меняется реже.
//
// Отдельной карточкой, а не строкой в карточке движка: это разные пакеты с разными
// версиями, и объединять их значило бы заставить человека держать в голове, к чему
// относится показанное число.

export default function SelfUpdateCard({
    info,
    onInstalled,
}: {
    info: SelfUpdateInfo | null
    onInstalled: () => void
}) {
    const [ver, setVer] = useState('')
    const [busy, setBusy] = useState(false)
    /** Что сказал установщик. Держится на экране, а не всплывашкой: там бывает
     *  требование перезапустить сеть руками, и уехавший через пять секунд тост означал бы,
     *  что требование не выполнят. */
    const [notes, setNotes] = useState('')

    const versions = info?.versions ?? []
    const latest = versions.length ? versions[0] : null
    // Ровно то же правило, что и у движка (I-038): пока список не пришёл, про «свежее»
    // мы не знаем ничего, и обещать обновление нельзя.
    const outdated = !!(latest && info?.current && cmpVersion(info.current, latest) < 0)
    const label = outdated
        ? `${t('Обновить до')} ${releaseName(latest!, info?.names)}`
        : t('Переустановить')

    useEffect(() => {
        if (latest) setVer((v) => v || latest)
    }, [latest])

    async function install() {
        if (!ver) { notify(t('Выберите версию'), 'warning'); return }
        setBusy(true)
        try {
            const r = await rpc.splify2Install(ver)
            if (!r.ok) throw new Error(r.error || t('не установилось'))
            notify(`${t('Интерфейс обновлён')}: ${r.installed}. ${t('Перезагрузите страницу.')}`)
            /* Слова установщика — на экран, дословно и целиком. Сокращать нельзя по той же
               причине, по которой не сокращаются предупреждения движка: там названа
               причина, а не оформление. Пустой вывод (штатная установка, менять нечего)
               блок не рисует. */
            setNotes((r.output || '').trim())
            onInstalled()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('Интерфейс')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                    {t('Сейчас')}: luci-app-splify2 {info?.current || '?'}
                </p>
                {/* Сказать это до нажатия, а не после: rpcd перезапускается вместе с
                    пакетом, бандл у браузера в кеше, и человек, не перезагрузивший
                    страницу, увидит старый интерфейс поверх нового бэкенда. */}
                <p className="text-sm">
                    {t('Пакета нет в feeds OpenWrt, поэтому обновляется он отсюда, а не через apk upgrade. После установки перезагрузите страницу: интерфейс в браузере остаётся прежним, пока она открыта.')}
                </p>

                <div className="flex flex-wrap items-center gap-2">
                    <select
                        value={ver}
                        onChange={(e) => setVer(e.target.value)}
                        aria-label={t('Версия интерфейса')}
                        className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        {info === null && <option value="">{t('загрузка…')}</option>}
                        {info !== null && versions.length === 0 && <option value="">{t('релизов не найдено')}</option>}
                        {/* Подпись — название выпуска, значение — версия: ею собирается имя
                            файла пакета, и пробелу там места нет. */}
                        {versions.map((v, i) => (
                            <option key={v} value={v}>
                                {releaseName(v, info?.names)}
                                {i === 0 ? ` — ${t('свежая')}` : ''}
                            </option>
                        ))}
                    </select>
                    <Button onClick={install} disabled={busy || !ver}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        {label}
                    </Button>
                </div>

                {/* Сказанное установщиком. Единственное место, где текст приходит от
                    менеджера пакетов как есть — и единственный канал, которым post-install
                    может о чём-то попросить человека с браузером. */}
                {notes && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
                        <p className="text-xs font-semibold text-warning">{t('Установщик сказал')}:</p>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
                            {notes}
                        </pre>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
