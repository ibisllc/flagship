# Gym recipe → Hetzner pipeline (sim-to-box e2e)

**Goal (owner-directed):** the *real app* (browser/simulator), pointed at the gym,
composes + signs a server **recipe** (InstallBlob), sends it to a gym **service**
that provisions a Hetzner box **from that recipe**, the box comes online **owned by
the app's IRK**, and the app drives **all its features** against the box. Then
multiple app surfaces join one account (companion/add-device) and run features in
parallel; plus multi-account-on-a-device. This doc is the spec; it survives
context compaction.

## Why the recipe model (identity, solved)
A box built from the app's own signed recipe is owned by the app's IRK **by
construction** — no demo-IRK, no client-side trust backdoor:
- `InstallBlob` (`packages/protocol/src/installBlob.ts`) embeds an `AuthCode`;
  both are **signed by the device IRK**. The box's owner IRK = `authCode.userPubKey`
  (cloud-init writes it to `config.json: irkPublicKey`, `demoUsersAdminCloudInit.ts:434`).
- The app mints + self-signs the AuthCode locally, records it via
  `POST /api/auth-code/issue` (`authCode.ts:handleAuthCodeIssue`, verified against
  the username's registered IRK), then signs the InstallBlob. **No booted box / relay
  needed** to produce a valid signed blob (the QR relay is only AEAD transport).
- The box registers via `serverRegister.ts:handleServerRegister`, which verifies +
  consumes the AuthCode → records the server under the owner's account.

## The entitlements constraint (the one hard part)
The daemon **requires** an IRK-signed entitlement bundle to boot
(`runtime.ts:779`, N12b, fail-closed). It binds the box's *boot-generated* identity
to the owner IRK, so it can only be signed *after* the box exists, by the IRK holder.
- **Demo path** ships the demo IRK priv to the box → box self-mints (the IRK priv is
  KEK-derived, throwaway).
- **Prod path** = the **entitlement relay** (`entitlementRelay.ts`): box requests →
  app (phone) signs binding the box's presented identity → delivers. No IRK priv
  ever leaves the phone.
- **Gym MVP**: the app generates a *test* IRK; the gym provision endpoint accepts the
  app's test IRK priv and ships it to the box to self-mint (reusing the demo
  machinery). This is a **gym-only** affordance (endpoint gym-gated; the IRK is a
  test identity). Prod must use the relay. Document loudly; never enable on prod.

## Build phases
### Phase 1 — `POST /api/gym/provision` (backend, gym-gated) ← BUILD FIRST
Input: `{ installBlob, blobSignature, irkPrivHex (gym test), region?, size? }`.
1. Verify the username is registered; `verifyInstallBlob(blob, blobSignature, regIrk)`
   and `verifyAuthCode(blob.authCode, blob.authCodeUserSignature, blob.authCode.userPubKey)`.
2. Confirm `irkPrivHex`'s pubkey == `authCode.userPubKey` (the box self-mints with it).
3. Record the AuthCode (same validations as `handleAuthCodeIssue`; idempotent if the
   app already issued it).
4. Build cloud-config via `buildCloudConfigUserData({ installBlobJson, installerGitRef,
   demoUserIrkPrivHex: irkPrivHex })` — the EXISTING builder; it ships the IRK priv +
   self-mints entitlements. (Reuse `demoUsersAdminCloudInit.ts`; factor the
   provision core so it can take a caller-supplied blob+irkPriv instead of deriving
   demo material.)
5. Provision Hetzner (`deps.hetzner.createServerWithUserData`), attach the gym SSH key
   (`DEMO_PUBLIC_SSH_KEY_ID`) so the box is **debug-able** (root SSH).
6. Gate: gym env only (`env.CONTROL_APEX` is the gym apex / a gym admin secret).
Return `{ serverDomain, serverId, ipv4 }`. Reuses: hetzner client, authCodes storage,
the cloud-init builder. Box ends up owned by the app's IRK + serves a real LE cert
(the cert/DNS path now works post the quota + serve-502 + teardown fixes).

### Phase 2 — webapp gym-mode "provision on gym cloud" (gym branch)
In `views/create-server.js`, when running on the gym apex, after composing the recipe
(the real `cs-deliver` compose: mint+record AuthCode, sign InstallBlob), POST it to
`/api/gym/provision` with the in-memory IRK priv instead of (only) the QR relay.
Gym-branch only (never main). The real app thus drives the real provision.

### Phase 3 — e2e (Playwright, `apps/web/e2e/live/`)
Drive the real gym webapp: bootstrap → claim username → create-server form →
"provision on gym" → poll until the box serves (cert) → install a service through the
UI → assert it serves at its subdomain (the serve-502 fix). Then the owner ops
(journal/front-page) via the app. This is the sim-to-box slice.

### Later phases
- Companion/add-device: a 2nd surface joins the same account (`companionReceiver.js`),
  runs features against the shared box.
- Parallel surfaces (web + iOS + iPad + Android sims) — needs `GymLiveTests.swift`
  (absent) + Android live + sim orchestration.
- Multi-account-on-a-device.

## Status / fixes that unblocked this
- DNS quota (200/200 free cap) cleaned + **teardown now deletes a box's DNS records**
  (commit `7ae086a`, main) so it can't recur. Future: per-user wildcard DNS + a paid
  CF plan + a separate gym DNS zone (see the architecture take in chat / memory).
- **Serve 502 fixed** (`e61a55e1`): the app-proxy now publishes `host:manifestPort` +
  injects `PORT` — container-serve works (validated live).
- Gym boxes are **debug-able** (SSH key on root via `DEMO_PUBLIC_SSH_KEY_ID`).
- Apps trust the gym via the `gym` branch CA anchor (`gym` branch, proven).
