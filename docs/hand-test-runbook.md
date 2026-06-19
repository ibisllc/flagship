# Hand-test runbook

> A structured tap-by-tap pass for the owner's on-device testing (2026-06-19). Ordered by RISK:
> the security ceremonies and the new gating are the least-proven, do them first. Each step lists
> the action + the EXPECTED result + what to watch. Capture a screenshot per step; log any dead
> control / wrong copy / crash. The automated gym is mostly mocked; this is the real e2e.

## Setup (one-time)
1. **Rebuild the apps** — iOS in Xcode (Archive or run on device), Android `:app:assembleDebug` / Android Studio. All session changes (gating v1+v2, parity, hardenings) are source-only.
2. **Get a v2 box** — either rebuild + re-sign the Mac burner (the daemon changes ship via the box recipe) and do a fresh encrypted burn, **or** provision a fresh demo box (it clones `main`, so it already has v2 gating + the box-as-authority + manifest fixes). Reuse the spare hardware if burning.
3. **Live client** — 3-tap the Welcome box → flip to the live client → point at the box.
4. Have **two devices** ready (iOS + Android ideally) for the multi-device + cross-platform flows.

---

## A. Account + recovery — DO FIRST (it gates the destructive ops)
1. **Create account** (account-name-first; account ≠ server). → Lands in the shell; no 404 on a fresh name.
2. **Enroll Cloud Recovery** (WebAuthn-PRF / passkey). → Enrolled; the tier-2/3 session actions ungrey. (Sign-out is BLOCKED until recovery exists — verify the greyed action shows the "set up recovery" toast, not the destructive path.)
3. **Recovery keyfile export** — Settings → export. → A client-side argon2id+AES-GCM `.flagshipkey` downloads.

## B. Server lifecycle
1. **Create server**, **Encrypt disk ON** (default). → Burn (or demo) → install ladder advances → registers → **green padlock** at `https://<server>.<user>.flagship.services/`.
2. **Front page** — assign an installed service to the apex. → Apex 302s (no-store) to the service's tier-1; clear the assignment → the default Flagship card.
3. **Decommission a failed/extra server**. → Frees the name; the row leaves Home.

## C. Security ceremonies — HIGHEST RISK, focus here
1. **Add a device (pairing)** — Settings → Add device → pairing QR + SAS on the new device. → SAS matches both ways; no-screenshot warning shows; the device appears in Trusted devices.
2. **Replace device / re-pair** — initiate from a new device; complete after grace. → The finalize ceremony (countdown + Complete) runs; the pending-re-pair banner shows; on completion the old key is rotated out.
3. **Single-device takeover** (keyfile-import recovery) — import the recovery keyfile on a fresh device. → A *rotated*-key recovery lands in re-pair-with-grace; an unrotated one pairs instantly. (Watch: the IRK must rotate — this was the #86 parity bug; confirm the recovered key ≠ the old registered key.)
4. **Phone-approval unlock** — reboot the box; on the phone, the boot-unlock Approve card surfaces (Home, top). → Check (Face ID) finds the request → Approve (Face ID) → box unlocks + comes online. (The least-proven path historically — watch the `awaitingUnlock` "waiting for approval" state, not "never came online".)
5. **Lock & power-off / dead-man** — "Lock and turn off"; arm the dead-man, let it lapse. → Confirm + biometric → box powers off; the dead-man lapse triggers the policy.
6. **Wipe & restart** (tier-2 lock-with-passkey) — only with recovery enrolled. → Local key+data erased; restore via recovery passkey.

## D. Services + the NEW gating — the part automation couldn't reach
1. **Install a service** — build-a-service → **vibe (chat-guided, NOT one-shot)**: give a prompt, answer the AI's questions in chat, Deploy. → Serves HTTP 200 at `<label>.<server>.<user>`. (Or git-import a Flagship-fit repo + Install.)
2. **Restrict it** — service-detail → Access → toggle open ⇄ **restricted**. → Status line reflects it; an anonymous visit now 403s / shows the knock page.
3. **Invites — the 3 tiers** (each: assign a name/label, get a link/QR):
   - **Personal auto-approve** → send the link → **redeem on a SECOND device** (different account) → that device reaches the restricted service.
   - **Personal manual-approve** → friend redeems → **pending** → friend's app emits an *acceptance reply* (link/QR) → send it back → author **opens it to finalize** → friend gets in. **Try finalizing from a DIFFERENT author device than the one that created the invite** — it should work (any-device, the box re-fetches the create).
   - **Group / multi-use** → set max uses (e.g. 3) + optional expiry → two+ friends redeem the SAME link → the guest list shows ONE "`<label>` — k/N" entry → **group-revoke** kicks them all.
4. **Web-experience (QR-login)** — open the restricted service in a **desktop browser**. → A knock page (QR + "Access site"). Scan/authorize on the phone → the browser transitions into the content. Settings → **"Open secured sessions"** lists it (site / browser / start) → **Stop** → the browser is locked out again.
5. **Remove a person** → their next visit is denied (the box prune, not just the `.com` revoke).
6. **Cross-platform interop** — mint an invite on **iOS**, redeem on **Android** (and vice versa); same for an acceptance reply. → The link/reply parses on the other platform (canonical `<secret>&a=&i=`).
7. **Privacy check** — confirm the author NEVER sees the friend's Flagship username anywhere — only the label the author assigned (or the group label).

## E. Existing matrix — smoke pass
Admin device-grants (grant/revoke a scope), **View journal** (Diagnostics card → owner-signed → log lines), AI-keys manager (add/delete, masked slug), the active-operations teal sliver (deploy/build), cert card, PIN lock (webapp), the maintainer-trust sliver.

## Known gaps / what to expect
- **Push / notifications won't arrive** — no store presence yet (TestFlight/Play is P2). The in-app long-poll→local→sliver path is the testable surface.
- **Maintainer-trust sliver** may show RED in the gym/dev env (the gym maintainer-blessing isn't fully stood up) — expected, not a regression.
- **One-shot vibe** is flaky; use the **chat-guided** build for a reliable serving service.

## Capture
Screenshot every step; for each flow note: ✅ works · ⚠️ works-but-rough (copy/affordance) · ❌ dead/crash. File issues per ❌/⚠️ with the screenshot + the step number.
