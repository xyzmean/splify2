import { useEffect, useState } from 'react'
import { Check, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
 *  спеку движка) к нему отношения не имеет.
 *
 *  ДВЕ КАРТОЧКИ, А НЕ ТРИ. Состояние («работает») стояло отдельной карточкой над списком
 *  резолверов и занимало треть экрана одним словом. Теперь оно в шапке той же карточки, где
 *  список: состояние и выбор — одно целое, и слово «работает» читается рядом с тем, что
 *  работает. Вторая карточка — про путь запросов к резолверу; это другой вопрос, и на широком
 *  экране она стоит справа, а не под длинным списком. */

export default function Doh({ live }: { live: Live }) {
    const [st, setSt] = useState<Awaited<ReturnType<typeof rpc.dohState>> | null>(null)
    const [busy, setBusy] = useState('')
    /** Форма своего резолвера развёрнута. Свёрнута по умолчанию: своё вписывают один раз, а
     *  два поля ввода под списком читались бы как обязательная настройка. */
    const [adding, setAdding] = useState(false)
    const [newUrl, setNewUrl] = useState('')
    const [newTitle, setNewTitle] = useState('')

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

    /** Режим: системный DNS (dnsmasq ходит к резолверам провайдера, как настроено в
     *  роутере) или DoH. Включение DoH без выбранного пункта берёт «по умолчанию». */
    async function mode(doh: boolean) {
        if (!st || busy) return
        if (!doh) { await off(); return }
        await choose(st.active || 'default')
    }

    async function addCustom() {
        const url = newUrl.trim()
        if (!/^https:\/\/\S+/.test(url)) {
            notify(t('Ссылка резолвера начинается с https://'), 'warning')
            return
        }
        if (busy) return
        setBusy('add')
        try {
            const r = await rpc.dohCustomAdd(url, newTitle.trim())
            if (!r.ok) throw new Error(r.error || t('не добавился'))
            if (r.warn) notify(r.warn, 'warning')
            else notify(t('Резолвер добавлен и включён'))
            setNewUrl('')
            setNewTitle('')
            setAdding(false)
            await reload()
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy('')
        }
    }

    async function delCustom(id: string) {
        if (busy) return
        setBusy(id)
        try {
            const r = await rpc.dohCustomDel(id)
            if (!r.ok) throw new Error(r.error || t('не удалился'))
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
    /* DoH «включён» — служба работает и ей есть к кому ходить: выбранный пункт или чужая
       ссылка. Остановленная служба при выбранном пункте — это тоже «выключено»: имена в
       этот момент разрешает dnsmasq сам. */
    const dohOn = st.running && (!!st.active || foreign)

    return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] xl:items-start">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Lock className="h-4 w-4" aria-hidden="true" />
                        <span className="flex-1">{t('DNS over HTTPS')}</span>
                        <span className="text-sm font-normal">
                            {st.running
                                ? <span className="text-success">{t('работает')}</span>
                                : <span className="text-muted-foreground">{t('не запущен')}</span>}
                        </span>
                    </CardTitle>
                    {!st.enabled && st.running && (
                        <CardDescription className="text-warning-fg">
                            {t('автозапуск выключен — после перезагрузки не вернётся')}
                        </CardDescription>
                    )}
                    {foreign && (
                        <CardDescription>
                            {t('Сейчас настроен резолвер не из этого списка:')}{' '}
                            <span className="break-all">{st.urls.join(', ')}</span>
                        </CardDescription>
                    )}
                </CardHeader>
                <CardContent className="space-y-1.5">
                    {/* force_dns — единственная тонкость, о которой человек обязан знать: у
                        движка своё перенаправление DNS, и два на одном порту дают гонку,
                        после которой доменные правила молча перестают действовать. */}
                    {st.needs_dnsd && (
                        <div className="mb-2 rounded-lg bg-accent px-3 py-2 text-xs text-muted-foreground">
                            {t('У вас есть правила по доменам, поэтому DNS сети заворачивает движок, а не https-dns-proxy (force_dns = 0). Иначе два перенаправления на порт 53 спорят между собой, и правила по доменам перестают действовать.')}
                        </div>
                    )}
                    {/* Режим — переключателем из двух положений, а не кнопкой «Выключить DoH»
                        под списком: «чем разрешаются имена» — выбор между двумя ответами, и
                        оба должны быть видны. «Системный DNS» — dnsmasq ходит к резолверам,
                        которые роутер получил от провайдера или которые вписаны в его
                        настройках; DoH — к выбранному ниже. */}
                    <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('чем разрешать имена')}>
                        {([false, true] as const).map((doh) => {
                            const on = doh ? dohOn : !dohOn
                            return (
                                <button
                                    key={String(doh)}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    disabled={busy !== ''}
                                    onClick={() => on ? undefined : void mode(doh)}
                                    className={[
                                        'rounded-lg border px-3 py-1.5 text-sm transition-colors duration-200 disabled:opacity-50',
                                        on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent',
                                    ].join(' ')}
                                >
                                    {doh ? t('DoH') : t('Системный DNS')}
                                </button>
                            )
                        })}
                        <span className="self-center text-xs text-muted-foreground">
                            {dohOn
                                ? t('запросы сети шифруются к выбранному резолверу')
                                : t('dnsmasq ходит к резолверам провайдера или роутера, как настроено в системе')}
                        </span>
                    </div>
                    {st.providers.map((p) => {
                        const on = dohOn && st.active === p.id
                        return (
                            <div key={p.id} className="flex items-center gap-1">
                                <button
                                    type="button"
                                    disabled={busy !== ''}
                                    onClick={() => void choose(p.id)}
                                    className={[
                                        'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm',
                                        'transition-colors duration-200 disabled:opacity-50',
                                        on ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                                    ].join(' ')}
                                >
                                    {on
                                        ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                                        : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                                    {p.custom && <span className="text-xs font-normal text-muted-foreground">{t('свой')}</span>}
                                    {busy === p.id && (
                                        <span className="text-xs text-muted-foreground">{t('применяю…')}</span>
                                    )}
                                </button>
                                {/* Удалить можно только своё: каталог приезжает с пакетом. */}
                                {p.custom && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                                        disabled={busy !== ''}
                                        aria-label={`${t('удалить')} ${p.title}`}
                                        onClick={() => void delCustom(p.id)}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                    </Button>
                                )}
                            </div>
                        )
                    })}
                    {/* Свой резолвер — за кнопкой, той же формы, что «новый выход» в обходе. */}
                    <button
                        type="button"
                        onClick={() => setAdding((v) => !v)}
                        aria-expanded={adding}
                        className={[
                            'mt-1 flex items-center gap-1 rounded-lg border border-dashed px-3 py-1.5 text-sm text-muted-foreground',
                            'transition-colors duration-200 hover:bg-accent',
                            adding ? 'border-primary text-primary' : 'border-border',
                        ].join(' ')}
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('свой резолвер')}
                    </button>
                    {adding && (
                        <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    value={newUrl}
                                    onChange={(e) => setNewUrl(e.currentTarget.value)}
                                    placeholder="https://dns.example.com/dns-query"
                                    aria-label={t('ссылка резолвера')}
                                    className="h-9 min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                                />
                                <input
                                    value={newTitle}
                                    onChange={(e) => setNewTitle(e.currentTarget.value)}
                                    placeholder={t('название (не обязательно)')}
                                    aria-label={t('название резолвера')}
                                    className="h-9 min-w-[10rem] rounded-lg border border-border bg-background px-3 text-sm"
                                />
                                <Button size="sm" disabled={busy !== '' || newUrl.trim() === ''} onClick={() => void addCustom()}>
                                    {busy === 'add' ? t('добавляю…') : t('Добавить')}
                                </Button>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {t('Ссылка — как её даёт провайдер DoH, обычно вида https://…/dns-query. Добавленный резолвер сразу включается.')}
                            </div>
                        </div>
                    )}
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
