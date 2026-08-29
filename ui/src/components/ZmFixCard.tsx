import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'

/** Фикс Zapret Manager.
 *
 *  Zapret Manager ставится и обновляется с GitHub, аддоны берёт оттуда же, а у той аудитории,
 *  ради которой splify2 и существует, GitHub закрыт. Поэтому адреса GitHub уводятся в туннель
 *  сами — правилом, которое иначе надо сначала догадаться создать.
 *
 *  Касается это ТОЛЬКО самого роутера: метка ставится в цепочке `output`, куда попадает лишь
 *  то, что роутер отправил сам. У устройств сети свои средства обхода, и уводить их трафик за
 *  них никто не просил — в правилах человека фикс тоже не появляется.
 *
 *  Включено по умолчанию: нужен он именно тем, кто ещё ничего не настроил. Выключатель — то
 *  единственное место, где им управляют. */

export default function ZmFixCard() {
    const [on, setOn] = useState<boolean | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        rpc.zmFix()
            .then((r) => setOn(r.on !== false))
            .catch(() => setOn(null))
    }, [])

    async function toggle() {
        if (on === null || busy) return
        const next = !on
        setOn(next)
        setBusy(true)
        try {
            const r = await rpc.zmFixSet(next)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            notify(t('Сохранено'))
        } catch (e) {
            setOn(!next)
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{t('Фикс Zapret Manager')}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="flex items-start gap-2.5">
                    <Switch
                        on={on === true}
                        label={t('Адреса GitHub через туннель')}
                        disabled={busy || on === null}
                        onClick={() => void toggle()}
                    />
                    <div className="min-w-0">
                        <div className="text-[13px]">{t('Адреса GitHub через туннель')}</div>
                        <div className="text-xs text-muted-foreground">
                            {on
                                ? t('касается только самого роутера — устройств сети не затрагивает')
                                : t('GitHub пойдёт как обычно')}
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
