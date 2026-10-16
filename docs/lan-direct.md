# LAN-direct: reaching a box without the relay

Open-work item 22 (2026-10-09). A device on the same network as its box should
talk to it directly instead of hairpinning through `.services`, which costs the
user relay quota (both directions count) and costs us egress.

## What exists today (investigated 2026-10-09)

- **The box listens only on loopback.** `startDaemonRuntime` binds its TLS server
  to `127.0.0.1:<ephemeral>` (`runtime.ts`); the tunnel client forwards every
  relayed stream into it. Nothing on the box accepts a LAN connection, and no
  firewall is configured (the daemon unit has no `User=`, so it runs as root).
- **Nothing trusts a loopback source.** Every relayed connection already arrives
  from `127.0.0.1`, so no handler can treat "loopback" as privileged; the only
  address-aware code keys rate limits on the client-supplied `X-Forwarded-For`.
  Feeding LAN connections into the same server changes no trust decision.
- **How a device pins the box.** The daemon signs a `flagship/daemon-status/v1`
  report with its STK; `.com` relays it verbatim on `/pods`; the device derives
  the STK from its own UMK (`deriveSTK(deriveSWK(UMK, serverId))`), verifies the
  report, and pins the box hostname to the leaf-cert SHA-256 — hard-fail
  (Android `CertPinRegistry` + `CertPinHostnameVerifier`, iOS equivalents).

## Design

**A separate signed hint, served by the box.** The box advertises where it can
be reached locally in a new STK-signed message, `flagship/lan-hint/v1`
(`packages/protocol/src/lanHint.ts`), served at `GET /api/screens/lan-hint`
behind the paired-session gate. Not in the daemon-status report, because:

- that report's canonical bytes are pinned by every installed client — growing
  it would make old apps fail their hard-fail cert pin, and `.com` would reject
  reports until redeployed;
- `.com` has no business knowing the owner's home network layout. The hint
  travels over the already-pinned relayed TLS, box to owner device only.

The hint carries `serverDomain`, the leaf-cert SHA-256 (so it is void the moment
the cert rotates), the endpoints, and `issuedAt`/`expiresAt` (≤ 24 h). A device
accepts it only if the signature verifies under its locally derived STK, the
domain and cert match what it pins, it is current, and **every** endpoint is a
LAN address — a box never emits anything else, so one public address voids the
whole hint.

**LAN addresses only.** `isLanAddress`: IPv4 RFC 1918 (10/8, 172.16/12,
192.168/16) and IPv6 unique-local (fc00::/7). Refused: public, loopback,
link-local (169.254/16, fe80::/10), CGNAT (100.64/10), multicast, unspecified,
IPv4-mapped IPv6. The daemon also skips container/VM/VPN interfaces (`docker*`,
`br-*`, `veth*`, `virbr*`, `tailscale*`, `wg*`, `tun*`, `zt*`, …). A VPS with only
a public address therefore binds nothing.

**One listener, two framings** (`packages/server-daemon/src/lanDirect.ts`). The
box listens on each LAN address at :443 and forwards bytes into the SAME loopback
TLS server the tunnel feeds — certificates, SNI routing, auth and service access
are unchanged. The first bytes decide:

- `0x16` (a TLS ClientHello) → pipe. Used by Android: OkHttp resolves the box
  hostname to the LAN address itself, so SNI and hostname verification still use
  the hostname and the existing pin applies.
- `CONNECT <host>:443` for the box itself or a name under it → `200`, then pipe.
  Used by iOS: URLSession can't override DNS per request, but iOS 17+ can route a
  session through an HTTP CONNECT proxy (`proxyConfigurations`), keeping the URL,
  SNI and certificate validation on the real hostname. Any other host or port is
  refused (403) without touching the backend.

Caps: 256 concurrent LAN connections, 5 s to send the first bytes, 5 min idle.
Rescan every 60 s (DHCP changes). `FLAGSHIP_LAN_DIRECT=0` disables it;
`FLAGSHIP_LAN_PORT` moves it.

**Clients: prove it's the box, then prefer it, never depend on it.** A device
that holds a verified hint probes it before use: a TLS handshake to the LAN
endpoint with SNI = the box hostname, accepted only if the leaf matches the
pinned fingerprint. Only then does it route there; the result is cached per
network and dropped on any network change. Probes run in the background, one
at a time per box: a request never waits for one, it takes the relay until the
box has proved itself. The probe is what makes a stale hint harmless: on
another network the same private address may belong to a different device, and
a bare TCP check would send the request there (and a pin failure is not
something OkHttp retries on another route). See "Failure handling" for what
every failure does.

**Web: out of scope.** A browser can't override DNS or choose a proxy per site,
and the box cert names the public hostname, so a page can't reach the box by
LAN address with valid TLS. The webapp keeps using the relay.

## Box to box (app copies, 2026-10-12)

Copying an app between two of the owner's servers (`docs/app-placement.md`
§5) used to cross the owner's uplink twice: target → relay → source and back.
With LAN-direct on, the source adds its bound LAN endpoints to the copy's
description (`lan` in the `meta` answer). That answer reaches only the box the
owner's signed order names as target, over the relayed TLS that ends on the
source, so the home network's layout goes to no one else and needs no
signature of its own. The target then sends every later request (each still
signed with its identity key) to that address, but still as
`https://<source>` (`appCopy/lanFetch.ts`): SNI, Host and the WebPKI
certificate check are against the source's own name, so a device that merely
holds the address can't answer. It prefers an endpoint on its own /24, never
tries a non-LAN address, gives a connection 3 s to connect and 15 s of silence after, and falls back to the relay
for the rest of the copy at the first failure. The copy records `route`
(`lan` | `relay`). A box with `FLAGSHIP_LAN_DIRECT=0` neither offers nor uses
a LAN route. Studio's hosted VMs share one NAT subnet on their Mac
(`192.168.64.0/24`), so two VMs on the same Mac copy over it even though a
phone on the Wi-Fi can't reach them.

## Failure handling

Owner rule (2026-10-16): LAN-direct is in the MVP because its failure is a
no-op. Whatever goes wrong costs at most a short timeout, is logged, and the
traffic goes over the relay as if LAN-direct didn't exist. It never sends a
request to a device that hasn't proved itself the box, and TLS always ends on
the box with its own cert for its own name (Android: SNI, hostname check and
pin on the box name; iOS: TLS to the box name inside the CONNECT tunnel, same
pinning delegate; box to box: WebPKI against the source's name). A hostile
LAN device sees what the relay sees: the box name and ciphertext.

Logs: box `[lan-direct]` / `[app-copy]` lines in the daemon journal; iOS
unified log subsystem `com.flagshipserver.app`, category `lan-direct`;
Android logcat tag `LanDirect`.

**Box.**

| Failure | What happens |
|---|---|
| `FLAGSHIP_LAN_DIRECT=0` | No listener; the hint endpoint answers 204; app copies neither offer nor use a LAN route. |
| No private address (a VPS) | Nothing bound; hint 204. |
| An address can't be bound (`:443` taken, address gone) | That address stays relay-only; said once per address and reason; retried every 60 s. |
| Interfaces unreadable, `FLAGSHIP_LAN_PORT` not a port, listener can't start | Relay only (bad port falls back to 443), logged; the daemon keeps running. |
| The box's own TLS server is down | Each LAN connection is closed at once (the client falls back). |
| A LAN client sends nothing / garbage / a CONNECT outside the box's zone or port | Closed after 5 s / closed after 4 KB / `403` without touching the TLS server. Over 256 connections: dropped. |
| No certificate yet, or the cert rotated | No hint until a cert exists (204); a hint names the cert, so an old one is void on clients. |

**Phone (iOS and Android).**

| Failure | What happens |
|---|---|
| Hint with a bad signature, another box's name, another cert, expired, or any non-LAN endpoint | Refused and forgotten (logged); relay. |
| No hint (204), hint fetch fails | Relay. |
| Nothing answers at the hinted address (box away, other network) | The background probe gives up (iOS 1.5 s, Android 0.4 s connect + 1.5 s handshake); cached as failed for this network for 5 min; relay. No request waits. |
| Another device holds the address (address reuse, hostile LAN) | Its TLS can't show the box's cert for the box name: the probe fails; relay. |
| iOS local-network permission refused (or its prompt still open) | The probe's connection waits, which counts as failure; relay. |
| The box leaves after proving itself (within the 5-min window) | iOS: `cannotConnectToHost` → the request goes again over the relay. Android: a LAN connect gets 1.5 s (not the client's 15 s), then OkHttp takes the relay route. LAN use stops on this network. |
| A different device takes the address after the probe | TLS/pin refused before anything is sent → resent over the relay; LAN use stops; not reported as interception of the relay. |
| The listener refuses the CONNECT (iOS) | CFNetwork proxy error → resent over the relay. |
| Wi-Fi switch or drop mid-request | Network change clears every probe, so new requests take the relay. The request in flight: a read is resent over the relay; a change (POST etc.) whose fate is unknown fails as it would on a relay drop, and the retry takes the relay. |
| A stalled LAN connection (box frozen, link up) | The request's own timeout, as on the relay; then as above. |
| Any other LAN error | LAN use stops on this network; reads resent, changes fail once. |

**Box to box (app copy).**

| Failure | What happens |
|---|---|
| Source offers no LAN endpoint, or only non-LAN ones | Relay for every part. |
| Nothing answers / handshake never finishes | 3 s, then that chunk and the rest of the copy go over the relay (`route: relay`, logged). |
| Another device holds the address | TLS refuses it (wrong name or untrusted cert) before any request is sent; relay. |
| The source goes quiet after the handshake (Wi-Fi drop, no reset) | 15 s of silence ends the request (was: the 5-minute request limit); relay. |
| The connection drops mid-answer | The chunk fails (never a short chunk), refetched over the relay. |
| Connection refused | Relay at once. |

The webapp never uses LAN-direct.

**Tested (2026-10-16).** Box: `lanDirect.test.ts` (listener over live
sockets, including the failure rows above), `appCopyLanFetch.test.ts` (stall,
quiet, truncation, wrong name, untrusted cert), `appCopy.test.ts` "with the
real listener and LAN fetch" (the source's export behind the real listener,
the target's real LAN fetch; decoy, mute, quiet, drops and refused each finish
the copy over the relay with a log line). Android: `LanDirectTest` (background
probe, single flight, fallback interceptor, connect cap). iOS:
`LanDirectFallbackTests` (shared package) and `LanHintTests` /
`LanDirectRegistryTests`; the app target builds. Two Debian 13 arm64 VMs
(QEMU/HVF on the Mac) joined by a private link: the real listener found and
bound the VM's two private addresses (not loopback, link-local or `fec0::`);
from the peer, the daemon's LAN fetch, raw TLS with the name resolved to the
LAN address (Android's route) and curl through CONNECT (iOS's route) all
reached the box with SNI and Host = the box name; CONNECT to another host got
403; 64 MB in 0.56 s. Failures on that link: replies black-holed → "no
answer" in 3.1 s; 4 s added latency → 3.1 s; link down mid-transfer → "went
quiet" 3 s after; listener stopped → refused in 33 ms; another TLS server
with a valid cert for another name at the address → refused before any
request (both curl routes too).

## Threat model

| Threat | Outcome |
|---|---|
| A device on the LAN connects to the listener | It reaches exactly what the relay already exposes to the internet — same server, same auth. Nothing new is reachable. |
| Rogue LAN device impersonates the box at the hinted address | TLS: no valid cert for the hostname, and the pin check fails. The probe rejects it; the client stays on the relay. |
| Forged or replayed hint | Signature fails (wrong key), or the cert/domain/expiry checks fail. A hint from before a cert rotation is void. |
| A hint pointing at a public address (exfiltration / tracking) | Refused even with a valid signature (`non-lan-endpoint`). |
| `.com` compromised | `.com` never sees or relays the hint; it can't forge one. |
| Using the listener as an open proxy | CONNECT is restricted to the box's own zone on :443. |
| Home box exposed to the internet via UPnP / port forwarding | Not done by Flagship; the listener only binds private addresses. A user who forwards :443 themselves exposes the same surface the relay already does. |
| LAN connection flood | Capped at 256 concurrent; header deadline 5 s. |

## Bluetooth (later)

Bluetooth LE suits the low-volume ceremonies — pairing, unlock approval,
recovery confirmations — where it removes the network entirely, not bulk data.
It needs its own transport binding (GATT + a Noise/XX-style handshake anchored
in the same STK) and is not part of this branch.

## Status (2026-10-16)

On `main` since 2026-10-12 and in the launch MVP (`launch-mvp.md`). Boxes
need an endorsed release with the 2026-10-16 fixes; phones need store builds.
Not yet shown on real hardware, and only a phone on a real metal box's Wi-Fi
can show it: iOS's local-network prompt and its effect, the CONNECT route
through iOS's networking stack, Android's DNS route, roaming off the network
and back, an app copy between two metal boxes on one LAN. A Studio-hosted VM
is behind NAT, so a phone's probe of it should fail and stay on the relay.
