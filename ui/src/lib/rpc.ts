// ubus calls into splify2's rpcd backend.
//
// The backend is a thin wrapper over the engine: it reads and writes the spec file,
// runs `steer apply`, and relays `steer status` / `steer explain` verbatim. It
// deliberately does not model channels itself — a second model would be a second
// thing to keep in sync with the engine's contract.

import {
    normalizeSpec,
    toCatalog,
    type ClientNet,
    type RawManifest,
    type Spec,
    type Status,
    type VlessNode,
    type VlessProbe,
    type VlessSkip,
} from './model'

export { toCatalog }

/** Состояние одного туннеля xsteer, как его пишет процесс пира (steer, src/ext/xsclient.c;
 *  схема описана в steer/docs/xsteer.md). Поля необязательны сознательно: движок постарше
 *  печатает не все, и требовать их значило бы показывать пустой экран вместо части данных. */
export interface XsteerTunnel {
    /** Имя устройства TUN. Есть всегда — оно выводится из настройки, а не из состояния. */
    device: string
    /** Возраст файла состояния в секундах. Нет, если файла нет вовсе. */
    age?: number
    state: {
        up: boolean
        mtu: number
        conns: number
        hub: string
        hub_key: string
        /** Секунды с последнего рукопожатия; -1 — рукопожатия ещё не было. */
        handshake_age: number
        stream?: boolean
        /** Что удалось договориться с ядром, а не что просили. */
        offload?: { gso: boolean; gro: boolean; rx: boolean }
        /** Размер, подтверждённый пробой пути. Пока расходится с mtu — идём на безопасном низу. */
        mtu_confirmed?: number
        /** Сколько раз ПОДНЯТАЯ сессия падала за жизнь процесса. */
        resets?: number
        /** Почему упала в последний раз. Нет — обрывов не было. */
        last_down?: string
        tx_packets: number
        tx_bytes: number
        rx_packets: number
        rx_bytes: number
        dropped: number
    } | null
}

/** Остаток трафика подписки словами панели: заголовок `subscription-userinfo` её ответа.
 *
 *  Байты приезжают СТРОКАМИ, и это не небрежность бэкенда: подписка на 200 ГБ — это 2·10^11,
 *  а `json_add_int` у jshn 32-битный, и числом такое значение приехало бы обрезанным. Тот же
 *  довод, по которому строками отдаются счётчики dev_stats.
 *
 *  Пустая строка в любом из полей значит «панель этого не назвала» — например у подписок без
 *  ограничения по объёму приходит только `expire`. */
export interface SubQuota {
    /** Отдано (upload) и принято (download) за период — по счёту ПАНЕЛИ, не роутера. */
    up: string
    down: string
    /** Объём периода. Пусто ИЛИ НОЛЬ — подписка без ограничения по объёму: нулём безлимит
     *  обозначают сами панели (Marzban, Remnawave, 3x-ui), и клиенты читают его так же. */
    total: string
    /** Unix-время конца периода; 0 — срок не назван. */
    expire: number
    /** Когда спрашивали. По нему считается «обновлено N минут назад» и решается, не пора ли
     *  спросить заново. mtime файла для этого не годится: файл переписывается и когда числа
     *  не изменились. */
    at: number
    /** Первое наблюдение этого периода: время и расход на тот момент.
     *
     *  Панель начала периода не сообщает — только конец, — поэтому средний расход в сутки
     *  считается по двум наблюдениям, а не по угаданной длине периода. На подписке на
     *  девяносто дней догадка «тридцать» завысила бы темп втрое и обещала бы, что трафик
     *  кончится, когда он не кончится. Пока наблюдения слишком близко (см. `MIN_SPAN_MS` в
     *  lib/quota.ts), темп не показывается вовсе. */
    since: number
    since_used: string
}

declare global {
    interface Window {
        /** Handed over by the loader shim (view/splify2/home.js), the same bridge
         *  splify 1 used. Absent when the bundle runs outside LuCI. */
        luci_rpc?: {
            declare: (o: {
                object: string
                method: string
                params?: string[]
                expect?: Record<string, unknown>
            }) => (...args: unknown[]) => Promise<unknown>
        }
    }
}

/** Мост к ubus берётся В МОМЕНТ ВЫЗОВА, а не при загрузке модуля.
 *
 *  Раньше он читался здесь же, при объявлении методов, и это стало ловушкой, когда загрузчик
 *  начал стартовать бандл, не дожидаясь build-id.txt: модуль успевал исполниться раньше, чем
 *  LuCI отдавала мост (`window.luci_rpc` выставляется в render()), и ВСЕ методы навсегда
 *  становились заглушкой «ubus is unavailable outside LuCI». Через раз — потому что гонка.
 *
 *  Мост, однажды полученный, запоминается: `rpc.declare` у LuCI не бесплатный, а методов
 *  под сорок. */
function declare<T>(method: string, params: string[] = []) {
    let call: ((...a: unknown[]) => Promise<unknown>) | null = null
    return (...args: unknown[]): Promise<T> => {
        if (!call) {
            const bridge = window.luci_rpc
            // Standalone (vite dev) — fail loudly rather than pretending to have data.
            if (!bridge) {
                return Promise.reject(
                    new Error(`ubus is unavailable outside LuCI (splify.${method})`),
                ) as Promise<T>
            }
            call = bridge.declare({ object: 'splify2', method, params })
        }
        return call(...args) as Promise<T>
    }
}

const specGetRaw = declare<Spec>('spec_get')
const appliedGetRaw = declare<Spec>('applied_get')
const listPutRaw = declare<unknown>('list_put',
    ['name', 'kind', 'text', 'url', 'append', 'source', 'filename'])
const listGetRaw = declare<unknown>('list_get', ['name', 'kind', 'offset'])
const listRemoveByName = declare<unknown>('list_remove', ['name', 'kind'])
const backupGetRaw = declare<unknown>('backup_get', ['offset'])
const backupPutRaw = declare<unknown>('backup_put', ['text', 'append', 'final'])

/** Ответ или отказ по сроку — но не бесконечное ожидание.
 *
 *  У вызова ubus есть свой предел (L.env.rpctimeout, у нас 120 с), и это верный предел для
 *  установки пакета. Но экран, который на время такого вызова написал «меряем…», обязан
 *  когда-нибудь это слово убрать: замер отклика и вопрос к панели — не установка, и две
 *  минуты вращающегося значка человек читает как «зависло навсегда» (поймано на роутере).
 *
 *  Отказ по сроку — это ответ «не дождались», а не ошибка вызова: сам вызов на роутере может
 *  доработать, и его результат приедет в следующий раз. */
export function deadline<T>(p: Promise<T>, ms: number, why = 'нет ответа'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(why)), ms)
        p.then(
            (v) => { clearTimeout(t); resolve(v) },
            (e) => { clearTimeout(t); reject(e) },
        )
    })
}

/** Ответ `vless_nodes` — как его печатает движок (`steer vless-nodes`), дословно. */
export interface VlessNodesReply {
    /** Имя выхода; пусто, когда узлы спрошены у подписки, а не у выхода. */
    output: string
    sub_file: string
    node: number
    /** Выбранные номера в порядке предпочтения; пусто — выбора нет (или спрошено у подписки). */
    chosen?: number[]
    usable: number
    skipped: number
    foreign: number
    nodes: VlessNode[]
    skipped_reasons?: VlessSkip[]
    skipped_other?: number
}

export const rpc = {
    /** Live engine state: outputs with up/nat, per-channel counters, warnings. */
    status: declare<Status>('status'),

    /** The spec as stored. The UI edits a copy and writes it back whole: a partial
     *  update would need the backend to understand channel ordering, and ordering is
     *  precisely what must not be reinterpreted on the way through. */
    /** Единственный вход спеки в интерфейс — поэтому и приведение написаний стоит здесь,
     *  а не в четырёх потребителях `match` по отдельности (I-041, splicicd#7). */
    specGet: () => specGetRaw().then(normalizeSpec),

    /** Снимок спеки в момент последнего apply — по нему считается «Применить · N».
     *  На старом бэкенде метода нет: вызывающий обязан ловить отказ (pending.ts ловит,
     *  и тогда применённым считается сохранённое — счётчик стартует с нуля). */
    appliedGet: () => appliedGetRaw().then(normalizeSpec),
    /** warn — сохранение прошло, но что-то требует внимания: например список, который не
     *  скачался, из-за чего его канал не поднимется. Это не ошибка сохранения. */
    specSet: declare<{ ok: boolean; error?: string; warn?: string }>('spec_set', ['spec']),

    /** Compile and install. Separate from spec_set so the UI can save a draft
     *  without steering traffic differently the same second. */
    apply: declare<{ ok: boolean; output?: string }>('apply'),

    /** "Where would this go?" — answered by the engine against the LIVE kernel, so
     *  it also covers the case where a set failed to load. */
    explain: declare<{ text: string }>('explain', ['address']),

    /** The publisher's manifest VERBATIM. Reshaping it in the rpcd wrapper would put
     *  JSON surgery in shell, where it is both dearer and less checkable; the adapter
     *  below does it here instead. */
    manifest: declare<RawManifest>('lists'),

    /** Fetch a list's file so a channel can use it. Downloading is the management
     *  layer's job, not the engine's. */
    listFetch: declare<
        /** `via` приходит, только когда файл приехал НЕ прямым адресом: провайдеры
         *  закрывают githubusercontent.com, и бэкенд достаёт список с хостов самого
         *  GitHub или через туннель роутера (splify2#15). Показать это надо: обход идёт
         *  дольше прямого пути, и без строки обновление выглядит как беспричинная пауза. */
        { ok: boolean; count?: number; error?: string; via?: string }
    >('list_fetch', ['id', 'kind']),

    /** Which list files are already on the router, with their local line count. The
     *  UI cannot tell a downloaded list from a merely offered one without this — and
     *  without that difference, "Download" sits over a list that is already there. */
    localLists: declare<{ files: Record<string, { count: number; mtime: number }> }>('local_lists'),

    /** Обновить разом всё, что используют правила. Тот же прогон, что идёт по
     *  расписанию: скачивание, подгонка под память, проверка скачанного и apply в конце.
     *  `updated` — сколько файлов сменилось, `failed` — сколько осталось прежними,
     *  `lines` — строки прогона для тех, кто захочет подробностей. */
    listsUpdate: declare<{
        ok: boolean
        updated?: number
        failed?: number
        lines?: string[]
        error?: string
    }>('lists_update'),

    /** Delete a downloaded list. Refuses while a channel still points at it: the
     *  engine reads the file when it compiles, so removing it under a live channel
     *  turns the next apply into a failure. */
    listRemove: declare<{ ok: boolean; error?: string }>('list_remove', ['id', 'kind']),

    /** Свой список: текстом, по ссылке или файлом по частям (append).
     *
     *  Один метод на все три способа намеренно. Загрузка через cgi-io была бы вторым
     *  путём со своими правами и своей проверкой формата, а проверка здесь не
     *  косметическая: непринятая строка — это молча пустой канал.
     *
     *  dropped — сколько строк не подошло по формату. Приходит всегда: молчаливая потеря
     *  строк хуже отказа. */
    listPut: (p: {
        name: string
        kind: 'domains' | 'prefixes'
        text?: string
        url?: string
        append?: boolean
        /** ОТКУДА список: набран руками, выбран файлом, дан ссылкой. Посылается явно, а не
         *  выводится из того, что мы прислали: файл едет тем же полем `text`, порциями, и
         *  различить его от набранного руками на той стороне нечем. А различать надо — правят
         *  их разными способами (см. CustomLists). */
        source?: 'text' | 'file' | 'url'
        /** Как файл назывался у человека. Только для показа: «выбран blocked.txt». */
        filename?: string
    }) =>
        /* Булево, а не 1/0. Метод объявлен в бэкенде как `json_add_boolean append`, то
         * есть политика ubus для этого поля — BOOL, а число приезжает как INT32.
         * blobmsg_parse молча ОТБРАСЫВАЕТ атрибут, тип которого не совпал с политикой,
         * поэтому до скрипта `append` не доходил вовсе, и каждая порция файла ЗАМЕЩАЛА
         * предыдущую вместо дописывания: от файла в 5000 строк на роутере оставалась
         * последняя тысяча, а `count` в ответе это подтверждал числом.
         *
         * Стенд отправлял настоящее булево (`"append":true`) и потому был зелёным на
         * типе, которого в браузере не бывает. Остальные булевы поля интерфейс шлёт
         * правильно — см. steerInstall. */
        listPutRaw(p.name, p.kind, p.text ?? '', p.url ?? '', p.append ?? false,
                   p.source ?? '', p.filename ?? '') as Promise<{
            ok: boolean
            error?: string
            path?: string
            count?: number
            dropped?: number
        }>,

    /** Удалить СВОЙ список — по имени и виду, а не через манифест: в манифесте его нет и
     *  быть не может, поэтому listRemove его найти не мог. Отказ при занятости каналом
     *  тот же, что и у списков издателя. */
    listRemoveCustom: (name: string, kind: 'domains' | 'prefixes') =>
        listRemoveByName(name, kind) as Promise<{ ok: boolean; error?: string }>,

    /** СВОИ списки с происхождением: чем каждый завели и, значит, чем его править.
     *
     *  Отдельно от localLists, потому что вопросы разные: тот отвечает «что уже лежит на
     *  диске» про ВСЕ списки, включая издательские, и считается одним awk по всему каталогу;
     *  здесь — единицы своих списков и то, чего у издательских не бывает.
     *
     *  `source` пустой значит «неизвестно»: список завели до появления этой записи, положили
     *  в каталог руками или вернули из архива настроек. Тогда интерфейс предлагает все три
     *  способа правки — врать одним неверным хуже, чем признать незнание. */
    listCustom: declare<{
        lists: {
            name: string
            kind: 'domains' | 'prefixes'
            path: string
            count: number
            bytes: number
            source: '' | 'text' | 'file' | 'url'
            url: string
            filename: string
            at: number
        }[]
    }>('list_custom'),

    /** Записи своего списка обратно, порциями по байтам.
     *
     *  Нужно редактору набранного руками: пустое поле вместо записей — это предложение
     *  незаметно потерять набранное, а не «начни заново». Куски приходят байт в байт (границы
     *  не по строкам), поэтому склеивать их надо простой конкатенацией. */
    listGet: (name: string, kind: 'domains' | 'prefixes', offset = 0) =>
        listGetRaw(name, kind, offset) as Promise<{
            ok: boolean
            error?: string
            name?: string
            kind?: string
            total?: number
            offset?: number
            next?: number
            eof?: boolean
            text?: string
        }>,

    /** Devices that could serve as an interface output — tunnels first. */
    devices: declare<{ devices: { name: string; up: boolean; kind: string }[] }>('devices'),

    /** Живое состояние туннелей xsteer: то, что знает только сам процесс пира.
     *
     *  ОТДЕЛЬНЫМ ВЫЗОВОМ, а не полем `live`, и это выбор бэкенда, а не случайность. Туннель
     *  xsteer, поднятый через netifd, движку не принадлежит: в спеке он обычный
     *  `kind: interface`, и `status` знает про него ровно то, что знает про любое устройство.
     *  Какой хаб, сколько секунд назад было рукопожатие, встала ли разгрузка сегментации,
     *  сколько раз соединение переподнималось и почему — знает только процесс, и он пишет это
     *  в свой файл состояния. Читать эти файлы на каждом круге опроса всем, у кого xsteer нет
     *  вовсе, незачем.
     *
     *  `state: null` означает «туннель не поднимался в эту загрузку» — это НЕ то же, что
     *  «поднят и молчит», и различать их человек сюда и приходит. `age` — возраст файла в
     *  секундах: процесс, которого убили, оставляет файл лежать навсегда, и без возраста его
     *  последнее `up: true` выглядело бы живым. */
    xsteerState: declare<{ ok: boolean; tunnels: Record<string, XsteerTunnel> }>('xsteer_state'),

    /** Ссылка xs:// в обе стороны: `{iface}` даёт ссылку на туннель, `{link}` — текст
     *  конфигурации из ссылки. Направление выбирает вход — так же, как у подкоманды движка.
     *
     *  Формат ссылки НЕ разбирается здесь и не собирается: он описан один раз в движке и
     *  сверяется побайтово с половиной на Go. Третья реализация того же формата в браузере
     *  была бы первой, у которой нет стенда. */
    xsteerLink: declare<{ ok: boolean; link?: string; conf?: string; error?: string }>(
        'xsteer_link', ['iface', 'link']),

    /** Принять ссылку: записать её в настройку СУЩЕСТВУЮЩЕГО интерфейса xsteer и поднять его
     *  заново. Интерфейс не создаёт — у интерфейса есть то, чего в ссылке нет и быть не может
     *  (зона фаервола, имя устройства), и созданный без зоны туннель выглядел бы настроенным и
     *  не вёз бы трафик. */
    xsteerLinkPut: declare<{ ok: boolean; iface?: string; hub?: string; error?: string }>(
        'xsteer_link_put', ['iface', 'link']),

    /** Обратный вопрос к `devices`: не куда выпустить трафик, а откуда приходят клиенты
     *  (splify2#16). Подсети выведены из адресов устройств тем же правилом, каким их
     *  выводит движок, — иначе экран показывал бы одну сеть, а маршрутизировалась другая. */
    clientNets: declare<{ nets: ClientNet[] }>('client_nets'),

    /** Умеет ли установленный движок VLESS. Спрашивается у движка, а не выводится из
     *  имени пакета: пакет мог быть собран из исходников или переименован. Без этого
     *  интерфейс предлагал бы выход, который отвергается при сохранении.
     *
     *  arch — архитектура ПАКЕТОВ (aarch64_cortex-a53, а не aarch64): по ней собирается
     *  имя файла релиза, и `apk --print-arch` для этого не годится. */
    engine: declare<{
        present: boolean
        vless: boolean
        arch?: string
        version?: string
        /** Автозапуск и работа — разные вещи: первое переживает перезагрузку, второе нет.
         *  Тумблеру «остановить всё» нужны оба. */
        enabled?: boolean
        running?: boolean
    }>('engine'),

    /** Остановить всё: сервис и правила в ядре. Снимает и автозапуск — иначе перезагрузка
     *  вернула бы движок, и «остановить всё» выглядело бы несработавшей кнопкой.
     *  Правила из nft и ip rule убирает сам движок в stop_service. */
    engineStop: declare<{ ok: boolean; enabled: boolean; running: boolean }>('engine_stop'),

    /** Обратная половина: включить автозапуск и поднять сервис. */
    engineStart: declare<{ ok: boolean; enabled: boolean; running: boolean }>('engine_start'),

    /** Версии САМОГО интерфейса и то, что стоит сейчас. Отдельный метод, а не поле в
     *  steer_versions: это разные пакеты с разными версиями, и одно поле на оба заставило
     *  бы гадать, к чему относится показанное число. */
    splify2Versions: declare<{
        current: string
        versions: string[]
        /** Название выпуска по его версии: «26.9» → «26.9 Andromeda». Версия — то, чем
         *  ставится пакет, название — то, как выпуск называют; в имени файла пакета и в теге
         *  пробелу места нет, поэтому это две разные строки. Поля может не быть вовсе —
         *  бэкенд старее интерфейса; тогда версия называет себя сама. */
        names?: Record<string, string>
        /** Почему список такой, какой есть: перечень релизов не отдали и версия взята из
         *  VERSION главной ветки (splify2#15). На здоровом пути поля нет. */
        note?: string
    }>('splify2_versions'),

    /** Обновить интерфейс. reload_needed — не любезность: вместе с пакетом
     *  перезапускается rpcd, а бандл у браузера в кеше, поэтому без перезагрузки
     *  страницы старый интерфейс работает поверх нового бэкенда.
     *
     *  `output` — вывод менеджера пакетов, включая строки post-install пакета. Показывать
     *  его надо и на успехе: именно там установщик говорит, что netifd держит прежний
     *  набор опций протокола и новые не действуют до перезапуска сети. */
    splify2Install: declare<
        {
            ok: boolean
            error?: string
            installed?: string
            reload_needed?: boolean
            output?: string
            /** Каким путём приехал пакет, если прямая ссылка релиза не отдала — см. listFetch. */
            via?: string
        }
    >('splify2_install', ['version']),

    /** Версии движка, доступные в релизах. Спрашиваются у GitHub, а не зашиты: зашитая
     *  версия означает, что интерфейс ставит прошлое, и заметить это можно только по
     *  отсутствию чего-то нужного. */
    steerVersions: declare<{
        arch: string
        versions: string[]
        /** Название выпуска по версии — см. splify2Versions выше. */
        names?: Record<string, string>
        /** Почему список такой, какой есть — см. splify2Versions выше. */
        note?: string
    }>('steer_versions'),

    /** Скачать и поставить движок выбранной версии и варианта. Вариант — выбор человека:
     *  он зависит от того, поднимает ли туннель сам движок, и пакетный менеджер такого не
     *  решает.
     *
     *  restarted — поднялся ли движок после установки. Отдельное поле, а не следствие
     *  `ok`: замена пакета останавливает сервис и сносит таблицу nft, поэтому «пакет
     *  встал» и «роутер маршрутизирует» здесь разные утверждения. Пока это поле было
     *  объявлено только на стороне rpcd, неподнявшийся движок отчитывался зелёным
     *  «установлен» (I-053).
     *
     *  removed — снимался ли по дороге работающий пакет. Приходит только на отказе и
     *  только на ветке смены варианта: без него сообщение об ошибке не отличает «ничего
     *  не изменилось» от «движка на роутере больше нет» (I-049). */
    steerInstall: declare<{
        ok: boolean
        error?: string
        installed?: string
        restarted?: boolean
        removed?: boolean
        /** Каким путём приехал пакет, если прямая ссылка релиза не отдала — см. listFetch. */
        via?: string
    }>('steer_install', ['version', 'extended']),

    /** Подписка: где лежит, откуда взята, когда обновлялась.
     *
     *  kind различает два источника: `url` — подписка, которую есть чем обновить, `links` —
     *  вставленные руками ссылки vless://, для которых кнопка «Обновить» лишена смысла. */
    subInfo: declare<{
        url?: string
        kind?: 'url' | 'links' | 'none'
        path: string
        present: boolean
        bytes?: number
        mtime?: number
        /** Идентификатор устройства для панелей, привязывающих подписку к устройствам.
         *  Выведен из MAC физического порта, потому что это единственное, что переживает
         *  сброс к заводским настройкам. Пустая строка — считать не из чего. */
        hwid?: string
        /** Остаток трафика, как его назвала панель. Приходит БЕЗ обращения наружу — это
         *  запомненное с последнего запроса, поэтому поле можно читать в общем опросе.
         *
         *  Поля нет вовсе — панель остатка не сообщала: либо ни разу, либо в последний раз
         *  промолчала. Различать эти два случая интерфейсу незачем, сказать он обязан одно и
         *  то же; а вот показывать прежние числа нельзя — бэкенд их поэтому и снимает. */
        quota?: SubQuota
    }>('sub_info', ['name']),

    /** Все подписки роутера одним ответом.
     *
     *  Подписок бывает несколько: у человека две панели, и локации из обеих он складывает в
     *  пулы. Списком, а не по одной: экран показывает их вместе, и десять вызовов ради десяти
     *  строк — это десять запусков shell на роутере.
     *
     *  `used` — сколько выходов ссылается на файл этой подписки. По нему видно, чем она
     *  занята, и почему удаление отказано. */
    subList: declare<{
        subs: {
            name: string
            title?: string
            url?: string
            kind?: 'url' | 'links' | 'none'
            path: string
            present: boolean
            bytes?: number
            mtime?: number
            used?: number
            quota?: SubQuota
        }[]
        hwid?: string
    }>('sub_list'),

    /** Удалить подписку: файл узлов, запомненный остаток и ключи. Отказ, пока на неё
     *  ссылается выход: движок читает файл при подъёме, и снос под живым выходом оставил бы
     *  правило вести в туннель без единого узла. */
    subDel: declare<{ ok: boolean; error?: string; name?: string }>('sub_del', ['name']),

    /** Спросить у панели остаток трафика заново.
     *
     *  Отдельный метод, а не поле sub_info, по цене: sub_info спрашивают в общем опросе
     *  каждые пять секунд, а здесь уходит запрос в интернет с таймаутом двадцать секунд.
     *
     *  Подписку метод НЕ подменяет — ни файл узлов, ни выбранный узел. Поэтому его можно
     *  звать при открытии обзора: единственное следствие — свежие числа.
     *
     *  `asked: false` значит «спрашивать некого»: узлы заданы ссылками vless:// или не
     *  заданы вовсе. Это не отказ, и `ok` при этом true — человек ничего не сделал не так. */
    subQuota: declare<{
        ok: boolean
        error?: string
        kind?: 'url' | 'links' | 'none'
        asked?: boolean
        why?: string
        quota?: SubQuota
    }>('sub_quota', ['name']),
    /** Задать источник узлов: ссылка на подписку ЛИБО одна или несколько ссылок vless://.
     *  Одно поле на оба случая — различает их бэкенд по схеме, а не человек выбором режима. */
    subSet: declare<
        /** `warn` — сказанное панелью про устройство: она отвечает на запрос без HWID не
         *  отказом, а заглушкой из ссылок в никуда, и без этой строки отказ выглядел бы как
         *  «подписка скачалась, узлы не работают». */
        {
            ok: boolean
            error?: string
            kind?: string
            name?: string
            bytes?: number
            warn?: string
            hwid?: string
            /** Сколько узлов движок счёл ПРИГОДНЫМИ — тем же кодом, которым читает подписку при
             *  подъёме туннеля. То есть это то самое число, по которому туннель и поднимется:
             *  «скачалось 15 КБ» ничего не обещает, а «пригодно 0» объясняет заранее, почему
             *  туннель не встанет. Поля нет — объект старее движка, который его считает. */
            usable?: number
        }
    >('sub_set', ['url', 'name', 'title']),

    /** Архив настроек: отдать его строкой, кусками по 16 КБ (R-005).
     *
     *  Файл собирается в БРАУЗЕРЕ, а не отдаётся ссылкой: второго пути наружу (cgi-io,
     *  свой обработчик uhttpd) в проекте нет, и заводить его ради одной кнопки значило бы
     *  вторые права и вторую проверку формата — тот же довод, по которому свой список
     *  грузится через list_put, а не загрузкой файла.
     *
     *  offset и next — БАЙТЫ, которые считает роутер, а не символы строки в браузере.
     *  Поэтому следующий кусок запрашивается ровно тем `next`, который приехал, и ничего
     *  не пересчитывается на этой стороне: в UTF-8 символ бывает длиннее байта, и любая
     *  своя арифметика здесь разъехалась бы с бэкендом на первой же русской букве. */
    backupGet: (offset: number) =>
        backupGetRaw(offset) as Promise<{
            ok: boolean
            error?: string
            format?: number
            total?: number
            offset?: number
            next?: number
            eof?: boolean
            text?: string
        }>,

    /** Принять архив и восстановить настройки. Кусками, как файл списка: ubus не резиновый.
     *
     *  Булевы поля — настоящими булевыми, а не 1/0. Метод объявлен в бэкенде как
     *  `json_add_boolean append` / `json_add_boolean final`, то есть политика ubus для них
     *  BOOL, а число приезжает как INT32 и blobmsg_parse молча ОТБРАСЫВАЕТ атрибут с чужим
     *  типом. Здесь это стоило бы дороже, чем в list_put: без `append` каждый кусок замещал
     *  бы предыдущий, а без `final` разбор не начался бы вовсе. Разобранная в подробностях та же
     *  ловушка — в комментарии к listPut выше; барьер на неё стоит в tests/pkgmatch.sh.
     *
     *  spec/sub/lists в ответе — что именно восстановлено. Отдельными полями, а не одним
     *  «ок»: архив может не содержать спеки, и «восстановлено» без перечня не отличает
     *  «вернули всё» от «вернули один список». */
    backupPut: (p: { text: string; append: boolean; final: boolean }) =>
        backupPutRaw(p.text, p.append, p.final) as Promise<{
            ok: boolean
            error?: string
            bytes?: number
            spec?: boolean
            sub?: boolean
            lists?: { name: string; kind: string; count: number; dropped: number }[]
            warn?: string
        }>,

    /** Память мастера: непрозрачная строка, формат принадлежит мастеру.
     *
     *  Нужна, чтобы мастер узнавал СВОИ записи в спеке при любых именах. По зашитым именам он
     *  их не находил: на живом роутере канал звался funny, а выход vless — настроенные руками, —
     *  и мастер предложил создать рядом второй туннель вместо того, чтобы показать этот. */
    uiGet: declare<{ state?: string }>('ui_get'),
    uiSet: declare<{ ok: boolean }>('ui_set', ['state']),

    /** Чем роутер качает списки и обновления: `auto` — туннель последним, `always` — первым,
     *  `off` — не трогать. `out` — выход, через который пойдёт скачивание; пусто означает,
     *  что поднятого выхода нет и `always` ничего не даст (splify2#15). */
    /** Фикс Zapret Manager: уводить ли адреса GitHub в туннель. Включён по умолчанию — он
     *  нужен именно тем, кто ещё ничего не настроил и до GitHub не дошёл. */
    zmFix: declare<{ on?: boolean; channel?: string }>('zm_fix'),
    zmFixSet: declare<{ ok: boolean; on?: boolean; error?: string }>('zm_fix_set', ['on']),

    fetchMode: declare<{ mode?: string; out?: string }>('fetch_mode'),
    fetchModeSet: declare<{ ok: boolean; mode?: string; error?: string }>('fetch_mode_set', ['mode']),

    /** ВЕСЬ КРУГ ОПРОСА ОДНИМ ВЫЗОВОМ: состояние, счётчики устройств, сведения о сети и —
     *  по просьбе — проверки движка.
     *
     *  Зачем. Круг стоил пяти вызовов (status, dev_stats, engine_state, diag, net_info), а
     *  каждый вызов — это запуск скрипта объекта на роутере: замерено на стенде (mipsel
     *  24kc, 880 МГц) 126 мс постоянной платы на разбор одного и того же файла при 30-90 мс
     *  на сам ответ. Круг занимал 1232 мс, из них 630 — пятикратный разбор. LuCI к тому же
     *  складывает вызовы одного такта в ОДИН запрос к ubus и выполняет их подряд, поэтому
     *  это была и задержка на экране: числа обновлялись через 1,2-1,5 с после начала круга.
     *  Одним вызовом — 240 мс, с проверками 432 мс (замер там же).
     *
     *  `diag` просит проверки, и просит их не каждый круг: они вдвое дороже состояния, а
     *  меняются реже — см. useLive, где записано, когда именно.
     *
     *  `fast` просит движок отдать ЗАПОМНЕННОЕ состояние вместо измеренного: он держит свой
     *  последний полный ответ и печатает его немедленно, не разбирая спеку и не спрашивая ни
     *  /sys, ни nft. Просит его только ПЕРВЫЙ круг — тот, что рисует экран; следом сразу же
     *  идёт обычный круг за свежим. Ответ на быстрый круг несёт `status.cached` и
     *  `status.at`, и пока свежий в пути, экран говорит «Обновление…» — рисовать память
     *  живой нельзя.
     *
     *  Метода нет — движок и объект старее интерфейса (пакет обновили, rpcd не перезапустили):
     *  useLive возвращается к пяти прежним вызовам, и ни один из них никуда не делся. */
    live: declare<{
        ok?: false
        error?: string
        status: Status
        devices: Record<string, { rx: string; tx: string; rx_packets: string; tx_packets: string }>
        net: { uptime: number; active_clients: number }
        diag?: { checks: { id: string; verdict: 'ok' | 'note' | 'warn' | 'fail'; what: string; why: string }[]; warn: number; fail: number }
        /** Проверок не умеет сам движок (не объект): отдельное сообщение, а не молчание. */
        diag_old?: true
    }>('live', ['diag', 'fast']),

    /** Счётчики устройств из /sys/class/net.
     *
     *  Нужны потому, что счётчик канала в nft считает только путь «наружу»: он стоит на
     *  правиле, ставящем метку, а обратный поток под него не подпадает. У туннельного
     *  устройства rx — это скачанное, tx — отданное. Числа приходят строками: байты на
     *  сутках работы не влезают в 32 бита. */
    devStats: declare<{
        devices: Record<string, { rx: string; tx: string; rx_packets: string; tx_packets: string }>
    }>('dev_stats'),

    /** Проверки состояния: движок спрашивает ЯДРО и живые процессы, а не спеку.
     *
     *  Нужно потому, что `status` отвечает «что применено», и человек, у которого сайт не
     *  открывается, сам угадывал, какие из полей важны. Здесь у каждой проверки есть приговор
     *  и причина, и есть то, чего в status нет вовсе: пустой набор при непустом списке,
     *  отсутствующий редирект DNS, незапущенный резолвер, обход DNS браузером и утечка IPv6. */
    diag: declare<{
        /* `note` — четвёртый вердикт движка: совет, а не находка (I-015). Тип обязан
         * его знать, иначе switch по вердикту с exhaustive-проверкой молча съест
         * неизвестное значение — ровно так «советы» и красились тревожным цветом. */
        checks: { id: string; verdict: 'ok' | 'note' | 'warn' | 'fail'; what: string; why: string }[]
        warn: number
        fail: number
    }>('diag'),

    /** Время работы движка и сколько устройств сейчас ходит в сеть.
     *
     *  Одним вызовом, а не тремя: каждый стоит запуска shell, а страница опрашивает по кругу.
     *  active_clients — это устройства В СЕТИ, а не «через туннель»: привязать соединение к
     *  выходу нечем, движок помечает пакет, а не соединение, и в conntrack следа выхода нет. */
    netInfo: declare<{ uptime: number; active_clients: number }>('net_info'),

    /** Отклик по одному выходу. По одному за вызов: проверка упирается в таймаут, и «проверить
     *  все» не уложилось бы в срок жизни вызова ubus.
     *
     *  ms = -1 значит «нет ответа». У vless меряет движок (ICMP через TUN не ходит вовсе, и ping
     *  показал бы «мертво» у исправного туннеля), у обычного устройства — ping через него. */
    outboundProbe: declare<{ output: string; state: string; ms: number; how: string }>(
        'outbound_probe', ['output'],
    ),

    /** Где выходит трафик выхода: страна и адрес, как их видит внешняя сторона.
     *
     *  Меряется, а не читается из подписки: имя узла пишет продавец, у выходов поверх
     *  WireGuard и xsteer имени нет вовсе, а узел мог переехать. Запрос уходит через сам
     *  выход, поэтому способ один на все виды. Бэкенд помнит измерение 15 минут; `fresh`
     *  заставляет сходить в сеть заново. */
    outboundGeo: declare<{
        output: string
        ip?: string
        cc?: string
        /** Время ответа ТОГО ЖЕ запроса, в миллисекундах. Отдельной проверки отклика для
         *  этого не нужно: соединение через устройство выхода уже установлено, а вторая
         *  проверка поднимает его заново через движок и стоит на роутере девятнадцать секунд
         *  против полутора у этого вызова. Поля нет — не мерили. */
        ms?: number
        at?: number
        cached?: boolean
        why?: string
    }>('outbound_geo', ['output', 'fresh']),

    /** Аренды DHCP: чтобы «кого касается» выбирали из имён устройств, а не набирали MAC руками.
     *  Опечатка в MAC не совпадёт ни с чем и не пожалуется — правило просто не действует. */
    leases: declare<{ leases: { mac: string; ip: string; name: string }[] }>('leases'),

    /** Состояние экземпляров движка и его последние слова.
     *
     *  «Выход настроен» и «туннель несёт трафик» — разные вещи, а различить их интерфейс мог
     *  только по наличию устройства: у vless его создаёт сам процесс туннеля, поэтому мёртвый
     *  туннель виден как пропавшее устройство. Не было видно ПОЧЕМУ, и за причиной приходилось
     *  идти в logread.
     *
     *  Строки журнала приходят дословно и здесь НЕ разбираются: формулировки принадлежат
     *  движку и меняются вместе с ним, а разбор на этой стороне означал бы, что правка
     *  сообщения тихо ломает показ. Человек прочитает их сам. */
    engineState: declare<{
        instances: Record<string, { running: boolean; pid: number }>
        log: string[]
    }>('engine_state'),

    /** Узлы подписки глазами движка, с причинами непригодности.
     *
     *  Оба поля опциональны, и по разным причинам. `skipped_reasons` новый движок
     *  печатает всегда, в том числе пустым массивом, — но пакет обновляют не в один
     *  день с интерфейсом, и на роутере со старым движком поля не будет вовсе.
     *  `skipped_other` печатается только при переполнении набора причин (их больше
     *  восьми) — то есть почти никогда. */
    vlessNodes: declare<VlessNodesReply>('vless_nodes', ['output']),

    /** Те же узлы — у ПОДПИСКИ, а не у выхода: путём к её файлу. Нужно редактору выхода, чтобы
     *  показать локации подписки, на которую ещё не заведён ни один выход; бэкенд принимает
     *  только пути из своего перечня подписок. Бэкенд постарше параметра не знает и отвечает
     *  «не указан выход» — вызывающий тогда спрашивает по любому выходу на этой подписке. */
    vlessNodesOfSub: declare<VlessNodesReply>('vless_nodes', ['sub']),

    /** Проверить узел и замерить время ответа. По одному за вызов: проверка упирается в
     *  таймаут, и «проверить все» не уложилось бы в срок жизни вызова ubus. node = -1
     *  означает «до первого рабочего» — то же решение, что примет движок при подъёме. */
    vlessProbe: declare<{ output?: string; results?: VlessProbe[]; working?: number; error?: string }>(
        'vless_probe',
        ['output', 'node'],
    ),

    /** ---- DNS over HTTPS ------------------------------------------------------------
     *
     *  Всё состояние вкладки одним вызовом: служба, каталог резолверов, выбранный, туннель.
     *  Четырьмя вызовами это стоило бы четырёх запусков скрипта объекта, а плата за запуск —
     *  126 мс (замер в шапке бэкенда). */
    dohState: declare<{
        installed: boolean
        running: boolean
        enabled: boolean
        /** id выбранного пункта каталога. ПУСТО — законное состояние, и означает оно одно из
         *  двух, различимых по `urls`: настройки нет вовсе (urls пуст) или в конфигурации
         *  стоит чужая ссылка, которой в каталоге нет (urls непуст). */
        active: string
        urls: string[]
        providers: { id: string; title: string }[]
        via_tunnel: boolean
        /** Через какой выход пойдёт DoH. Выбора здесь нет: это первый поднятый выход со
         *  своей меткой, тот же, что у фикса Zapret Manager. */
        out: string
        /** Нужен ли движку свой резолвер доменных каналов. От этого зависит force_dns. */
        needs_dnsd: boolean
        /** Что записано в force_dns. Показывается потому, что иначе это выглядит как
         *  «поставил 1 руками, а splify2 сбросил»: два перенаправления порта 53 в одной
         *  точке дают гонку, и проигравший наш резолвер молча перестаёт видеть запросы. */
        force_dns: string
    }>('doh_state'),

    dohSet: declare<{ ok: boolean; error?: string; active?: string; force_dns?: string }>(
        'doh_set', ['provider'],
    ),
    dohOff: declare<{ ok: boolean; error?: string }>('doh_off'),
    dohTunnelSet: declare<{ ok: boolean; error?: string; on?: boolean; out?: string }>(
        'doh_tunnel_set', ['on'],
    ),

    /** ---- обход DPI ------------------------------------------------------------------ */
    zapretState: declare<{
        installed: boolean
        /** Работает ли служба zapret ВСЕГО РОУТЕРА (обработчики выходов kind=zapret — не она). */
        running: boolean
        /** Включён ли её автозапуск. «Не запущен» и «выключен» — разные состояния: первое —
         *  поломка, второе — решение человека (zapretEnable). */
        enabled: boolean
        version: string
        /** Есть ли curl. Без него проверка стратегий невозможна, и сказать это надо ДО
         *  нажатия кнопки: ключи, которыми меряет Zapret Manager, у uclient-fetch выразить
         *  нечем, а мерить другим инструментом — получить числа, несравнимые с его. */
        curl: boolean
        strategies: number
        /** Когда каталог обновлялся последний раз (unix-время). 0 — ни разу. */
        updated: number
        /** Имя активной стратегии всего роутера, как её отмечает Zapret Manager. Пусто —
         *  отметки нет: так выглядит свежий пакет zapret со своей стандартной стратегией. */
        active: string
        drifted: boolean
    }>('zapret_state'),

    zapretInstall: declare<{
        ok: boolean; error?: string; note?: string
        version?: string; strategies?: number; curl?: boolean
    }>('zapret_install'),
    zapretRemove: declare<{ ok: boolean; error?: string }>('zapret_remove'),
    zapretSync: declare<{ ok: boolean; error?: string; strategies?: number; updated?: number; note?: string }>(
        'zapret_sync',
    ),

    /** Каталог стратегий и выходы kind=zapret. Числа проверки приходят ОТДЕЛЬНО
     *  (zapretResults) и соединяются здесь, в интерфейсе: разбирать полсотни объектов JSON
     *  в shell ради того же самого JSON — работа ради работы. */
    zapretStrategies: declare<{
        active: string
        updated: number
        strategies: { name: string; family: ZapretFamily }[]
        outputs: { name: string; strategy: string; queue: number; up: boolean }[]
    }>('zapret_strategies'),

    /** Одна стратегия целиком: её ключи nfqws, по строке на ключ. По запросу, а не в каталоге:
     *  каталог показывается при каждом открытии вкладки, а ключи человек разворачивает у
     *  одной-двух стратегий. */
    zapretStrategy: declare<{ name: string; family: ZapretFamily; opts: string[] }>(
        'zapret_strategy', ['name'],
    ),

    /** Применить стратегию. `out` пуст — всему роутеру (/etc/config/zapret), иначе выходу
     *  kind=zapret. Два места применения одной и той же стратегии. */
    zapretApply: declare<{ ok: boolean; error?: string; name?: string; out?: string }>(
        'zapret_apply', ['name', 'out'],
    ),

    /** Выключатель обхода всего роутера: служба zapret, а не стратегия — та остаётся
     *  отмеченной, и Zapret Manager видит свою конфигурацию. Обработчики выходов kind=zapret
     *  живут своими экземплярами, их это не касается. */
    zapretEnable: declare<{ ok: boolean; error?: string; enabled?: boolean; running?: boolean }>(
        'zapret_enable', ['on'],
    ),

    /** Набор: `all`, семейство (`flowseal`, `v`, `yv`) либо одна стратегия — `one:<имя>`.
     *  Результат одиночной проверки ложится РЯДОМ с остальными, а не затирает их. */
    zapretTestStart: declare<{ ok: boolean; error?: string; scope?: string }>(
        'zapret_test_start', ['scope'],
    ),
    zapretTestStop: declare<{ ok: boolean; error?: string }>('zapret_test_stop'),

    /** Ход проверки. Дёшев нарочно — его опрашивают раз в две секунды, пока проверка идёт.
     *
     *  `running` спрашивается У ПРОЦЕССА, а не берётся из файла хода: файл мог остаться от
     *  проверки, которую убили (снятие питания, OOM), и страница показывала бы «идёт» вечно,
     *  не давая запустить новую. */
    zapretTest: declare<{
        state: 'idle' | 'starting' | 'running' | 'done' | 'error'
        running: boolean
        started?: number
        scope?: string
        total?: number
        done?: number
        targets?: number
        current?: string
        error_text?: string
        results_at: number
    }>('zapret_test'),

    /** Результаты последней проверки — дословно тем файлом, который она написала.
     *  Отсортированы по убыванию доли удач; ok = -1 значит «стратегия не поднялась».
     *
     *  Наборов целей ДВА, как у Zapret Manager: общий (сайты плюс dpi-checkers) для Flowseal и
     *  v, YouTube — для Yv. У каждого свой контрольный проход «без обхода» и свой перечень
     *  целей; строка результата называет свой набор и то, что в нём открылось. Верхние
     *  `targets` и `baseline` — про общий набор, для файла постарше. */
    zapretResults: declare<ZapretResults>('zapret_results'),
}

export type ZapretFamily = 'flowseal' | 'v' | 'yv' | 'other'

export type ZapretSet = 'general' | 'youtube'

export interface ZapretResults {
    at: number
    targets: number
    /** Сколько целей открылось БЕЗ обхода вовсе. Без этого числа «30 из 54» не значит
     *  ничего: может, у этого провайдера и без обхода открывается тридцать. */
    baseline: number
    scope?: string
    sets?: Partial<Record<ZapretSet, {
        baseline: number
        total: number
        at?: number
        /** Все цели набора по порядку и те из них, что открылись без обхода. */
        targets: string[]
        opened: string[]
    }>>
    results: {
        name: string
        ok: number
        /** Сколько целей было у ЭТОЙ стратегии; нет — как у набора (файл постарше). */
        total?: number
        set?: ZapretSet
        at?: number
        /** Метки открывшихся целей — в порядке перечня целей набора. */
        opened?: string[]
    }[]
}

export type Rpc = typeof rpc
