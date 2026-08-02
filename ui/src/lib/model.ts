// The shapes this UI edits and displays. They mirror steer's spec and status
// one-to-one on purpose: the dashboard is an editor for the engine's config, and
// every extra layer of its own vocabulary would be one more place for the two to
// drift apart. See steer/docs/contract-v1.md.

/** Where a channel's traffic goes. `interface` is a device; `direct` claims the
 *  packet and leaves it on the normal path. */
export type OutputKind = 'interface' | 'direct'

export interface Output {
    name: string
    kind: OutputKind
    /** Only for kind 'interface'. Failover may re-point this without touching channels. */
    device?: string
}

/** Observed facts the engine reports per output. `nat`/`in_firewall` matter because
 *  an interface output silently swallows traffic without them — the route applies,
 *  the counter rises, and every site behind it hangs. */
export interface OutputStatus extends Output {
    up?: boolean
    mark?: string
    table?: number
    in_firewall?: boolean
    nat?: boolean
}

/** fake-IP is precise per domain; real-IP keeps traceroute hops legible and loses
 *  precision only where two domains share one address. Not cosmetic — see the
 *  contract. Prefix channels ignore it. */
export type DomainMode = 'fakeip' | 'realip'

export interface Channel {
    name: string
    /** Who: subnets or addresses. Empty means the spec's from_default. */
    from?: string[]
    /** Arrays, like the engine: several lists feeding one channel is the normal case,
     *  and the compiler merges channels that agree on output/clients/mode into ONE set
     *  and ONE rule — so a dozen enabled lists cost two rules per packet, not a dozen. */
    match: {
        prefixes_files?: string[]
        domains_files?: string[]
        mode?: DomainMode
        any?: boolean
    }
    /** Output name, not a device: the device is the output's business. */
    out: string
}

export interface Spec {
    schema: 1
    from_default?: string[]
    lan_device?: string
    traceroute_hops?: boolean
    outputs: Record<string, Output>
    /** ORDERED: first match wins, and the order is the priority. Reordering this
     *  array is a behaviour change, which is why the UI shows it as a ranked list
     *  rather than a set of independent toggles. */
    channels: Channel[]
}

export interface ChannelStatus {
    name: string
    out: string
    live: boolean
    packets?: number
    bytes?: number
}

export interface Status {
    schema: 1
    outputs: Record<string, OutputStatus>
    channels: ChannelStatus[]
    warnings?: { code: string; text: string; channel?: string }[]
}

/** A list a channel can point at. The two kinds are not interchangeable: an IP list
 *  fills its set from the file, a domain list is filled by the resolver at query
 *  time. One manifest carries both so the picker can offer either. */
export type ListKind = 'prefixes' | 'domains'

export interface ListEntry {
    id: string
    kind: ListKind
    /** Russian display name from the manifest. */
    name: string
    description?: string
    /** Prefixes or domains, as counted by whoever published the manifest. */
    count?: number
    /** Sensible default per the publisher — not a promise this router can hold it. */
    default_on?: boolean
    file: string
    /** Where the list came from, so the UI can say why two lists disagree. */
    source?: string
    /** Address categories covering the same target. Shown as a warning, not hidden:
     *  the choice between forms is real (domains are more precise, addresses cheaper),
     *  but enabling both is never what someone means. */
    same_as_ip?: string[]
}

/** Exactly what the publisher ships. Address categories and domain lists live under
 *  separate keys because they have different shapes and different purposes — and
 *  keeping them separate means an older consumer does not break on the new one. */
export interface RawManifest {
    version: string
    base_url: string
    categories?: {
        id: string
        name_ru: string
        description_ru?: string
        file: string
        count?: number
        default_on?: boolean
        is_geoblock?: boolean
    }[]
    domain_lists?: {
        id: string
        kind: 'domains'
        name_ru: string
        file: string
        count?: number
        default_on?: boolean
        source?: string
        /** Address categories built from the SAME source file — the same target in
         *  another form. Enabling both is the likeliest misconfiguration there is:
         *  double the memory, and two channels arguing over one destination. */
        same_as_ip?: string[]
        overlaps?: { with: string; domains: number; percent: number }[]
    }[]
}

export interface Manifest {
    version: string
    base_url: string
    lists: ListEntry[]
}

/** Flattens the publisher's two keys into one pickable list. */
export function toLists(m: RawManifest): Manifest {
    const lists: ListEntry[] = []
    for (const c of m.categories || []) {
        lists.push({
            id: c.id,
            kind: 'prefixes',
            name: c.name_ru,
            description: c.description_ru,
            count: c.count,
            default_on: c.default_on,
            file: c.file,
        })
    }
    for (const d of m.domain_lists || []) {
        lists.push({
            id: d.id,
            kind: 'domains',
            name: d.name_ru,
            count: d.count,
            default_on: d.default_on,
            file: d.file,
            source: d.source,
            same_as_ip: d.same_as_ip,
        })
    }
    return { version: m.version, base_url: m.base_url, lists }
}

/** What a fresh install starts from: nothing routed anywhere. An empty channel list
 *  is a valid spec, and it beats guessing which lists someone wants. */
export const EMPTY_SPEC: Spec = {
    schema: 1,
    outputs: {},
    channels: [],
}
