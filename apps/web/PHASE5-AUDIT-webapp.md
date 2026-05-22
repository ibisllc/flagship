# Phase 5 — never-404 login audit (webapp PWA)

The login / join space is **access-control evaluation, not a web fetch**
(`docs/login-and-account-redesign.md`, "The principle"). A raw `404` here
is a category error: every "absent" server state MUST render a clean
in-app **STATE**, never a raw error / unhandled throw.

This audit walks **every network call** in the webapp
login/onboarding/join/recovery/add-device flows and records its
absent-state handling. **Verdict: all flows are clean — no genuine gaps
were found.** The Phase 0–4 work already implemented never-404 across the
board; Phase 5 adds the consolidated decision-matrix + never-404
conformance tests
(`apps/web/tests/webappLoginNever404Conformance.test.ts`) that pin the
whole contract as one matrix so a regression fails loudly.

## The preflight (the keystone)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| `GET /api/account/resolve/<u>` | `lib/accountResolve.js` `resolveAccount` | **200-always**; a miss is `kind:"unknown"` in the body. `429`→rate-limit message; non-2xx→thrown transport error. A literal `404` would be a deploy/route fault, NOT a missing account. | CLEAN |
| branch on resolution | `views/bootstrap.js` `handleRecover` → `classifyResolution` | `unknown`→`showNoSuchAccount` (inline STATE). `demo`→`joinDemo`. `single`/`multi`→`recoverRealAccount`. A `resolveAccount` throw is caught and toasted as "couldn't reach the directory" — a transport STATE, never "no such account". | CLEAN |

## Demo branch (special-case recovery; crypto no-op)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| (none) | `lib/accountResolve.js` `activateDemoAccount` | Demo join touches **no** credential network call — the username is the capability. Mints a fresh device key, persists the profile, unlocks, opens. No 404 surface exists. | CLEAN |

## Real-account login (single / multi takeover)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| (recovery presence) | `lib/loginTakeover.js` `classifyRealAccount` / `noRecoveryState` | `recovery.present == false`→a clean inline STATE (single: "use a device that still has access"; multi: "use another device, or one of your recovery codes"). No network call is made for the no-recovery branch. | CLEAN |
| cloud unwrap (popup) | `lib/recovery.js` `recoverFromCloud` (injected) | Sub-origin popup ceremony; rejects with a readable error on cancel/timeout/malformed payload. Surfaced as a toast by `recoverRealAccount`. Not a 404 surface (the account existence was already established by the preflight). | CLEAN |
| `POST /api/users/:u/re-pair` | `lib/loginTakeover.js` `initiateRePair` | Throws on non-2xx — but this fires only AFTER the user confirmed a takeover on a recovery-present account, so a 4xx is a genuine server rejection (e.g. multi missing `totpProof`), surfaced as a toast. Not an absent-state. | CLEAN |
| `POST /api/users/:u/re-pair/complete` | `lib/loginTakeover.js` `completeRePair` | **Every absent state is a tagged outcome, never a throw:** `404`→`already-completed` (swapped earlier / swept), `403`/`409`→`objected`, `425`→`too-early`. Only a genuine `500` throws. | CLEAN |

## Open-account (decoupled from server provisioning)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| `POST /api/username/claim` | `lib/openAccount.js` `claimUsername` | **`409` (name already bound to this IRK) is treated as SUCCESS** (`alreadyClaimed:true`) — idempotent on retry / legacy create-path. Other non-2xx throw. | CLEAN |

## Cross-device pairing (collaborator add / join)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| `GET /api/users/:u/pubkey-cert` | `lib/crossDevicePairing.js` `fetchAccountIrkPubHex` | Throws a readable error on non-2xx. This runs only AFTER a SAS-verified relay handshake (the account is known to exist); a 404 here is a genuine mid-pairing anomaly, rendered by `views/join.js` as an in-view error STATE (`setStatus("error", …)`), never an unhandled crash. | CLEAN |
| `POST /api/users/:u/devices/admit` | `lib/crossDevicePairing.js` `postDeviceAdmit` | Throws on non-2xx; `views/join.js` renders it as an in-view error STATE. | CLEAN |
| admit response → quarantine | `lib/crossDevicePairing.js` `quarantineTimeline` | A vouched device joins QUARANTINED; the incoming side surfaces a countdown. A missing `quarantineUntil` falls back cleanly (no throw). | CLEAN |
| (admin generator) | `views/add-device.js` `runAdminAddDevice` | Relay-driven; cancel/fault surface via `setStatus`. No raw HTTP surface. | CLEAN |

## Recovery settings (in-account; not the login space, audited for completeness)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| `GET /api/recovery/by-username/:u` | `lib/recovery.js` `hasCloudRecovery` | `r.ok` → presence; non-ok (incl. 404) → `false` (absent is a state, not an error). | CLEAN |
| `GET …` then `DELETE …` | `lib/recovery.js` `deleteCloudRecovery` | `404`→`{ deleted:false }` (benign already-gone). Other non-ok throw. | CLEAN |

## Settings: trusted devices (in-account management; not the login space)

| Call | File | Absent-state handling | Verdict |
|---|---|---|---|
| `GET /api/users/:u/devices` | `views/trusted-devices.js` `fetchDevices` | Non-ok throws, but the caller renders it as an in-card error STATE (`err-text`), not an unhandled throw. The empty-list case renders a "just this device" STATE. | CLEAN |
| `DELETE /api/push/<tokenId>` | `views/trusted-devices.js` `disconnectDevice` | **`404` is treated as benign** (already gone); other non-ok throw and toast. Quarantined rows render a disabled Disconnect + countdown. | CLEAN |

## Conformance tests added (Phase 5)

`apps/web/tests/webappLoginNever404Conformance.test.ts` — 25 tests, run
against the **shipped JS** modules:

1. **AccountResolution decision matrix** — `classifyResolution` /
   `classifyRealAccount` over the full kind set; `graceModel` fixture
   parity with the server projection.
2. **Preflight never-404** — a 200 `unknown` is a STATE; a literal 404 /
   429 / 5xx is a transport STATE distinct from a missing account.
3. **demo → activate** with zero credential network calls.
4. **recovery.present == false → clean STATE** (single vs multi copy),
   no network.
5. **single (7d) vs multi (24h, TOTP-gated)** takeover matrix.
6. **re-pair complete** — `404`/`403`/`409`/`425` each → a tagged
   outcome; only `500` throws.
7. **open-account claim** — `409` → success.
8. **quarantine countdown** view-model (added device).
9. **cross-device admit faults** surface as readable errors (rendered as
   join STATES).
