import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'

/** Чем роутер качает списки и обновления.
 *
 *  ЗАЧЕМ ЭТО ВЫБОР ЧЕЛОВЕКА, А НЕ АВТОМАТИКА. По умолчанию туннель стоит последним: сначала
 *  прямой адрес, потом те же файлы с хостов самого GitHub. Роутеру, у которого издатель
 *  доступен, менять нечего. Но там, где провайдер закрыл `githubusercontent.com` насовсем
 *  (splify2#15), автоматика каждый раз проходит две ступени впустую, а вторая в худшем случае
 *  тянет архив ветки целиком ради одного списка. Человек знает про свою сеть больше нас и
 *  вправе сказать «ходи сразу через туннель»: тогда файл едет по прямому адресу одним запросом.
 *
 *  Имя выхода показано рядом с выбором, а не спрятано в подсказке: без поднятого выхода
 *  «через туннель» не даст ничего, и знать это надо ДО того, как человек его выберет. */

/** Три значения хранит бэкенд (`auto` — туннель последней ступенью, `always` — первой, `off` —
 *  не трогать вовсе), но человеку показывается ОДИН переключатель: «качать через туннель» или
 *  нет. Три варианта требовали прочитать и сравнить три подписи ради настройки, которую
 *  меняют раз в жизни. `off` остаётся для того, кто дойдёт до uci: запретить туннель совсем —
 *  это уже не выбор пути, а его запрет. */
type Mode = 'auto' | 'always' | 'off'

export default function FetchCard() {
    const [mode, setMode] = useState<Mode | null>(null)
    const [out, setOut] = useState('')
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.fetchMode()
            .then((r) => {
                setMode((r.mode as Mode) || 'auto')
                setOut(r.out || '')
            })
            .catch(() => setMode('auto'))
    }, [])

    async function choose(next: Mode) {
        if (next === mode || busy) return
        const prev = mode
        setMode(next)
        setBusy(true)
        try {
            const r = await rpc.fetchModeSet(next)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            notify(t('Сохранено'))
        } catch (e) {
            // Возврат к прежнему значению обязателен: иначе на экране остаётся выбор,
            // которого на роутере нет, и человек уверен, что настроил.
            setMode(prev)
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    const on = mode === 'always'

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{t('Качать списки через туннель')}</CardTitle>
                <CardDescription>
                    {t('Списки, каталог и пакеты роутер берёт с GitHub. У части провайдеров githubusercontent.com закрыт — тогда роутер сходит за ними через ваш туннель.')}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                <label className="flex cursor-pointer items-center gap-3">
                    <input
                        type="checkbox"
                        role="switch"
                        checked={on}
                        disabled={busy || mode === null}
                        onChange={() => void choose(on ? 'auto' : 'always')}
                        className="h-4 w-4 accent-[var(--sp-primary)]"
                    />
                    <span className="text-[13px]">
                        {on ? t('Да, сразу через туннель') : t('Нет, только если не вышло напрямую')}
                    </span>
                </label>

                {/* Имя выхода — рядом с переключателем, а не в подсказке: без поднятого выхода
                    «через туннель» не даст ничего, и знать это надо ДО того, как человек его
                    включит. */}
                {on &&
                    (out ? (
                        <p className="text-xs text-muted-foreground">
                            {t('Пойдёт через выход')} <span className="font-medium text-foreground">{out}</span>.
                        </p>
                    ) : (
                        <p className="text-xs text-warning-fg">
                            {t('Поднятого выхода со своей таблицей маршрутизации сейчас нет — скачивание пойдёт обычным порядком, пока он не появится.')}
                        </p>
                    ))}
            </CardContent>
        </Card>
    )
}
