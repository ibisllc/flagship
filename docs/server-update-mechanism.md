# Server update mechanism — phone-ordered, dual-signed in-place updates

> **Status: DESIGN. Build post-launch (sequence with the other post-launch pillars).**
> Recorded 2026-07-01. Lets a running box be updated in place — its harness/daemon code
> and/or its declared security posture — without a reburn, under a **2-of-2** signature
> gate: **Flagship's current-mandate maintainer authority** (the code is blessed, not
> malicious) **and** an **admin phone** (an admin authorized applying it to this box).

## Why this exists

Today a box is pinned to the `installerGitRef` baked into its recipe at create time
(`packages/protocol/src/installBlob.ts`). There is **no in-place update path** — patching
the daemon or changing what the box runs means a reburn. That's untenable once boxes are
in the field: security fixes, harness improvements, and posture changes (e.g. enabling a
new auth mode) all need a safe, remote, authorized way to land.

The hard part isn't shipping bytes — it's doing it **without becoming a supply-chain
backdoor**. An update that changes the code a box runs is the single most dangerous
capability in the system. So the mechanism is designed around one rule:

## The core rule: 2-of-2 (authenticity × authorization)

An update applies **only if BOTH** hold:

1. **Authenticity — the maintainer signature.** The update *artifact* (its content hash +
   target version) is signed by **the maintainer/CA key currently holding the mandate** —
   the same authority chain boxes + apps already pin and verify
   (`packages/protocol/src/maintainerCa.ts`: `MAINTAINER_PINNED_MANDATE_HASH` →
   `authorizedCaKeysOrFailClosed(now)`). This proves the code is an **official, audited
   Flagship release**, not attacker-injected.

2. **Authorization — the admin-phone signature.** An **admin device** — one holding an
   `admin`-scope `DeviceCapabilityGrant` anchored at the account's **admin master root**
   (`admin_root_pub_hex`, carried in the signed `AuthCode` and pinned by the box;
   `packages/protocol/src/deviceCapability.ts` + `adminRootRotation.ts`), verified
   box-side by `adminAuthorityLocal` (`requireMasterAdmin`) — signs an order naming **this
   box** and **this exact blessed artifact**. This proves an admin **consented** to
   applying this update here. Applying an update is a **SENSITIVE op**, so it rides the
   *same* admin-master-root gate the Slice-D device-admin tier already puts on wipe /
   transfer / decommission (`docs/device-admin-tier-spec.md`).

Neither alone suffices, and that's the whole point:

| Attacker | Has | Can they push code? |
|---|---|---|
| Rogue `.com` / compromised git/R2 host | store/replay/withhold + serve bytes | **No** — can't forge either sig; the box verifies bytes against the maintainer-signed hash. Worst case: withhold (DoS), mitigated by the box checking the release channel. |
| Stolen **maintainer** key (alone) | blesses malicious code | **No box, no blast radius** without a per-box admin order. Further contained by the mandate lease/rotation/revocation (`CaEndorsement`) + a transparency log (below). |
| Stolen **admin device / admin-root** (alone) | authorizes applying an update | **Cannot run arbitrary code** — only a *maintainer-blessed* artifact. At worst forces a box onto a different **blessed** version; anti-downgrade caps the harm. **This is the headline benefit: an admin-key compromise is not arbitrary code execution, and an admin cannot be socially-engineered into running attacker code.** (Admin-root compromise/loss is itself handled by the Slice-D escrow + `admin-root-rotation/v1`.) |

So dual-sig is strictly stronger than either party alone — it's genuine supply-chain
hardening on both ends.

**Non-goal (explicit):** this mechanism does **not** let an owner run unblessed/forked
code. That is deliberate — "must be maintainer-blessed" is what makes it safe. Running a
fork is an out-of-band, physical/debug-console operation (the owner-grant debug path), not
this update channel.

## Envelopes

Both follow the repo canonical-bytes convention (`flagship/<purpose>/v1|…`,
`packages/protocol`).

**UpdateManifest** — signed by the current-mandate maintainer key:
```
flagship/update-manifest/v1
  | targetVersion            (semver / monotonic)
  | artifactHash             (sha256 of the exact update pack bytes — the trust anchor)
  | minFromVersion           (refuse to apply onto anything older)
  | allowDowngrade           (0/1 — downgrades are an attack vector; off unless blessed)
  | class                    ("security" | "feature" | …  — drives the auto-policy)
  | postureDeclCsv           (declared posture/capability changes this version enables)
  | issuedAt | notBefore | expiresAt
```
Verified: signer ∈ `authorizedCaKeysOrFailClosed(now)` for the box's pinned mandate; sig
valid; `now ∈ [notBefore, expiresAt]`. The `artifactUrl` is an **unsigned** delivery hint —
trust is the hash, not the URL, so a malicious host can't substitute bytes.

**UpdateOrder** — signed by an admin device:
```
flagship/update-order/v1
  | serverDomain             (THIS box)
  | manifestHash             (sha256 of the canonical UpdateManifest bytes — binds to the exact blessed update)
  | fromVersion              (the box's expected current version)
  | nonce | issuedAt
```
Verified: `serverDomain` == this box; `manifestHash` == hash(the manifest presented);
signer ∈ {owner IRK, admin device-capability chain} via `adminAuthorityLocal`; fresh
(`issuedAt` within replay window, `nonce` unused); `fromVersion` == box's current version.

## What an update can change (and the boundary with existing grants)

- **Harness / daemon code** (the primary use) — move the box to a new blessed daemon
  version. **Never touches identity/keys/data** (`/var/flagship`, LUKS) — it is a *code
  swap only*; all state persists.
- **Security-posture changes that alter what code/capabilities the box runs** (e.g. a new
  auth mode) — ride the same dual-signed manifest, because the maintainer sig proves the
  operation is a **known, audited, blessed** change, not arbitrary commands.
- **Boundary — do NOT duplicate existing owner-only grants.** Pure runtime toggles that
  are already first-class owner-signed grants stay as they are: e.g. **"allow SSH / debug
  console" is the existing `flagship/debug-access/v1` grant** (owner-signed, single-sig —
  it's config on already-blessed code, the owner's choice on their box; see
  `packages/server-daemon/src/debugAccessGate.ts`). The update channel is for changing the
  **code / the set of blessed operations**, not re-implementing runtime config toggles.
  Rule of thumb: *changes what bytes run → dual-signed update; flips a flag the running
  blessed code already honors → owner-grant.*

## Distribution + delivery

1. **`.com` publishes blessed manifests** (public, signed — a sibling of
   `GET /api/maintainer-blessing`). The maintainer signs manifests out-of-band (the
   `maintainers` CLI / the planned NFC ceremony app); `.com` is content-blind distribution.
   Publish into an **append-only transparency log** so a secretly-blessed malicious build
   is publicly detectable (mirrors the CT-monitoring the project already does for certs).
2. **The phone sees an update is available** for the owner's box(es), fetches the manifest,
   and **verifies the maintainer sig against its own pinned mandate** (the app already does
   maintainer-blessing verification — never trust `.com`'s word).
3. **The admin taps "Update this server" → Face ID → signs the UpdateOrder** (owner IRK)
   binding {this box, this manifest hash, fromVersion, nonce}.
4. **Delivery to the box** — two paths, reuse existing plumbing:
   - **Deposit lane (primary):** a new `update_orders` `secret_mailbox` lane on `.com`; the
     box polls + claims on its heartbeat, exactly like `pairingDepositConsumer` /
     `cgkDepositConsumer` / `decommissionConsumer`. Survives box-offline; good for fleets
     and the hali "was offline" case.
   - **Direct pipe (interactive):** POST `(manifest, order)` to the box's pinned pipe, same
     shape as `/api/power` / `/api/journal`, for "update now" when online.

The **update pack** (prebuilt, hash-pinned) is fetched from `.com`/R2 (or git) and verified
byte-for-byte against `manifestHash`'s `artifactHash` — so even a compromised host can't
substitute code. Prefer **signed prebuilt packs** (fast, no on-box build, simple integrity)
over on-box `git fetch`+build; the pack hash should be a **reproducible-build** output so
anyone can rebuild from source and confirm the blessed bytes (ties into `release-guard.sh`
+ the reproducible-build work).

## Box-side update agent (transactional, health-gated, never bricks)

New `updateConsumer.ts` (mirrors the other deposit consumers; wired in `index.ts`). On a
verified (manifest + order):

1. **Verify both sigs + all rules** (§ envelopes). Reject silently on any failure (never
   apply on bad input, never crash).
2. **Anti-attack gates:** `nonce` unused (at-most-once via a local applied marker);
   `fromVersion` == current (anti-replay of stale orders); `targetVersion` > current unless
   `allowDowngrade` (anti-downgrade — stops reintroducing patched vulns); current ≥
   `minFromVersion`.
3. **Stage:** fetch the pack, verify `artifactHash`, unpack into a staging slot **beside**
   the running version (A/B). Never overwrite the live version in place.
4. **Switch atomically** (symlink/service swap) → restart the daemon.
5. **Health-gate + auto-rollback:** the new daemon must, within a window, reconnect the
   tunnel + land a signed heartbeat + serve (reuse the tunnel supervisor + the self-healing
   heartbeat from the hali work). If it fails the gate → **revert to the previous version +
   restart** → report `update-failed (rolled back)`. **A bad update can never brick a box.**
6. **Report status** through the provision-status / heartbeat channel (reuse the hali
   status surface): `updating → staging → switching → verifying → live (vX)` or
   `rolled-back (reason)`, so the phone shows a live update timeline.
7. Record the applied nonce + bump the box's persisted **current version** (which now
   supersedes the recipe's `installerGitRef` as the source of truth for "what this box
   runs").

## Optional: standing auto-apply policy (fast security patching)

Requiring a per-update owner order maximizes control but slows critical security fixes. So
offer an **opt-in, owner-signed standing policy**:
```
flagship/update-auto-policy/v1 | serverDomain | class(es) (e.g. "security") | maxVersion? | issuedAt | nonce
```
When present + enabled, the box auto-applies a **blessed** manifest in the allowed class
**without** a per-update order. This still honors 2-of-2 in spirit: the **maintainer
blesses each** update; the **owner pre-authorized the class** (once, from the phone).
**Default: off** (explicit per-update order). On = "keep me patched." This is the
control-vs-speed dial; document the tradeoff and keep it a conscious, phone-signed choice.

## Reused primitives (build on, don't reinvent)

- **Maintainer authority:** `packages/protocol/src/maintainerCa.ts`
  (`MAINTAINER_PINNED_MANDATE_HASH`, `authorizedCaKeysOrFailClosed`), the
  `maintainer-blessing` distribution + the transparency/CT-monitoring pattern.
- **Admin authorization:** the Slice-D **admin master root** — `admin_root_pub_hex`
  (pinned via the signed `AuthCode`), `admin`-scope `DeviceCapabilityGrant`
  (`deviceCapability.ts`), rotation/escrow (`adminRootRotation.ts`), box-side
  `adminAuthorityLocal` / `requireMasterAdmin`. `docs/device-admin-tier-spec.md`.
- **Delivery:** the `secret_mailbox` deposit lanes + the consumer pattern
  (`pairingDepositConsumer` / `cgkDepositConsumer` / `decommissionConsumer` /
  `transferRehomeConsumer`), and the direct owner-order pipe (`/api/power`, `/api/journal`).
- **Health/rollback:** the tunnel supervisor (`superviseTunnelClient`) + the self-healing
  heartbeat (`daemonStatusHeartbeat`) as the post-update health gate.
- **Status UX:** the provision-status timeline (the hali status-surface design).
- **Integrity:** `scripts/release-guard.sh` + reproducible builds → the blessed
  `artifactHash`.

## Interactions

- **Deployment-form-agnostic:** works on the bare-metal appliance, the future
  desktop-hosted **VM appliance** (`docs/desktop-vm-appliance.md`), and any native install —
  it's daemon-level. This is the in-place patch path all of them need.
- **Supersedes `installerGitRef`** as the live "what this box runs" pointer (the recipe ref
  becomes the *initial* version; the box tracks its updated version + history).
- **Complements** decommission/transfer/recovery (those move ownership/routing; this moves
  code) and **debug-access** (owner-only runtime toggle; this is blessed-code change).

## Open questions / phasing

- **Manifest signing UX:** the maintainers CLI signs manifests today; the NFC ceremony app
  (`docs/maintainer-ca-endorsement.md` §11–12) would make it tap-to-sign.
- **Pack format + reproducibility:** exact pack layout (built daemon + pinned deps per
  arch) and getting a byte-reproducible hash; v0 could be git-ref + on-box build (simpler,
  weaker integrity) before packs.
- **Transparency log:** where it lives (a `.com` append-only table + a public mirror) and
  how the phone monitors it.
- **Multi-admin / capability revocation:** how an admin device that signed a pending order
  is handled if revoked before the box applies it.
- **Downgrade policy:** exact rules for blessed downgrades (incident rollback) vs the
  anti-downgrade default.
- **Phasing:** v0 = manual per-box owner order + git-ref update + health-gated rollback; v1
  = signed reproducible packs + transparency log; v2 = standing auto-apply-security policy +
  fleet rollout surfacing.
