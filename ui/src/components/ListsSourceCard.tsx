import { useEffect, useState } from 'react'
import { Library } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'

/** Откуда роутер берёт КАТАЛОГ списков.
 *
 *  ЗАЧЕМ ЭТО НА ЭКРАНЕ. Ссылка на каталог жила в uci и раньше, но задать её можно было
 *  только по ssh — то есть настройка существовала для одного человека из ста. А выбор здесь
 *  осмысленный: свой форк каталога со своими списками, каталог соседа, каталог без чужих
 *  источников. Каталог — это перечень («какие списки бывают и где лежит каждый»), а не сами
 *  списки: смена источника не выбрасывает то, что уже скачано, и не трогает правила.
 *
 *  ПОЛЕ, А НЕ ВЫБОР ИЗ ДВУХ. Список готовых источников здесь был бы вымыслом: их ровно
 *  столько, сколько форков у людей, и назвать мы можем только свой. Поэтому — адрес и
 *  кнопка «вернуть свой», чтобы человек, попробовавший чужой каталог, мог вернуться, не
 *  вспоминая ссылку. */
export default function ListsSourceCard() {
    const [url, setUrl] = useState<string | null>(null)
    const [def, setDef] = useState('')
    const [isDefault, setIsDefault] = useState(true)
    const [busy, setBusy] = useState(false)

    const load = () =>
        rpc.listsSource()
            .then((r) => {
                setUrl(r.url || '')
                setDef(r.default_url || '')
                setIsDefault(!!r.default)
            })
            .catch(() => setUrl(''))

    useEffect(() => { void load() }, [])

    async function save(next: string) {
        if (busy) return
        setBusy(true)
        try {
            const r = await rpc.listsSourceSet(next)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            notify(next ? t('Источник списков изменён') : t('Вернулся свой каталог списков'))
            await load()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    if (url === null) return null

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                    <Library className="h-4 w-4" aria-hidden="true" />
                    {t('Источник списков')}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.currentTarget.value)}
                        placeholder={def}
                        aria-label={t('ссылка каталога списков')}
                        className="h-9 min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs"
                    />
                    <Button size="sm" disabled={busy} onClick={() => void save(url.trim())}>
                        {busy ? t('минуту…') : t('Сохранить')}
                    </Button>
                    {/* «Вернуть свой» показывается только когда есть что возвращать: кнопка,
                        которая ничего не меняет, учит не читать кнопки. */}
                    {!isDefault && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save('')}>
                            {t('Вернуть свой')}
                        </Button>
                    )}
                </div>
                <div className="text-xs text-muted-foreground">
                    {t('Каталог — это перечень списков: какие бывают, как называются и где лежит каждый. Уже скачанные списки и правила смена источника не трогает.')}
                </div>
                {isDefault && (
                    <div className="text-xs text-muted-foreground">
                        {t('Сейчас — каталог splify2.')}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
