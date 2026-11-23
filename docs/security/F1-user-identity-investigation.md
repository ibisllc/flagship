# FLAGSHIP-F1: `/api/user-identity` investigation

Investigated 2026-11-23, read-only, on `release/0.4` = `main` = `15ce803e8` (production `.com` was
deployed from `4e74bb2f4`, an ancestor with identical code here). No code, data or deploy was changed.
`docs/security/` is new; the existing `docs/security-assessment/` is the external-assessor pack, not a
findings log, so this note does not go there.

## 1. Verdict: confirmed, and unchanged since 2026-05-11

Every deployed `.com` since `f20e496c8` (2026-05-11, "wire user-identity store into the runtime")
carries the same code; neither the handler (`f7e5fc491`) nor the storage class has changed since.

What `POST /api/user-identity` checks (`packages/control-plane/src/userIdentity.ts`):

- shape only: `usernameHash` 64 hex, blob 1..256 KiB base64 (`:69`), 1..16 signers of 64 hex,
  `blobVersion` a positive integer (`:170`, `Number.isInteger`, so values far above 2^53 pass),
  signature 128 hex (`:148-181`);
- the signature over `flagship/user-identity-record/v1|hash|sha256(blob)|sorted signers|version`
  against **the `authorizedSigners` the same request supplies** (`:183-209`). Nothing compares those
  keys with the stored row's signers, the account's IRK / AID / admin root / device keys, or anything
  else `.com` knows;
- then `putIfNewer` (`:212`): `packages/storage/src/d1.ts:4374-4408` reads the row and, if the new
  version is strictly higher, upserts every column, **signers included**. The read and the write are
  separate statements (a concurrent lower write can still land: minor TOCTOU).

Routing: `apps/com/src/controlPlaneRoutes.ts:1059-1060` and `:2869-2885`, no auth, no read token, no
account-gone gate. Not in `apps/com/src/rateLimit.ts` `endpointFor` (no budget at all).
`GET /api/user-identity/<hash>` (`userIdentity.ts:226`) returns blob, signers, version and signature
to anyone.

The row key is `SHA-256("flagship/userIdHash/v1|" + username + "|flagship.v1")` (`:124-129`); the
module itself says the fixed salt gives no protection (`:37-44`).

So the report is exact: anyone can create a row for any name, overwrite any row by choosing their own
signer with a higher version, and freeze a row for good with a huge version (`2147483648`, or up to
~1.79e308; past 2^53 an honest `version + 1` cannot even be expressed). There is no reset path, and
account deletion / rename never touch the table (`packages/storage/src/accountRename.ts:128-129`
lists it as "the owning client must re-key it").

Not in the report: **unauthenticated, unmetered storage**. Each POST stores up to 256 KiB under a new
hash, with no rate limit; a client can mint as many hashes as it likes. Production D1 is ~7.5 MB today;
~40,000 POSTs (~14 GB uploaded, one Ed25519 signature each) would reach D1's 10 GB database cap, after
which every `.com` write fails. It is also a free anonymous blob host on `flagshipserver.com` (served as
`application/json`, `finishPlain`, `controlPlaneRoutes.ts:4933`, so not directly script-executable).

## 2. Writers and readers: none. The feature is dead

Searched `release/0.4` and every local and remote branch (`git grep` over all refs) for
`api/user-identity`, `userIdHash`, `user_identity`, `EncryptedBlobAdapter`:

| Surface | Writes | Reads |
|---|---|---|
| Webapp (`apps/web/public/webapp`) | no | no |
| iOS / watchOS (`apps/mobile/ios`, `apps/mobile/shared`) | no | no |
| Android / Wear (`apps/mobile/android`) | no | no |
| Studios (Mac, Windows, Linux) | no | no |
| Box (`packages/server-daemon`, Rust) | no | no |
| `.com` itself | only the route | only the route |
| Tests | `apps/web/tests/userIdentity.test.ts`, `packages/storage/tests/parityCas.test.ts:867` | same |

The only consumer ever designed was `@ibisllc/maintainers`' `EncryptedBlobAdapter` (vendored in
`4832a2558`, its doc comment names this GET), which Flagship never instantiates: `.com` imports only the
mandate-chain verifier from that package. Its intended job (encrypted per-user labels, device names,
friend names) is now done by the account directory (`account_profiles`, device self/managed profiles,
directory key grants: `packages/control-plane/src/accountDirectory.ts`), which is device-authenticated
and admin-root-signed.

Security relevance today: none. No recovery, restore, device list, key, contact or box decision reads
these rows; nothing trusts a record, so no client checks signers. Practical attacker gain today: pin
or squat a name's row (harmless while unused), store junk, and the D1-exhaustion outage above. Worst
case if a future client consumed the GET without checking signers against keys it already trusts:
an attacker-chosen blob accepted as the owner's (meaningless if the client decrypts under a UMK-derived
key, since AES-GCM would fail, but a permanent 409 denial of the owner's own store either way).

## 3. Production (read-only SELECTs, 2026-11-23)

- `user_identity_records`: **5 rows**, 124 blob bytes in total, all written 2026-11-19 between
  07:12 and 15:41 UTC. One signer each.
- Rows matching an account: **0 of 5**, against all 32 `usernames` rows (as stored and lower-cased),
  `usernames_aliases` (0 rows), `demo_users` (1) and common guesses.
- The researcher's two names: `zzqresearch7f3a` -> `d274a6ab2827...` (version 999999) and
  `zzqvalidate01c` -> `f84415de2b00...` (version **2147483648**): both present.
- The other three (`22a7b11863a7...` v1, `430bff193b08...` v2, `9627fb7c50bc...` v1) map to no known
  name; same day, so very likely the researcher's earlier probes.
- Rows with version > 1e6: **1** (the 2147483648 row).
- Signers equal to any registered key (`irk_pub_hex`, `aid_pub_hex`, `admin_root_pub_hex`,
  `device_identities.device_pub_hex`): **0**. No real account has a row, poisoned or otherwise.

## 4. Severity

**Medium now** (agree with the researcher, for a different main reason). Integrity of the records
themselves is irrelevant today (no consumer), so the "overwrite / lock out" half is Low in effect. What
keeps it at Medium is that an anonymous, unmetered write lets anyone grow production D1 toward its cap
and take every `.com` write down (account creation, server registration, unlock requests, orders),
plus anonymous content hosting under our domain. It is easy, needs no account, and is live. It is not
High: no user data is read or changed and no key or recovery path depends on it. It would become High
the day any client trusted the GET, which removing the endpoint rules out.

## 5. Fix

**Recommended: remove the endpoint** (unused everywhere, superseded by the account directory):

1. Delete the two routes (`controlPlaneRoutes.ts:1059-1060`, `:2869-2885`), the handler
   (`packages/control-plane/src/userIdentity.ts` + its `index.ts` export),
   `D1UserIdentityRecordStorage` and the in-memory twin, the `userIdentity` storage member, and the
   two tests. `/api/user-identity*` then answers the Worker's normal 404.
2. A new D1 migration (migrations stay on `main`) that `DELETE`s all rows, or `DROP TABLE
   user_identity_records` and its `schema.ts` / `accountRename.ts` entries; keep `0012` as history.
   All 5 production rows are probes; none belongs to an account.
3. No client changes on any platform: nothing writes or reads it. No box release, no store build.
4. Credit the researcher; the hall-of-fame / bounty decision is the owner's.

**If the owner wants to keep it** (match the established account-write pattern):

- Move it under the account: `PUT/GET /api/accounts/<u>/identity-record` (the
  `account-directory-request/v1` canonical bytes only allow `/api/accounts/...` paths,
  `packages/protocol/src/accountMetadata.ts:376-401`). Key the row by account name, not a hash (the
  hash hides nothing, `.com` holds the names), so deletion and rename can handle it.
- Write auth: `authorizeActiveDevice` (`accountDirectory.ts:62-94`: fresh, nonce-claimed request
  signed by a registered, non-revoked device key), and admin-only via `isAdministrator` /
  `authorizeSensitiveComOp` (`adminAuthorityGate.ts`) if it carries authority. The blob's own
  signature, if kept, must verify under the account's admin root (as `handlePutAccountProfile` does,
  `accountDirectory.ts:217-240`), never a caller-supplied list. First write is bound the same way
  (no unbound pre-existing rows exist, so no grandfathering is needed).
- Versioning: compare-and-swap on `expectedRevision` with `revision + 1` only (like
  `account_profiles`, `d1.ts:3788-3795`), as one conditional SQL statement (closes the TOCTOU);
  reject non-safe integers.
- Read: `Bearer` account read token and `private, no-store` (`finishRead`), as `/pods` and the
  directory reads.
- Limits: a `rateLimit.ts` budget per source and per account, a per-account size cap, rows dropped
  on account deletion, the row carried or refused on rename.
- Operator reset: an `x-admin-secret` route that deletes one account's row (the pattern at
  `controlPlaneRoutes.ts:1831`), logged; with account binding it is rarely needed.
- Clients: webapp, iOS, Android would all have to write and read it in the same release, with shared
  vectors; today none do.

## 6. Similar patterns elsewhere

Searched `packages/control-plane/src` and `apps/com/src` for verifies whose key comes from the request:

- `serverShares.ts:414-435` `POST /api/share-inbox`: signature checked against `req.inboxPubHex` from
  the request, but the inbox row **is** that key (a writer can only touch its own inbox), so no
  takeover. Same storage concern in a smaller form: no account binding, 200 entries per inbox
  (`SHARE_INBOX_CAP`, `:71`), unlimited inboxes; worth checking it has a `rateLimit.ts` budget (none
  found by name) and an entry size cap.
- `serverRevocation.ts:236-275`: body-supplied `signerPubHex`, but bound to a `revoke-others`/`admin`
  device grant afterwards. OK.
- `notifyOwner.ts:150-173`, `secretMailbox.ts:200-223`: body `stkPub` must equal the registered server
  key. OK.
- `rePair.ts:395-430`: the new IRK signs, by design, gated by recovery proofs. OK.
- `routing.ts` RCK registration: through `authorizeSensitiveComOp`. OK.
- `peerBackupNetwork.ts:240`, `:374`: server STK first, then a first-use peer identity bound to that
  server. OK.
- `inheritance.ts`: IRK-bound, and not routed at all (dead code; candidate for removal too).

No other cross-account overwrite with a self-asserted signer was found.

## Open questions for the owner

1. Remove the endpoint (recommended) or keep it with the design above?
2. Delete the 5 probe rows now, or with the removal migration?
3. Bounty / hall-of-fame for FLAGSHIP-F1 (the D1-exhaustion angle is ours, not the reporter's).
4. Is there a zone-level Cloudflare rate limit in front of `.com` (dashboard; not visible from the
   repo)? It would bound the D1-fill attack until the fix ships.
5. Review `share-inbox` limits in the same change.
