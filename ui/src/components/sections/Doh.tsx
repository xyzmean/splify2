import { useEffect, useState } from 'react'
import { Check, Lock, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { t } from '@/lib/i18n'
import { type Live } from '@/lib/live'

/** DoH: DNS по HTTPS.
 *
 *  ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ РАЗДЕЛ. Провайдер видит имена сайтов раньше всего остального: DNS
 *  идёт открытым текстом, и по нему же и блокируют — подменой ответа. Ни обход по SNI, ни
 *  маршрутизация по адресу до этого не доходят: адрес уже подменён. То есть DoH — не
 *  «дополнительная настройка», а первая ступень, и держать её в складе настроек значило бы
 *  прятать то, с чего надо начинать.
 *
 *  Список резолверов перенесён из Zapret Manager (usr/share/splify2/doh-providers.conf),
 *  вместе с названиями: человек, который пользуется и тем и этим, должен видеть один и тот
 *  же список и узнавать в нём выбранное.
 *
 *  Выбор применяется СРАЗУ, без «Сохранить»: здесь нет черновика, который имеет смысл
 *  копить, — это одно действие с немедленным последствием, и пилюля применения (она про
 *  спеку движка) к нему отношения не имеет. */

export default function Doh({ live }: { live: Live }) {
    const [st, setSt] = useState<Awaited<ReturnType<typeof rpc.dohState>> | null>(null)
    const [busy, setBusy] = useState('')

    const reload = () => rpc.dohState().then(setSt).catch(() => setSt(null))
    useEffect(() => { void reload() }, [])

    async function choose(id: string) {
        if (busy) return
        setBusy(id)
        try {
            const r = await rpc.dohSet(id)
            if (!r.ok) throw new Error(r.error || t('не применилось'))
            notify(t('DoH включён'))
            await reload()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function off() {
        if (busy) return
        setBusy('off')
        try {
            const r = await rpc.dohOff()
            if (!r.ok) throw new Error(r.error || t('не выключилось'))
            notify(t('DoH выключен'))
            await reload()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function toggleTunnel() {
        if (!st || busy) return
        setBusy('tunnel')
        try {
            const r = await rpc.dohTunnelSet(!st.via_tunnel)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            await reload()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    if (!st) return <div className="p-5 text-sm text-muted-foreground">{t('Загрузка…')}</div>

    if (!st.installed) {
        return (
            <Card>
                <CardHeader><CardTitle className="text-base">{t('DNS over HTTPS')}</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <div>{t('Пакет https-dns-proxy не установлен.')}</div>
                    <div className="text-xs text-muted-foreground">
                        {t('Он объявлен зависимостью splify2, поэтому обычно приезжает вместе с ним. Если его нет — поставьте его пакетным менеджером роутера.')}
                    </div>
                </CardContent>
            </Card>
        )
    }

    /* Ссылка есть, а в каталоге такой нет: человек вписал свою руками или взял из версии
       менеджера новее нашей. Это законное состояние, и показать надо ССЫЛКУ, а не «не
       настроено» — иначе выбор кажется потерянным. */
    const foreign = !st.active && st.urls.length > 0

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Lock className="h-4 w-4" aria-hidden="true" />
                        {t('DNS over HTTPS')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="text-sm">
                        {st.running
                            ? <span className="text-success">{t('работает')}</span>
                            : <span className="text-muted-foreground">{t('не запущен')}</span>}
                        {!st.enabled && st.running && (
                            <span className="ml-2 text-xs text-warning-fg">
                                {t('автозапуск выключен — после перезагрузки не вернётся')}
                            </span>
                        )}
                    </div>
                    {foreign && (
                        <div className="text-xs text-muted-foreground">
                            {t('Сейчас настроен резолвер не из этого списка:')}{' '}
                            <span className="break-all">{st.urls.join(', ')}</span>
                        </div>
                    )}
                    {/* force_dns — единственная тонкость, о которой человек обязан знать: у
                        движка своё перенаправление DNS, и два на одном порту дают гонку,
                        после которой доменные правила молча перестают действовать. */}
                    {st.needs_dnsd && (
                        <div className="rounded-lg bg-accent px-3 py-2 text-xs text-muted-foreground">
                            {t('У вас есть правила по доменам, поэтому DNS сети заворачивает движок, а не https-dns-proxy (force_dns = 0). Иначе два перенаправления на порт 53 спорят между собой, и правила по доменам перестают действовать.')}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle className="text-base">{t('Резолвер')}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                    {st.providers.map((p) => {
                        const on = st.active === p.id
                        return (
                            <button
                                key={p.id}
                                type="button"
                                disabled={busy !== ''}
                                onClick={() => void choose(p.id)}
                                className={[
                                    'flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm',
                                    'transition-colors duration-200 disabled:opacity-50',
                                    on ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                                ].join(' ')}
                            >
                                {on
                                    ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                                    : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                                {busy === p.id && (
                                    <span className="text-xs text-muted-foreground">{t('применяю…')}</span>
                                )}
                            </button>
                        )
                    })}
                    <div className="pt-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== '' || (!st.running && !st.active)}
                            onClick={() => void off()}
                        >
                            {t('Выключить DoH')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        {t('DoH через туннель')}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-start gap-2.5">
                        <Switch
                            on={st.via_tunnel}
                            label={t('DoH через туннель')}
                            disabled={busy !== ''}
                            onClick={() => void toggleTunnel()}
                        />
                        <div className="min-w-0">
                            <div className="text-[13px]">{t('Запросы к резолверу — через туннель')}</div>
                            <div className="text-xs text-muted-foreground">
                                {/* Зачем это вообще нужно: сам резолвер тоже закрывают, и
                                    тогда DoH не поднимается, dnsmasq остаётся без серверов,
                                    и «интернет пропал» при исправном туннеле рядом. */}
                                {st.via_tunnel
                                    ? st.out
                                        ? t('идут через выход') + ` ${st.out}`
                                        : t('поднятого выхода нет — пока идут напрямую')
                                    : t('cloudflare-dns.com и dns.google закрывают так же, как сайты; тогда DoH не поднимается вовсе')}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {t('Касается только самого роутера — устройств сети не затрагивает. Туннель упал — запросы сами пойдут напрямую: иначе роутер не смог бы разрешить имя узла своего же туннеля и не поднял бы его никогда.')}
                            </div>
                        </div>
                    </div>
                    {st.via_tunnel && !live.status?.outputs && (
                        <div className="mt-2 text-xs text-warning-fg">
                            {t('движок не отвечает — правило поставится при следующем «Применить»')}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
