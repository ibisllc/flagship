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
network and dropped on any network change. Any failure falls back to the relay
silently. The probe is what makes a stale hint harmless: on another network the
same private address may belong to a different device, and a bare TCP check
would send the request there (and a pin failure is not something OkHttp retries
on another route).

**Web: out of scope.** A browser can't override DNS or choose a proxy per site,
and the box cert names the public hostname, so a page can't reach the box by
LAN address with valid TLS. The webapp keeps using the relay.

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

## Status

- Protocol message + cross-language vector, daemon listener + signed hint
  endpoint, Android and iOS clients: on `feat/lan-direct`.
- Needs a real box and phone on one network to validate end to end (bind on a
  real interface, iOS proxy path, roaming between networks).
