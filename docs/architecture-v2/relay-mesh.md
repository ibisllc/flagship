# Relay mesh: several relays, one data plane (release 0.3)

Status: design, owner-approved direction (AGENTS.md "Make Fly redundant", 2026-11-01). Nothing built. This is the
contract the implementation chunks in §15 build to. Current system: `relay-transport.md` (both relays, frames,
conformance), `serving-wiring.md` (serving gate, revocation log, feed), `phone-route.md` (the bare name),
`docs/maintainer-trust-enforcement.md` (relay blessing).

Unchanged by the mesh: SNI passthrough with TLS ending on the box (or phone), the v1 frame format, the HELLO and its
checks, the serving decision (`servingDecision`), the `:8444` PROXY-header echo, the 4 s hold and delayed drop.

## 0. Decisions in one page

1. **A relay is one process with one key and one direct name.** `<relayId>.tunnel.<servicesApex>`. On Fly that means
   one Fly app per relay (two machines in one app cannot be dialled one by one on raw TCP). §2.
2. **Two relay kinds.** `full` relays hold box and phone tunnels; `entry` relays only accept visitors and forward them.
   0.3 runs only `full` relays, all Flagship-operated. Independent operators join as `entry` relays later: they never
   see leases, never meter, never need a `.com` secret. §2.
3. **Boxes keep one tunnel.** After HELLO_ACK the box signs an **attachment** (STK) naming the relay. The relay
   pushes it to every peer; peers verify it against the public relay log. No `.com` registry of who holds what. §5.
4. **An account's boxes live on one relay** (its **home**). Shortened names (`<app>.<user>`), the allocator, nudges
   and DOMAIN_GRANTED stay local to one relay, as today. A box that lands elsewhere is moved home with a signed move
   hint; rebalancing moves whole accounts. §7.3, §10.
5. **Bridges** between relays are WebSockets on the existing `:8443` (`/mesh`), server-authenticated by WebPKI and
   mutually authenticated by relay-key signatures over both nonces and both relay ids. Not mTLS: Fly ends TLS at its
   edge, so a relay process cannot see a client certificate. One hop only; only ciphertext. §6.
6. **`.com`'s relay-facing data becomes one public, signed, append-only relay log** served as static files from R2
   behind Cloudflare's cache (`https://feed.<controlApex>/v1/`), plus a signed head re-minted every 5 s and a
   CA-signed relay directory. No caller identity. It publishes keys, hashes and generations only: never leases,
   policies, delegations, device grants, account names or the phone ledger. Boxes present their own leases and
   policy to their relay; phones present their own grants. §4.
7. **The phone ledger moves from `.com` to a relay.** Each account's phone ledger lives on the first reachable `full`
   relay in a rendezvous-hash ranking of the directory. The existing ledger functions run there unchanged. The phone
   keeps its tunnel wherever it landed; visitors go straight to that relay. `.com` no longer learns when a phone is in
   the foreground or where. §8.
8. **Contact rules on signed data.** A relay is fresh while it holds a verified head no older than 60 s (from `.com`'s
   feed or from any peer). Stale 60 s: refuse new tunnels. Stale 10 min: close every tunnel. §4.6.
9. **Old boxes** (no `mesh-v1`) are announced by their relay with a relay-signed legacy attachment, honoured only from
   `full` relays and always beaten by a box-signed one. They are never moved. §5.3.
10. **Defence in depth on the box**: a mesh box applies `stop-apps` itself (refuses app streams when its own
   `servingDecision` says apps off), because a rogue holder relay could ignore the dead-man. §9.6.

## 1. Terms

- **relayId**: `^[a-z][a-z0-9-]{1,30}$`, e.g. `iad1`, `ams1`, `upc-fra1`. Unique in the directory, never reused.
- **Relay key**: the relay's Ed25519 identity key. The same key signs HELLO_ACK `hubSig` (it replaces the per-boot
  hub key). Seed from a secret (`FLAGSHIP_RELAY_KEY_SEED`, 64 hex), never generated per boot in mesh mode.
- **Holder**: the relay a box's (or phone's) tunnel is on. **Entry**: the relay a visitor's TCP connection reached.
- **Home** of an account: the relay its boxes should be on (§7.3). **Phone ledger relay** of an account: §8.1.
- **Log key**: today's revocation key (`SERVING_REVOCATION_SEED` on `.com`), now signing the whole relay log. The
  relay env `FLAGSHIP_RELAY_LOG_PUB` replaces `FLAGSHIP_SERVING_REVOCATION_PUB` (the old name is still read).
- **nameHash(fqdn)** = `sha256hex("flagship/relay-name/v1|" + lowercase(fqdn))`.
  **accountHash(u)** = `sha256hex("flagship/relay-account/v1|" + u)`.
- Canonical bytes: UTF-8 of `tag|field|field…` (`packages/protocol` convention). Numbers are decimal integers (ms
  since epoch), keys lowercase hex, an absent field is the empty string, lists are sorted bytewise and joined by `,`.
  Every signature is Ed25519 (strict), hex, over the canonical bytes, unless stated.

## 2. Topology and addressing

| Hostname | DNS | Who uses it | Lands on |
|---|---|---|---|
| `*.<apex>` and `<apex>` | Cloudflare LB, DNS-only, health-checked | visitors (`:443`), ACME validators | any relay (`full` or `entry`) |
| `tunnel.<apex>` | Cloudflare LB, DNS-only | boxes and phones (`:8443` `/tunnel`, `/phone-tunnel`) | `full` relays only |
| `<relayId>.tunnel.<apex>` | plain A/AAAA, DNS-only | move hints, bridges, echo (`:8443`, `:8444`) | that relay |

`tunnel` is already a reserved username (`RESERVED_USER_LABELS`), so no account can collide with these names. It must
also be added to the services-zone list (`packages/services-zone/src/validation.ts`) and `npm run zone-health` must
accept records under `tunnel.` (today it fails on any record at an account name).

If Cloudflare does not support a DNS-only load balancer on a wildcard hostname, the zone keeps one wildcard **CNAME**
`*` → `lb.<apex>` (a reserved label, to add) and the LB sits on `lb.<apex>`. To verify before the owner step.

`.com` stops hard-coding the hub: `GET /api/services/endpoints` returns `tunnelHub: "wss://tunnel.<apex>:8443/tunnel"`,
keeps `passthroughIPv4/6` (the first-party primary, for old phones) and adds
`relays: [{relayId, tunnelHost, ipv4: [...], ipv6: [...]}]` from the directory, which phones test with the echo
(`docs/relay-addresses.md`) instead of the single pair.

Ports per relay are today's: `:443` raw TCP (SNI passthrough), `:8443` TLS + HTTP (`/tunnel`, `/phone-tunnel`,
`/mesh`, `/api/health`, `/api/stats`, `/pb/m/<id>`), `:8444` TLS + PROXY (echo). No new port.

**TLS for the direct names.** Fly: `flyctl certs add <relayId>.tunnel.<apex>` and `tunnel.<apex>` on each relay app,
validated by DNS-01 (a `_acme-challenge` CNAME to Fly), because HTTP-01/TLS-ALPN behind a load balancer may reach
another relay. Non-Fly (UpCloud): Caddy in front of `:8443` and `:8444` with the Cloudflare DNS-01 plugin, raw `:443`
straight to the relay.

**LB health.** Monitor: HTTPS `GET https://<origin>:8443/api/health` with `Host: <relayId>.tunnel.<apex>`, expect
200, every 15 s (or the plan's minimum), 2 failures to mark down. `/api/health` answers 503 unless the relay is
**mesh-ready**: a valid blessing, listed in the current directory under its key, a fresh head (§4.6), not draining,
and bridges up to at least half of the other relays. One pool per relay; proximity steering; every pool is the
fallback of every other.

## 3. Relay identity, blessing and directory

### 3.1 Admission (owner, once per relay)

`.com` keeps the relays it admits in D1 `relays(relay_id PK, relay_key, kind, tunnel_host, region, ipv4_json,
ipv6_json, added_at, retired_at)` (migration in chunk B). Admin route `POST /api/admin/relays` (`x-admin-secret`) with
`{op: "add"|"retire"|"update", ...}`; CLI `npm run relays -- add <relayId> <relayKey> <kind> <region> [--ipv4 ..]
[--ipv6 ..] | retire <relayId> | list`. Retiring appends a `relay-revoke` log entry (§4.2) and mints a new directory.

### 3.2 RelayBlessing

```text
flagship/relay-blessing/v1|<relayId>|<relayKey>|<servicesApex>|<tunnelHost>|<relayKind>|<nonce>|<issuedAt>|<expiresAt>
```

JSON envelope, shaped like `ServiceBlessing`: `{kind:"RelayBlessing", version:1, relayId, relayKey, servicesApex,
tunnelHost, relayKind, nonce, issuedAt, expiresAt, signedBy, signatures:[{pubkey, sig}]}`. Signed by `.com`'s hot CA
key. Verified exactly like `verifyCaSignedServiceBlessing` (pin → mandate chain → CA key authorized now → signature →
TTL), plus `servicesApex` equals the verifier's apex. TTL 26 h, refreshed every 12 h. `nonce` is 32 lowercase hex,
`tunnelHost` is exactly `<relayId>.tunnel.<servicesApex>`, and `issuedAt` may be up to 60 s ahead of the verifier's
clock (relays and boxes run their own clocks).

Issuance: `POST /api/services/relay-blessing` `{relayId, relayKey, servicesApex, issuedAt, signature}` where the
signature is the relay key over
`flagship/relay-blessing-request/v1|<relayId>|<relayKey>|<servicesApex>|<issuedAt>`. `.com` answers only for an
admitted, unretired row with that key, `|issuedAt − now| ≤ 60 s`. Answer: `{relayBlessing, serviceBlessing}`. The
`ServiceBlessing` (v1, `hubKeyPub` = relay key) is still minted so old boxes' observe-mode check keeps passing. This
replaces the shared-secret issuer (`maintainer-trust-enforcement.md` step 7: a dedicated credential per relay).

The relay keeps no state on disk. A relay that restarts during a `.com` outage gets its own last
blessing back from a peer during the bridge handshake (§6.2) and reuses it while it is valid. This closes step 8 without a volume.

### 3.3 RelayDirectory

```text
flagship/relay-directory/v1|<servicesApex>|<directoryVersion>|<issuedAt>|<expiresAt>|<entriesSha256>
```

`entriesSha256` = sha256 hex of the entry lines, sorted bytewise, joined by `\n`, one per active relay:
`<relayId> <relayKey> <tunnelHost> <relayKind> <region> <ipv4 list or -> <ipv6 list or ->` (each address list sorted
bytewise and joined by `,`; `region` is `^[a-z0-9][a-z0-9-]{0,31}$`; a relay id or relay key listed twice is refused).
JSON: `{kind:"RelayDirectory", version:1, servicesApex, directoryVersion, issuedAt, expiresAt, relays:[{relayId,
relayKey, tunnelHost, relayKind, region, ipv4:[], ipv6:[]}], signedBy, signatures}`. Signed by the CA hot key, same
verification as the blessing. `directoryVersion` increases by one on every change; re-minted daily with the same
version and a new `issuedAt`; `expiresAt = issuedAt + 7 d`. A verifier keeps the highest version it verified and never
goes back. An expired directory is still used (fail-open for routing) but makes `/api/health` 503 after 24 h past
expiry.

Published at `https://feed.<controlApex>/v1/directory.json` (§4.5), carried in the head's `directoryVersion`, gossiped
on bridges (§6.3). Boxes fetch it hourly (§9.4).

### 3.4 Revoking a relay

Owner retires it (§3.1). Effects, all from signed data: the `relay-revoke` log entry reaches every relay within the
head cadence (§4.6) and over gossip; peers close the bridge (4403), drop every attachment it announced and refuse its
announcements and queries; it disappears from the next directory; its blessing is not renewed (≤ 26 h). The operator
also removes its LB pool. Boxes on it find it missing from the directory within an hour and move (§9.4).

## 4. The public relay feed

### 4.1 What today's internal routes expose, and what is published instead

| Today (control-secret routes) | Sensitive part | Published instead |
|---|---|---|
| `/api/internal/serving/:u/:boxPub` → adminKey, regGen, revoked, policy, leases, delegations | leases show when the owner opens the app (habits); delegations name devices; policy shows the dead-man setting and names | `box-register`, `box-revoke`, `account-authority`, `policy-head` (a hash). Leases, delegations and the policy itself come from the box (HELLO) |
| `/api/internal/serving-revocations` (entries name the account) | which account removed a device, when | `renewal-key-revoke`, `device-grant-revoke` keyed by key / grant id only |
| `/api/internal/serving-feed` WebSocket with `?relay=<id>`, acks | which relays exist and are up (harmless) | head polling + mesh gossip; acks dropped |
| `/api/internal/phone-route/:u/eligibility` | the account's device list | the phone presents its own grant (§8.2) |
| `/api/internal/phone-route/ledger` | which relay a phone uses, when it is in the foreground | the ledger lives on a relay (§8) |
| `/api/username/:u`, `/api/server/by-domain/:id`, `/api/cert-revocations/:u`, eviction chain (public today) | per-name lookups tell `.com` which relay asked about which box | `account-authority`, `box-register` (newest per name = eviction), `cert-revoke` |

What the log still reveals: every registered box key with a hash of its name, every account's admin root and IRK
public keys keyed by a hash of the account name, and when boxes were registered, revoked or changed policy. Names are
hashed, not secret (Certificate Transparency already lists every box name, so a dictionary inverts the hash); the hash
only keeps the log from being a plain list. Accepted.

Mesh-mode relays never call the internal routes. They stay in `.com` for one release so a rollback to a non-mesh relay
works (§13.3), then go.

### 4.2 Log entries

One table `relay_log(sequence INTEGER PRIMARY KEY, kind, at, f1, f2, f3, f4, signature)` replaces `revocation_log`
(migration in chunk B: the old entries are re-appended as new kinds; 0.3 is unreleased, so no v1 compatibility).

```text
flagship/relay-log/v1|<servicesApex>|<sequence>|<kind>|<at>|<f1>|<f2>|<f3>|<f4>
```

| kind | f1 | f2 | f3 | f4 | Appended when |
|---|---|---|---|---|---|
| `box-register` | nameHash(serverFqdn) | boxPub | regGen | | a server registers, re-registers or is un-revoked (new regGen) |
| `box-revoke` | boxPub | regGen (every generation ≤ it) | | | a server is revoked or deleted |
| `account-authority` | accountHash | adminRootPub or empty | irkPub | authorityGen | account created, admin root or IRK rotated |
| `policy-head` | boxPub | regGen | policyGen | sha256hex(canonicalServingPolicy) | a serving policy is stored |
| `renewal-key-revoke` | renewalPub | | | | a device holding a renewal key is removed |
| `device-grant-revoke` | grantId | devicePub | | | a device is removed or its grant revoked |
| `cert-revoke` | accountHash | certId | | | an entitlement or ServiceGrant cert is revoked |
| `relay-revoke` | relayId | relayKey | | | a relay is retired |

Each entry is appended in the same D1 transaction as the change that causes it, at the next sequence, signed by the
log key. JSON on the wire: `{entry:{sequence, kind, at, f1, f2, f3, f4}, signature}`.

State a relay derives (`RelayLogState`, protocol chunk A): per nameHash the newest `box-register` (an older key for
the name is evicted); per boxPub the highest revoked regGen; per accountHash the newest authority; per (boxPub, regGen)
the newest policy head; sets of revoked renewal keys, grant ids, cert ids and relays. `servingDecision` gets its
revocations through an adapter keyed by box key alone (box keys are unique, so `boxRevoked` drops the account).

### 4.3 The head

```text
flagship/relay-log-head/v1|<servicesApex>|<sequence>|<tipSha256>|<directoryVersion>|<issuedAt>
```

`tipSha256` = sha256 hex of the canonical bytes of entry `sequence` (64 zeros when 0). Signed by the log key. JSON
`{head:{servicesApex, sequence, tipSha256, directoryVersion, issuedAt}, signature}`.

### 4.4 Serving gate inputs in mesh mode

Per box, the holder computes `servingDecision` with: `adminKeyFromCom` = the log's admin root for the account (else
IRK); `adminKeyFromBox` = HELLO `servingAdminKey`; `regGen` from the log; `policies` = the HELLO `servingPolicy` only
when its sha256 equals the log's policy head for (boxPub, regGen) (no head: the HELLO policy as given); `leases` =
HELLO `servingLeases` (new, §9.5). A head the box cannot match gives `{control: true, apps: false, reason:
"policy-stale"}` (a new `ServingReason`; TS `ServingInput.policyHead`, Rust `serving_decision_at_head`): the box gets the policy from its heartbeat and re-HELLOs. Recomputed on HELLO,
on HELLO refresh, on a `policy-head`, `box-revoke`, `renewal-key-revoke` or `account-authority` entry for the box, and at
`until`, as today.

### 4.5 Publication

`.com` writes the feed to an R2 bucket served on a custom domain with Cloudflare cache, so no request reaches a Worker:

| Object | Content | Cache-Control |
|---|---|---|
| `v1/head.json` | the latest signed head | `public, max-age=2` |
| `v1/log/<page>.json` | `{page, entries:[...]}`, entries `page*512 .. page*512+511` | full page: `public, max-age=31536000, immutable`; the tail page `public, max-age=2` |
| `v1/directory.json` | `{directory, blessings:[current RelayBlessing per relay]}` | `public, max-age=60` |
| `v1/log-key.json` | `{logKey}` (also `GET /api/serving/revocation-key`) | `public, max-age=3600` |

The `ServingFeed` Durable Object becomes the publisher: after each append the Worker calls it; it reads the tail from
D1 and rewrites the tail page and the head. An alarm every 5 s re-mints the head (fresh `issuedAt`) and catches up any
missed publish. A relay polls `head.json` every 5 s and fetches only pages past its sequence. Query strings are not part
of the object key (R2 custom domain + a cache rule that ignores them), so spam cannot bust the cache. Requests carry
nothing about the relay; an operator who wants `.com` (or Cloudflare) not to see its address fetches through any proxy
or from a peer (§6.3).

Later (when the log passes ~100k entries): a daily signed snapshot (`v1/snapshot-<sequence>.json`, the derived state
with a log-key signature over its sha256) so a new relay starts from it. Not needed for 0.3.

### 4.6 Freshness and contact rules

A relay is **fresh** while it holds a head that verified under the log key, whose `issuedAt ≥ now − 60 s`, and has
applied the log up to that head's `sequence` with a matching `tipSha256`. It takes the newest head it sees from the feed
or from any peer (heads are verifiable wherever they come from).

- Not fresh for 60 s (`HEAD_REFUSE_NEW_MS`): every new HELLO and phone `begin` is answered "try again" (1013), and
  `/api/health` is 503 (the LB stops sending new boxes and visitors).
- Not fresh for 10 min (`HEAD_CLOSE_ALL_MS`): every tunnel is closed 1013 `serving-feed-lost`, as today.
- Entry duties need freshness too: a relay that is not fresh refuses to forward to a mesh holder (delayed drop), because
  it cannot know about revocations.

A gap (the log page lacks an entry, a tip hash mismatch, a bad signature) stops applying at that point and refetches;
a bad signature from the feed is logged and the entry ignored until a correct copy arrives.

## 5. Attachments

### 5.1 Box attachment (box-signed)

```text
flagship/relay-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
```

Signed by the box's STK. `attachedAt` = when this tunnel's HELLO_ACK arrived (box clock), fixed for the tunnel's life;
`issuedAt` = signing time; `notAfter = issuedAt + 30 min` at most (`ATTACH_TTL_MS`). The box sends one right after an
accepting HELLO_ACK that named `relayId` and verified (`hubSig` under the RelayBlessing key), then every 10 min
(`ATTACH_RENEW_MS`). JSON: `{kind:"box", attachment:{serverFqdn, boxPub, regGen, relayId, attachedAt, issuedAt,
notAfter}, signature}`.

**Valid** (any relay, `checkBoxAttachment` in chunk A): canonical bytes well-formed; `serverFqdn` is a pod name under the
apex; the log's newest `box-register` for nameHash(serverFqdn) has exactly this `boxPub` and `regGen`; not revoked at
that regGen; signature verifies under `boxPub`; `relayId` is in the directory and not revoked; `attachedAt ≤ issuedAt <
notAfter`; `notAfter − issuedAt ≤ 30 min`; `issuedAt ≤ now + 60 s`; `notAfter > now`. The holder additionally checks
that `boxPub` and `serverFqdn` are this tunnel's and `relayId` is itself.

### 5.2 Precedence (per serverFqdn)

Among valid attachments for one name, the winner is decided in this order: higher `regGen`; box-signed beats legacy;
later `issuedAt`; smaller `relayId`. Newest wins, so a box that moved supersedes its old relay at its first signature on
the new one. A relay routes a box from its own registry only while its own attachment for that box is the winner; once
superseded it forwards like any entry relay, even while the old tunnel finishes its streams.

### 5.3 Legacy attachment (old boxes)

```text
flagship/relay-legacy-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
```

Signed by the holder's relay key, for a box whose HELLO did not offer `mesh-v1` (or did and sent no attachment within
10 s). TTL 3 min, renewed every 60 s while the tunnel is up. Honoured only from a `full` relay (directory `relayKind`).
Always beaten by a box-signed attachment. This is the one place a relay's word places a box: a rogue `full` relay could
attract an old box's visitors. Accepted for 0.3 (all `full` relays are Flagship's); it ends when old boxes are gone.

### 5.4 Withdrawal (tombstone)

```text
flagship/relay-withdraw/v1|<subjectKind>|<subject>|<relayId>|<withdrawnIssuedAt>|<at>
```

`subjectKind` `box` (subject serverFqdn) or `phone` (subject the bare hostname). Signed by the relay named by the
attachment it withdraws; it removes that attachment and any older one from that relay. Sent when a tunnel closes or is
superseded. A withdrawal by any other relay is ignored. Attachments without a withdrawal simply expire at `notAfter`.

### 5.5 Announcement and caches

- The holder pushes every new or renewed attachment and every withdrawal to every peer within 1 s (batched, ≤ 500 per
  message). Peers keep all of them: replication is full, the query (§7.2) only repairs gaps.
- Attachment store caps: 200,000 box items in all, 100,000 per announcing relay, 20,000 phone items. Over a cap, the
  item with the oldest `issuedAt` from another relay is evicted (a query brings it back). A relay never evicts its own.
- Verified signatures are cached per (attachment canonical bytes) so a renewal from the same relay costs one verify.

## 6. Bridges

### 6.1 Transport

WebSocket to `wss://<peer tunnelHost>:8443/mesh` (TLS checked by WebPKI against `<peerRelayId>.tunnel.<apex>`). The
relay with the bytewise-smaller relayId dials; the other only accepts (if both connections exist, the one dialled by
the smaller id stays). Dial timeout 5 s; reconnect with full-jitter backoff 1 s → 60 s. Text messages are JSON control
(≤ 1 MiB); binary messages are v1 frames, exactly one per message, as on `/phone-tunnel`.

### 6.2 Handshake

```text
acceptor → {type:"mesh-hello", v:1, relayId:S, nonce:Ns, at}
dialer   → {type:"mesh-auth", v:1, relayId:C, peer:S, nonce:Nc, at, blessing:<RelayBlessing C>, sig}
acceptor → {type:"mesh-auth", v:1, relayId:S, peer:C, nonce:Ns, at, blessing:<RelayBlessing S>, sig}
```

`sig` is the signer's relay key over
`flagship/relay-bridge-auth/v1|<role>|<signerRelayId>|<peerRelayId>|<serverNonce>|<clientNonce>|<at>` with role
`client` or `server`. Each side checks: nonces are 32-byte hex; `|at − now| ≤ 60 s`; the blessing verifies (§3.2),
names the claimed relayId and a key equal to the directory's entry for it; the relay is not revoked in the log; `peer`
is its own relayId. Naming both ids stops a relay from replaying one peer's proof to another. Each step has 5 s; a
failure closes 4401 with a reason code (`bad-blessing`, `not-in-directory`, `revoked`, `bad-signature`, `stale`,
`wrong-peer`). TLS terminates at Fly's edge, so this is the mutual authentication; the WebPKI hostname check is the
outer layer.

A relay that restarted without a blessing (`.com` down) sends `blessing: null`. The other side accepts it only if it
still holds a valid blessing for that relayId with the same key (kept from earlier handshakes and `directory.json`),
uses that copy, and returns it in `{type:"blessing", blessing}` right after the handshake. The key, from the seed, is
what is checked; the blessing only has to exist and be valid.

### 6.3 Control messages (JSON)

```text
{type:"sync", directoryVersion, head:{head, signature}, features:[...], load:{tunnels, capacity}}   both, once after auth
{type:"announce", items:[BoxItem|LegacyItem|PhoneItem]}          full dump after sync, then deltas
{type:"sync-done"}                                               after the dump
{type:"withdraw", items:[{withdraw:{subjectKind, subject, relayId, withdrawnIssuedAt, at}, signature}]}
{type:"query", qid, name}                                        lowercase FQDN, §7.2
{type:"answer", qid, items:[...], busy?:true}                    items it holds or knows; [] = none
{type:"head", head, signature}                                   a newer head, at most once per 5 s per peer
{type:"log", entries:[{entry, signature}]}                       entries newer than last sent to this peer, ≤ 256
{type:"log-since", since}   → {type:"log", entries}              ≤ 1024 entries
{type:"directory", directory, blessings}                         when the peer's version is lower
{type:"blessing", blessing}                                     a peer returns a restarted relay its own last blessing
{type:"load", tunnels, capacity, draining}                       every 30 s
{type:"account-move", move, signature}                           §10.3
{type:"phone-begin"|"phone-claim"|"phone-renew"|"phone-release"|"phone-vacant", ...}   §8
{type:"refuse", stream, code}                                    then CLOSE; codes below
```

Every item, entry, head and directory is verified by the receiver before use; nothing is trusted because a peer sent
it. Bad items are dropped and counted per peer (`/api/stats` `mesh.peers[].rejected`).

### 6.4 Streams

- Ids: dialer-opened odd, acceptor-opened even, `1..0x7fffffff`, never reused while open.
- `OPEN` payload on a bridge is JSON `{sni, kind:"tls"|"pb-mail", hop:1}`; then `DATA`, `CLOSE`, and `STREAM_CREDIT`
  (0x06) with the `stream-credit-v1` rules from `relay-transport.md` §1, mandatory on bridges (both ends are new code):
  256 KiB initial window per direction, credit returned at ≥ a quarter window.
- The entry relay sends the peeked ClientHello bytes as the first `DATA`, then pipes.
- `refuse` codes: `not-holder` (no winning attachment here), `apps-off` (serving gate), `revoked`, `busy` (a cap),
  `stale` (the holder is not fresh), `hop` (an OPEN without `hop:1`).
- Caps per peer: 2,000 OPENs per second (token bucket, burst 4,000), 20,000 open streams, 64 MiB queued; past a queue
  cap the relay stops reading the visitor sockets of that bridge (TCP backpressure), as for a box tunnel.
- Keepalive: WebSocket ping every 10 s; no pong for 30 s → bridge down, all its streams closed, its attachments marked
  unreachable (kept, but not forwarded to until the bridge is back or a newer attachment arrives).

## 7. Routing

### 7.1 Name classes

For an SNI under the apex (lowercased): **box-scoped** (`<server>.<user>`, `<x>.<server>.<user>`, `*.<server>.<user>`
claims; key = `<server>.<user>.<apex>`), **account-level** (`<app>.<user>`, leader-routed meta names; key = the
account), **bare** (`<user>.<apex>`, the phone; key = the hostname). Custom domains are Pro and stay off `main`.

### 7.2 The entry relay's algorithm

On a parsed ClientHello (unchanged peek bounds):

1. **Box-scoped**: if this relay's own attachment for the key wins, route locally (holder duties, §7.4). Else take the
   winning attachment in the store. None: check the log (§7.5); if the name is registered and unrevoked, query (step 4);
   else delayed drop.
2. **Account-level**: compute the home (§7.3). Home is self: local, as today (registry, allocator, park-and-nudge).
   Home is a peer: forward to it. No home (no live attachment for the account): delayed drop.
3. **Bare**: the winning phone item (§8.4); forward to its holder or route locally. None: delayed drop.
4. **Query**: single-flight per name. Send `query` to every peer with a live bridge, 1.5 s timeout
   (`MESH_QUERY_TIMEOUT_MS`), take the first answer item that is valid and beats what the store holds, add it to the
   store. Nothing: remember the miss for 10 s (negative cache, ≤ 50,000 names, LRU) and delayed drop.
5. **Forward**: before forwarding, the entry checks the target is not revoked (box key / regGen in the log, relay in the
   directory) and that it is fresh itself (§4.6); then `OPEN` on the holder's bridge. On `refuse not-holder` it drops
   that attachment, re-queries once excluding that relay, and forwards again or delayed-drops. Other refusals: close the
   visitor.

Timing: every refusal path closes the visitor no earlier than `HOLD_TIMEOUT` (4 s) after arrival, so a prober learns
nothing from timing, whether the miss was local, a mesh query or a holder's refusal. The whole mesh path (query 1.5 s +
re-query 1.5 s) fits inside the hold.

Inbound query limit per peer: 500 per second (burst 1,000); past it the answer is `{busy:true}` with no lookup. A relay
only queries for names the log says exist, so random-name spam costs no mesh traffic.

### 7.3 Account home

Computed by every relay from the same replicated data (`accountHome` in chunk A):

1. A valid **account move** (§10.3) to relay B, unexpired, and B holds at least one live attachment of the account: B.
2. Otherwise, among `full` relays holding live (box-signed or legacy) attachments of the account: the most attachments;
   then the earliest `attachedAt` among each relay's attachments; then the smaller relayId.

A holder that is not its account's home sends each `mesh-v1` box of that account a move hint (`co-locate`, §9.3) right
after the box's attachment wins. During a split (an old box, a box that cannot reach home), shortened names still go to
exactly one relay (the home), so every entry relay forwards them to the same place; box-scoped names always go to
their own holder. DOMAIN_GRANTED snapshots and REQUEST_TRANSFER keep their per-relay meaning: a box on a non-home
relay sees only its own relay's view until it moves. Accepted: it lasts seconds for mesh boxes.

### 7.4 Holder duties (local or bridged visitor)

Exactly today's: the serving gate (control name always, app names only with `apps: true`, app streams closed at
`until`), the allocator (home only for account-level names), park-and-nudge (home only), per-account metering and
over-quota slow-down (only the holder meters; an entry relay never reports usage, so bytes are counted once), slow
visitor cuts. A bridged stream is matched only against local tunnels: a holder never forwards a stream that came from
a bridge (no second hop, no loop).

### 7.5 Entry duties

Revocation (box key and regGen, the target relay), freshness, the log precheck before a query, the hold timing,
per-source limits it already has (pending hellos, delayed drops). The entry relay sees only the SNI and TLS bytes.

### 7.6 Peer-backup mailboxes and ACME

- `/pb/m/<id>` lands on any relay (LB). The holder announces each PIK-signed mailbox announcement it accepted, in its
  `announce` stream (`{kind:"mailbox", announce, signature}`; self-authenticating, TTL as today). A relay without the
  mailbox forwards the HTTP request over the bridge as an `OPEN kind:"pb-mail"` stream (request bytes, then response
  bytes, the same 1 MiB cap). Same one-hop rule.
- Let's Encrypt's TLS-ALPN-01 validators hit `<server>.<user>.<apex>:443` from several vantage points, which the LB may
  send to different relays; every one forwards to the holder. The mesh path is therefore on the critical path of box
  certificate issuance and must be in place before a second relay joins the LB.

## 8. The phone's bare name across the mesh

### 8.1 Phone ledger relay

For account `u`: rank the directory's `full` relays by `sha256hex(accountHash(u) + "|" + relayId)` descending
(rendezvous hashing); the ledger relay is the first one this relay can reach (self, or a live bridge). Every relay
computes the same ranking; they differ only under a partition (§11).

### 8.2 Flow

The phone dials `tunnel.<apex>` and keeps its tunnel on whatever `full` relay P it lands on. The `/phone-tunnel`
messages to the phone are unchanged except `begin` gains the phone's eligibility proof:

```text
phone → {type:"begin", account, grants:[{grant, signatureHex, signerRoot}]}   its own admin grant chain (new field)
```

P and the ledger relay L (P itself when P = L) exchange, over the bridge:

```text
P → L {type:"phone-begin", qid, account}
L → P {type:"phone-begun", qid, generation, vacant, holderGeneration?}        generation = the next one to offer
P → phone challenge {..., generation}; phone → P claim (unchanged route-claim/v1)
P checks the claim signature and eligibility (grants under the log's admin root, grant ids not revoked, unexpired)
P → L {type:"phone-claim", qid, hostname, generation, holder:{relayId:P, sessionId, phoneRoutePub}}
L → P {type:"phone-claimed", qid, ok, code?, grant?, grantSignature?}          ledgerAcquire, unchanged rules
P → L {type:"phone-renew", hostname, generation, sessionId}   every 15 s → new grant (60 s), or {ok:false, code}
P → L {type:"phone-release", hostname, generation, sessionId}                 signed release checked by P first
L → all {type:"phone-vacant", hostname, generation}                           standbys anywhere claim on it
```

L runs `ledgerAcquire`, `ledgerRenew`, `ledgerRelease` and `liveEntry` from `packages/protocol/src/phoneRoute.ts` on its
own in-memory table; nothing about it goes to `.com`. A new L (the previous one gone) starts a hostname's generation at
the highest generation in any phone item it has seen, plus one.

### 8.3 Phone route grant

```text
flagship/phone-route-grant/v1|<hostname>|<phoneRoutePub>|<generation>|<holderRelayId>|<ledgerRelayId>|<issuedAt>|<notAfter>
```

Signed by L's relay key, `notAfter = issuedAt + 60 s` (`PHONE_ROUTE_LEASE_MS`). P announces it to every peer as
`{kind:"phone", grant:{...}, signature}` at each renewal and withdraws it (§5.4) when the phone leaves.

### 8.4 Visitors to the bare name

A phone item is valid when its signature verifies under the directory key of `ledgerRelayId` (a `full` relay, not
revoked), the announcing relay is `holderRelayId`, and `notAfter > now`. Winner: higher generation, then later
`issuedAt`. The entry relay forwards to the holder as for a box. The bare name still never resolves to a box.

Eligibility revocation: a `device-grant-revoke` for the holder's grant makes P close the phone tunnel 4403 and end its
visitor streams within 5 s (`PHONE_ROUTE_REVOKE_CLOSE_MS`) and release at L; L refuses renewals for it.

## 9. Box side (`packages/server-daemon/src/tunnel/`)

### 9.1 Capability and frames

The box offers `mesh-v1` in HELLO `capabilities`; a mesh relay answers it in HELLO_ACK `capabilities` and adds
`relayId` and `relayBlessing`. Two new frame types, accepted by a decoder only when `mesh-v1` was negotiated (the
`drain-v1` pattern: `DecodeOptions.mesh`):

| Frame | Type | Direction | Payload |
|---|---|---|---|
| `ATTACHMENT` | `0x07` | box → relay | `{attachment, signature}` (§5.1) |
| `ATTACHMENT` | `0x07` | relay → box | `{ok:true}` or `{ok:false, code}` (`clock`, `mismatch`, `not-registered`, `revoked`) |
| `MOVE_HINT` | `0x08` | relay → box | `{hint, signature, target: <RelayBlessing>}` (§9.3) |

### 9.2 Attachment

After an accepting HELLO_ACK whose `relayBlessing` verifies and whose `hubSig` verifies under its `relayKey`, the box
signs and sends an attachment for that relayId, and renews every 10 min. If the blessing does not verify (no chain,
expired) the box still serves but sends no attachment; its relay then announces it as legacy (§5.3) if it is `full`.
A `clock` refusal is logged and shown in diagnostics (the box's clock is off by more than 60 s).

### 9.3 Move hint

```text
flagship/relay-move-hint/v1|<serverFqdn>|<boxPub>|<fromRelayId>|<toRelayId>|<reason>|<issuedAt>|<notAfter>
```

`reason`: `locality` (rebalancing), `co-locate` (account home), `retire` (the relay is leaving). Signed by the sending
relay's key; `notAfter = issuedAt + 10 min`. The box acts only if all hold:

1. The hint names this box and this tunnel's relay as `fromRelayId`, and its signature verifies under the current
   relay's blessed key.
2. `target` verifies as a RelayBlessing (§3.2), `relayKind` `full`, `relayId == toRelayId`, apex equals the box's.
3. `toRelayId` is in the box's directory (fetched within the last 24 h; else fetch first).
4. Rate limits: `locality` at most once per 6 h; `co-locate` at most once per 10 min and 6 per 24 h; `retire` always.
   A target that failed is ignored for 1 h.

Then make-before-break, reusing the `onDrain` path in `superviseTunnelClient`: dial
`wss://<target tunnelHost>:8443/tunnel`, HELLO, require an accepting HELLO_ACK within 10 s whose `hubSig` verifies under
the target blessing's key, sign and send the attachment for the target, then keep the old tunnel 30 s for its open
streams and close it. Any failure: stay, record it. The box never moves to a relay that is not blessed, never chains
hints (a hint arriving on a tunnel less than 10 min old is a new decision, subject to the same limits).

### 9.4 Relay checks over time

Every hour, and at each attachment renewal past it: re-verify the current relay's blessing expiry and fetch the
directory. If the relay is no longer listed, revoked, or its blessing has expired: reconnect through `tunnel.<apex>`
(make-before-break). This also closes `maintainer-trust-enforcement.md` step 9 (mid-session expiry).

### 9.5 Leases and policy in HELLO

HELLO gains `servingLeases: [{record, signature, delegation?: {record, signature}}]` (at most 8, the best per signer,
from `serving.json`) next to `servingPolicy`. The box sends a HELLO refresh (`servingRehelloRef`) whenever its best lease
or its policy changes. The relay never fetches leases from `.com` in mesh mode.

### 9.6 Box-side stop-apps

Every minute and on every store, the box already runs `servingDecision` for its lock. A mesh box also uses the answer
for its own routing: while `apps` is false, `resolveBackend` returns null for every name but the control name. A rogue
holder relay can then black-hole the box but cannot keep its apps serving past the owner's dead-man.

## 10. Rebalancing

### 10.1 Measurement

The home relay counts, per account, visitor bytes (both directions) by entry relay (self for local visitors) in
one-minute buckets over the last 60 min. Phone traffic is not counted.

### 10.2 Decision (`rebalanceDecision` in chunk A, pure)

Every 60 min (± 10 min jitter) per account, with `T` the top entry relay other than home and `share(x)` its fraction of
the window's bytes, move to `T` when all hold:

- window total ≥ 64 MiB or ≥ 500 streams;
- `share(T) ≥ 0.6` and `share(T) − share(home) ≥ 0.3`;
- `T` is `full`, fresh-looking (its last `load` message < 60 s old), not draining, `tunnels / capacity < 0.8`;
- no account move for this account in the last 6 h; no old (legacy) box in the account.

### 10.3 Account move

```text
flagship/relay-account-move/v1|<accountHash>|<fromRelayId>|<toRelayId>|<issuedAt>|<notAfter>
```

Signed by the home (`from`); `notAfter = issuedAt + 10 min`. Announced to every peer, then a `locality` hint goes to each
box of the account, 2 s apart. Peers accept a move only from the relay they compute as the account's home, at most one
per account per 6 h. Once `to` holds a box of the account, it is the home (§7.3 rule 1), so the old home's remaining
boxes get `co-locate` hints from the old home, not the other way round (no ping-pong).

### 10.4 Retiring a relay

Draining a mesh relay: mark draining (`/api/health` 503, `load.draining`), then send each `mesh-v1` box a `retire` hint
to its account's best other `full` relay (lowest load, same region first), spread over the first half of the grace;
`DRAIN_NOTICE` to the remaining `drain-v1` boxes; withdrawals as tunnels close; close everything at the end of the grace
(1012, as today).

## 11. Failure handling and abuse

| Case | What happens |
|---|---|
| **Rogue blessed relay forges an attachment** | Impossible without the box's STK: peers verify every item; it is dropped and counted |
| **Rogue relay replays an old attachment** | Loses to any newer one (§5.2). If the box is offline and nothing newer exists, it attracts that box's visitors until `notAfter` (≤ 30 min): visitors to an offline box fail anyway |
| **Rogue relay black-holes** (as entry or holder) | Not preventable by protocol: it is in the data path. Detected by the mesh canary (§14.3), per-peer stats (first-byte latency, refusals), owner reports; removed by retiring it (§3.4). A holder black-holing its boxes keeps them only until their next hourly check (§9.4) after retirement |
| **Rogue relay sends false move hints** | Target must be blessed and in the directory; rate limits cap moves (one `locality` per 6 h). Worst case: a box is moved to another honest relay, or to the rogue itself (which already held it) |
| **Rogue relay floods queries or OPENs** | Per-peer token buckets (§6.4, §7.2); over the limit: `busy`. A peer over its limit for 60 s straight is cut for 10 min and flagged in stats |
| **Rogue relay floods announcements** | Per-relay store cap (100,000); verification cost bounded by the cache; only boxes that really attached to it can be announced |
| **Rogue relay holds a phone route** | It can only hold one after a phone really claimed there and L granted it; grants last 60 s and need L's renewals |
| **Rogue `full` relay as phone ledger** | Can refuse claims (route unavailable for accounts it ranks first for) or grant to a relay that does not hold the phone (black-hole). Cannot serve as the phone: TLS ends on the phone's certificate |
| **Rogue `full` relay announces legacy attachments** | Can attract old boxes' visitors (§5.3). Accepted for 0.3: all `full` relays are Flagship's |
| **Stolen box key** | The thief can already HELLO as the box; now also sign attachments. Ended by the owner's revoke: a `box-revoke` makes every fresh relay refuse its attachments and HELLOs |
| **Replayed attachment after re-registration** | regGen / key no longer match the log's `box-register`: invalid |
| **A relay stops forwarding** (crash, hang) | Bridge pings fail in 30 s → its attachments unreachable; LB health drops it within ~30 s; boxes on it reconnect through the LB when their keepalive fails (30 s × 3); visitors to them get a delayed drop meanwhile |
| **Traffic loops** | `hop:1` on every bridged OPEN; a holder matches bridged streams only against local tunnels and refuses `not-holder`; the entry relay re-queries once, never via the holder |
| **Partition between relays** | Each side routes what it can see. Two relays may each think they are an account's home or phone ledger: shortened names and the bare name may be served from both sides. Healed by the deterministic rules once bridges return (higher generation / rule order wins) |
| **`.com` outage** | Routing continues from the replicated state; heads stop being minted. At 60 s every relay refuses new tunnels and is 503 to the LB; at 10 min every tunnel closes (today's rule, now fleet-wide). Peers' gossip cannot help: nobody has a fresher head. See §16 risk 1 |
| **Cloudflare (R2/cache) outage, `.com` up** | Heads come from peers that still reach it; a relay that reaches neither goes stale |
| **Clock skew** | Box: attachment refused `clock` (diagnostics). Relays: handshake and attachment checks allow 60 s; a relay off by more is cut by its peers (`stale`), so keep NTP on non-Fly hosts |
| **Mixed versions** | §13.1 |

## 12. Guarantees under the mesh

- **Box revocation**: once `.com` appends `box-revoke`, the head carries it within 5 s; a fresh relay applies it within
  one poll (5 s) or sooner by gossip. The holder closes the tunnel and its streams at once; every entry relay refuses to
  forward. Target with contact: under 65 s (the gym's `REVOKE_DEADLINE_MS`), expected ~15 s. Without contact: no new
  tunnels after 60 s, everything closed by 10 min.
- **Lease end (dead-man)**: the holder closes app streams within 5 s of `until` (today's timer), and the box refuses app
  streams itself (§9.6). Entry relays do not know leases.
- **Renewal-key, device-grant, cert revocations**: the same propagation; the holder re-decides the affected boxes and
  phones on apply.
- **Relay revocation**: peers drop it on apply; boxes leave it within the hour (§9.4); its blessing dies in ≤ 26 h.
- **`.com` never learns which relay holds a box or a phone**: no protocol message to `.com` names a box and a relay
  together. Remaining side channels, accepted for 0.3: first-party relays' usage reports (`/api/usage/report`, per
  account, from a relay's source address, no relay field) and outbound AI checks (`/api/outbound/*`) are made by the
  holder; Cloudflare sees which address fetches the feed. Independent `entry` relays make neither.

## 13. Versions, rollout, rollback

### 13.1 Mixed versions

| Peer | Behaviour |
|---|---|
| Box without `mesh-v1` (main, 0.2) | Served as today; legacy attachment (§5.3); never moved; counts toward its account's home |
| 0.3 box with `mesh-v1` against a non-mesh relay | No `relayId` in the ACK: no attachment, no hints; works as today |
| Relay with mesh off (`FLAGSHIP_MESH=off`) | Exactly today's relay (internal routes, `.com` feed WebSocket, `.com` phone ledger). Never in a mesh directory |
| Phone app without the `grants` field in `begin` | Refused `not-eligible` on a mesh relay. The phone route is 0.3-only, so every phone build that has it ships the field |
| Old box's observe-mode blessing check | Still passes: the relay sends `serviceBlessing` (v1) with `hubKeyPub` = its relay key |

### 13.2 Rollout

1. Protocol, vectors, `.com` feed and directory deployed; the log is backfilled (one `box-register`, `account-authority`
   and `policy-head` per existing server and account, then the revocations) and published. Relays unchanged.
2. Relays (TS and Rust) gain mesh code, off by default. Conformance §14.2 green on both, existing S/P/M scenarios
   unchanged with mesh off.
3. Gym: three relays (§14.1), LB on the gym names, mesh on; the mesh groups and the full shared run green.
4. Prod: the existing relay becomes `iad1` in a one-relay directory with mesh on (behaviour equals today's; the feed is
   now the public log). `tunnel.<apex>` and the LB created with one pool; `.com` `TUNNEL_HUB_URL` →
   `wss://tunnel.<apex>:8443/tunnel`. Boxes update to 0.3 and start signing attachments.
5. Prod: a second Fly relay in another region (its own app), admitted, added to the LB. Watch `npm run ops -- mesh`.
6. Later: a non-Fly `full` relay; later still, independent `entry` relays.

### 13.3 Rollback

Retire the newest relay (directory + LB pool): its boxes get `retire` hints and drain to the rest. To leave mesh mode
entirely: one relay left, `FLAGSHIP_MESH=off`, `TUNNEL_HUB_URL` back to its direct name; `.com`'s internal routes are
still there for one release. Boxes need nothing (a 0.3 box simply stops getting `relayId`).

## 14. Tests

### 14.1 Gym

Relays: `gym-a` (Fly app `flagship-services-gym`, iad, TS or Rust per `GYM_RELAY`), `gym-b` (new Fly app
`flagship-services-gym-b`, another region, IPv6-only direct name, the other runtime), `gym-c` (Rust relay on an UpCloud
VM, Caddy for `:8443`/`:8444`, provisioned by a script in chunk G). The brief's "two Fly machines" becomes two Fly apps:
two machines in one app share one address and cannot be told apart on raw TCP. Gym directory from the gym `.com`
(gym CA); Cloudflare LB on `*.gym.<apex>` and `tunnel.gym.<apex>`. `relayInstances.ts` is superseded by the mesh group
(its pinning-by-machine trick no longer applies).

New group `relay-mesh` (`tools/live-e2e/groups/release03/relayMesh.ts`, runs alone), each check with a sim box
(`lib/boxSim.ts`, gaining `mesh-v1`, attachment signing and hint handling) and visitors pinned to a relay by its direct
address:

| Check | What it proves |
|---|---|
| cross-relay visit | box on A; visitors through B and C reach it, bytes verbatim; the miss path closes at the hold time |
| account home | a second box of the account lands on B (via a pinned dial), gets a `co-locate` hint, moves to A; `<app>.<user>` answered by one box from every entry |
| phone across relays | a sim phone on B; its ledger relay (computed) grants; visitors via A and C reach it; a second phone on C gets `route-held`, then claims on vacancy |
| revocation across relays | box on A, visitors via B; revoke → B refuses and A closes within 65 s; HELLO again refused on every relay |
| dead-man across relays | lease end: app names stop via every entry within 5 s + one poll; control name still answers |
| rebalancing | `FLAGSHIP_MESH_REBALANCE_MS` shortened on the gym; visits through C dominate; the account moves to C with no failed visit during the move |
| relay leaving | drain A: mesh boxes move by `retire` hints, old boxes by DRAIN_NOTICE + LB; no visit fails beyond the grace |
| relay joining | admit a relay; bridges form, sync completes, it turns healthy, visitors through it reach existing boxes |
| rogue relay | a harness peer (`lib/meshSim.ts`, a gym-admitted key) announces a forged attachment, replays an old one, sends a hint to an unblessed target, floods queries: all refused or rate-limited; real routing unaffected |
| `.com` contact | the gym feed paused (gym-only switch): relays go 503 at 60 s, refuse new tunnels; resumed → healthy |

### 14.2 Conformance (`tools/relay-conformance`, both relays, and mixed pairs)

The harness's mock `.com` gains the public feed (R2-shaped files, head minting, directory, relay-blessing issuance with
proof of possession). Mesh scenarios run with three relays in one mesh: TS–TS, Rust–Rust and TS–Rust in both entry and
holder roles. Same answers required on both.

| Id | Scenario |
|---|---|
| MESH01 | Bridge handshake: good; wrong `peer`; unblessed key; expired blessing; not in directory; revoked relay; stale `at` (close codes and reasons) |
| MESH02 | Attachment checks: bad signature, unregistered name, wrong regGen, revoked, future `issuedAt`, TTL too long; precedence (newer wins, box-signed beats legacy); withdrawal by another relay ignored |
| MESH03 | Cross-relay forward: ClientHello and 70 KB reply verbatim both ways; closes both ways; credit honoured |
| MESH04 | Query on miss; negative cache; inbound query limit → `busy`; no query for a name absent from the log |
| MESH05 | One hop: a bridged OPEN for a name not held → `not-holder`; never forwarded on; entry re-queries once |
| MESH06 | Move hint: a `mesh-v1` box moves make-before-break; unblessed target, wrong `fromRelayId`, rate limit → ignored |
| MESH07 | Account home and account move: shortened name from one relay; no ping-pong during a move |
| MESH08 | Phone: ledger relay ranking; claim through P granted by L; vacancy across relays; renew lapse; eligibility revocation → 4403 |
| MESH09 | Feed: head polling; stale 60 s → `try-again` + 503; 10 min → close all; head from a peer keeps a relay fresh; a forged gossiped entry refused |
| MESH10 | Legacy box: announced legacy by a `full` relay, refused from an `entry` relay, beaten by a signed attachment |
| MESH11 | Timing: local miss, mesh miss and holder refusal all close at the hold time (± 250 ms) |
| MESH12 | Mailbox forwarded over a bridge |
| MESH13 | Mesh off: S01–S20, P01–P06, M01–M03 unchanged |

### 14.3 Ops

`npm run ops -- mesh`: per relay health, head age, directory version, bridges, per-peer opens / refusals / rejected
items / first-byte latency, store sizes, account moves in the last day. A mesh canary: a Flagship-operated canary box,
visited every 5 min through every relay's direct address from GitHub Actions; a failure names the relay.

## 15. Work breakdown

Interfaces are fixed by this document (canonical strings §§3–10, JSON shapes §§6, 8, 9, routes and files §§3–4, env
§15.7), so chunks B–G start in parallel against it; A lands its types and canonical functions first (day 1–2), the rest
of A after.

### 15.1 A. Protocol and vectors

Files: `packages/protocol/src/relayMesh.ts` (new; exported from the index), `packages/tunnel-protocol/src/frames.ts`
(`FRAME_ATTACHMENT 0x07`, `FRAME_MOVE_HINT 0x08`, `CAPABILITY_MESH_V1 = "mesh-v1"`, `DecodeOptions.mesh`),
`packages/protocol/src/servingAuthority.ts` (`policy-stale` reason; revocations keyed by box key), Rust twins
`rust/crates/flagship-crypto/src/relay_mesh.rs` and `rust/crates/flagship-relay/src/frame.rs`. Vectors
`packages/protocol/test-vectors/relay-mesh/vectors.json` generated by `tools/relay-mesh-vectors.ts`; frame vectors
regenerated (`tools/tunnel-frame-vectors.mjs`).

Contents: canonical/sign/verify for relay-blessing, blessing-request, relay-directory (with the entry lines), relay-log
entry, head, box attachment, legacy attachment, withdraw, bridge-auth, move hint, account move, phone-route grant;
`nameHash`, `accountHash`; `RelayLogState` + `applyRelayLog(state, entries, logKey)` (gap / bad-signature / malformed,
like `applyRevocationEntries`); `checkBoxAttachment`, `compareAttachments`, `checkPhoneItem`, `accountHome`,
`phoneLedgerRanking`, `checkMoveHint` (box side, with its rate-limit state passed in), `rebalanceDecision`; constants
(§15.8). Tests: vectors byte-identical in TS and Rust; negative vectors for every check.

#### 15.1.1 Decisions taken while building A (2026-11-01)

Where the text above left a detail open, chunk A fixed it as follows (code: `packages/protocol/src/relayMesh.ts`,
`rust/crates/flagship-crypto/src/relay_mesh.rs`; every rule has vectors in `test-vectors/relay-mesh`).

- **Field shapes.** Log fields are strings: numbers as canonical decimals (no sign, no leading zero, ≤ 2^53 − 1),
  `account-authority` f2 empty when the account has no admin root, `renewal-key-revoke` f1 a compressed P-256 key,
  `grantId` and `certId` 64 hex. `nameHash` takes 1–253 printable ASCII characters without `|`. Pod names are
  `<server>.<user>.<apex>` (two labels), bare names `<user>.<apex>`, all lowercase.
- **Log state.** `applyRelayLog` returns, on `gap` / `bad-signature` / `malformed`, the state and count applied before
  the failure (the valid prefix is kept; fetch from `at`). The state remembers the last 1,024 entry hashes, so a head
  behind the tip can still be matched: `relayLogHeadStatus` → `applied | behind | fork | unknown`; `relayLogFresh`
  = applied and `issuedAt ≥ now − 60 s`. The newest head is the later `issuedAt`, then the higher sequence. A newer
  authority or policy head needs a generation at least as high as the one held.
- **Revocations keyed by box key.** `RevocationState.boxes` (the old revocation log too) is keyed by box key; the
  four-argument `boxRevoked(state, account, box, regGen)` still works and ignores the account. The TS gate and the
  Rust gate re-decide the boxes whose key changed.
- **Directory.** Verifying never fails on expiry (`{ok, expired}`); one issued more than 60 s in the future is refused.
- **Attachments.** Refusal order: `malformed`, `not-pod-name`, `ttl-too-long`, `future`, `expired`,
  `not-registered`, `mismatch`, `revoked`, `relay-revoked`, `unknown-relay`, holder checks (`not-this-tunnel`,
  `not-this-relay`), then `not-full` (legacy only) and `bad-signature`. The frame codes: `future`/`expired` → `clock`,
  `not-registered`, `revoked`, everything else `mismatch`.
- **Withdrawals** must name a pod name (`box`) or a bare name (`phone`) and have `at ≤ now + 60 s`.
- **Bridge auth.** A record whose signer and peer are the same relay is malformed. With `blessing: null` the held copy
  must name the same relay id. Order: `wrong-peer`, `stale`, `bad-blessing`, `revoked`, `not-in-directory`,
  `bad-signature`.
- **Move hints (box).** The directory's key for `toRelayId` must equal the target blessing's; a target that failed in
  the last hour is ignored for every reason, `retire` included. `recordMoveHint` / `recordMoveTargetFailed` keep the
  state (`{lastLocalityAt, coLocateAt, failedTargets}`) pure.
- **Account moves** need a `full`, unrevoked target in the directory and the home's directory key.
- **Phone items** need both the ledger and the holder to be unrevoked `full` relays in the directory, a grant of at
  most 60 s, and `issuedAt ≤ now + 60 s`. Equal generation and `issuedAt`: the smaller holder id wins.
- **Rebalancing** uses integer arithmetic (share ≥ 6/10, lead ≥ 3/10, load < 8/10). `T` is the entry relay with the
  most bytes other than the home (ties: the smaller id), never one with zero bytes; zero capacity counts as full load.
- **HELLO / HELLO_ACK fields** live in `frames.ts`: HELLO `servingLeases` (≤ 8), HELLO_ACK `relayId` and
  `relayBlessing`, written after `capabilities` (key order is part of the byte vectors).
- **Extra constants**: `LEGACY_ATTACH_WAIT_MS` 10 s, `HEAD_FRESH_MS` 60 s, `DIRECTORY_EXPIRED_UNHEALTHY_MS` 24 h,
  `BOX_DIRECTORY_MAX_AGE_MS` 24 h, `MESH_PEER_OVER_LIMIT_MS` 60 s / `MESH_PEER_CUT_MS` 10 min,
  `ACCOUNT_MOVE_HINT_SPACING_MS` 2 s, `REBALANCE_BUCKET_MS` 1 min, `RELAY_LOG_TIP_HISTORY` 1,024.
- **Confidentiality of the feed** (open owner decision: public, or encrypted to a mesh key sent with blessings) does
  not touch these records: an encryption layer would wrap the published files (chunk B), not the canonical forms.

### 15.2 B. `.com` feed, directory and blessing

Files: `packages/storage/migrations/01xx_relay_mesh.sql` (`relay_log`, `relays`; drops `revocation_log`,
`serving_relay_acks` after backfill), `apps/com/src/relayFeed.ts` (append helper used by every writer, the publisher in
the `ServingFeed` DO, R2 binding `RELAY_FEED`), `apps/com/src/relayDirectory.ts` (admission, directory minting, daily
cron tick in `cronPlan.ts`), `apps/com/src/relayBlessing.ts` (`POST /api/services/relay-blessing`), the writers
(server register / revoke / un-revoke / delete, admin root and IRK rotation, `serving-policy`, device removal,
renewal-key revoke, cert revoke) calling the append helper in their transaction, `GET /api/services/endpoints`
(`relays`, new `tunnelHub` default), backfill script `scripts/relay-log-backfill.ts`, CLI `scripts/relays.mjs`
(`npm run relays`), `wrangler.toml` bindings for prod and gym. `confirmedByRelays` in `GET /api/accounts/:u/serving`
becomes null (the apps hide the line; chunk F). Tests: append-in-transaction for each writer, page/head files,
cache headers, PoP refusals, directory versioning, backfill idempotence, `apps/com/test/cpuBudget.test.ts` still green.

### 15.3 C. TS relay mesh (`apps/web/src/tunnel/mesh/`)

`feed.ts` (head poll, pages, `RelayLogState`, freshness, gossip in/out), `directory.ts`, `bridge.ts` (`/mesh` server and
dialer, handshake, control dispatch, stream mux with credit), `attachments.ts` (store, precedence, caps, withdrawals),
`query.ts`, `home.ts` (account home, moves), `phoneLedger.ts` (ledger relay role + P side, replacing the `.com` ledger
client in `phoneRoute.ts`), `rebalance.ts`, `legacy.ts`. Integration: `tunnelHub.ts` (HELLO `mesh-v1`, ACK fields,
`ATTACHMENT` handling, `MOVE_HINT` send, leases from HELLO), `sniRouter.ts` (§7.2 algorithm, hold timing),
`servingGate.ts` (§4.4 inputs from the log and HELLO), `hubBlessingProvider.ts` (relay key from seed, relay-blessing
request), `mailboxRelay.ts`, `server.ts` (`/api/health` mesh-ready, `/api/stats` mesh block), `drainOnSignal.ts`
(retire hints). Unit tests per module; an in-process three-relay test.

### 15.4 D. Rust relay mesh (`rust/crates/flagship-relay/src/mesh/`)

Same modules and behaviour as C (`feed.rs`, `directory.rs`, `bridge.rs`, `attachments.rs`, `query.rs`, `home.rs`,
`phone_ledger.rs`, `rebalance.rs`, `legacy.rs`), wired into `hub.rs`, `router.rs`, `serving.rs` / `serving_feed.rs`
(replaced by `mesh/feed.rs` in mesh mode), `phone.rs`, `blessing.rs`, `http.rs`, `config.rs`. Bridge dialing uses
tokio-tungstenite over tokio-rustls (as `serving_feed.rs`). Tests: unit, `tests/mesh_core.rs` (three relays on
loopback), a fuzz target for bridge control JSON and the attachment parser. `cargo clippy -D warnings`, `cargo deny`.

### 15.5 E. Box side

`packages/server-daemon/src/tunnel/tunnelClient.ts` (`mesh-v1`, ACK fields, `ATTACHMENT` send/renew, `MOVE_HINT`
handling through the supervisor's make-before-break, hourly relay check), `packages/server-daemon/src/tunnel/relayMesh.ts`
(new: blessing and directory verification, hint rate-limit state persisted in `<dataDir>/relay-mesh.json` via
`durableFile.ts`), the serving store (`servingLeases` in HELLO, re-HELLO on change), `resolveBackend` stop-apps
(§9.6), Activity entries `server.relay.moved` / `server.relay.move-refused`. Tests: unit against vectors; the
supervisor's handover with a fake WebSocket factory (no gap in routing, old tunnel closed after grace, refused hints).

### 15.6 F. Phones, apps and sims

iOS `PhoneEndpoint*.swift`, Android `phoneroute/*.kt`, `tools/live-e2e/lib/phoneSim.ts`: send `grants` in `begin`.
Webapp, iOS, Android: hide `confirmedByRelays`; Android/iOS relay-address fallback reads `relays` from
`/api/services/endpoints`. Parity row `relay-mesh-phone`.

### 15.7 G. Gym, conformance, ops

`tools/relay-conformance/harness.ts` (feed files, directory, PoP blessing, three-relay launcher with mixed runtimes),
`tools/relay-conformance/tests/relayMesh.test.ts` (§14.2), `tools/live-e2e/groups/release03/relayMesh.ts` and
`lib/meshSim.ts`, `lib/boxSim.ts` (mesh-v1), `fly.gym.relay-b.toml`, `scripts/gym-relay-c.sh` (UpCloud VM + Caddy),
`docs/runbooks/relay-mesh.md` (admit a relay, LB pools and monitor, certs, retire, rollback), `npm run ops -- mesh`,
`.github/workflows/mesh-canary.yml`, zone-health accepting `tunnel.`. Do not change `scripts/gym-release-run.sh` in this
work; the release manager adds the group to it.

Env (both relays): `FLAGSHIP_MESH=on|off` (default off), `FLAGSHIP_RELAY_ID`, `FLAGSHIP_RELAY_KEY_SEED`,
`FLAGSHIP_RELAY_KIND=full|entry`, `FLAGSHIP_RELAY_FEED_URL` (default `https://feed.<controlApex>/v1`),
`FLAGSHIP_RELAY_LOG_PUB`; test-only shortening: `FLAGSHIP_MESH_REBALANCE_MS`, `FLAGSHIP_MESH_MIN_MOVE_MS`,
`FLAGSHIP_MESH_ATTACH_TTL_MS`, `FLAGSHIP_MESH_FEED_POLL_MS` (with the existing `FLAGSHIP_SERVING_REFUSE_NEW_MS`,
`FLAGSHIP_SERVING_CLOSE_ALL_MS`).

### 15.8 Constants

| Name | Value |
|---|---|
| `ATTACH_TTL_MS` / `ATTACH_RENEW_MS` | 30 min / 10 min |
| `LEGACY_TTL_MS` / `LEGACY_RENEW_MS` | 3 min / 60 s |
| `MESH_CLOCK_SKEW_MS` | 60 s |
| `MESH_QUERY_TIMEOUT_MS` | 1.5 s |
| `MESH_NEG_CACHE_MS` / max | 10 s / 50,000 |
| attachment store caps | 200,000 box items, 100,000 per relay, 20,000 phone items |
| per-peer limits | queries 500/s (burst 1,000); OPENs 2,000/s (burst 4,000); 20,000 streams; 64 MiB queued |
| bridge | dial 5 s, each handshake step 5 s, ping 10 s, down after 30 s, backoff 1–60 s |
| feed | head re-minted 5 s, polled 5 s, page 512 entries |
| `HEAD_REFUSE_NEW_MS` / `HEAD_CLOSE_ALL_MS` | 60 s / 10 min |
| directory | TTL 7 d, re-minted daily; box re-check 1 h |
| blessing | TTL 26 h, refresh 12 h |
| rebalance | every 60 min ± 10; ≥ 64 MiB or 500 streams; share ≥ 0.6 and ≥ home + 0.3; target load < 0.8 |
| moves | account move TTL 10 min, ≥ 6 h apart; box `locality` ≥ 6 h; `co-locate` ≥ 10 min, ≤ 6 / 24 h; dial 10 s; old tunnel grace 30 s; failed target ignored 1 h |
| phone | grant 60 s, renew 15 s (existing constants) |

## 16. Risks and open points

1. **A `.com` outage longer than 10 minutes stops every box on every relay.** That is today's contact rule, but today
   it guards one relay; the mesh makes the same rule fleet-wide, so adding relays adds no availability against `.com`.
   Options for the owner: a longer close-all for boxes whose policy is indefinite (they have no dead-man to enforce;
   revocation is the only thing lost), or a second head signer. Not decided here.
2. **Partitions break exclusivity.** The bare name and shortened names can be served from two places while relays
   cannot see each other. The phone ledger used to be one compare-and-set in a Durable Object; now it is a relay chosen
   by ranking. Accepted for 0.3 (both holders are the owner's own devices or boxes).
3. **Legacy attachments rest on the relay's word** (§5.3). Fine while every `full` relay is Flagship's; must end before
   any independent `full` relay.
4. **Metering and outbound checks still tell `.com` which first-party relay carries an account** (§12). Independent
   relays are `entry` only until there is an anonymous reporting scheme.
5. **Cloudflare LB on a wildcard, DNS-only**, and the LB's cost (pools, origins, health-check regions) need checking with
   Cloudflare before step 4 of the rollout.
6. **The log makes every box key and name hash public.** CT already publishes the names; the owner should still confirm.
7. **An IPv4-only box cannot follow a hint to an IPv6-only relay.** It stays where the LB put it (the dial fails, it
   backs off); its account may stay split. Prod `full` relays should keep an IPv4 direct address.
8. **Bridge throughput through Fly's proxy** (WebSocket on `:8443`) is unmeasured; add a mesh row to
   `benchmarks-0.3.md` before step 5.
