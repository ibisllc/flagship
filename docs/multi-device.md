# Multi-device & device-list management

How a Flagship account can be controlled from more than one device
(iPhone + iPad, iPhone + Android tablet, iPhone + browser), and how a
user removes a device or replaces a lost one without nuking their
account.

> The trust boundary is the **IRK** (Identity-Recovery Key). A device
> with the active IRK private key can sign re-pair envelopes that bind
> new devices onto the account. There is exactly one active IRK pubkey
> per username at a time — recorded as `users.irk_pub_hex` in the
> Worker's D1.

## Vocabulary

| Term | Meaning |
|---|---|
| **Phone-trust device** | A device holding the current IRK private key. Currently 1 per account; can be expanded in v2. |
| **Paired session** | A device-pod relationship; bound to a stable-id and a per-server PSK. Lives in `paired_sessions`. |
| **Push subscription** | Per-device push transport (APNs / FCM / Web Push) keyed by `device_id`. Lives in `push_tokens`. A device may have one per active platform. |
| **Trusted device** | What the user sees in Settings → Trusted devices. Backed by the union of paired-sessions and push-tokens, deduped by `device_id`. |
| **IRK rotation** | Generate a fresh IRK keypair, sign a re-pair envelope with the old IRK, atomically swap on .com. Used by "Replace device" and "Wipe & restart". |

## Three actions a user can take on a device

| Action | Crypto effect | UI label (mobile) | UI label (web) | Audit kind |
|---|---|---|---|---|
| **Disconnect** (push only) | Revoke that device's push subscription; paired-session untouched. | "Disconnect" | "Disconnect" | `device-disconnected` |
| **Replace** (IRK rotation) | Rotate IRK; old device's signature becomes invalid; per-pod re-pair fans out. | "Replace device" | "Replace device" | `device-replaced` |
| **Wipe & restart** (v1.1) | Drop UMK + recovery envelope + IRK; new account at the same username. | "Wipe & restart" | "Wipe & restart" | `wipe-restart` |

Sign-out is **not** a concept on phone clients — there's no password to
re-enter; the app just opens with Face ID. Self-removal exists as
"Remove from this account" (covered in [[revocation-ui]]).

## Endpoints

```
GET    /api/users/:u/devices              -> { devices: [...], etag }
POST   /api/users/:u/devices/:id/disconnect
POST   /api/re-pair                       (If-Match: <etag>)
POST   /api/users/:u/wipe-restart         (v1.1)
GET    /api/users/:u/audit?since=&limit=  -> { events: [...] }
```

All five live on .com (the Cloudflare Worker), not on the daemon —
they're account-state operations, not pod-state.

## ETag and the If-Match flow

The device list ETag is the FNV-1a hash of `(tokenId|label|platform|addedAt)` for
each device, joined by `0x1f`. **`lastSeenAt` is deliberately
excluded** — push delivery flutters it constantly, and the user
should be able to start a Replace flow without losing their place
just because a background push landed.

`/api/re-pair` honors an optional `If-Match` header. If the IRK pubkey
in D1 doesn't match the header's quoted ETag, the Worker returns
**412 Precondition Failed** with a fresh `etag` in the body. The
client re-fetches `/devices`, re-confirms intent with the user, and
retries — Compare-And-Swap semantics, no lost updates.

This matters because a Replace ceremony has multiple round-trips
(WebAuthn assertion → biometric → re-pair POST) and the IRK could
rotate underneath you (e.g., another device beat you to it).

## SQL CAS in the Worker

Inside `handleRePair`:

```sql
UPDATE users
SET    irk_pub_hex = ?, last_rotated_at = ?
WHERE  username = ?
AND    lower(irk_pub_hex) = lower(?)
```

`rowsAffected === 0` means the old IRK on D1 doesn't match what the
client signed for — race lost, return 412. This is the atomic primitive
underneath the If-Match flow; the ETag is the user-visible projection.

## How "Replace device" works end-to-end (planned)

1. User on the new device opens the app → "I already have an account".
2. New device generates IRK keypair locally in the Secure Enclave / Keystore.
3. WebAuthn-PRF ceremony with the recovery passkey → unwraps the cloud-stored UMK.
4. Device requests `GET /api/users/:u/devices` → captures ETag.
5. App shows "Keep both devices" vs. "Replace lost device" (see [[reference_ios_architecture]]'s PostRecoveryChoice).
6. On "Replace", new device signs `RePair(oldIrkPub, newIrkPub, ts)` with the recovered UMK-derived key.
7. POST `/api/re-pair` with `If-Match: "<etag>"`.
8. Worker SQL-CAS swaps `users.irk_pub_hex`. Inserts `device-replaced` audit row.
9. New device fans out to each known pod and signs fresh per-server PSKs.
10. Old device's next push fails with "user account changed" → triggers peer "your account was reset" detection (E7).

Steps 6–9 require Keystore primitives that don't exist yet on either
platform. Tracked as **B7** (iOS) and **C7** (Android).

## Why we don't just delete the old device's row

Because we can't reach the old device to confirm it's the one we mean
to remove. The user might have lost it on a beach in Lisbon. The IRK
rotation makes the old device's signatures invalid regardless of
whether it ever phones home again — the cryptographic state of the
account moves forward.

## See also

- [[wipe-restart]] — the v1.1 nuclear option.
- [[revocation-ui]] — UI surfaces across iOS, Android, webapp.
- `docs/build-tasks.md` section S.7 (the v1-alpha device-list checklist).
