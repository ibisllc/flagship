# Relay addresses: asking `.com` when DNS can't help

Status: built on `main` for Android and iOS (2026-10-19); the relay echo was added 2026-10-20
(the `.services` side needs a Fly deploy, see "The relay echo"). The webapp and the three Studios
have nothing to feed (see "Who uses it").

## The problem

When an app cannot resolve a box's name, it connects to the relay directly, with the box's
name still used for SNI, hostname checks and the certificate pin (`RelayFallbackDns`). Those
relay addresses used to be only compiled into the app, so re-addressing the relay meant a
release. They are a way round a DNS failure, nothing more.

## The rule

The app asks `.com`, which it already reaches and trusts over ordinary TLS, which relay
addresses it recommends: `GET /api/services/endpoints` already answers `passthroughIPv4` and
`passthroughIPv6` from `SERVICES_PASSTHROUGH_IPV4/6`, the same values the zone's wildcard
records must equal (`docs/wildcard-dns.md`). Nothing new is signed or served.

`.com` is not trusted with the box. The connection still has to prove itself: TLS to the
box's own name, then the box's STK-signed certificate fingerprint (`CertPinHostnameVerifier`).
So a wrong address, or a `.com` that recommends one, cannot read or impersonate a box.

What the pin does **not** prove is that the first hop is our relay: a forwarder run by whoever
controls the address can pass the box's TLS through untouched, and would see the phone's IP,
which box it asked for, and the timing. The relay echo (below) closes that.

## The relay echo

An address `.com` recommends (one that is not in the compiled-in pair) must also answer
"which address did you reach me at?" with itself. The relay answers it on `:8444`
(`apps/web/src/lib/addressEcho.ts`): Fly ends TLS there with the app's own `fly.dev` certificate
and puts a PROXY-protocol header in front, and the reply names the destination address from
that header. The phone checks the certificate (so a forwarder cannot write the answer) and
compares the reported address with the one it dialed. A forwarder has to dial the relay's own
address to reach it, so its echo names that one, not the forwarder's, and the phone drops it.

The compiled-in pair is exempt (it is ours, and the pinned handshake is its test), so an old or
undeployed echo never strands the last resort. **Not yet verified live:** that Fly's PROXY header
carries the dedicated public address rather than an internal one. Check with
`openssl s_client -connect 149.248.216.86:8444 -servername flagship-services.fly.dev`, then
`GET /echo`, right after the first deploy; if it names something else, `.com` addresses fail the
echo and the phones fall back to the compiled-in pair, which is safe.

## Test first, then rely

Before an address is used it is tested: a TLS handshake to it under a known box's name that
ends in that box's own pinned certificate. That shows the relay is up and forwards for the
box, so it is both on and authorized; a relay that is down, stale, or not the relay cannot
pass. Results are kept 10 minutes (passed) or 2 minutes (failed). With no box known yet
(nothing paired) there is nothing to test with, so only the compiled-in pair is tried.

## Order of use, when DNS fails

1. The addresses `.com` recommends (passing the pinned handshake and the echo), and the seed
   (passing the pinned handshake), best first.
2. Android only, when none pass: `relay-fallback.<apex>` (answered by the zone's root wildcard).
3. The compiled-in seed (`RelayAddresses.prod`, prod apex only), last. An address `.com`
   recommended is never used untested.

## Who uses it

| app | uses relay addresses | how |
|---|---|---|
| Android | yes | `RelayFallbackDns` (OkHttp `Dns`), `RelayAddressCenter`, `TlsPinRelayProber` |
| iOS | yes | URLSession cannot choose an address, so `LoopbackAddressShim` is a small CONNECT listener on the phone's own loopback (the same `ProxyConfiguration` route as LAN-direct); it is on the phone, not a server of ours. TLS still runs between URLSession and the box; the shim sees ciphertext and serves only names under the data apex on port 443, at most 32 clients, a request line within 5 s, and closes tunnels idle for 60 s. It is stopped when the app goes to the background (`RelayRoute.suspend()`) and a fresh one, on a fresh port, starts at the next need. `RelayRoute`, `RelayAddressRegistry`, `RelayAddressFetcher` |
| webapp | no | a browser cannot choose an address for a name; it needs DNS |
| Studios (Mac, Windows, Linux) | no | they only call `.com` (order status, health) and never dial `.flagship.services` |
| box daemon | already | reads the hub from the same `/api/services/endpoints` answer (`servicesEndpoints.ts`), with a compiled-in default |

The address rules (public unicast only, at most 8) are shared as
`apps/mobile/test-vectors/relay-addresses.json`, read by both phone test suites.

## A failed attempt reads as the unresolved name, and keeps its real reason

A connection through relay addresses that fails (stale address, closed handshake, pin
mismatch) reads as the unresolved name it was before (`RelayHintFailureInterceptor`), never
as a TLS or trust error. A name DNS answered keeps its real errors. Any host that proves it
is the box works, whichever address led there.

The sentence stays calm, but the reason is kept: `DiagnosticsLog` (the last 50, never a body,
key or chosen name) records `relay-route-unverified` or `relay-pin-mismatch` with the underlying
class (`net-dropped`, `net-timeout`, `tls-failed`, ...). The codes are the same on iOS
(`DiagnosticCode`) and Android (`DiagnosticCode.kt`).

## What `.com` and a network can do

- A malicious `.com` can withhold or blackhole addresses (denial) and can point at a forwarder;
  the echo drops a forwarder. It cannot read a box or pass the pin with an unrelated endpoint.
  With no box known yet, nothing from `.com` is tried.
- A network that blocks `.com` or an address forces the compiled-in pair; one that redirects at
  the IP level fails TLS or the pin. A network on the path already sees the phone's IP and the SNI.
- A stale address fails the handshake or the echo; results are re-tested every 10 minutes.

## What is checked on the phone

A recommended address must be a public unicast literal: not loopback, link-local, private,
CGNAT, multicast or unique-local, so `.com` cannot point the fallback at the local network.
At most 8 are kept.
