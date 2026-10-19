# Relay addresses: asking `.com` when DNS can't help

Status: built on `main` for Android (2026-10-19). No server change was needed. iOS has no
DNS-failure fallback yet, so it has nothing to feed.

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

## Order of use, when DNS fails

1. `relay-fallback.<apex>` (answered by the zone's root wildcard).
2. The addresses `.com` last recommended (kept on the phone, refreshed about daily).
3. The compiled-in seed (`RelayAddresses.prod`, prod apex only).

## A failed attempt is not an error about the box

A connection through relay addresses that fails (stale address, closed handshake, pin
mismatch) reads as the unresolved name it was before (`RelayHintFailureInterceptor`), never
as a TLS or trust error. A name DNS answered keeps its real errors. Any host that proves it
is the box works, whichever address led there.

## What is checked on the phone

A recommended address must be a public unicast literal: not loopback, link-local, private,
CGNAT, multicast or unique-local, so `.com` cannot point the fallback at the local network.
At most 8 are kept.
