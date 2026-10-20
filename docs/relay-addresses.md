# Relay addresses: asking `.com` when DNS can't help

Status: built on `main` for Android and iOS (2026-10-19). No server change was needed. The
webapp and the three Studios have nothing to feed (see "Who uses it").

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
A wrong address, or a `.com` that recommends one, can only fail to connect.

## Test first, then rely

Before an address is used it is tested: a TLS handshake to it under a known box's name that
ends in that box's own pinned certificate. That shows the relay is up and forwards for the
box, so it is both on and authorized; a relay that is down, stale, or not the relay cannot
pass. Results are kept 10 minutes (passed) or 2 minutes (failed). With no box known yet
(nothing paired) there is nothing to test with, and the untested order below is used.

## Order of use, when DNS fails

1. The addresses `.com` recommends, and the seed, that pass the test, best first.
2. Android only, when none pass: `relay-fallback.<apex>` (answered by the zone's root wildcard).
3. The addresses `.com` last recommended (kept on the phone, refreshed about daily).
4. The compiled-in seed (`RelayAddresses.prod`, prod apex only), last.

## Who uses it

| app | uses relay addresses | how |
|---|---|---|
| Android | yes | `RelayFallbackDns` (OkHttp `Dns`), `RelayAddressCenter`, `TlsPinRelayProber` |
| iOS | yes | URLSession cannot choose an address, so `LoopbackAddressShim` is a CONNECT proxy on the phone's own loopback (the same `ProxyConfiguration` route as LAN-direct); TLS still runs between URLSession and the box, the forwarder sees ciphertext and serves only names under the data apex. `RelayRoute`, `RelayAddressRegistry`, `RelayAddressFetcher` |
| webapp | no | a browser cannot choose an address for a name; it needs DNS |
| Studios (Mac, Windows, Linux) | no | they only call `.com` (order status, health) and never dial `.flagship.services` |
| box daemon | already | reads the hub from the same `/api/services/endpoints` answer (`servicesEndpoints.ts`), with a compiled-in default |

The address rules (public unicast only, at most 8) are shared as
`apps/mobile/test-vectors/relay-addresses.json`, read by both phone test suites.

## A failed attempt is not an error about the box

A connection through relay addresses that fails (stale address, closed handshake, pin
mismatch) reads as the unresolved name it was before (`RelayHintFailureInterceptor`), never
as a TLS or trust error. A name DNS answered keeps its real errors. Any host that proves it
is the box works, whichever address led there.

## What is checked on the phone

A recommended address must be a public unicast literal: not loopback, link-local, private,
CGNAT, multicast or unique-local, so `.com` cannot point the fallback at the local network.
At most 8 are kept.
