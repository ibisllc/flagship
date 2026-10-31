# Wiring the serving authority (the dead-man) into `.com`, the relay, the box and the apps

Status: the contract the 2026-10-31 wiring works to. Protocol: `packages/protocol/src/servingAuthority.ts` (Rust twin
`rust/crates/flagship-crypto/src/serving.rs`), records and rules: `issuance-and-lease-records.md` (section 5 is the
owner's single dead-man setting and its UI copy). Every surface calls the protocol functions; none re-implements a rule.

## 0. Terms

- **Sensitive-order key** of an account: its admin root, or its IRK on a legacy account that pins no admin root (the
  rule every sensitive order already follows). "Admin key" below means this key.
- **regGen** of a box: the registration generation. `.com` keeps it per server row (column `reg_gen`, default 1),
  advances it when a revoked server is un-revoked or re-registered, and tells the box (heartbeat reply) and the relay.
- **Box key**: the box's identity public key `.com` registered (the key its HELLO is checked against today).

## 1. `.com` (apps/com, packages/storage, packages/control-plane)

D1 migration **0120_serving_authority.sql**: `servers.reg_gen INTEGER NOT NULL DEFAULT 1`;
`serving_policies(username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at, PK(username, box_pub))`
(keeps the highest policy_gen only); `renewal_delegations(renewal_pub PK, username, device_id, record_json, signature,
created_at, revoked_at)`; `serving_leases(username, box_pub, signer_pub, record_json, signature, delegation_pub,
not_after, PK(username, box_pub, signer_pub))` (keeps the later notAfter per signer); `revocation_log(sequence INTEGER
PRIMARY KEY, entry_json, signature, created_at)`; `serving_relay_acks(relay_id PK, sequence, seen_at)`.

Revocation key: Worker secret `SERVING_REVOCATION_SEED` (32-byte hex Ed25519 seed). Its public key is served at
`GET /api/serving/revocation-key` and is configured on each relay (`FLAGSHIP_SERVING_REVOCATION_PUB`); a relay never
learns it from the feed.

Routes (all JSON; errors `{error, code}` with a sentence):
- `POST /api/accounts/:u/serving-policy` `{policy, signature}`: verifies under the account's admin key, the box key is
  one of the account's servers, `regGen` is the server's, `policyGen` is above the stored one; stores, pushes to the
  feed. 403 `serving-policy-signature`, 409 `serving-policy-stale`.
- `POST /api/accounts/:u/renewal-delegations` `{delegation, signature}`: admin key; `deviceId` is a live device of the
  account. Stores; one per renewal key.
- `POST /api/accounts/:u/serving-leases` `{leases: [{lease, signature, delegationPub?}]}`: each lease must verify
  (directly under the admin key, or under a stored, unrevoked delegation's P-256 key) for a server of the account at its
  current regGen and policyGen; stored, pushed. Answers `{accepted, refused:[{leaseId, code}]}`. Rate limit per account.
- `GET /api/accounts/:u/serving` (account read token): per server `{serverDomain, boxPub, regGen, policy?:{record,
  signature}, lease?: best, until, onLapse, grace, confirmedByRelays}` where `until/onLapse` come from
  `servingDecision` with the stored records (the apps show it).
- Revocation entries: appended (signed with the revocation key, next sequence, in one D1 transaction with the change)
  when a server is revoked or deleted (`kind: box`, its regGen) and when a device is removed (`kind: renewal-key` for
  each of its delegations). Pushed at once.
- Internal, for the relay (auth: the existing services control secret header): `GET
  /api/internal/serving/:u/:boxPub` → `{adminKey, regGen, policy?, leases[], delegations[]}`; `GET
  /api/internal/serving-revocations?since=N` → `{entries:[{entry, signature}], sequence}`.
- **Feed**: Durable Object `ServingFeed`, one instance; relays connect by WebSocket to
  `/api/internal/serving-feed?relay=<id>` (same control secret). Frames (JSON): relay→`{type:"hello", since}`;
  .com→`{type:"revocation", entry, signature}` (in order; replays since `since` first), `{type:"changed", username,
  boxPub}` (policy/lease/delegation changed: the relay re-reads that box), `{type:"beat", sequence}` every 60 s;
  relay→`{type:"ack", sequence}` (stored in `serving_relay_acks`). Hibernatable WebSockets.
- Box heartbeat reply (daemon-status): adds `serving: {regGen, policy?, leases[], delegations[]}` for that box.

## 2. Relay (apps/web: the TS hub; the Rust relay G7 calls the Rust twin when it goes live)

- HELLO gains `servingAdminKey` (the box's pinned admin key, hex) and `servingPolicy` (the box's stored signed
  policy, or null). Missing key: the box is refused app routes (`admin-keys-differ`) but keeps its control name.
- `ServingFeedClient`: one connection per relay process; applies revocations with `applyRevocationEntries`, persists
  nothing (on start it reads since 0), acks; on a gap it reads `serving-revocations?since`. A box revocation ends that
  box's tunnel at once.
- Lost contact: no frame for 60 s → refuse NEW tunnels (HELLO answered "try again", the box retries); 10 min →
  close every tunnel until the feed is back.
- Per box, a decision from `servingDecision` with `adminKeyFromCom` (the existing per-user authority lookup's admin key,
  else IRK), `adminKeyFromBox` (HELLO), `policies` = [.com's, the box's], `leases` from `.com`. Recomputed on HELLO and
  on `changed`; a timer at `until` re-decides and closes the box's app streams within 5 s.
- Enforced in the SNI router: the box's exact control name (`<server>.<user>`) is always routable while `control`;
  every other name the box claims (apps, canonical `app.user`) needs `apps: true`. Also excluded from canonical-app
  allocation and failover while `apps` is false. Refused streams: TLS closed like an unknown name.
- `/api/stats` gains counts: boxes serving, apps-stopped, revoked, feed sequence and lag.

## 3. Box (packages/server-daemon)

- HELLO sends `servingAdminKey` and its stored policy.
- Stores `serving.json` (policy, leases, delegations, regGen) from the heartbeat reply and from the apps directly:
  `POST /api/screens/serving` `{policy?, leases?, delegations?}` (owner session; every record verified with
  `servingDecision`'s rules under the pinned admin key before it is kept). Keeps the best.
- **Lock**: every minute and on every store, `servingDecision({adminKeyFromCom: pinned, adminKeyFromBox: pinned,
  policies: [stored], leases, revocations: empty})`; `lock: true` → the existing one-shot suppression (`bootlock`,
  `/boot/flagship-lock-once`) then a restart (never a power-off). Activity entry `server.serving.locked`.
- `server-detail` gains `serving: {grace, onLapse, until, policyGen, regGen, scopeSha256}` (the apps' server-page line;
  the scope hash so a policy edit can be signed without guessing).
- Retired: `DeadManController`, `/api/deadman/*`, `set-deadman-policy/v1` and `deadman-affirm/v1` handling.
  Lock & restart / power buttons stay (`/api/power`).

## 4. Apps (webapp, iOS, Android: same behaviour)

- **Renewal key** on every admin device: ECDSA P-256, non-exportable (iOS Secure Enclave via CryptoKit
  `SecureEnclave.P256.Signing`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no user presence; Android
  Keystore StrongBox when present else TEE, `setUserAuthenticationRequired(false)`; webapp WebCrypto ECDSA P-256
  `extractable: false` in IndexedDB). Created at login/first unlock when none exists (a fresh install has none: iOS
  must delete any keychain item left from a previous install on first launch), delegated once with the admin root
  (Face ID) and posted to `/renewal-delegations`. Signatures go on the wire compact `r‖s` low-S (normalise S).
- **On app open** (foreground / page load), on an admin device: for each server whose policy is finite, sign
  `leaseFor(policy, now, randomLeaseId)` and post them in one call to `.com`; best-effort also to the box
  (`POST /api/screens/serving`). Nothing under an indefinite policy. Never a prompt.
- **Server page line** and **editor** exactly as `issuance-and-lease-records.md` section 5 (copy there; i18n in every
  shipped language through each app's pipeline). The editor signs a new `serving-policy/v1` with the admin root
  (Face ID), `policyGen = current + 1`, the box's `scopeSha256` from `server-detail`, posts to `.com` and the box, and
  when it is finite signs a first lease at once.
- Old dead-man screens removed (iOS `DeadManViewModel`, `DeadManStore`, the lock-power dead-man section; Android
  equivalents; webapp `leaseCapForDeadMan` and its UI).

## 5. Tests

Unit tests next to each change; a mock-gym scenario per app (line shows the date; editor changes the policy; Never
greys out the lock choice); a live gym group `serving` (a 7-day policy with a lease → apps serve; the lease's end → app
routes stop within 5 s while the control name answers; with `lock-server` the box restarts locked; revoking the box
closes its tunnel; a renewal key's revocation drops its leases).
