# Lock & power-off + dead-man heartbeat-lock

Status: SPEC (signed off 2026-06-11). One shared daemon primitive — power off / restart
the host — exposed two ways: a manual button and an automatic dead-man heartbeat.
**No feature-gating for now** (free/paid split is a later pass).

## The primitive (daemon)

A real host power action — `systemctl poweroff` / `systemctl reboot` — NOT the existing
`shut-down` order (which only exits the daemon process). The daemon is already privileged
(LUKS + Docker), so no new privilege path. On a LUKS-from-phone box, powering off drops the
in-memory disk key ⇒ the next boot needs phone approval to unlock ("lock"). On a non-LUKS
box it's a plain power action (no lock).

New signed `power-off` PhoneOrder with `mode: "off" | "restart"` (canonical
`flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>`, IRK/biometric-signed). The
existing `shut-down` order is left as-is for its internal daemon-exit use.

## Manual buttons (iOS / Android / webapp — server detail)

Two buttons:
- **"Lock and turn off"** → `power-off {off}`
- **"Lock and restart"** → `power-off {restart}`

Drop "Lock and " when the box is non-LUKS (label "Turn off" / "Restart"). Each: an
"Are you sure?" confirm + biometric, then the signed order is delivered to the box. No
explanatory copy. UI then shows powering-off/restarting → offline.

## Dead-man heartbeat-lock

Opt-in per-server policy, default OFF, clearly labeled. When on:

- The phone periodically prompts the user — **a manual, biometric-gated affirmation**
  ("keep <server> unlocked?"). It renews a **dead-man lease** distinct from the silent
  auto-unlock lease. Because it requires biometric, a stolen/unattended phone cannot renew
  it.
- The daemon enforces the lease deadline. On lapse (window + grace, no renewal): it
  **suppresses the silent auto-unlock** (so the box won't quietly re-unlock), then executes
  the lockout action.
- **Lockout action:** default **turn off** (rubber-hose posture), user-selectable to
  **restart** (fast resume). Both land the box at the approve-mode boot-unlock prompt
  requiring an explicit biometric approval to return — which also re-arms the dead-man.

### Window
- Default **24h window + 6h grace**; reminders at T-6h / T-1h / T-15m (phone-side).
- User-adjustable down to minutes, with a one-tap **"tighten now"** for transient
  high-risk moments (border control, etc.).

### Recovery
Power on (if off) → approve-mode boot unlock → biometric approve → unlocked + dead-man
re-armed. Cloud recovery remains the always-available escape.

## Reuse / build notes

- Signed-order plumbing exists (`packages/protocol` PhoneOrder + `server-daemon/orders.ts`
  dispatch). New: the real poweroff/reboot executor, the `power-off` order, the dead-man
  lease + enforcement timer (reuses the lease store), and the auto-unlock suppression on
  trigger.
- Phone→box order delivery uses the same channel as other phone orders (pinned pipe /
  `.com` relay — confirm at build).
- Randomness/clock/executor injected so tests never touch real `systemctl`.

## Out of scope (tracked separately)
- The post-creation "grant a box cert autonomy" ceremony is now vestigial under per-box
  self-renewal — retire in a separate cleanup.
- In-place data-volume locking without reboot (Tier B) — not built.
