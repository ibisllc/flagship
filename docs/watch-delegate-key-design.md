# Watch delegate-key for opt-in quick approvals — design notes

**Status**: backlog (post-v1). Captured 2026-05-31 from a design
conversation; no implementation yet.

**Scope**: let the user approve a server boot (and possibly other
low-stakes operations) from the Apple Watch without an iPhone Face/Touch
ID prompt, while keeping the IRK private key fully biometric-gated for
everything else.

---

## 1. Why this exists

Today the Watch shows pending approvals (W1) + a complication for
install phase (W2), but the actual approve action requires the
iPhone:

1. Watch tap → WCSession message → iPhone.
2. iPhone needs the IRK out of the Secure Enclave.
3. IRK access control includes `.biometryCurrentSet`
   (Sources/Flagship/Keystore.swift:660-665) — biometric prompt
   on the iPhone fires every time.

If the iPhone is in the user's pocket, that prompt is awkward —
either the watch shows "tap continued on phone" (extra step) or the
approval just hangs until the user picks up the phone. The
conversation noted that this kills the otherwise-glanceable Watch
surface for boot approvals.

## 2. The naive option (and why we're not doing it)

Relax the IRK access policy from `.biometryCurrentSet` to
`.userPresence` (biometric OR passcode). Combined with "iPhone has
been unlocked since boot" (always true if WCSession can reach it),
this would let a Watch-driven sign succeed silently.

**Problems**:
- The flag is fixed at SE key creation. Changing it means rotating
  the IRK on every device that opts in.
- Relaxing the IRK gate weakens **every** sensitive operation
  (server revoke, wipe & restart, replace device, re-pair) — not
  just boot approvals. Single flag, wide blast radius.
- The IRK is the user's master signing identity. Loosening its
  access for one convenience feature compromises the security
  posture of operations that are genuinely destructive.

## 3. The accepted design — scoped watch-delegate key

Issue a **separate** signing key that:

- Lives in the iPhone Secure Enclave alongside the IRK, with a
  laxer access policy (`.userPresence`, NOT `.biometryCurrentSet`)
  so a Watch-driven sign succeeds without a fresh biometric prompt
  while the phone is unlocked.
- Is *itself* signed/attested by the IRK at creation — the cloud
  verifies the delegate's pubkey against an IRK-signed
  `WatchDelegateKey` envelope so the delegate's authority is
  cryptographically tied back to the user's master identity.
- Is **scoped to boot approvals only**. The cloud (and the
  daemon's `boot.flagshipserver.com` handler) refuses delegate-
  signed payloads for any other operation kind. Smaller blast
  radius — a compromised delegate key cannot revoke servers, wipe,
  or replace devices.
- Has a TTL (suggest 7 days, renewable) — limits the window of
  exposure if a watch is lost without the user realizing.
- Is revocable independently from the IRK. A "Stop allowing the
  Watch to approve" toggle drops the delegate's authority without
  touching the IRK.

## 4. UX surface

A single iPhone Settings toggle:

> **Quick approve from Apple Watch**
> When on, you can approve a server boot from your Watch without
> unlocking your iPhone. Your Watch must be on your wrist and
> unlocked. Other sensitive actions (revoke server, wipe & restart,
> replace this device) always require Face ID on iPhone.
> _Off by default._

When the user flips it on for the first time:
1. iPhone prompts Face/Touch ID to authorize the IRK to sign a
   fresh `WatchDelegateKey` envelope.
2. iPhone generates the delegate keypair in the SE under
   `.userPresence`.
3. iPhone POSTs the IRK-signed `WatchDelegateKey` to `.com` for
   registration.
4. Cloud stores it under the user's account with the scope flag
   + TTL.
5. Watch receives a state update via WCSession; the next approve
   tap uses the delegate-key signing path.

When the user flips it off:
1. iPhone POSTs an IRK-signed `RevokeWatchDelegate` to `.com`.
2. Cloud invalidates the delegate immediately.
3. Watch UI greys out the approve action; tap falls back to "Open
   on iPhone" (today's behavior).

The toggle should also auto-revoke on any of:
- IRK rotation (the new IRK doesn't sign the old delegate, so
  cloud-side verification fails naturally — but explicit revocation
  is cleaner audit trail).
- "Replace device" or "Wipe & restart" flow.
- A Watch unpair event from the iPhone Settings → Watch panel.

## 5. Threat model summary

| Threat | Without delegate | With delegate, opt-in |
|---|---|---|
| iPhone unattended + watch on wrist | Attacker can't approve from watch (biometric prompt fires on iPhone) | Attacker with physical access to the watch can approve boots (only boots — destructive ops still gated) |
| Watch stolen while on wrist | Same — watch alone can't authorize | Same — but watch can now drive boot approvals until owner revokes from iPhone |
| Sleeping user, attacker taps Watch | Watch tap triggers biometric prompt on iPhone, fails | Watch tap with double-confirm UI mitigates; small risk remains |
| Watch passcode brute-forced | Watch alone can't authorize | Brute-forcer can drive boot approvals until owner notices + revokes |
| iPhone compromised | All bets off either way | Same |

The honest accounting: the delegate key trades a small amount of
boot-approval security for a meaningful glanceability win, and
constrains the loss to the **least destructive** operation kind.
Default-OFF + explicit toggle + double-tap confirm on the watch
side keeps the conservative-default property.

## 6. Implementation surface (when picked up)

Rough size estimate: **multi-day** (this isn't a 30-min task).

**`@flagship/protocol`**:
- `WatchDelegateKey` envelope: `{userId, delegatePub, scopes,
  issuedAt, expiresAt}`. IRK-signed; canonical bytes mirror the
  existing `DeviceCapabilityGrant` shape.
- `RevokeWatchDelegate` envelope: `{userId, delegateGrantId,
  issuedAt}`. IRK-signed.
- `BootApproval` envelope (existing or new): when signed by a
  delegate key, carries the delegate's pubkey + the cloud verifies
  against the active `WatchDelegateKey` registration. Today's
  IRK-signed path stays as the fallback.

**iPhone**:
- New SE keypair management in `Keystore.swift` for the delegate
  key (lower access control flags, separate keychain tag, separate
  rotation lifecycle).
- New Settings toggle wired to a view model that mints + posts
  `WatchDelegateKey` to `.com`.
- WCSession handler change: when delegate is active, approve
  messages take the delegate-signing path (no biometric prompt);
  when inactive, fall back to today's IRK-signed path with the
  biometric prompt.
- Auto-revoke hooks on IRK rotation / replace device / wipe.

**Watch**:
- Watch-side `WCSession` state needs an "approve allowed" boolean
  that the iPhone publishes alongside the pending approvals.
- Approve button on Watch shows different copy + a double-tap
  confirm when delegate is active.

**Cloud (`.com`)**:
- `D1` table for active watch delegates per user, with TTL +
  scope.
- Boot-approval handler verifies signatures against EITHER the IRK
  OR an active delegate (delegate signatures only accepted for the
  boot-approval kind).
- Audit-log entry on delegate mint + delegate use + delegate
  revoke.
- Endpoint to register a new delegate +
  endpoint to revoke + endpoint for the iPhone to list active
  delegates for the toggle's "are you sure?" surface.

**Auto-revoke triggers** (cross-cutting):
- IRK rotation → revoke all delegates for the rotating IRK.
- Replace-device flow → revoke delegates tied to the replaced
  device.
- Wipe & restart → revoke + drop SE-side delegate key.

## 7. When to pick this up

Not v1. Likely **v1.1 or v1.2** — paired with the rest of the
"Watch approve" re-routing through the new sealed-lease /
`boot.flagshipserver.com` relay model that's also in transition.
Both pieces of work touch the same Watch ↔ iPhone bridge and the
same cloud surface, so doing them together avoids two passes at
the same code.

A reasonable trigger for picking this up: real user feedback that
the current "tap Watch → unlock iPhone → tap Approve" friction is
killing the Watch surface's value. Until then, default-OFF means
nothing breaks for the conservative path.
