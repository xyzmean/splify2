// ubus calls into splify2's rpcd backend.
//
// The backend is a thin wrapper over the engine: it reads and writes the spec file,
// runs `steer apply`, and relays `steer status` / `steer explain` verbatim. It
// deliberately does not model channels itself — a second model would be a second
// thing to keep in sync with the engine's contract.

import {
    normalizeSpec,
    toCatalog,
    type RawManifest,
    type Spec,
    type Status,
    type VlessNode,
    type VlessProbe,
} from './model'

export { toCatalog }

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

function declare<T>(method: string, params: string[] = []) {
    const rpc = window.luci_rpc
    if (!rpc) {
        // Standalone (vite dev) — fail loudly rather than pretending to have data.
        return async (): Promise<T> => {
            throw new Error(`ubus is unavailable outside LuCI (splify.${method})`)
        }
    }
    const fn = rpc.declare({ object: 'splify2', method, params })
    return (...args: unknown[]) => fn(...args) as Promise<T>
}

const specGetRaw = declare<Spec>('spec_get')
const listPutRaw = declare<unknown>('list_put', ['name', 'kind', 'text', 'url', 'append'])
const listRemoveByName = declare<unknown>('list_remove', ['name', 'kind'])

export const rpc = {
    /** Live engine state: outputs with up/nat, per-channel counters, warnings. */
    status: declare<Status>('status'),

    /** The spec as stored. The UI edits a copy and writes it back whole: a partial
     *  update would need the backend to understand channel ordering, and ordering is
     *  precisely what must not be reinterpreted on the way through. */
    /** Единственный вход спеки в интерфейс — поэтому и приведение написаний стоит здесь,
     *  а не в четырёх потребителях `match` по отдельности (I-041, splicicd#7). */
    specGet: () => specGetRaw().then(normalizeSpec),
    specSet: declare<{ ok: boolean; error?: string }>('spec_set', ['spec']),

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
    listFetch: declare<{ ok: boolean; count?: number; error?: string }>('list_fetch', ['id', 'kind']),

    /** Which list files are already on the router, with their local line count. The
     *  UI cannot tell a downloaded list from a merely offered one without this — and
     *  without that difference, "Download" sits over a list that is already there. */
    localLists: declare<{ files: Record<string, { count: number; mtime: number }> }>('local_lists'),

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
    }) =>
        listPutRaw(p.name, p.kind, p.text ?? '', p.url ?? '', p.append ? 1 : 0) as Promise<{
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

    /** Devices that could serve as an interface output — tunnels first. */
    devices: declare<{ devices: { name: string; up: boolean; kind: string }[] }>('devices'),

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
    splify2Versions: declare<{ current: string; versions: string[] }>('splify2_versions'),

    /** Обновить интерфейс. reload_needed — не любезность: вместе с пакетом
     *  перезапускается rpcd, а бандл у браузера в кеше, поэтому без перезагрузки
     *  страницы старый интерфейс работает поверх нового бэкенда. */
    splify2Install: declare<{ ok: boolean; error?: string; installed?: string; reload_needed?: boolean }>(
        'splify2_install',
        ['version'],
    ),

    /** Версии движка, доступные в релизах. Спрашиваются у GitHub, а не зашиты: зашитая
     *  версия означает, что интерфейс ставит прошлое, и заметить это можно только по
     *  отсутствию чего-то нужного. */
    steerVersions: declare<{ arch: string; versions: string[] }>('steer_versions'),

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
    }>('sub_info'),
    /** Задать источник узлов: ссылка на подписку ЛИБО одна или несколько ссылок vless://.
     *  Одно поле на оба случая — различает их бэкенд по схеме, а не человек выбором режима. */
    subSet: declare<{ ok: boolean; error?: string; kind?: string; bytes?: number }>('sub_set', ['url']),

    /** Память мастера: непрозрачная строка, формат принадлежит мастеру.
     *
     *  Нужна, чтобы мастер узнавал СВОИ записи в спеке при любых именах. По зашитым именам он
     *  их не находил: на живом роутере канал звался funny, а выход vless — настроенные руками, —
     *  и мастер предложил создать рядом второй туннель вместо того, чтобы показать этот. */
    uiGet: declare<{ state?: string }>('ui_get'),
    uiSet: declare<{ ok: boolean }>('ui_set', ['state']),

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

    /** Узлы подписки глазами движка, с причинами непригодности. */
    vlessNodes: declare<{
        output: string
        sub_file: string
        node: number
        usable: number
        skipped: number
        foreign: number
        nodes: VlessNode[]
    }>('vless_nodes', ['output']),

    /** Проверить узел и замерить время ответа. По одному за вызов: проверка упирается в
     *  таймаут, и «проверить все» не уложилось бы в срок жизни вызова ubus. node = -1
     *  означает «до первого рабочего» — то же решение, что примет движок при подъёме. */
    vlessProbe: declare<{ output?: string; results?: VlessProbe[]; working?: number; error?: string }>(
        'vless_probe',
        ['output', 'node'],
    ),
}

export type Rpc = typeof rpc
