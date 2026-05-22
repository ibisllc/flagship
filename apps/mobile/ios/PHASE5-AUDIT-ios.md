# Phase 5 — never-404 audit (iOS)

**Principle (`docs/login-and-account-redesign.md`):** the sign-in / join
space is access-control evaluation, not a fetch — it must NEVER surface a
404. Every "absent" server state is a node in the decision tree, rendered
as a clean in-app STATE (guidance copy), never a raw HTTP-error card or a
crash.

**Scope:** every network call in the iOS login / onboarding / join /
recovery / add-device flows. **Verdict: all clean.** No leftover error
cards on absent states were found; no fixes were needed. Hardening added
consolidated decision-matrix conformance tests (below).

## Network calls audited (flow → call → absent-state handling)

| Flow / ViewModel | Network call | Absent-state handling | Verdict |
|---|---|---|---|
| `LoginViewModel.submit` (Join username-first) | `resolveAccount(username:)` → `GET /api/account/resolve/<u>` | Worker + Mock return **200 always**; a missing account decodes to `kind:"unknown"` → `.resolved(.unknown)`. A non-2xx is treated as a transport outage → `.failed` (retry copy), and is **never** conflated with `.unknown`. | CLEAN |
| `JoinUsernameScreen` | (renders `LoginViewModel`) | `unknown` renders the inline `join-unknown` STATE card ("No Flagship account by that name") — not a field error, not a 404. | CLEAN |
| `RealAccountLoginViewModel` (single/multi takeover) | `fetchRecoveryEnvelope(credentialId:)`, `initiateRePair`, `completeRePair` | `recovery.present == false` short-circuits to the `.noRecovery` STATE **before any call** (no fetch ⇒ no 404). A missing envelope on a present-recovery account → `humanizedRecoveryError` clean message ("…use a device that still has access"). `completeRePair` 404 = already-swapped ⇒ treated as `.finalized` success; 425 = stay-in-grace; 403/409 = objected. multi 401 (rejected 2nd factor) → clean retry copy. | CLEAN |
| `RealAccountLoginScreen` | (renders `RealAccountLoginViewModel`) | `.noRecovery` renders the `login-no-recovery` STATE (single vs multi copy); only action is Back. Takeover failures render `login-takeover-error` inline copy. | CLEAN |
| `OpenAccountViewModel.openAccount` (Create path) | `claimUsername(...)` → `POST /api/username/claim` | Claim is **idempotent** (Live accepts 200/201/204/409). Not a lookup — it's an account-mutation, so a real failure surfaces a `.failed` message (correct; there is no "absent" state to render here). | CLEAN |
| `ChooseUsernameViewModel.evaluate` (Create path) | `usernameAvailable(_:)` → `POST /api/users/check` | A network failure falls back to a permissive label STATE (`networkFallbackAvailable`) so the screen still moves; `already claimed` → `.taken` STATE; other reasons → `.invalid(reason)` STATE. Never an error card. | CLEAN |
| `AddDeviceViewModel` (admin QR pairing) | relay only (`adminAwaitDevicePubkey`, `adminDeliverBundle`) | Relay failure → `.failed("Pairing didn't complete…")` STATE; TTL/screenshot → `.invalidated` STATE. No HTTP lookup; no 404 surface. | CLEAN |
| `JoinAccountViewModel` (incoming QR pairing) | `admitDevice(account:body:)` → `POST /api/users/<u>/devices/admit` | Malformed/forged bundle → clean STATE messages; admit username mismatch is a **403 gate** (mirrors Worker), surfaced as a clean join failure. `quarantineUntil` from the admit response drives the countdown — not an error. | CLEAN |
| `SettingsViewModel.loadTrustedDevices` / `disconnect` (device-list mgmt) | `listDevices`, `revokePushToken` | List failure → `LoadingState.failed` (a rendered banner, not a crash). `disconnect` reverts optimistically on failure; `revokePushToken` 404 = success (already gone). A future `quarantineUntil` ⇒ `TrustedDevice.isQuarantined()` ⇒ destructive menu DISABLED + clock indicator + tooltip toast (no 404, no destructive call attempted). | CLEAN |

## Why no fixes were required

The Phase 0–4 work already established the never-404 architecture:

- The preflight (`/api/account/resolve`) is **200-always** on both the
  Worker (`packages/control-plane/src/accountResolve.ts`) and the iOS
  Mock; the Live client only raises on a genuine non-2xx (a 5xx outage),
  which is the correct distinction between "no such account" (a state)
  and "couldn't ask" (a retryable failure).
- Every credential-absent fork (`recovery.present == false`,
  no-second-factor, no-envelope) resolves to a rendered branch/state
  **before** any network call that could 404.
- The mutation paths (claim, admit, re-pair) are idempotent or treat the
  relevant 404s as success, so a "missing" record never becomes a hard
  error card.

## Conformance tests added

`Tests/FlagshipMobileTests/LoginDecisionMatrixConformanceTests.swift`
(16 tests) — the consolidated contract for the full `AccountResolution`
decision matrix:

1. `resolveAccount` **never throws** for an absent account (Mock wire +
   router); a 5xx outage is `.failed`, never `.unknown`.
2. **demo** → `.demo` outcome → sandbox activates.
3. **unknown** → clean `.unknown` STATE (no error).
4. **single + recovery** → `.realAccount` → `.singleTakeover` (7d).
5. **multi + recovery** → `.realAccount` → `.multiTakeover` (24h-TOTP);
   empty second factor fails cleanly with no re-pair initiated.
6. **recovery.present == false** (single AND multi) → `.noRecovery`
   STATE; `startTakeover` is a no-op (no network call) on that branch.
7. **quarantined device** → `isQuarantined()` gates Remove; admit returns
   the 14-day deadline that drives the countdown.
8. The **full matrix** is walked from a single table so any routing
   regression names the offending cell.
9. **Mock-matches-Worker-wire**: each kind's Mock output decode-equals
   the Worker's `AccountResolution` JSON shape (demo / unknown / multi),
   and the admit username-mismatch 403 gate mirrors the Worker.
