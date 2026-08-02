// ubus calls into splify2's rpcd backend.
//
// The backend is a thin wrapper over the engine: it reads and writes the spec file,
// runs `steer apply`, and relays `steer status` / `steer explain` verbatim. It
// deliberately does not model channels itself — a second model would be a second
// thing to keep in sync with the engine's contract.

import type { Manifest, Spec, Status } from './model'

declare global {
    interface Window {
        // Provided by LuCI's runtime on the page that hosts this bundle.
        L?: {
            rpc?: {
                declare: (o: {
                    object: string
                    method: string
                    params?: string[]
                    expect?: Record<string, unknown>
                }) => (...args: unknown[]) => Promise<unknown>
            }
        }
    }
}

function declare<T>(method: string, params: string[] = []) {
    const rpc = window.L?.rpc
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

    /** Lists available to point a channel at, IP and domain alike. */
    lists: declare<Manifest>('lists'),

    /** Fetch a list's file so a channel can use it. Downloading is the management
     *  layer's job, not the engine's. */
    listFetch: declare<{ ok: boolean; count?: number; error?: string }>('list_fetch', ['id']),

    /** Devices that could serve as an interface output — tunnels first. */
    devices: declare<{ devices: { name: string; up: boolean; kind: string }[] }>('devices'),
}

export type Rpc = typeof rpc
