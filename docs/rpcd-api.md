# splify2 rpcd API Contract

splify2 exposes a `ubus`/`rpcd` object named **`splify2`** to the Web UI (and any authenticated rpcd caller). This document is the contract for that object: the methods, their inputs, and their outputs.

splify2 is a thin shell wrapper over the `steer` engine. Methods that ask for engine state or diagnostics (`status`, `diag`, `vless_nodes`, `explain`) call the corresponding `steer` subcommand and return its JSON **verbatim**. The reason is deliberate: parsing the engine's output here would mean maintaining a second model in shell that drifts from the engine on the first change. When the engine prints JSON, the wrapper passes it through unchanged; when it does not, the wrapper returns a uniform error object.

## Conventions

- **Transport**: every method that takes input reads it as **JSON on stdin**, not as a positional argument. (`steer_install` previously read its blob from `$2`; it was aligned with the other methods and now also reads stdin. Callers passing the blob positionally will get empty values and an error.)
- **Success**: the shape documented per method.
- **Error**: every method signals failure with a uniform object:
  ```json
  { "ok": false, "error": "human-readable reason in Russian" }
  ```
  Methods that proxy the engine additionally return this object when the engine emits no valid JSON (e.g. `{"ok":0,"error":"движок не ответил"}`). Note that a **non-zero engine exit code is not itself an error** — e.g. `diag` and `vless-probe` exit `1` when they find a problem but still emit valid JSON, which is returned as success.
- **Access control**: methods are split into read/write groups in `luci/root/usr/share/rpcd/acl.d/luci-app-splify2.json`. A build-time check in `build.sh` fails the build if a declared method is missing from the ACL. New methods must be added to both the `list)` block of the rpcd script and the ACL file.

## Engine install and versions

These methods are the public interface for installing/updating the `steer` engine from the UI. Their behavior changed during the week of 2026-08-04 and is documented here as the current contract.

### `steer_versions` (read)

Returns the engine versions available to install. Queried live from GitHub (not a baked-in list), because a baked-in list would silently install an outdated engine.

- **Input**: none.
- **Output**:
  ```json
  { "arch": "aarch64_cortex-a53", "versions": ["0.9.4", "0.9.3", "..."] }
  ```
  `versions` contains the `tag_name`s of the last 10 releases of `xyzmean/steer`, without the leading `v`. Parsed from the GitHub releases API with `grep -o` (one tag per match) so it tolerates minified single-line JSON; an earlier greedy-`sed` parser collapsed everything into one capture and returned a malformed list.

### `steer_install` (write)

Downloads and installs a specific engine version and variant (base or extended). Installs *exactly* the requested package — it does not guess the variant, because choosing base vs. extended depends on whether the user wants the engine to run a VLESS tunnel itself.

- **Input** (JSON on stdin):
  ```json
  { "version": "0.9.4", "extended": false }
  ```
  - `version`: required, must match `X.Y.Z` (digits and dots only). Anything else is rejected with `"версия не в виде X.Y.Z"`.
  - `extended`: truthy values `1` or `true` select `steer-extended`; anything else selects base `steer`.
- **Output (success)**:
  ```json
  { "ok": true, "installed": "steer-extended-0.9.4-1_aarch64_cortex-a53.apk" }
  ```
- **Output (failure)**: the standard error object with one of: `"версия не в виде X.Y.Z"`, `"не определилась архитектура"`, `"не скачалось: <name> (нет такой версии для <arch>?)"`, or the captured stderr of `apk add`.
- **Behavior notes**:
  - To avoid apk file-ownership conflicts between `steer` and `steer-extended` (both own `/usr/sbin/steer`), the previously-installed variant is removed first with two separate `apk del steer` / `apk del steer-extended` calls. They run as separate commands because `apk del a b` fails if either package is absent, and their output is suppressed (`>/dev/null 2>&1`) so it does not corrupt this method's JSON response.
  - Installs with `apk add --allow-untrusted --force-overwrite`.
  - Enables the `steer` init service after install.

## Engine state and health

### `status` (read)
Returns the engine's applied state. Passes `steer status` output through verbatim. If the engine emits no object starting with `{`, returns `{"ok":0,"error":"движок не ответил"}`. See the steer `status` contract (incl. `down_packets`/`down_bytes`) in the steer `contract-v1.md`.

### `diag` (read)
Returns engine diagnostics. Passes `steer diag` output through verbatim. The engine exits `1` when it finds a `fail` verdict but still prints valid JSON — that JSON is returned as a normal response (the non-zero exit is **not** treated as an error). See the steer diag contract (verdict set `ok`/`note`/`warn`/`fail`, `note` excluded from counters) in steer `contract-v1.md`. If the engine produces no JSON, returns `{"ok":0,"error":"движок не умеет diag — обновите steer"}`.

### `engine_state` (read)
Returns the running state of engine instances and their last journal lines. Added because "output configured" and "tunnel carrying traffic" are different things, and a dead VLESS tunnel previously showed only as a missing device with no reason. The engine now exits non-zero with a reason line when a tunnel stops carrying traffic (see steer `vless.md` exit codes).
- **Input**: none.
- **Output**: per-instance running/pid plus the last lines of its journal, returned **verbatim** — the wrapper intentionally does not parse engine message text, because wording changes with the engine and parsing it here would silently break the display on every message edit.
- **Access**: added to the read ACL so it is reachable from the browser (it was previously reachable only from ssh).

### `dev_stats` (read)
Returns byte/packet counters for each network device from `/sys/class/net/*/statistics` (excluding `lo`). Needed because an nft channel counter sits on the mark rule in the LAN→WAN direction, so the reverse flow from the tunnel device does not match — on a live router this showed ~4.3 MB against 223 MB actually downloaded. For tunnel devices, `rx` is what the engine delivered to clients (downloaded) and `tx` is what it took from them.
- **Input**: none.
- **Output**:
  ```json
  { "devices": { "awg0": { "rx": "...", "tx": "...", "rx_packets": "...", "tx_packets": "..." }, "...": {} } }
  ```

## Specification

### `spec_get` (read)
Returns the current spec JSON from `/etc/steer/spec.json`, or `{"schema":1,"outputs":{},"channels":[]}` if the file is absent/empty.

### `spec_set` (write)
Validates and saves a new spec. **Input** (JSON on stdin): `{ "spec": "<full JSON spec string>" }`. The spec is validated with `steer apply --dry-run` before it is written, so the engine (the sole judge) never finds a spec on disk that it would reject. If the VLESS node fingerprint changed, the subscription is marked dirty for re-reading. Returns the standard success/error object.

### `apply` (write)
Applies the current spec via `steer apply`. No input. Returns the standard success/error object.

### `explain` (read)
- **Input** (JSON on stdin): `{ "address": "1.2.3.4 | example.com" }`.
- **Output**: `{ "text": "<steer explain output>" }`. The wrapper wraps the engine's text output verbatim.

## Lists and subscription

### `lists` (read)
Returns the list manifest (downloads it on first call). Pass-through.

### `local_lists` (read)
Lists locally-managed list files.

### `list_fetch` (write)
- **Input** (JSON on stdin): `{ "id": "<list id>", "kind": "<optional kind>" }`.
Fetches one list from the manifest by id (and kind). Returns success/error.

### `list_remove` (write)
- **Input** (JSON on stdin): `{ "id": "<list id>" }`.
Removes one locally-managed list.

### `sub_info` (read)
Returns information about the saved VLESS subscription (source URL or inline links, kind, size).

### `sub_set` (write)
- **Input** (JSON on stdin): `{ "url": "<subscription URL | one-or-more vless:// links>" }`.
Sets the subscription. Accepts an `http(s)://` subscription URL **or** one or more `vless://` links (space- or newline-separated). Returns `{ "ok": true, "kind": "url|links", "path": "<sub file>", "bytes": <n> }` on success, or the standard error object.

## Wizard / UI state

### `ui_get` (read)
Returns the wizard/UI state the user created, stored as an opaque string in UCI (`splify2.main.wizard`), separate from the spec. The format belongs to the UI and may change with it; the wrapper does not parse it.
- **Input**: none.
- **Output**: `{ "state": "<opaque string, possibly empty>" }`.

### `ui_set` (write)
Saves the wizard/UI state.
- **Input** (JSON on stdin): `{ "state": "<opaque string>" }`.
- **Output**: `{ "ok": true }`.

## Probes and devices

### `outbound_probe` (read)
- **Input** (JSON on stdin): `{ "output": "<output name>" }`.
Probes one output's responsiveness. For a VLESS output it asks the engine (`steer vless-probe`) because ICMP does not traverse the TUN; for an interface output it pings through the device. Returns `{ "output": "...", "state": "ok|нет ответа|нет устройства", "ms": <rtt or -1>, "how": "..." }`.

### `vless_nodes` (read)
- **Input** (JSON on stdin): `{ "output": "<vless output name>" }`.
Returns the nodes parsed from the subscription for that output, verbatim from `steer vless-nodes`.

### `vless_probe` (read)
- **Input** (JSON on stdin): `{ "output": "<vless output name>", "node": <index, -1 for all> }`.
Probes a single node (one per call, because the probe is timeout-bound and "all nodes" would exceed an rpcd call lifetime). Returns the engine's `steer vless-probe` JSON verbatim.

### `devices` (read)
Returns the network devices known to the system.

### `leases` (read)
Returns DHCP leases (device names by MAC).

### `net_info` (read)
A combined snapshot of tunnel-relevant info in a single call (avoids three separate ubus calls per poll on a 64 MB / single-core router). Deliberately does **not** include the external IP: discovering it requires a request to leave *through* the tunnel, but steer routes by packet mark not source address, so binding to the tunnel device address still sends the request over the default route and returns the ISP address — a confident wrong answer.

### `engine` (read)
Returns engine presence/version info: `{ "present": 1, "vless": 0|1, "arch": "...", "version": "..." }`.

## Method inventory

All 25 declared methods (from the `list)` block of the rpcd script). ACL group in parentheses.

| Method | ACL | Input on stdin |
|--------|-----|----------------|
| `status` | read | — |
| `spec_get` | read | — |
| `spec_set` | write | `{spec}` |
| `apply` | write | — |
| `explain` | read | `{address}` |
| `lists` | read | — |
| `list_fetch` | write | `{id, kind?}` |
| `devices` | read | — |
| `local_lists` | read | — |
| `list_remove` | write | `{id}` |
| `engine` | read | — |
| `sub_set` | write | `{url}` |
| `sub_info` | read | — |
| `dev_stats` | read | — |
| `diag` | read | — |
| `net_info` | read | — |
| `outbound_probe` | read | `{output}` |
| `leases` | read | — |
| `engine_state` | read | — |
| `ui_get` | read | — |
| `ui_set` | write | `{state}` |
| `vless_nodes` | read | `{output}` |
| `vless_probe` | read | `{output, node}` |
| `steer_versions` | read | — |
| `steer_install` | write | `{version, extended}` |

## Source of truth

This document is derived from `files/usr/libexec/rpcd/splify2`. If the two disagree, the script is correct and this document is stale.
