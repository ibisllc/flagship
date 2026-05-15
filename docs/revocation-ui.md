# Revocation UI — iOS, Android, webapp

What each platform actually renders for the three revocation actions
described in [[multi-device]] and [[wipe-restart]]. This is a
visual-and-copy spec; protocol details live in the linked docs.

## Where the actions live

| Platform | Entry point | Surface |
|---|---|---|
| iOS | Settings → Trusted devices → tap a device row | Bottom sheet (`.sheet`) with three buttons + a "Cancel" |
| Android | Settings → Trusted devices → tap a device card | `ModalBottomSheet` with three buttons + dismiss-on-scrim |
| Webapp | Settings → Trusted devices → "•••" menu on a device card | Native `<dialog>` (HTML5) with three buttons + Esc-to-close |

The device-list lives at Settings → Trusted devices on all three. On
desktop browsers we render the cards in a 2-column grid; on
mobile-web it falls back to single-column.

## Voice & copy

Tone: **direct and slightly stern** for Replace and Wipe. We don't
want a user to fat-finger a destructive action. Quoting from
`docs/design-system.md` § Voice: "Speak to the user like a competent
adult; explain consequences in one sentence each."

### "Disconnect" sheet copy

> **Disconnect this device?**
>
> Notifications stop on this device immediately. The device stays
> paired to your pods — to remove it from your account entirely,
> choose Replace below.
>
> [Disconnect notifications] (primary)
> [Cancel]

### "Replace device" sheet copy

> **Replace this device?**
>
> Rotates your account's identity key. Every other device on this
> account — including this phone — will need to confirm a new pairing
> the next time it opens the app. You won't be locked out, but you'll
> see a one-time biometric prompt on each device.
>
> Pods stay running. Apps stay installed.
>
> [Replace] (primary, destructive-style)
> [Cancel]

### "Wipe & restart" sheet copy (v1.1)

> **Wipe and start over?**
>
> Your account keeps the username **`@<u>`** and your pods keep their
> data. Every device currently on this account will be disconnected.
> You'll re-pair each one fresh — including this phone, which becomes
> the new root of trust.
>
> This can't be undone from another device.
>
> [Wipe and start over] (primary, danger-styled)
> [Cancel]

## Scare-sheet patterns

We use a **two-tap confirmation** for Replace and Wipe — the sheet
shows the primary button as enabled, but tapping it doesn't immediately
fire. Instead it animates the primary into a "Hold to confirm" state
(1.5s long-press). This pattern is borrowed from iOS's own
"erase iPhone" flow.

On webapp, where long-press isn't ergonomic, we substitute a 3-second
countdown ("Replacing in 3… 2… 1…") with a prominent "Cancel" button.
The user can interrupt at any point during the countdown.

## What gets recorded

Every confirmed action writes an audit row via the Worker (see
[[multi-device]] § endpoints). The audit feed surfaces these on the
Activity tab on iOS / Android / webapp — same set of `eventKind`s
across all three:

| eventKind | Label (English) | Icon |
|---|---|---|
| `device-disconnected` | "Disconnected device" | 🔌 (web) / lock.open.trianglebadge.exclamationmark (iOS) |
| `device-replaced` | "Replaced device" | 🔄 / arrow.triangle.2.circlepath.circle |
| `device-added` | "Added device" | ➕ / plus.circle |
| `wipe-restart` | "Wiped & restarted account" | 🗑️ / trash.fill |
| `recovery-set-up` | "Set up recovery" | 🔐 / key.horizontal.fill |
| `recovery-rotated` | "Rotated recovery passkey" | 🔁 / arrow.triangle.2.circlepath |

`detail` is a short human-readable string (`"Disconnected iPad
(kitchen)"`, max 256 chars per migration `0018_audit_events.sql`).

## Self-revocation

Each device's row in the trusted-devices list has a "Remove from this
account" affordance — actionable only on **your current device's row**
(the row tagged with "This device"). Tapping it:

1. Wipes local Keystore (Secure Enclave / AndroidKeyStore / IndexedDB).
2. Sends a final `disconnect` to .com.
3. Drops the user back to the Welcome screen.

This is **not** sign-out. Sign-out is meaningless on a phone — there
is no password to forget. Self-revocation is "I'm giving this phone
away; clean it up first."

Tracked as **B6a** (iOS) and **C6a** (Android).

## Disabled states (v1 only)

On v1 the Wipe & restart action is rendered with the third button
**disabled** and a "Coming soon" subtitle. Tapping it opens an
informational sheet explaining that v1 ships with Replace only, and
linking to the security blog post when one exists. This is
deliberately visible (not hidden) so that users understand the option
exists and is being designed — they don't feel cornered into Replace.

## Cross-platform parity matrix

| Action | iOS | Android | Webapp |
|---|---|---|---|
| List trusted devices | ✅ | ✅ | ✅ (read-only) |
| Disconnect | ✅ | ✅ | ✅ |
| Replace device | ⏳ B7 | ⏳ C7 | ⏳ D2 (sub-task) |
| Wipe & restart (button visible, disabled) | ✅ B8 | ✅ C8 | ✅ |
| Wipe & restart (ceremony) | ⏳ E2/E3 | ⏳ E4/E5 | ⏳ E6 |
| Self-revoke ("Remove from this account") | ⏳ B6a | ⏳ C6a | ✅ (just clears localStorage) |
| Activity feed audit section | ✅ | ✅ | ✅ |

## See also

- [[multi-device]] — protocol layer.
- [[wipe-restart]] — v1.1 ceremony in detail.
- `docs/design-system.md` § Voice + § Modal patterns.
- `docs/build-tasks.md` sections B, C, D, E.
