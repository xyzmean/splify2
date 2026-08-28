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

type Mode = 'auto' | 'always' | 'off'

const CHOICES: { id: Mode; label: string; hint: string }[] = [
    {
        id: 'auto',
        label: 'Сам разберётся',
        hint: 'Сначала напрямую, потом с других адресов GitHub, и только потом через туннель.',
    },
    {
        id: 'always',
        label: 'Через туннель',
        hint: 'Сразу через туннель — одним запросом, без обходных адресов. Если GitHub у вас закрыт, берите этот.',
    },
    {
        id: 'off',
        label: 'Только напрямую',
        hint: 'Туннель не трогать. Списки и обновления пойдут только своим каналом.',
    },
]

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

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{t('Откуда качать списки и обновления')}</CardTitle>
                <CardDescription>
                    {t('Списки, каталог и пакеты роутер берёт с GitHub. У части провайдеров githubusercontent.com закрыт — тогда роутер может ходить за ними через ваш туннель.')}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('Откуда качать')}>
                    {CHOICES.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            role="radio"
                            aria-checked={mode === c.id}
                            disabled={busy || mode === null}
                            onClick={() => choose(c.id)}
                            className={[
                                'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                mode === c.id
                                    ? 'border-primary bg-primary/10 font-medium text-primary'
                                    : 'border-input text-muted-foreground hover:text-foreground',
                            ].join(' ')}
                        >
                            {t(c.label)}
                        </button>
                    ))}
                </div>

                <p className="text-xs text-muted-foreground">
                    {t(CHOICES.find((c) => c.id === mode)?.hint || '')}
                </p>

                {mode === 'always' &&
                    (out ? (
                        <p className="text-xs text-muted-foreground">
                            {t('Пойдёт через выход')} <span className="font-medium text-foreground">{out}</span>.
                        </p>
                    ) : (
                        <p className="text-xs text-warning">
                            {t('Поднятого выхода со своей таблицей маршрутизации сейчас нет — скачивание пойдёт обычным порядком, пока он не появится.')}
                        </p>
                    ))}
            </CardContent>
        </Card>
    )
}
