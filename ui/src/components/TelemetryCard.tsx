import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'
import { notify } from '@/lib/notify'
import { fmtWhen } from '@/lib/format'
import { t } from '@/lib/i18n'

/** Согласие на телеметрию. Контракт целиком — docs/TELEMETRY.md.
 *
 *  ТРИ СОСТОЯНИЯ, А НЕ ДВА, и это главное в карточке. «Не спрашивали» даёт право предложить
 *  ОДИН РАЗ; «отказался» не даёт никогда; «включено» показывает, как оно работает. Свести
 *  первые два в один булев `on` — самая дешёвая и самая противная ошибка здесь: экран
 *  выглядит рабочим, а человек, однажды сказавший «нет», получает то же предложение при
 *  каждом открытии страницы. Отказ — это ответ, а не отсутствие ответа.
 *
 *  ПОЧЕМУ ЗДЕСЬ ЕСТЬ КНОПКА «ПОКАЗАТЬ ПАКЕТ». Согласие, у которого нельзя проверить, на что
 *  оно даётся, согласием не является. Перечень полей в прозе для этого не годится: он врёт
 *  ровно тогда, когда важен, — когда в чью-то настройку затесалось лишнее. Поэтому кнопка
 *  зовёт `telemetry_preview`, который зовёт ТОТ ЖЕ сборщик, что и отправка, и показывает
 *  приехавшее ДОСЛОВНО: карточка не знает схемы пакета и не пересобирает его по своим
 *  представлениям — иначе она показывала бы не то, что уедет, а то, что мы думаем об этом.
 *
 *  ПРЕДПРОСМОТР РАБОТАЕТ И ПРИ ВЫКЛЮЧЕННОЙ ТЕЛЕМЕТРИИ — иначе посмотреть, что уедет, можно
 *  было бы только после согласия, то есть после того, как оно уже уехало. */

type Consent = 'unset' | 'off' | 'on'

interface St {
    consent: Consent
    /** Пусто, пока идентификатор не посчитан: его счёт стоит секунд, и ради опроса
     *  страницы роутер его не считает. */
    id: string
    lastAt: number
    lastError: string
}

/** Что уезжает и чего в пакете нет — по docs/TELEMETRY.md, а не по памяти.
 *
 *  Перечень «чего нет» закрытый и важнее схемы, поэтому он на экране, а не в документе,
 *  который никто не откроет. */
const SENDS = 'модель роутера и версия OpenWrt, версии splify2 и движка, страна, город и ' +
    'номер автономной системы, виды выходов и то, подняты ли они, номера списков каталога, ' +
    'состояние DoH и обхода DPI, домен панели подписки — только две последние метки, ' +
    'номера сработавших проверок и счётчики событий с загрузки.'

const NEVER = 'ни одного IP-адреса, ссылок подписок и токенов в них, названий подписок, ' +
    'имён узлов и их адресов, имён выходов и правил, имён своих списков, ключей туннелей, ' +
    'строк журнала и текстов ошибок, счётчиков трафика и числа устройств в сети.'

export default function TelemetryCard() {
    const [st, setSt] = useState<St | null>(null)
    const [busy, setBusy] = useState(false)
    /** Текст пакета как он приехал (с отступами для читаемости — значения те же). */
    const [pkt, setPkt] = useState('')
    const [pktError, setPktError] = useState('')
    const [asking, setAsking] = useState(false)

    async function load() {
        const r = await rpc.telemetryState()
        const c: Consent =
            r.consent === 'on' || r.consent === 'off' || r.consent === 'unset'
                ? r.consent
                : r.on
                  ? 'on'
                  : 'unset'
        setSt({
            consent: c,
            id: r.id || '',
            lastAt: Number(r.last_at) || 0,
            lastError: r.last_error || '',
        })
    }

    useEffect(() => {
        // Не ответил бэкенд — считаем, что согласия нет И предлагать нельзя. Молчание не
        // повод звать: предложение, показанное по незнанию, человек прочтёт как «нас снова
        // спрашивают», хотя он уже ответил.
        void load().catch(() => setSt({ consent: 'off', id: '', lastAt: 0, lastError: '' }))
    }, [])

    async function toggle() {
        if (!st || busy) return
        const next = st.consent !== 'on'
        setBusy(true)
        try {
            const r = await rpc.telemetrySet(next)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            notify(next ? t('Спасибо — отчёт будет уезжать раз в сутки') : t('Отправка выключена'))
        } catch (e) {
            notify(String(e instanceof Error ? e.message : e), 'error')
        } finally {
            setBusy(false)
            // Состояние перечитывается ВСЕГДА, а не подставляется от себя: на роутере запись
            // могла не пройти, и тогда экран показывал бы согласие, которого там нет. К тому
            // же отказ убирает идентификатор и время отправки — их тоже надо перечитать.
            await load().catch(() => undefined)
        }
    }

    async function preview() {
        if (asking) return
        setAsking(true)
        setPktError('')
        try {
            const r = await rpc.telemetryPreview()
            // Отказ приезжает общей формой объекта; в самом пакете поля `ok` нет.
            if (r && (r as { ok?: unknown }).ok === false) {
                throw new Error(
                    String((r as { error?: unknown }).error || t('пакет не собрался')),
                )
            }
            setPkt(JSON.stringify(r, null, 2))
        } catch (e) {
            // Пустое окно человек прочтёт как «ничего не уезжает» — то есть молчание здесь
            // врёт в самую опасную сторону. Поэтому причина словами.
            setPkt('')
            setPktError(String(e instanceof Error ? e.message : e))
        } finally {
            setAsking(false)
        }
    }

    const on = st?.consent === 'on'

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{t('Отчёт о работе')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex items-start gap-2.5">
                    <Switch
                        on={on}
                        label={t('Отправлять отчёт о работе раз в сутки')}
                        disabled={busy || st === null}
                        onClick={() => void toggle()}
                    />
                    <div className="min-w-0">
                        <div className="text-[13px]">{t('Отправлять отчёт о работе раз в сутки')}</div>

                        {/* Зовущий текст — ТОЛЬКО здесь. Человек, сказавший «нет», больше его
                            не увидит: это и есть третье состояние. */}
                        {st?.consent === 'unset' && (
                            <div className="text-xs text-muted-foreground">
                                {t('Помогите сделать splify2 лучше: раз в сутки роутер отправит короткий обезличенный отчёт о себе. По умолчанию выключено.')}
                            </div>
                        )}

                        {st?.consent === 'off' && (
                            <div className="text-xs text-muted-foreground">
                                {t('Ничего не отправляется.')}
                            </div>
                        )}

                        {on && (
                            <>
                                <div className="text-xs text-muted-foreground">
                                    {st.lastAt
                                        ? `${t('Последняя отправка')}: ${fmtWhen(st.lastAt)}`
                                        : `${t('Последняя отправка')}: ${t('её ещё не было')}`}
                                </div>
                                {st.id && (
                                    <div className="text-xs text-muted-foreground">
                                        {t('Идентификатор')}: <span className="font-mono">{st.id}</span>
                                    </div>
                                )}
                                {st.lastError && (
                                    <div className="text-xs text-warning-fg">
                                        {t('Прошлая отправка не удалась')}: {st.lastError}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                    <div>
                        <span className="font-medium text-foreground">{t('Уезжает')}</span>: {SENDS}
                    </div>
                    <div>
                        <span className="font-medium text-foreground">{t('Не уезжает')}</span>: {NEVER}
                    </div>
                    {/* Честная оговорка: обещать «мы не знаем ваш адрес» нельзя — его видит
                        любой получатель любого запроса. Обещать можно только то, что в пакете
                        адреса нет и в базу он не пишется. */}
                    <div>
                        {t('В пакете адреса нет. При самой отправке получатель видит адрес, как его видит любой сайт, и в базу он не пишется.')}
                    </div>
                </div>

                <div className="space-y-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={asking}
                        onClick={() => void preview()}
                    >
                        {asking ? t('Собираем…') : t('Показать пакет')}
                    </Button>
                    {/* Показывается ровно то, что вернул роутер: отступы для читаемости,
                        значения — без единой правки. */}
                    {pkt && (
                        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2 font-mono text-[11px] leading-relaxed">
                            {pkt}
                        </pre>
                    )}
                    {pktError && (
                        <div className="text-xs text-warning-fg">{pktError}</div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
