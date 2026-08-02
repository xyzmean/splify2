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
    match: {
        prefixes_file?: string
        domains_file?: string
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
}

export interface Manifest {
    version: string
    base_url: string
    lists: ListEntry[]
}

/** What a fresh install starts from: nothing routed anywhere. An empty channel list
 *  is a valid spec, and it beats guessing which lists someone wants. */
export const EMPTY_SPEC: Spec = {
    schema: 1,
    outputs: {},
    channels: [],
}
