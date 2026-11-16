# 05c: adversarial review of voi.ci call keys, org directory/connectors, keyd org CGK, box log heads, retail claim helper

Branch `0.4/review-cloud` (pushed), base `e46b6eb88` (release/0.4). Failing tests (no fixes) are in commits
`037423994`, `649bcdc29`, `9b99f84ce`, `9bd5fef61`.

## Summary

| id | severity | area | one line |
|----|----------|------|----------|
| F1 | Medium | voi.ci call keys / `.com` | Any account's owner key can revoke any other account's call key; the revocation is global by `callKeyPub` and permanent |
| F2 | Medium | SCIM server (box) | `/scim/v2/Users/__proto__` and `/Groups/__proto__` resolve to `Object.prototype`: PUT/PATCH pollute every object in the daemon (and the PUT throws out of the handler) |
| F3 | Medium | Connector runtime (box) | `linkSeats` links a pending person to any seat on a decision and invite from `.com` without verifying either one's org approval |
| F4 | Medium | keyd org CGK (TS and Rust) | A CGK ring approved under any record of the handed chain (not the newest) is adopted, and keyd keeps no chain head, so a truncated chain works: a removed admin can still rotate the box's CGK |
| F5 | Medium | Org audit export | The verifier flags objects the log does not name, never logged objects that are missing: `.com` can drop a server and its box log head (or serve an older head) and the export verifies clean |
| F6 | Low | voi.ci call keys | The call-key room join has no nonce: a captured join is replayable for its callId within ±10 min (unsigned `decline` then ends the call) |
| F7 | Low | SCIM server | PATCH applies operations to the live in-memory object before validating them all; a 400 leaves a half-applied patch that the next save persists. PUT/PATCH can also give two users the same `userName` |
| F8 | Low | Directory engine | An IdP user with `externalId: "__proto__"` (or `constructor`) makes `links[...]` return a prototype; `entryFor` then throws, aborting every sync of that connector |
| F9 | Low | SCIM wiring | The audit counter key embeds `resource` (the raw first path segment) and is unbounded until the 15-minute flush; it lands verbatim in an Activity line |
| F10 | Info | Retail claim helper | Root's re-check of `retail-first-boot` adds nothing against a compromised claim service: claim state, marker and recipe live in the claim user's own folder and the recipe is self-signed (`verifyClaimRecipe(t, 0)`) |
| F11 | Info | keyd parity | Rust refuses a binding `"v": 1.0` (as_u64) that TS accepts (`b.v !== 1`); Rust is stricter, so it fails closed only |

No Critical or High findings.

---

## F1 (Medium): cross-account revocation of a voi.ci call key

**Scenario.** Alice binds call key K (its public half reaches every caller in `answer.callKey.binding.callKeyPub`). Mallory, who has her own voi.ci page,
calls Alice once to learn K, then POSTs `/api/accounts/mallory/voici-call-key/revoke` with
`{revoke:{username:"mallory", deviceId:<any>, callKeyPub:K, revokedAt}, signature: Ed25519 by mallory's ownerSignPub}`.
`verifyVoiciCallKeyRevoke` checks only `r.username === "mallory"` and the signature under Mallory's own page key, so it passes.
`revokeCallKey` inserts `(call_key_pub=K, username=mallory, ...)` into `voici_call_key_revocations`, and `isCallKeyRevoked(K)` is global. Alice's locked
device can then never join (`authorizeVoiciCallKeyDevice` returns null) and the same key can never bind again (`putCallKey` refuses). The clients
do not notice; "Answer calls while Flagship is locked" silently stops working. Repeatable for every new key Alice binds.

**Where.** `packages/control-plane/src/voiciCalls.ts:534-546` (route), `:574` (global check); `packages/storage/src/voiciCalls.ts:210-219` (D1),
`:307-313` (in-memory).

**Fix.** Accept a revocation only for a key bound to that account: look up `getCallKey(u, r.deviceId)` and require `callKeyPub` to match (or a
revocation row keyed `(username, callKeyPub)` and checked per account). Keep the self-signed path, but key the stored revocation to the
username the binding names. `isCallKeyRevoked` should take the username too.

**Test.** `packages/control-plane/tests/voiciCallKeys.test.ts`, "review-cloud: another account's owner key cannot revoke alice's call key
(cross-account DoS)", commit `037423994`. Fails: `expected null not to be null`.

## F2 (Medium): prototype pollution in the SCIM server

**Scenario.** The holder of the connector's bearer token (the IdP, or whoever got the token) sends
`PUT /scim/v2/Users/__proto__` with `{"userName":"x"}`. `data.users["__proto__"]` is `Object.prototype` (the data is a JSON.parse'd plain object), so
`Object.assign(u, {...}, f, {lastModified})` writes `userName`, `active`, `displayName`, `externalId`, `givenName`, `familyName`, `emails`,
`lastModified` onto `Object.prototype` of the daemon process; then `userJson` throws `RangeError: Invalid time value` out of the handler.
`PATCH /scim/v2/Groups/__proto__` succeeds (204) and writes `displayName` (and with a `members` op, `members`) onto the prototype. Every object in the
daemon now inherits these keys until restart: option bags (`opts.active`), `"members" in value` checks, `?? default` reads.
`/Users/constructor` etc. crash the same way.

**Where.** `packages/server-daemon/src/directory/scim.ts:343` (`data.users[id]`), `:355` (`Object.assign`), `:397` (`data.groups[id]`), group PATCH/PUT
below it.

**Fix.** Use `Object.hasOwn(data.users, id)` (and groups) before indexing, or keep the stores as `Map`s / `Object.create(null)`; refuse ids that are
not the server's own format (`^[0-9a-f]{32}$`). Same in `engine.ts` for `links`/`users` keyed by `externalId` (F8).

**Test.** `packages/server-daemon/tests/directory.test.ts`, "review-cloud: PUT/PATCH /scim/v2/Users/__proto__ and /Groups/__proto__ are 404 and pollute
nothing", commit `649bcdc29`. Fails with `put: "threw Invalid time value", patch: 204, leaked: [userName, active, displayName, externalId, givenName,
familyName, emails, lastModified]`. The test deletes the polluted keys in `finally`.

## F3 (Medium): `.com` can link a directory person to any seat

**Scenario.** Ana (pending id P) was proposed for an invite. `.com` serves `GET /proposals` with `{bundle: <Ana's proposal>, decision: {statement:
{decision:"done", refSha256: sha(invite)}}}` and `GET /seats` with an invite naming seat M (someone else, present in the pinned seat book). Neither
carries an org approval, and `linkSeats` reads only `decision.statement` and `invite.seatId`. The box links Ana to M. When the IdP disables Ana the box
signs and posts "offboard M", sealed to the admins with Ana's entry; renaming Ana produces an "entry-update" for M carrying Ana's names. An admin
approving what reads as "offboard Ana (disabled in Entra)" removes M. The comment "`.com` alone cannot link a person to a seat" holds only for seats
outside the book.

**Where.** `packages/server-daemon/src/directory/connector.ts:202-228` (`linkSeats`; `:212` invite hash map, `:220` decision read).

**Fix.** Verify the decision's org approval (`canonicalOrgProposalDecision`, one org admin under the pinned chain, `verifyOrgRecordedApprovals`) and
the invite's approvals before linking, and require the decision's `proposalId` to be this proposal's. Note the existing test "opens its sealed setup
... links a seat once an admin carried out the invite" serves an unapproved decision and invite; it must gain real approvals with the fix.

**Test.** Same file, "review-cloud: an unapproved decision and invite served by .com do not link a pending person to an existing seat", commit
`649bcdc29`. Fails: received `[["offboard", "6161…61"]]`, expected `[]`.

## F4 (Medium): keyd adopts a CGK approved under a superseded authority record (TS and Rust)

**Scenario.** keyd's stated rule is "never on the daemon's or `.com`'s word". It looks up the approval's record as
`records.find(r => r.version === ring.oarVersion)`, any record of the chain it is handed, and stores no chain head (only `cgkVersion`). So:
1. With the full chain [v0, v1], a ring approved under v0 is adopted (the test).
2. Worse: admin X removed by a later direct record (v1, the offboarding the CGK rotation is meant to answer) signs ring version `held+1000`,
   `oarVersion` = a record where X was admin, sealed to the box, key chosen by X. A daemon (compromised, or fed by `.com`) hands keyd the chain truncated to
   that record. keyd verifies it from genesis, adopts X's key and writes `cgkVersion = held+1000`, so every legitimate rotation is now "stale" until the
   next boot ceremony. X can read and forge the box's gossip; the box is cut off from the org's.
keyd also never checks `prevSha256` linkage between ring versions or approval `notAfter` against `now`.

**Where.** `packages/keyd/src/orgCgk.ts:262`; `rust/crates/flagship-keyd/src/org_cgk.rs:764`. Same in both, so no parity split.

**Fix.** Pin in `org.json` the newest authority version and hash keyd has verified; refuse a chain that ends below it (or forks from it); require
`ring.oarVersion` to be the chain head (or at least require the approval's `issuedAt` to be before the next record's `issuedAt` and the signer to be
an admin of the head). Bound the version step (`ring.version === held + 1`, or check `prevSha256` against the held ring's hash).

**Tests.** `packages/keyd/tests/orgCgk.test.ts` "review-cloud: refuses a CGK ring approved under a record older than the newest one it was shown"
(fails: `expected 'adopted' to be 'stale-oar'`) and `rust/crates/flagship-keyd/tests/org_cgk.rs`
`review_cloud_refuses_a_ring_approved_under_a_superseded_record` (fails: `left: None, right: Some("stale-oar")`). Both read the fixture
`rust/crates/flagship-keyd/tests/fixtures/review-cloud-superseded-oar.json` (case 0's ring with `oarVersion: 0`, re-signed by the founder with
`signOrgApproval(..., {deterministic: true})`). Commit `9b99f84ce`.

## F5 (Medium): audit export can drop or roll back box log heads

**Scenario.** The log names each stored head (`box-log-head`, ref = sha of the canonical head) and each registration (`server-registered`). The
admin's export approval covers the log head, not the object list. `verifyOrgAuditExport` only runs `need()` over objects present, adding to
`unlogged` those the log does not name; a log ref whose object is absent is never reported. A malicious `.com` serves the signed log with
`servers: []` and `boxLogHeads: []`: verifies, `unlogged` empty, no heads, and the CLI's "server that sent none" warning cannot fire (no servers
listed). Keeping an older head (h1, seq 10) and serving it instead of h2 (seq 20) also verifies, so a box's rewrite of entries 11..20 goes unseen.
That is the property the commit claims ("a later copy ... either extends the signed head or shows it was rewritten").

**Where.** `packages/protocol/src/orgAudit.ts:250-279` (`refs` / `need`, servers and heads loops).

**Fix.** Every `server-registered` and `box-log-head` log ref must resolve to an object in the export (carry every logged head, not only the newest,
or put `serverDomain|seq` into the logged ref so the verifier can check the served head is the last one logged per server). Report or throw on
logged-but-missing.

**Test.** `packages/protocol/tests/orgServersVectors.test.ts`, "review-cloud: an export whose log names a box-log-head but carries no head (nor the
server) is flagged", commit `9bd5fef61`. Fails: `expected false not to be false`.

## F6 (Low): replayable call-key join

`authorizeVoiciCallKeyDevice` (`packages/control-plane/src/voiciCalls.ts:572`) checks the P-256 join over `username|callId|deviceId|callKeyPub|issuedAt`
within ±10 min but uses no nonce (the device-header path does, through `D1NonceStore`). Anyone holding a copy of the join headers (TLS terminator,
logs) can open a device socket for that call and send the unsigned `decline`. Fix: record `(callKeyPub, callId)` or the signature in the nonce store.
Not tested (needs a header capture to matter).

## F7 (Low): non-atomic SCIM PATCH, duplicate userName

`scim.ts` PATCH loops `patchUser`/`patchGroup` on the stored object and returns 400 at the first bad op, leaving earlier ops applied in memory
(`load()` returns the live object from the wiring's map); the next successful request saves them. POST checks `userName` uniqueness, but PUT and PATCH do not.
Fix: patch a clone and swap it in on success; check uniqueness on every write.

## F8 (Low): `externalId` used as a plain object key in the engine

`engine.ts` `links[user.externalId]` with `externalId: "__proto__"` returns `Object.prototype`. `entryFor` gets `pendingId: undefined` and
`canonicalOrgDirectoryEntryBody` throws, so the whole `sync` for that connector fails every time. An IdP user (or a SCIM POST with that `externalId`)
blocks the connector. Fix as F2 (`Map` / `Object.hasOwn`).

## F9 (Low): unbounded SCIM audit counter

`wiring.ts` counts `${method} ${resource} ${status}` where `resource` is the raw first path segment; a token holder can create unbounded keys until the
15-minute flush, all written into one Activity line. Fix: map `resource` to a closed set (`Users|Groups|...|other`).

## F10 (Info): retail claim helper's re-check

The privd `retail-claim` profile itself is tight: only `op: "setup"` with `step` in {`retail-wipe`, `retail-first-boot`}, `noExtra`, a fixed argv
(`node .../setup.js <step>`), and no other ops. Its unit is root, socket `0660 root:flagship-claim`, `NoNewPrivileges`, env scrubbed, conditioned
off once `first-boot-done` exists. However `setup.ts:247-258` re-checks only state the claim user controls: `/var/lib/flagship-retail` is chowned to
`flagship-claim` (claim unit `ExecStartPre`), so `claim-state.json`, `reset-marker.json` and `claimed-recipe.json` are all the claim service's word,
and `verifyClaimRecipe(t, 0)` verifies a recipe under the account key the recipe names (self-signed). A compromised claim service (the BLE-facing
process) can therefore always reach the wipe and a first boot with a recipe for any account. That is no more than it can already do as the claim's
decider, unless the recipe→bootstrap engine has an injection path into the root-run bootstrap. I did not audit the preseed engine. Suggest the doc
stop calling the root re-check a defence against the claim service, or bind the recipe to the receipt `.com` signed at claim.

## F11 (Info): keyd binding `v` number form

`org_cgk.rs` `admin_key` requires `v.as_u64() == Some(1)`; TS `adminKey` accepts any JSON number equal to 1 (`1.0`). The direction is Rust refusing
what TS accepts (fails closed). Align with `safe_integer` if strict parity matters.

---

## Checked and found sound

- **voi.ci canonical bytes** (`binding`, `revoke`, `join`, `answer`, `end`, `allow`, `receipt`): every field is a fixed-charset value (username
  `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, 32-hex deviceId, 130-hex SEC1 point validated on-curve, lowercase-hex ids, safe-integer times, enum
  side/reason/op). The SDP is hashed, `turnSecret` hashed, `media` an enum appended only when present. No field can carry `|`; no field-shift.
- **Parity TS / Swift / Kotlin** for call-key canonicals: same tags, field order and validators (Swift `isUsername` is equivalent to the regex; Kotlin
  `Regex.matches` is a full match; all three check the point on the curve). All three P-256 verifiers accept high-S (TS `lowS:false`, Swift folds S,
  BouncyCastle). Only TS verifies answers carrying `callKey`; the native apps only sign them.
- **Room authority**: a call-key peer's answer must be signed by the key `.com` checked at join (`ctx.callKeyPub`), and an owner-signed answer from
  that peer is refused; an account-key peer cannot present a call-key answer (deviceRef mismatch). Owner end by call key only after that key won.
  `x-voici-call-key-pub` is stripped from client headers before the room sees them.
- **Join authorization**: fresh signature, a stored binding that equals the presented key, not revoked, the binding re-verified under the page's
  *current* ownerSignPub (rotation kills old keys), and the device still an admin device under the admin root.
- **Binding route**: device-header auth for the same deviceId, admin check, createdAt within skew, signature under the current page key.
- **Org directory entry canonical** (`orgDirectory.ts`): free text is base64url, groups comma-joined base64url, strict canonical re-encode on parse,
  NFC/control/size checks; AAD binds org, entry, key version, bucket. No field shift.
- **LDAP pull**: the filter is the admin's configured `userFilter` only (no user input interpolated), `ldaps://` required outside tests, Node TLS
  defaults (certificate and hostname verified), read-only bind/search/unbind, bind password never logged (error text has `@` tokens masked).
- **SCIM auth**: SHA-256 of the bearer token compared with `timingSafeEqual`, token 16-512 non-space chars, body cap 256 KiB, filter parser limited
  to `eq` on two attributes with an in-memory compare (no injection surface), host header sanitized before reflection.
- **keyd chain replay (TS vs Rust)**: same genesis rule (all admins consent, pinned hash), direct-only transitions, newcomer consent under the new
  version, ordinary approvals under the previous record's keys, removed signers and non-`admin` kinds refused, bylaws/founder changes need the
  strictest threshold, record shape (thresholds, floor, overturn set, duplicate seats/keys) and the canonical/admins/bylaws hashes built identically;
  ring canonical, recipient hash (sorted `recipient:kemKeyId:sha(sealed)`), commitment string, constants (skew 5 min, lifetime 7 d, k max 7, 32 admins,
  256 recipients, 8192 hex) all match. The shared vectors pass on both sides. `org.pin` needs the ceremony token (Rust compares in constant time; TS
  uses `Buffer.equals`, not constant time, Info) and cannot be repinned to another org.
- **Box log head**: canonical has hex/domain/uint fields only; `.com` checks STK under the registration, refuses older/forked heads, logs each one;
  the export verifier checks each served head under the registered key and refuses a head of an unlisted server.
- **privd retail-claim profile**: see F10; no op other than the two setup steps is reachable, args are closed, and the exec is fixed.

## Not checked

- Native Swift/Kotlin builds and tests (not buildable here; I read the code). The Gradle unit tests were not run.
- The voi.ci frame layer and SDP rules beyond a read (`checkVoiciCallSdp` uses `lines.find` over the whole SDP for opus/fmtp, not per section; I did not
  turn this into a concrete issue).
- The preseed engine's recipe→bootstrap path for root injection (F10), `retailWipeAsRoot` internals, and the BLE claim protocol.
- The admin consoles' rendering of proposals (how misleading F3's proposals look in practice).
- `.com`'s org proposal/decision routes (whether `.com` itself verifies decisions; F3 assumes `.com` is not trusted, as the design says).
- Full vitest and cargo suites (only the touched files were run: control-plane voiciCallKeys, server-daemon directory, keyd orgCgk, protocol
  orgServersVectors, Rust `flagship-keyd --test org_cgk`).
