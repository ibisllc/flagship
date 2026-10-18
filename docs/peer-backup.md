# Peer backup between accounts

> **Status: design, 2026-10-16.** Replaces the same-account peer backup
> (`peerBackup/*` v1, `.com` `/api/peer-backup/request-peers`). The policy
> it plugs into (Phone-side / Peer / None, the 1/3 cap, scheduled archives)
> is in `docs/server-backup-and-clone.md` ("Backup policy", "Scheduled
> backups").

## 1. What the owner gets

A server on the **Peer** policy may use only a third of its disk. The other
two thirds are its **pool**. Part of the pool holds pieces of other people's
backups ("bricks"). The rest is filled with random filler, so the server can
prove the space is really there. In return, the server's newest scheduled
backup is cut into bricks and spread over eight other people's servers. Any
four of those eight bring it back.

Nobody learns more than they must:

- **The other servers** hold only same-sized random-looking bricks. They
  never learn whose they are, what is in them, or which server sent them.
- **The owner's server** never learns who holds its bricks. It sees an
  anonymous key, a reliability score and a capacity.
- **flagshipserver.com** knows who takes part and how much space each server
  pledges and proves. It never learns who backs up to whom.

Restore works from any device of the account, even after the server is gone
for good. Every key comes from the account key (UMK), never from the dead
box.

## 2. Terms

| Term | Meaning |
|---|---|
| owner | the server whose backup is being stored |
| holder | a server storing bricks for owners it doesn't know |
| archive | the newest scheduled backup: the sealed data file plus the small backup file (`serverArchive/`) |
| payload | the archive's data file, the bytes that get cut up |
| segment | `k × B` bytes of payload |
| shard | one of the `n` Reed-Solomon pieces of a segment (`B` bytes) |
| brick | a shard encrypted for one holder (`B` bytes, looks random) |
| filler | `B`-byte random bricks from `.com` that fill the rest of a holder's pool |
| PIK | peer identity key: the holder's anonymous Ed25519 key, plus an X25519 key for sealing. Random, never derived from the account. |
| PBK | peer backup key: `HKDF(deriveSWK(UMK, serverId), "flagship/peer-backup-key/v1")` |
| lease | an owner's right to `slots × 64` bricks on one holder for 90 days, paid with blind tokens |
| root | the sealed record on `.com` that a restore starts from |

Network constants come from `.com` (`GET /api/peer-backup/network`), so the
gym can shrink them:
`B = 4 MiB`, `k = 4`, `n = 8`, leaf = 1 KiB, 64 bricks per slot,
leases of 90 days. The gym runs `k = 1, n = 1` with small bricks, because it
has only two accounts.

**Why 4 of 8.** Storing a backup on 4-of-8 costs exactly twice its size,
which is the owner's split: data uses at most 1/3 of the disk, and the backup
needs at most 2/3, the size of the pool. Eight holders also survive more:
say each holder dies with probability 12% over the six months after its
owner's box dies. Then 3-of-5 loses the backup with probability 1.3%, and
4-of-8 with 0.1%.

## 3. Keys

All derivations are HKDF-SHA256 over UTF-8 info strings.

```
SWK            = deriveSWK(UMK, serverId)                 (existing; the box holds it)
PBK            = HKDF(SWK, info "flagship/peer-backup-key/v1")
rootKey        = HKDF(PBK, info "flagship/pb-root/v1")
brickKey(id)   = HKDF(PBK, info "flagship/pb-brick/v1|" + brickIdHex)   AES-256-CTR, IV 0
brickId        = HMAC(PBK, "flagship/pb-brick-id/v1|" + gen + "|" + seg + "|" + shard + "|" + rev)[0..16]
leaseKey       = random Ed25519 seed per (holder, generation), kept in the root
```

The box holds the SWK, so it can make every peer-backup key. A device of the
account holds the UMK, so it can make the same keys for any of the account's
servers, including a dead one. After a full account recovery (passkey plus
passphrase, or the backup key file), the recovered device has the UMK again,
so peer restore works from it too. The archive itself opens with its account
slot (`deriveServerArchiveKey(UMK, archiveId)`), so the archive format does
not change.

`rev` is the placement revision of that shard. A repair bumps it, so a shard
placed again on a new holder gets a new id and a new key, and its bytes have
never existed anywhere else.

## 4. Bricks

For each generation (one archive):

1. The payload is cut into segments of `k·B` bytes. The last one is padded
   with zeros.
2. Each segment is Reed-Solomon coded into `n` shards of `B` bytes, with
   the systematic Cauchy code in `packages/protocol/src/erasure.ts`, so any
   `k` shards decode (tested exhaustively for every k-of-n in use). Until
   2026-10-16 that file stacked the identity on Vandermonde rows, which is
   not MDS: with `k=4, n=8`, shards {2,4,5,6} didn't decode. Only the `3/5`
   the same-account code used happened to be safe.
3. Shard `i` of segment `s` goes to stripe member `i`. Its brick is
   `AES-256-CTR(brickKey(brickId), shard)`. CTR keeps the brick exactly `B`
   bytes, and without the key it is indistinguishable from random. Two
   effects: no Flagship header, frame length or zero padding shows, and two
   holders never hold equal bytes.
4. For each brick the owner computes a Merkle root over its 1 KiB leaves
   (`SHA-256(0x00‖leaf)` / `SHA-256(0x01‖l‖r)`) and keeps it locally, 32
   bytes per brick, so it can challenge any brick (§6.1). The **index**
   lists the SHA-256 of every data shard's plaintext, in order (segment,
   shard). It is cut into segments and coded like the payload, as segments
   `S..S+T−1`, and the root on `.com` keeps the hashes of the index shards.
   A restore decrypts each brick it fetches and checks the shard against its
   hash. Shard hashes don't depend on the placement revision, so a repair
   never rewrites the index.

A generation uses one **stripe** of `n` holders, or several stripes when one
holder can't take `1/n` of the bricks (segment `s` uses stripe `s mod
stripes`).

## 5. Blind matching

### 5.1 Holders register

A Peer server makes a PIK once (random; `<dataDir>/peer-backup/pik.json`). It
checks in with `.com` every 10 minutes, signed by its STK:

```
POST /api/peer-backup/holder/checkin
flagship/pb-checkin/v1|<serverDomain>|<pikPubHex>|<xPubHex>|<poolBytes>|<fillerHeld>|<leaving 0|1>|<issuedAt>
```

`.com` binds the PIK to the server (one PIK per server), records an hour bit
in a 30-day presence ring, and replies with filler it may fetch, a filler
challenge when one is due, and the outcome of token redemptions.

The check-in is the holder's heartbeat. The daemon-status heartbeat keeps
only its latest report, so it can't measure uptime over a month. The
check-in also carries the challenge channel.

### 5.2 The directory

```
POST /api/peer-backup/directory      (STK-signed, Peer servers only)
→ { network, entries: [ { pik, xPub, freeSlots, reliability, accountTag, netTag } ], self: { accountTag } }
```

Every Peer server downloads the same directory: holders that checked in
within a day and are not leaving, leaving out the asker's own account.
The owner picks its holders itself, so `.com` sees only "server X downloaded
the directory" and never which entries it used.

- `reliability` (0 to 100, in steps of 10) = presence over the last 30 days ×
  filler-proof pass rate. A holder younger than 7 days shows at most 50.
- `freeSlots` is bucketed to a power of two.
- `accountTag = HMAC(PB_TAG_SECRET, username)[0..8]` and `netTag = HMAC(PB_TAG_SECRET,
  /24 or /48 of the check-in's source address)[0..8]`. Owners can tell
  that two holders share an account or a network, but never which. `.com`
  stores only the tag, never the address.

**Placement:** the owner picks `n` entries with distinct `accountTag` and
distinct `netTag`. It never picks its own account. It draws at random,
weighted by `reliability × min(freeSlots, need)`, and skips entries below 30.
If a holder refuses (full or gone), the owner draws again. If the directory
can't supply `n` distinct holders, the state is **waiting for peers** ("Peer
backup starts once 8 other servers can hold it. 5 can now."), and nothing is
placed half-diverse.

LAN-direct doesn't apply. Holders on the owner's network are excluded by the
`netTag` rule.

### 5.3 Mailboxes through the relay

A holder's tunnel announces its mailbox to the hub:

```
mailboxId(epoch) = SHA-256("flagship/pb-mailbox/v1|" + pikPubHex + "|" + epoch)[0..16]   epoch = floor(t / 7 days)
announce:  flagship/pb-mailbox-announce/v1|<pikPubHex>|<epoch>    signed by the PIK
```

It announces the current and the next epoch. The hub keeps
`mailboxId → tunnel` in memory, like SNI routes, and checks the PIK
signature, so nobody can take over another holder's mailbox. An owner
computes the mailbox from the PIK it got from the directory and sends:

```
POST https://<services apex>:8443/pb/m/<mailboxId>      body: sealed envelope (≤ B + 64 KiB)
```

The hub passes the body over the holder's tunnel (`FRAME_PB_MAIL_*`) and
returns the sealed reply. The owner never learns the holder's name or
address, and the holder never learns the owner's.

**Envelope** (`packages/protocol/src/peerBackupMail.ts`):
`0x01 ‖ ephX25519Pub(32) ‖ nonce(12) ‖ AES-256-GCM(k, nonce, plaintext, aad = mailboxId)`,
where `k = HKDF(X25519(eph, holderXPub), salt = mailboxId, info "flagship/pb-mail/v1|req")`.
The reply is sealed under `info "…|resp"` with a fresh nonce. The plaintext
is `u32 headerLen ‖ header JSON ‖ raw bytes`. The hub sees only the mailbox
id, sizes and timing.

### 5.4 Paying with blind tokens

Space has to be fair: you store about what others store for you. And `.com`
must not learn where you spend it. Both come from RSA blind signatures
(RFC 9474, RSABSSA-SHA384-PSS-Randomized, 2048-bit key `PB_TOKEN_RSA_JWK`):

1. **Issue.** The owner makes random 32-byte serials, blinds them and sends
   them, STK-signed, to `POST /api/peer-backup/tokens`. `.com` signs at most
   `3 × provenSlots(owner) + 8` in any 30 days. That covers renewal, one
   new generation and repairs. The `+8` lets a new server start before its
   pool is full.
2. **Spend.** The owner opens a lease at a holder with as many tokens as it
   needs slots. The holder checks each signature locally with `.com`'s
   public key (a standard RSA-PSS verify).
3. **Redeem.** The holder redeems the spent tokens with `.com`
   (`POST /api/peer-backup/holder/redeem`, STK-signed), in batches, after a
   random delay of 0 to 6 hours, so redemption time doesn't point at the
   owner's backup time. `.com` refuses a serial it has seen, and the holder
   then drops that lease. Each redemption credits the holder
   `slots × 64 × B` for 90 days.

`provenSlots(server) = (fillerHeld·B + Σ live lease credit) / (64·B)`.
That is space a holder proves by answering filler challenges, plus space it
holds for others. So an owner can place only about as much as its own
server provably holds.

### 5.5 Filler

Filler brick `j` of holder `pik` is
`AES-256-CTR(HMAC(PB_FILLER_SECRET, "flagship/pb-filler/v1|" + pik + "|" + j), IV 0, zeros(B))`.

`.com` serves it to the holder (`POST /api/peer-backup/filler`, STK-signed,
at most 25 GB a day). It serves only index `fillerHeld` (the next one), or
the latest one again within 15 minutes when a download broke. It can
recompute any byte of any filler brick, so it checks proofs without storing
anything. The holder keeps filler indices `0..fillerHeld−1`. When a lease
needs room, it deletes filler from the top and reports the lower count at
its next check-in.

The holder can't regenerate filler, since the secret stays on `.com`, and
can't download it again on demand, since `.com` refuses. The only way to
answer a filler challenge is to keep the filler.

## 6. Proof of storage

### 6.1 Owners prove their bricks

Every 6 hours, for each stripe member, the owner picks a random brick and
two random leaves, and sends `brick.prove {leaseId, brickId, leaves}`
(signed by the lease key). Within 120 seconds the holder must return the
leaves and their Merkle paths. The owner checks them against the Merkle root
it keeps, so it never downloads a brick and never holds a shared secret.
There is no limit on how many challenges it can make.

A holder that keeps only a fraction `f` of an owner's bricks fails a
challenge with probability `1 − f`. Dropping half fails within a day with
probability 94%. Dropping 1% is caught within a month with probability about
70%, and is harmless while it lasts: any 4 of 8 shards rebuild a segment, and
a repair moves that member.

### 6.2 `.com` proves the filler

On a check-in that is due (about one an hour), `.com` returns
`{ id, brick j, leaf L, nonce N, deadline }`. The holder answers
`SHA-256(N ‖ leaf L of filler j)` on `POST /api/peer-backup/holder/proof`
within 120 seconds. `.com` computes the same bytes with AES-CTR at offset
`L·1 KiB`. The pass rate over 30 days feeds `reliability`.

### 6.3 Decoys (phase 2)

A holder knows which bricks came from `.com` (filler) and which came through
the mailbox (owners). A cheater could therefore keep filler, drop real
bricks, and pass `.com`'s checks while the owners notice. Owners do notice
and repair, but `.com`'s score wouldn't reflect it. Phase 2 adds
**decoy leases**: `.com` acts as an ordinary owner through the relay, with
real tokens, lease keys and Merkle challenges, for about 2% of each holder's
pool. Inside the mailbox a decoy can't be told from an owner, so dropping
"real-looking" bricks also fails decoys, and `.com` scores it. Decoys cost
relay egress, which is why they are a small share and not all of the filler.

## 7. Collusion, and what's left

- **Two holders can't share one copy.** Every brick is encrypted under its
  own key (§3), so no two bricks are equal anywhere. Filler is keyed by the
  holder's PIK. There is nothing to deduplicate.
- **Filler can't be faked**, because only `.com` can make it (§5.5).
- **Holders can't tell an owner's bricks apart** or link them: equal sizes,
  pseudorandom bytes, anonymous lease keys per (holder, generation).
- **Colluding holders learn nothing.** Even all eight together can't decode:
  every shard is encrypted under PBK keys before anyone sees it, and the
  archive inside is sealed again under its content key.
- **Sybils.** The diversity rule allows one shard per account and per network
  in a stripe. Someone who wants several shards of one stripe needs several
  accounts on several networks, each a real server with two thirds of its
  disk proved by filler. That is possible for a determined attacker with
  real hardware. It stays the main residual risk, and the score's 7-day
  ramp only slows it down.
- **Outsourcing.** A holder may keep bricks somewhere else (a cloud bucket).
  The 120-second deadline doesn't stop that, and it doesn't need to: the
  data is still retrievable.
- **Cheating pays for at most one lease.** A holder that drops a lease's
  bricks keeps the lease's credit until it expires (90 days at most, from
  the owner's last renewal). Owners stop renewing as soon as they see
  failures, and decoys (phase 2) also cost it reliability.
- **What timing still shows `.com`.** Token issue counts reveal roughly how
  big each owner's backup is, and redemptions how much each holder stores.
  Jittered redemption hides when a placement happened, but with very few
  participants `.com` could still guess pairs from volumes. The relay (§9)
  is a stronger observer.

## 8. Lifecycle

**Placing.** After each archive is saved (`onArchiveSaved`), the engine
decides whether to send a new generation. By default it sends at most one a
week, only when the archive changed, and only once the previous generation
is fully placed. It pins the archive it is sending and the one on peers
(`pinnedArchiveIds`), so retention keeps the local copy that repairs read
from. Uploads are spread over time, at most 4 bricks in flight. When the new
generation is fully placed and its root is deposited, the old generation's
leases are closed.

**Renewal.** A lease is renewed when it has fewer than 60 days left, so
normally every 30 days.

**Repair.** A stripe member is replaced after 3 failed challenges in a row,
after 72 hours unreachable, or when the directory marks it leaving. The
owner rebuilds that member's shards from its local archive (pinned), with a
new `rev`, places them on a newly drawn holder, and deposits a new root
revision. If the local archive is gone, it fetches `k` shards per segment
from the others first.

**Holder churn and leaving.** A server that leaves the Peer policy (or turns
off) is marked `leaving` at its next check-in. It takes no new leases, keeps
the ones it has for 14 days so owners can move away, and then frees its
pool. Until then its data cap stays 1/3.

**Deletes.** `brick.delete` and `lease.close` only mark bricks: the holder
keeps them for 14 days, during which they can still be fetched with the lease
key, then frees them. So someone who takes over an owner box can't destroy
its peer copies at once.

**Eviction.** A holder never evicts a live lease. It drops a lease 7 days
after it expires, or right away when its redemption is refused as a
double spend.

**Owner gone.** Leases run 90 days from the last renewal, so a dead server's
backup stays on peers for at least 60 days. The apps show the date by which
to restore.

## 9. Restore

From any device of the account (admin device to add a server, by the
existing rule):

1. The device derives `SWK → PBK → rootKey` for the lost server and fetches
   the root: `GET /api/peer-backup/root/<serverDomain>`, sealed and public
   like the old manifest lane. `.com` keeps the last 8 root revisions, so a
   box that has been taken over can't erase the history.
2. The root names the archive (id, size, SHA-256, created) and carries its
   small backup file. The device opens the account slot with the UMK and
   signs the usual restore order. Nothing comes from the dead box.
3. The new server (waiting for a backup, as in Restore from backup → From a file) gets the
   PBK from the device over the owner session. It runs `restoreFromPeers`:
   it fetches the index bricks, then each segment's bricks from the stripe
   (any `k`, checked against their Merkle roots, a bad or missing one replaced
   by the next holder), decodes, and writes the data file. Then the restore
   continues exactly as after an upload
   (`serverArchiveService.setPeerFetcher`).

## 10. Who learns what

| Party | Learns | Never learns |
|---|---|---|
| `.com` | which servers take part; each one's PIK, pool, presence, filler pass rate, account tag and network tag; tokens issued per owner; leases redeemed per holder; sealed roots | who stores for whom; brick ids; contents; the holder's network address |
| relay (`.services`) | while relaying: owner's source address → mailbox, sizes, timing (not logged; a compromised relay could log pairs) | contents, brick ids, lease keys (sealed) |
| holder | its mailbox receives same-sized bricks under anonymous lease keys; which of its bricks are filler | owner's account, server, address, contents |
| owner | holders' PIKs, reliability, capacity, opaque tags | holders' accounts, names, addresses |
| compromised owner box | its own backup (it already has the data); it can close its own leases, but holders keep them 14 days and `.com` keeps old roots | other owners' anything |
| compromised holder | ciphertext; it can drop bricks (detected, repaired) | anything readable |

The relay is the one place pairs pass in the clear. It is our own stateless
pipe, keeps no logs, and sees the box's home address on its tunnel anyway.

## 11. Box interface (with the backup policy)

- `BackupPolicyStore.current().policy === "peer"` runs the engine. A change
  away starts a graceful exit (§8).
- `backupCap.reservedForPeersBytes()` sizes the pool (minus 2% headroom).
- `serverArchiveService.setSavedHooks({ onArchiveSaved, pinnedArchiveIds })`.
- `backupPolicyHttp.setPeerStatus(() => status)` fills the server page:
  `{state, reason?, lastPlacedAt, healthyBricks, totalBricks, holders,
  archiveId, hostingBytes, provenBytes, poolBytes}`. `state` is one of
  `waiting-for-peers`, `filling`, `placing`, `protected`, `at-risk`,
  `leaving`, `off`.
- `serverArchiveService.setPeerFetcher(restoreFromPeers)`.
- Own routes: `GET /api/screens/peer-backup/status` (the full status screen:
  stripe members as "Server 1..8" with state and last proof, hosting
  breakdown, restore-by date), `POST /api/screens/peer-backup/restore`
  (owner session; PBK in the body), `GET /api/screens/peer-backup/root?server=`.

## 12. Migration from the same-account code

Before launch, old boxes need no compatibility (owner rule). With the new
engine:

- The box deletes the v1 state (`<dataDir>/peer-pool`,
  `<dataDir>/peer-backup/{registry.json,own-shards,manifest.json}`) at start.
  v1 shards on sibling servers were only ever the account's own ciphertext.
- `BackupLoop`'s file walk, `/api/peer-backup/frames` and `.com`
  `request-peers` / `stk/:domain` are removed once Migrate stops using
  `runRestoreOnce` (the backup agent is moving it to the archive path). Until
  then they stay, untouched.
- `peer_backup_manifests` (0080) stays as a workspace artifact. Roots live
  in the new tables (migration 0104).

## 13. `.com` state (migration 0104)

`pb_holders` (pik, server, username, xPub, pool, tags, presence ring,
filler count, pending challenge, proof counts, leaving),
`pb_leases` (pik, leaseId, slots, expiresAt),
`pb_token_serials` (SHA-256 of each spent serial),
`pb_token_issue` (server, window, count),
`pb_roots` (server, generation, revision, sealed root; the last 8 kept).
Secrets: `PB_TOKEN_RSA_JWK`, `PB_FILLER_SECRET`, `PB_TAG_SECRET`. Without
them the endpoints answer 503 "Peer backup between accounts isn't set up on
this server yet."

## 14. Costs and limits

- Relay egress: every brick crosses Fly once. A 100 GB server sends 200 GB
  per generation, so generations are weekly at most and only when changed.
  Incremental generations need an archive format split per app (later).
- Filler comes from Cloudflare (no egress fee), capped at 25 GB a day per
  holder. A 1 TB disk takes about four weeks to fill. Until then the server
  can place only what it has proved (`3 × provenSlots + 8` tokens).
- Worker cost of filler: each 4 MiB brick is one WebCrypto AES-CTR pass
  (measured at about 1 ms on Apple silicon; allow 2 to 5 ms on a Worker)
  plus one Ed25519 verify. 25 GB a day is 6,400 requests and about 30 s of
  CPU per filling server per day: about $0.002 in requests and $0.0006 in
  CPU at Workers paid rates. `.com` caps it in the handler: only the next
  index, or the last one again within 15 minutes; at most 25 GB per server
  per UTC day (429 with a sentence); never past the pool the server
  declared; none for a server that is leaving.
- Hub routing is per machine, like SNI. A mailbox on the other Fly machine
  answers 404 and the owner retries.

## 15. Turning it on (owner)

`.com` needs migration 0104 and three secrets. Until then the routes answer
503 and Peer servers say peer backup isn't set up. Run once, from `apps/com`:

```sh
npx wrangler d1 execute flagship-state --remote \
  --file=../../packages/storage/migrations/0104_peer_backup_network.sql
node -e 'process.stdout.write(JSON.stringify(require("node:crypto").generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"jwk"})))' \
  | npx wrangler secret put PB_TOKEN_RSA_JWK
openssl rand -hex 32 | npx wrangler secret put PB_FILLER_SECRET
openssl rand -hex 32 | npx wrangler secret put PB_TAG_SECRET
npm run deploy
```

Then deploy `.services` (the mailbox relay) and endorse a box release.

- Never rotate `PB_FILLER_SECRET`: every filler brick on every holder
  would stop matching, and holders would fail their proofs until they
  fetched their filler again.
- Rotating `PB_TAG_SECRET` only re-tags the directory.
- Rotating `PB_TOKEN_RSA_JWK` voids every unspent token. Owners then ask
  for new ones.

The gym gets its own values from `scripts/gym-setup-live-env.sh` (or
`scripts/gym-refresh.sh`, which keeps them as gym-only secrets). It runs
with `PB_NETWORK = {"k":1,"n":1,"diversity":"account"}` (set in
`wrangler.gym.toml`).
