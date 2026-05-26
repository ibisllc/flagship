# Feature parity — webapp · iOS · Android

The three clients must reach **feature parity**. This is the living matrix +
gap list. Tasks P0–P13 (see the session task list) track closing every gap.

**Caveat:** the cells below come from a fast source audit (2026-05-25); two
audit passes disagreed on a few cells, so every parity task is framed
**audit-then-port** — the implementer re-verifies the actual state per surface
before/while porting. Treat ✅ as "believed wired", not proof. Keep this file
current as gaps close (task P0).

Canonical surface = wherever the feature is most complete (port FROM there).

| # | Feature | webapp | iOS | Android | Port to | Task |
|---|---------|:--:|:--:|:--:|---------|------|
| 1 | Open / create account | ✅ | ✅ | ✅ | — | — |
| 2 | Username taken-state + **trademark-claim** | ✅ | ✅ | ✅ | — | ✓ P2 |
| 3 | Login / account-resolve (never-404, takeover) | ✅ | ✅ | ✅ | — | — |
| 4 | Join / **cross-device QR pairing + admit** | ✅ | ✅ | ❌ | Android | **P4** |
| 5 | Recovery (keyfile + cloud + post-recovery) | ✅ | ✅ | ✅ | — | — |
| 6 | Key backup + Secure-your-account + **reminder** | ✅ | ⚠️ | ⚠️ | iOS+Android (reminder) | **P1** |
| 7 | Create server (QR relay, TTL, boot-unlock) | ✅ | ✅ | ✅ | — | — |
| 8 | Pending server + cancel → **release name** | ✅ | ✅ | ✅ | — | ✓ P3 |
| 9 | Server detail (auto-unlock, metrics, events) | ✅ | ✅ | ✅ | — | — |
| 10 | Boot/unlock approval | ✅ | ✅ | ✅ | — | — |
| 11 | Provisioning-status timeline | ✅ | ✅ | ✅ | — | — |
| 12 | Devices: trusted-devices + paired-sessions | ✅ | ✅ | ✅ | — | — |
| 13 | Account security (badge + TOTP 2FA) | ✅ | ✅ | ✅ | — | — |
| 14 | **Audit log** | ✅ | ✅ | ✅ | — | ✓ P5 |
| 15 | **Collaborator invites** (issue + manage) | ✅ | ❌ | ❌ | iOS+Android | **P6** |
| 16 | Marketplace (browse + install) | ✅ | ⚠️ | ✅ | verify iOS wiring | **P0** |
| 17 | Services / detail / env-vars / BYOK LLM | ✅ | ✅ | ✅ | — | — |
| 18 | Vibe-code (chat + app build) | ✅ | ✅ | ✅ | — | — |
| 19 | **Peer-backup** management (+ daemon BFF) | ⚠️ | ❌ | ❌ | all 3 + BFF | **P9** |
| 20 | **Tier-status / monetization** | ✅ | ✅ | ✅ | — | ✓ P7 |
| 21 | Multi-profile / iCloud switching | ⚠️ | ✅ | ✅ | webapp | **P12** |
| 22 | Settings + developer settings | ✅ | ✅ | ✅ | — | — |
| 23 | Push registration | ✅ | ✅ | ✅ | — | — |
| 24 | **In-app browser-viewer** | ✅ | ❌ | ❌ | iOS+Android | **P8** |
| 25 | Activity feed | ✅ | ✅ | ✅ | — | — |
| 26 | **Replace device** (IRK rotation) | ❌ | ✅ | ✅ | webapp | **P10** |
| 27 | **Wipe & restart** | ❌ | ✅ | ✅ | webapp | **P11** |
| 28 | **Kill-switch / server revocation UI** | ❌ | ❌ | ❌ | all 3 | **P13** |

Legend: ✅ believed wired · ⚠️ partial / unverified / audit-disputed · ❌ missing.

## Gap list (port direction)

- **To iOS + Android:** collaborator invites (P6), browser-viewer (P8 —
  framebuffer-stream, see decision note below), peer-backup (P9), cross-device
  pairing → Android only (P4), backup reminder (P1 mobile half).
- **To webapp:** Replace device (P10), Wipe & restart (P11), multi-profile (P12).
- **All three:** kill-switch UI (P13 — per-server danger zone, decided),
  companion-browser dock (P14 — new, see below).
- **Verify-only:** marketplace iOS wiring, create-server iOS pickers (P0).

### P8 decision (2026-05-25)
The real use-case for the browser-viewer is "log into social media / Uber /
etc. **server-side** so a bot can later act as me" — the session, cookies,
MFA artifacts must live on the box. So P8 on iOS + Android = mirror the
webapp's WS framebuffer-stream + input-forwarding, not a native WebView. A
native in-app WebView is a separate convenience feature that can come later.

### P14 — companion-browser dock (new, 2026-05-25)
Every owner app (iOS / Android / webapp / Electron) should be able to dock
to a regular browser as an ephemeral companion surface (WhatsApp-style),
where the owner app is the long-lived trust root and the browser is paired
for ergonomic input. Cross-cutting; will land on all three.

## Discipline going forward

Any NEW user-facing feature must land on all three surfaces (or open parity
tasks at the same time) and update this matrix. The protocol/control-plane
layers are already shared; divergence is a UI-layer problem, so the canonical
behavior is whichever surface implemented it first.
