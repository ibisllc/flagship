# v1 UX coherence spec (implementation contract)

Status: ACTIVE for the v1-hardening pass. Additive only — rename/move/merge, **never delete a feature**. Applies identically to iOS, Android, webapp so the three surfaces become isomorphic. Keep the design language: teal accent `#14B8A6`, the rounded-square-containing-a-circle mark. The flag-on-mast **pennant is retired — remove any remaining `PENNANT_SVG`.**

The canonical accent is teal on all three today; `docs/design-system.md` still lists a stale blue `#3B5BFF` — update that doc to teal + the real per-platform font stacks as part of this pass.

## S1 — Settings: one 6-group taxonomy (collapse the flat lists; add zero depth)

Every surface renders Settings as these labeled groups, one tap to any row:

1. **Account** — Account security · AI keys · Recovery · Back up account key · Profiles
2. **Devices** — Trusted devices *(the single home for Add / Replace / Wipe / Remove device)* · Browser sessions · Dock a browser · Companion requests
3. **Web access** — Open secured sessions · Process URL
4. **Backup & peers** — Peer-backup
5. **App** — Appearance · Notifications · Privacy · About
6. **Danger zone** — Remove this device · Delete account
7. **Developer** *(hidden behind the existing 3-tap / debug toggle)* — Send order (debug), Create-server draft, mock/live

Consolidations (each a move, no feature lost):
- Android: merge the separate "Add a control device" top row **into** Devices → Trusted devices; **add** the missing Account-security, Appearance, About rows (parity with iOS/web).
- iOS: turn the flat `links()` list into the 6 groups.
- webapp: relocate "Create a server (draft composer)" + "Send order (debug)" into the hidden Developer group; add About/Appearance/Privacy rows.
- Home: **one** "Add a server" (collapse webapp's "Pair to a server" + "Pod pairing" + "Add a server"; move manual-pair behind Advanced). Webapp home cards must open **server-detail** on tap (today sliver/deep-link only). Tag `view-trusted-devices`, `view-account-delete`, `view-audit-log` in the webapp `SUB_VIEW_TABS` so the tab bar doesn't go dark.

## S2 — Date formatting: one helper per surface, these rules

Add a single shared helper (`Date+FlagshipFormat` / `DateFormat.kt` / `lib/dateFormat.js`) and route every ad-hoc formatter through it:
- **< 60s:** "just now"
- **< 60m:** "{n}m ago"
- **< 24h:** "{n}h ago"
- **same calendar year:** "MMM d" (e.g. "Jul 4"); with a time when it's a precise event: "MMM d, h:mm a"
- **older:** "MMM d, yyyy"
Locale-aware month names; never a raw ISO string or `toLocaleString()` in the UI.

## S3 — Buttons, touch targets, destructive actions

- **Min height 44pt/dp/px** on every primary/secondary/ghost/danger button primitive (today all three are ~40). Grow, don't clip.
- **On-grid padding** only (see S4 grid). Remove off-grid literals (28/20 dp, 11/18px).
- **Every destructive action** — Revoke, Remove, Delete, Wipe, Decommission — MUST render with the danger component (red) **and** gate behind a confirm step (grey Cancel vs red confirm). The compliant reference to copy is the webapp server-level revoke (grey Cancel + red Revoke + confirm modal). Fix the inline offenders: iOS `InviteManageScreen`, Android `PairedSessionsScreen` session revoke, webapp `invite-manage.js`/`server-detail.js` revoke-lease.

## S4 — Tokens: unify the scale, keep platform fonts

- **Spacing:** one 4pt grid `{4,8,12,16,20,24,32,40}`. Remove off-grid values (webapp `--space-5:20` is fine on-grid; the 22px gutter is NOT — snap to 24). 
- **Radii:** one scale `{6,10,16}` across surfaces (webapp's 8/12/18/22 → nearest of 6/10/16).
- **Color roles:** name tokens by ROLE and use them, never literals: `accent` (teal), `danger`, `ok`, `warn`, `muted`, `onAccent`. Replace hardcoded colors (webapp `post-recovery.js` status pills, grey `#1f2937`/`#1f3a1f` literals; Android `Components.kt` baked `Color.White` label → `onAccent`; iOS over-dimmed `textMuted.opacity(0.5/0.7)` → the muted token at full strength).
- **Fonts:** keep each platform's native stack (platform-idiomatic type is good UX); just record the real stacks in `docs/design-system.md`. Do NOT swap the webapp font family.
- Retire the pennant (`views/home.js` `PENNANT_SVG`).

## S5 — Copy: sentence case + plain language

- **Sentence case** everywhere (webapp toasts/labels are lowercase today — "provider saved" → "Provider saved", "online" → "Online").
- **Jargon → plain language** in all user-facing strings (keep technical terms only in the hidden Developer surface / logs):

| Jargon | User-facing |
|---|---|
| daemon | your server |
| Pod / Pod pairing | server |
| IRK | account key |
| manifest | app config |
| envelope | signed request *(or drop)* |
| escrow | encrypted backup |
| draft composer | (drop) |

## Naming (apply the canonical label everywhere)

AI keys *(not "AI providers")* · Recovery *(not "Recovery setup")* · Add a device *(not "Add a control device")* · Notifications *(not "Browser notifications")*.

## Sequencing within the UX lane

Per surface, in order: token/contrast pass (A) + destructive-button pass (B) + touch/padding (D) → date helper (C) → jargon/copy (E) → **Settings regroup (F)** and Home reconciliation (G) last, so groups land with correct labels. F is the highest-value coherence win; A/B the highest-value accessibility wins. Each chunk ships with tests (gym scenarios / view tests where they exist).
