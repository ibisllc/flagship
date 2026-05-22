# Phase 5 — never-404 login audit (Android)

Audit of every network call in the Android login / onboarding / join /
recovery / add-device flows against the principle in
`docs/login-and-account-redesign.md`: **login must NEVER surface a 404 /
raw error for a missing-state; every "absent" is a node in the decision
tree.**

Verdict: **all flows already clean.** No genuine code gaps were found —
the Phase 1–4 work converts every absent server state into a rendered
in-app STATE. Phase 5 adds decision-matrix conformance coverage
(`LoginDecisionMatrixConformanceTest`, 16 tests) and this note. The one
audit edge that lacked an explicit test (a `recovery.present==true`
preflight contradicted by a server-side missing envelope) is now pinned.

## Network calls + absent-state handling

| # | Flow / file | Network call | Absent / "not found" handling | Status |
|---|---|---|---|---|
| 1 | `JoinAccountContainer.submit` | `resolveAccount(handle)` | `account/resolve` is **200-always**. `kind="unknown"` → `NoAccountView` STATE ("No Flagship account by that name"). `demo` → `DemoFixtures.activate`. `single/multi` → hand off. The `catch` block fires ONLY for a genuine transport error (renders an inline retry message, not a 404). | clean |
| 2 | `LoginViewModel.begin` | (consumes preflight) | `recovery.present==false` → `LoginPhase.NoCloudBackup` STATE (single vs multi copy), never an error. Does not open the account or call the server. | clean |
| 3 | `LoginViewModel.unwrapUmk` | `fetchRecoveryEnvelope(credentialId)` | Only reached when `recovery.present==true`. If the envelope is gone server-side (rare race), the 404 is caught → `LoginPhase.Failed` via `humanizedError` ("We couldn't find a recovery passkey…"), never a crash. **Now pinned** by `login_recoveryEnvelopeRace_landsOnFailedNotCrash`. | clean |
| 4 | `LoginViewModel.confirmTakeover` | `initiateRePair` | This is an ACTION (mutating the device key), not a lookup — a genuine failure correctly lands on `LoginPhase.Failed`. Multi gates on the second factor first (Worker 401s without `totpProof`); that 401 is humanized, not surfaced raw. | clean |
| 5 | `LoginViewModel.completeTakeover` | `completeRePair` | Action; genuine failure → `LoginPhase.Failed`. 425 (grace not elapsed) is gated by the UI (button disabled until countdown elapses). | clean |
| 6 | `OpenAccountViewModel.openAccount` (create path) | `claimUsername` | Idempotent: Live treats 409-same-IRK as success (`accept = {200,201,204,409}`); a real failure → `OpenAccountPhase.Failed` inline. No 404 path. | clean |
| 7 | `JoinDeviceViewModel.verifyAndJoin` | `getUsernameRecord`, `admitDevice` | Security-critical: a forged/wrong-key admit, a wrong-device binding, or a 401 from `.com` **fail closed** → `JoinDevicePhase.Failed` (humanized), and the account does NOT open. This is correct fail-closed security, not an absent-state masquerading as an error. Quarantine (`quarantineUntil`) is a STATE (countdown copy). | clean |
| 8 | `AddDeviceViewModel` (admin) | relay only (no `.com` lookup) | Relay-down / missing-IRK → `AddDevicePhase.Failed`. No account-lookup network call, so no 404 surface. | clean |
| 9 | `RecoverFromWelcomeContainer` (legacy) | `BlockStore` local read | NOT wired into `OnboardingFlow` anymore (superseded by `JoinAccountContainer` → `RealAccountLoginContainer`). Its local "no recovery passkey on this device" path is already a clean state. Left untouched. | clean (dead-on-the-login-path) |

## Invariants confirmed

- **`account/resolve` is 200-always.** Both `LiveFlagshipServerClient`
  (`getJson`, no error status to special-case) and `MockFlagshipServerClient`
  return a value for a missing account (`kind="unknown"`, zeroed factors),
  never an exception. A non-existent name returns the SAME shape as a
  miss so timing/shape don't distinguish them (matches `accountResolve.ts`).
- **A transport OUTAGE is distinct from a missing account.** A failed
  resolve throws (surfaces as a retry-able error); it must NOT masquerade
  as `kind="unknown"`. Pinned by
  `resolve_transportFailure_throws_isDistinctFromUnknown`.
- **Mock matches the Worker wire.** Field names + values for
  `resolveAccount` and `admitDevice` match `accountResolve.ts` and the
  admit handler in `push.ts` byte-for-byte (`graceModel` matrix:
  demo→`instant`, single→`7d`, multi→`24h-totp`, unknown→`none`).

## Conformance tests added

`app/src/test/java/com/flagshipserver/app/viewmodels/LoginDecisionMatrixConformanceTest.kt`
(16 tests, Robolectric) — mirrors the iOS `LoginViewModelTests` shape and
pins the full decision matrix as one cohesive contract:

- Layer 1 (`resolveAccount` tuple): demo→instant, unknown→none/zeroed
  (never throws), single→7d, multi→24h-totp, factor projection
  (recovery-present + trustedDeviceCount).
- Layer 2 (branch each tuple drives): demo→activate (1 device),
  unknown→clean state (no open), single→7d takeover→admin,
  multi→TOTP-gated 24h takeover, recovery.present=false→`NoCloudBackup`
  state (single + multi copy), admit→quarantine countdown,
  admit-rejected→fail-closed.
- Invariant A: transport-failure ≠ unknown; envelope-race → Failed (no
  crash).
- Forward-compat: an unknown future kind/grace parses to Unknown/None.

Pre-existing coverage that already pinned the matrix and is retained:
`AccountResolveTest` (wire decode + demo/unknown/single/multi),
`LoginFlowTest` (single/multi takeover state machine),
`DevicePairingFlowTest` (admit verify + forged-admit fail-closed).
