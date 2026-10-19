# Relay hints: the relay's well-known addresses, as a signed advisory

Status: built on `main` for the signed document, `.com`, the signing tool and Android
(2026-10-19). iOS has no DNS-failure fallback yet, so it has nothing to feed. Nothing is
signed or deployed: the committed hint is `null`, and every app uses its compiled-in seed.

## The problem

When an app cannot resolve a box's name, it connects to the relay directly, with the box's
name still used for SNI, hostname checks and the certificate pin (`RelayFallbackDns` on
Android). Those relay addresses used to be compiled into the app, so re-addressing the
relay meant a release and a security notice. They are only a hint, so they should be
changeable without a release, and a bad one must never raise an error about the box.

## The rules

1. **Advisory only.** The addresses are used only after DNS has failed, never first. A box
   is authenticated by TLS to its own name and its pinned certificate, whatever address
   answered. A wrong or hostile address can fail to connect; it cannot impersonate a box.
2. **A failed hint is not an error about the box.** A connection through a hint that fails
   (stale address, closed handshake, pin mismatch) reads as the unresolved name it was
   before the hint (`RelayHintFailureInterceptor`). A name DNS answered keeps its real errors.
3. **Any host that proves the box works.** The pin is checked against the box's own
   STK-signed fingerprint, not against an address, so DNS or a hint sending the app to a
   different host that holds the same certificate succeeds silently.
4. **Signed by the authority.** The hint is signed offline by the cold ca-track maintainer
   authority (the same key as security notices), so a network or `.com` cannot steer every
   phone's fallback somewhere useless. Apps verify against the baked pin and fail open.

## The document

```
flagship/relay-hint/v1|<signedBy>|<seq>|<validFrom>|<validUntil>|<addresses>
```

`addresses` is 1 to 8 public IPv4 or IPv6 literals joined with `,` (no private, loopback,
link-local, CGNAT, multicast or unique-local ranges; no duplicates). The window is at most
180 days. `seq` only rises; apps remember the highest verified and refuse an older one.
Code: `packages/protocol/src/relayHint.ts`; vectors: `packages/protocol/test-vectors/relay-hint/`
(`npx tsx packages/protocol/tests/genRelayHintVectors.ts`), run by TypeScript and Kotlin.

## Order of use, when DNS fails

1. `relay-fallback.<apex>` (answered by the zone's root wildcard).
2. The stored signed hint's addresses, if in window and still verifying against the authority now.
3. The compiled-in seed (`RelayAddresses.prod`, prod apex only).

## Serving it

`GET /api/relay-hints` on `.com` (`apps/com/src/relayHints.ts`): one static document for
everybody, 204 when nothing is signed, no auth, no cookie, no counter, cacheable for an
hour. It carries the public ca-track mandate log the app needs to find the current
authority. Apps fetch it about daily, on a client of their own (no headers, no redirects).

## Signing

```
node scripts/relay-hint.mjs --address 149.248.216.86 --address 2a09:8280:1::110:d2b6:0          # preview
node scripts/relay-hint.mjs --address ... --sign                                                # YubiKey, typed RELAY-HINT
```

Writes `.maintainers/relay-hints/current.json` and `history/<seq>.json`. Commit it, land it
on `main`, then redeploy `.com` (`npm run deploy` in `apps/com`): the Worker bundles the file.
Take the addresses from `flyctl ips list -a flagship-services`, and keep the old ones in the
list for a release cycle so phones that have not fetched the new hint still reach the relay.

## Not built

- iOS: no DNS-failure fallback exists to feed. Adding one needs a path that connects to a
  chosen address while keeping the box's name for TLS (Network.framework, or the CONNECT
  proxy LAN-direct already uses); the vectors and Swift port of the document follow it.
- The webapp does not need one: browsers resolve through the system and have no seed.
