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
 *  ВКЛЮЧЕНО ПО УМОЛЧАНИЮ, И ЭТО ГЛАВНОЕ В КАРТОЧКЕ. Согласие подразумевается самим фактом
 *  того, что человек пользуется splify2; отдельного «да» никто не спрашивает, а единственное
 *  явное действие здесь — ОТКАЗ. Поэтому отправляем везде, кроме `off`, и поэтому карточка
 *  живёт в «Настройки → О ПО»: это раздел про сам продукт и про то, что он о себе собирает,
 *  и именно это место названо человеку в документации как то, где телеметрия выключается.
 *  Если названное место и настоящее разойдутся, отказ станет квестом — а отказ обязан быть
 *  дешевле, чем поиск, где его нажать.
 *
 *  СОСТОЯНИЙ ПО-ПРЕЖНЕМУ ТРИ, но нужны они уже не для решения. `unset` и `on` отправляют
 *  одинаково; различать их стоит только тому, кто ЧИТАЕТ состояние — «работает по умолчанию»
 *  и «человек сам включил обратно» это разные вещи, и слить их значило бы потерять след
 *  того, трогали переключатель или нет. Для вопроса «отправлять ли» правило одно и записано
 *  оно в карточке РОВНО ОДИН РАЗ (`on` ниже): разъехавшиеся отрисовка и обработчик дают
 *  включённый переключатель, нажатие на который включает ещё раз.
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
    'номера сработавших проверок и счётчики событий с загрузки; при падении движка, обхода ' +
    'DPI или туннеля — что именно упало, причина из закрытого набора, код возврата и сигнал ' +
    'и сколько раз это было с загрузки.'

const NEVER = 'ни одного IP-адреса, ссылок подписок и токенов в них, названий подписок, ' +
    'имён узлов и их адресов, имён выходов и правил, имён своих списков, ключей туннелей, ' +
    'счётчиков трафика и числа устройств в сети; ни одной строки журнала и ни одного текста ' +
    'ошибки — в том числе в отчёте о падении, где от журнала уезжает только сам факт.'

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
        // Не ответил бэкенд — показываем то же, что верно на роутере по умолчанию, то есть
        // «не спрашивали». Рисовать здесь `off` нельзя: такого состояния на роутере нет, пока
        // человек его не выбрал, и экран успокаивал бы «ничего не отправляется» ровно тогда,
        // когда отчёт продолжает уезжать. Молчание rpcd телеметрию не выключает.
        void load().catch(() => setSt({ consent: 'unset', id: '', lastAt: 0, lastError: '' }))
    }, [])

    /** Правило «отправляем ли» — единственное на всю карточку: отправляем везде, кроме явного
     *  отказа. Его читают и отрисовка, и обработчик нажатия; второй его записи быть не должно,
     *  иначе переключатель и то, что он делает, разъедутся. */
    const on = st?.consent !== 'off'

    async function toggle() {
        if (!st || busy) return
        const next = !on
        setBusy(true)
        try {
            const r = await rpc.telemetrySet(next)
            if (!r.ok) throw new Error(r.error || t('не сохранилось'))
            notify(next ? t('Отчёт снова будет уезжать раз в час') : t('Отправка выключена'))
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

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{t('Отчёт о работе')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex items-start gap-2.5">
                    <Switch
                        on={on}
                        label={t('Отправлять отчёт о работе раз в час')}
                        disabled={busy || st === null}
                        onClick={() => void toggle()}
                    />
                    <div className="min-w-0">
                        <div className="text-[13px]">{t('Отправлять отчёт о работе раз в час')}</div>

                        {/* Показывается при ЛЮБОМ включённом состоянии, а не только при «не
                            спрашивали»: человек, который переключатель не трогал, и человек,
                            включивший его сам, находятся в одном положении, и знать они должны
                            одно и то же. Ничего не просим — просто говорим, что происходит и
                            где это остановить. */}
                        {on && (
                            <div className="text-xs text-muted-foreground">
                                {t('Отчёт о работе уезжает раз в час, а при падении движка, обхода DPI или туннеля — сразу. Он включён по умолчанию: этими данными живёт разработка. Выключить можно здесь.')}
                            </div>
                        )}

                        {st?.consent === 'off' && (
                            <div className="text-xs text-muted-foreground">
                                {t('Ничего не отправляется.')}
                            </div>
                        )}

                        {/* `st &&` здесь не украшение: пока состояние не приехало, отчёт уже
                            считается включённым (так оно и есть на роутере), но времени
                            отправки и идентификатора ещё неоткуда взять. */}
                        {st && on && (
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
