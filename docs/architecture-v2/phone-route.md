# The phone's bare name: tunnel, claim, routing and endpoint (plan H2, H3)

Status: built 2026-11-01 on `release/0.3` (TS relay, `.com` ledger and eligibility, protocol, node phone simulator,
Android and iOS phone side). Not deployed; not run on a device; the issuance API it orders through is H1's. The
decisions behind every number are in `issuance-and-lease-records.md` §4 "Phone routing" (agent recommendation,
owner to confirm). Rules and constants: `packages/protocol/src/phoneRoute.ts`; vectors:
`packages/protocol/test-vectors/phone-route/vectors.json` (`npx tsx tools/phone-route-vectors.ts`).

## 1. Pieces

| Where | File | What |
|---|---|---|
| protocol | `packages/protocol/src/phoneRoute.ts` | bare-name parse, claim check, eligibility, ledger CAS, CSR, cert reuse, endpoint policy |
| relay | `apps/web/src/tunnel/phoneRoute.ts` | sessions, the per-hostname holder, renewals, eligibility re-checks, `.com` clients |
| relay | `apps/web/src/tunnel/phoneTunnel.ts` | the `/phone-tunnel` WebSocket |
| relay | `apps/web/src/tunnel/registry.ts` | `findBySni`: a bare name resolves ONLY from the phone routes |
| `.com` | `apps/com/src/phoneRoute.ts` | eligibility read, the ledger (inside the ServingFeed DO), the eligibility push |
| phones | iOS `PhoneEndpoint*.swift`, Android `phoneroute/*.kt` | key, CSR, order, cert reuse, tunnel, TLS termination, endpoint |
| gym | `tools/live-e2e/lib/phoneSim.ts`, `groups/release03/phoneRoute.ts` | a phone in node; the live group |

The relay turns the feature on only with the serving authority (`FLAGSHIP_SERVING_REVOCATION_PUB` and
`SERVICES_CONTROL_SECRET`); `FLAGSHIP_PHONE_ROUTE=off` turns it off. Without it the bare name never routes.

## 2. The tunnel (`wss://<services apex>:8443/phone-tunnel`)

Text messages are JSON control; binary messages are tunnel-protocol v1 frames, exactly one per message. The relay
opens one stream per visitor (`OPEN` with the SNI, then the visitor's bytes as `DATA`), the phone answers `DATA` and
`CLOSE`. TLS ends on the phone.

```text
relay → {type:"hello", relayId, serverTime}
phone → {type:"begin", account}
relay → {type:"challenge", account, hostname, generation, sessionNonce, serverTime, expiresAt}
phone → {type:"claim", claim:{account, phoneRoutePub, hostname, generation, sessionNonce, issuedAt}, signature}
relay → {type:"granted", hostname, generation, leaseMs}   |   {type:"refused", code, generation?}
relay → {type:"route-vacant", hostname, generation}        to standbys: the holder left; claim now (first wins)
phone → {type:"release", release:{…claim fields, fresh issuedAt}, signature}   the holder gives the route up
relay → {type:"released", hostname, generation, confirmed}
relay → {type:"lost", hostname, generation, reason}        expired | revoked | contact | released
phone → {type:"beat"}                                      every 15 s (also answers WebSocket pings)
```

Handover is vacancy-only (owner, 2026-11-01; `issuance-and-lease-records.md` §4): a claim is committed only while the
route is vacant, decided by the ledger. A live holder keeps it while its tunnel and lease live; another eligible phone
is refused `route-held` with the holder's generation and, with its tunnel left open, becomes a standby that gets
`route-vacant` when the holder's tunnel drops, it releases, or its lease lapses. Leaving the foreground is just closing
the socket: the route is vacant at once and the holder's streams end with it (no drain).

`claim` is `flagship/route-claim/v1` signed (Ed25519) by the phone's account device key, the key its admin grant
names; `release` is `flagship/route-release/v1` over the held claim's fields. Refusal codes: `malformed`, `busy`,
`holding` (this session already holds it), `no-challenge` (none offered, expired or already used), `unavailable`
(`.com` unreachable), `not-eligible`, `route-held` (a live holder exists; carries its generation), `not-holder` (a
release from a session that holds nothing), `wrong-session`, `wrong-generation`, `wrong-account`, `wrong-hostname`,
`stale` (clock off by more than 60 s), `bad-signature`. Close code 4403: the phone is no longer eligible.

## 3. `.com`

- `GET /api/internal/phone-route/:u/eligibility` → `{adminRootPub, grants:[{grantId, username, deviceId,
  devicePubHex, scopes, issuedAt, expiresAt, signatureHex, signerRoot}]}`: active, unexpired grants of devices not
  removed. The relay runs `phoneRouteEligibility` (`requireMasterAdmin`, never the bare admin root).
- `GET /api/internal/phone-route/ledger?hostname=` → `{entry}`; `POST` the same path with `{op: acquire|renew|release,
  hostname, generation, holder|sessionId}` → `{ok, entry}` or `{ok:false, code, entry}` (`route-held` while a live
  holder exists).
- Both with the services control secret. The ledger is kept in the ServingFeed Durable Object (one instance), which
  pushes `{type:"phone-route", hostname, generation, vacant}` to every relay on a committed acquisition (`vacant:
  false`) or release (`vacant: true`); a relay with standbys also re-reads the ledger every 15 s. A device removal or
  grant revocation pushes `{type:"phone-eligibility", username}`.

## 4. The phone

- **Key.** P-256, made on the phone, never leaves it. Android: Android Keystore (StrongBox when present, else TEE),
  usable by `SSLEngine` through a Keystore-backed `KeyManager`. iOS: Secure Enclave key when the TLS stack accepts it
  (a `SecIdentity` from the SE key and the certificate); otherwise a `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  Keychain key. Which one was used is recorded with the certificate and shown in diagnostics.
- **CSR and order.** `phoneCsrInfo` bytes (CN and one dNSName SAN, exactly `<account>.<apex>`), signed by the key;
  `certificate-order/v1` with `class: phone`, `device` = account device key, `regGen` 0, signed by the device key, sent
  through one small issuance interface (`PhoneCertIssuer`), so the H1 API plugs in without touching the rest.
- **Reuse.** The chain is stored and reused until 30 days before it expires; a failed order waits 6 h. Never one order
  per handover.
- **Presence.** Coming to the foreground, every device of the account says a signed hello: `GET
  https://<account>.<apex>/` with `x-flagship-presence-device`, `-at`, `-sig` over
  `flagship/phone-presence/v1|<account>|<devicePub>|<hostname>|<issuedAt>`. A 2xx means a phone holds the name.
- **Foreground only.** On an admin device holding a certificate, the app then opens the tunnel and claims; refused
  `route-held`, it stays connected as a standby and claims on `route-vacant`. It closes the tunnel when it leaves the
  foreground. `release()` sends the signed release (its trigger, a request from another device through the account's
  `.com` mailbox, is a follow-up).
- **Endpoint.** Every relayed stream is TLS-terminated with the phone's key, then a minimal HTTP/1.1 server answers:
  - `GET /` → `{present: true, recorded}`: the presence answer; a valid signed hello is recorded (device key → last
    seen, in memory, at most 32; exposed as the endpoint's `lastSeen`, the UI is a follow-up).
  - `GET /.well-known/flagship-phone` → `{account, hostname, phoneRoutePub}` (proves the TLS peer is this account's
    admin phone; no secrets).
  - Retired in 0.3 (H11): the one-time-code session (`POST /api/phone/session`, `POST /api/phone/ping`, the
    `__Host-flagship-phone` cookie). A website now reaches only `GET /api/phone/live` and `POST
    /api/phone/deliver` (plus its preflight), from the listed voi.ci origin, with no cookie
    (docs/voici-and-messages.md; `phoneWebCheck`, then `phoneEndpointCheck` with no session; live group
    `phone-endpoint`).
  - Every non-GET (and every WebSocket upgrade) passes `phoneEndpointCheck`: Host exactly the phone's name, Origin
    exactly `https://<name>` (a sibling app is same-site, not same-origin), the host-only cookie, the CSRF header. No
    CORS headers are ever sent.

## 5. Open

- Follow-ups (owner, 2026-11-01): another device asking the holder to release through the account's `.com` mailbox;
  a UI for the holder's last-seen list. A hello records the device key it names; it is not yet checked against the
  account's device list.
- Visitors that land on a relay instance not holding the phone's tunnel are closed (no cross-instance forwarding).
- The Rust relay (G7) ports it (`rust/crates/flagship-relay/src/phone.rs`); `tools/relay-conformance` P01–P06 run the same scenarios against both relays.
- Device-level runs: SE-backed TLS identity on iOS and Keystore-backed `SSLEngine` on Android are unproven on hardware.
