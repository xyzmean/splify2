// ubus calls into splify2's rpcd backend.
//
// The backend is a thin wrapper over the engine: it reads and writes the spec file,
// runs `steer apply`, and relays `steer status` / `steer explain` verbatim. It
// deliberately does not model channels itself — a second model would be a second
// thing to keep in sync with the engine's contract.

import {
    toLists,
    type RawManifest,
    type Spec,
    type Status,
    type VlessNode,
    type VlessProbe,
} from './model'

export { toLists }

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

export const rpc = {
    /** Live engine state: outputs with up/nat, per-channel counters, warnings. */
    status: declare<Status>('status'),

    /** The spec as stored. The UI edits a copy and writes it back whole: a partial
     *  update would need the backend to understand channel ordering, and ordering is
     *  precisely what must not be reinterpreted on the way through. */
    specGet: declare<Spec>('spec_get'),
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

    /** Devices that could serve as an interface output — tunnels first. */
    devices: declare<{ devices: { name: string; up: boolean; kind: string }[] }>('devices'),

    /** Умеет ли установленный движок VLESS. Спрашивается у движка, а не выводится из
     *  имени пакета: пакет мог быть собран из исходников или переименован. Без этого
     *  интерфейс предлагал бы выход, который отвергается при сохранении.
     *
     *  arch — архитектура ПАКЕТОВ (aarch64_cortex-a53, а не aarch64): по ней собирается
     *  имя файла релиза, и `apk --print-arch` для этого не годится. */
    engine: declare<{ present: boolean; vless: boolean; arch?: string; version?: string }>('engine'),

    /** Версии движка, доступные в релизах. Спрашиваются у GitHub, а не зашиты: зашитая
     *  версия означает, что интерфейс ставит прошлое, и заметить это можно только по
     *  отсутствию чего-то нужного. */
    steerVersions: declare<{ arch: string; versions: string[] }>('steer_versions'),

    /** Скачать и поставить движок выбранной версии и варианта. Вариант — выбор человека:
     *  он зависит от того, поднимает ли туннель сам движок, и пакетный менеджер такого не
     *  решает. */
    steerInstall: declare<{ ok: boolean; error?: string; installed?: string }>(
        'steer_install',
        ['version', 'extended'],
    ),

    /** Подписка: где лежит, откуда взята, когда обновлялась. */
    subInfo: declare<{ url?: string; path: string; present: boolean; bytes?: number; mtime?: number }>('sub_info'),
    /** Скачать подписку по ссылке. Загрузка — дело управляющего слоя, движок читает файл. */
    subSet: declare<{ ok: boolean; error?: string; bytes?: number }>('sub_set', ['url']),

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
