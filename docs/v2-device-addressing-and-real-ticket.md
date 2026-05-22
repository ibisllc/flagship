# v2 device-addressing + real-ticket integration

**Status:** spec. Source of truth for sub-phases S3.1 → S3.5.

**Scope:** the engineering contract every downstream PR is implemented
against. Solves two blockers exposed by the 2026-05-20 live Phase F
run:

1. `scripts/sample-user.mjs` personalized its ISO via the offline
   `synthesizeBlob` mode, so the trailer's auth-code serial was never
   registered with `.com`; first-boot `/api/server/register` was
   rejected and the install silently never completed.
2. The existing single-IRK-per-user model lacks a corporate /
   restricted-device addressing layer the demo flow needs to showcase
   ("reviewer" devices that can browse but cannot install services).

Both are solved together because the demo flow's "type
`<demo-user>.<device-label>`" path is the first live use site for the
v2 device-addressing model. Demos are the proving ground; the same
envelope + table is what corporate deployments eventually consume.

---

## 1. Overview

Today's identity model: **one IRK per user**, claimed via
`packages/control-plane/src/usernameClaim.ts:19`. Multiple devices
share that IRK in practice (iCloud-Keychain export through the Secure
Enclave). The username's traffic resolves to "any pod the user owns";
`<server>.<user>.flagship.services` is keyed by `USERKEYHASH.*`.

v2 layers a per-device identity on top:

- **User IRK (master)** — unchanged. Still claims the username, still
  the recovery root. One per account.
- **Device IRK (per device)** — a separate Ed25519 keypair that
  identifies a specific device. Bound to the user via a
  `DeviceCapabilityGrant` signed by the user IRK.
- **DeviceCapabilityGrant envelope** — declares which device IRK
  belongs to which user, under what human-meaningful label, with what
  authorized scopes (`browse`, `install-service`, `vibe-code`,
  `add-device`, `manage-services`, `revoke-others`, `demo-provision`).
- **Two-level addressing** — `<user>` keeps meaning "any device the
  user owns" (unchanged). `<user>.<device-label>` resolves to a
  specific device's view, honoring its capability scopes.

The current single-device path is the v2 default when the account has
exactly one device and no DeviceCapabilityGrants — equivalent to a
single grant with full scopes. Existing accounts pay zero migration
cost: the new envelope is additive.

For demos the spec re-uses the same envelope. `demoalice` resolves to
the user-level demo identity (full scopes). `demoalice.reviewer`
resolves to a device-scoped sub-identity with `['browse']` only,
visible in the mobile UI as a restricted device sharing one VPS with
`demoalice`. The CLI mints the demo user's IRK deterministically from
the demo username (Worker-side, never leaves the Worker secret
boundary), then mints any number of device-scoped sub-identities under
that user.

---

## 2. DeviceCapabilityGrant envelope

Modeled on `ServiceGrant` (`packages/protocol/src/auth.ts:2695`).
IRK-signed, canonical-bytes, expiry-bounded, revocable.

```ts
export type DeviceScope =
  | 'browse'            // read-only access to user content
  | 'install-service'   // can sign InstallServiceRequest
  | 'vibe-code'         // can drive a vibe-code session
  | 'add-device'        // can sign a child DeviceCapabilityGrant
  | 'manage-services'   // can rename / uninstall services
  | 'revoke-others'     // can revoke other devices
  | 'demo-provision';   // can issue /connect on a demo account

export interface DeviceCapabilityGrant {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  /** Username at issuance time. Renames produce new grants under the new name. */
  username: string;
  /** Human-meaningful device label ("ipad", "work-laptop", "reviewer"). */
  deviceLabel: string;
  /** Device's Ed25519 pubkey (32 bytes). Identifies the device. */
  devicePubKey: Bytes;
  /** Authorized scopes (sorted at canonicalization). */
  scopes: DeviceScope[];
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; SHOULD be issuedAt + 90*24*3600*1000 by convention (90d). */
  expiresAt: number;
}
```

Canonical tag: `flagship/device-capability-grant/v1`. Field ordering
mirrors `ServiceGrant`: tag, grantId, username, deviceLabel,
hex(devicePubKey), sorted-scopes, issuedAt, expiresAt — `|` separator,
no nesting. Validation rejects `|` and control bytes in every string
field (H1 hardening — same shape as `validateServiceGrantFields`).

`deviceLabel` regex: `/^[a-z0-9-]{1,24}$/` (same shape as the
RFC-1035-like rules in `validateAppLabel`). Reserved labels:
`admin`, `user`, `root`, `home`, `service`, `services`. The leading-
hyphen / trailing-hyphen rules from `validateUserLabel` apply.

Signature: `signDeviceCapabilityGrant(g, userIrk: Keypair)` — Ed25519
over canonical bytes. Verifier: `verifyDeviceCapabilityGrant(g, sig,
userIrkPub)`.

Grant id helper: `deviceCapabilityGrantId(g)` — SHA-256 hex of canonical
bytes. Used as the D1 primary key and as the lookup handle in revocation
lists.

### 2.1 Revocation

A new IRK-signed envelope `RevokeDeviceCapabilityGrant`:

```ts
export interface RevokeDeviceCapabilityGrant {
  grantId: string;
  username: string;
  reason: 'lost' | 'stolen' | 'decommissioned' | 'replaced';
  issuedAt: number;
}
```

Canonical tag: `flagship/revoke-device-capability-grant/v1`. The
Worker writes `revoked_at` on the matching grant row; the daemon's
periodic refresh pulls `/api/users/:u/device-grants` (sorted by
issuedAt) and treats `revoked_at IS NOT NULL` as void. Daemon
defense-in-depth: a grant for the same (username, deviceLabel) with a
strictly newer `issuedAt` SUPERSEDES the older grant even without
explicit revocation — same shape as ServiceGrant.

### 2.2 Default scopes by account-type

Single-device account, first device:
`['browse', 'install-service', 'vibe-code', 'add-device',
'manage-services', 'revoke-others']`. (Excludes `demo-provision`.)
Equivalent to today's full-power IRK.

Multi-device account, freshly-admitted device:
`['browse']`. The user explicitly grants more later. The 14-day
quarantine from Plan B Phase 2 stays — it blocks `revoke-others` until
the quarantine window closes even if the scope is granted.

Demo user's primary device (created at `create-sample-user`):
`['browse', 'install-service', 'vibe-code', 'add-device',
'manage-services', 'revoke-others', 'demo-provision']`. Full power
within the demo sandbox.

Demo user's `reviewer` sub-identity:
`['browse']`. Read-only.

### 2.3 Migration of existing accounts

No forced migration. Existing accounts continue to work without any
DeviceCapabilityGrant. The daemon + Worker treat "no grants on file
for this user" as "single device, full scopes" (legacy mode). The
first time the user touches a v2 mobile-app surface that mints a
grant — explicit opt-in — the legacy mode is left behind for that
user; from then on, every request must carry or imply a grant.

This deliberately keeps Plan B accounts (single-device + 7-day grace)
unchanged.

---

## 3. Two-level addressing

### 3.1 At the URL layer

Today: `<server>.<user>.flagship.services` is a 3-label hostname where
the middle label keys to a single IRK pubkey.

v2: `<user>` continues to address "any of this user's devices". A new
optional middle label `<user>.<device-label>` is reserved at the
`/api/users/check` boundary as a special-case lookup — it never
appears in a real TLS hostname (those stay 3-label). The dot is a
client-side separator the Worker resolves into the
`device_capability_grants` table.

Specifically:
- `/api/users/check` with `{username: "demoalice"}` returns the
  user-level response (legacy shape + the `demoServer` block).
- `/api/users/check` with `{username: "demoalice.reviewer"}` returns
  the user-level response PLUS a `deviceCapability` block describing
  the `reviewer` device's label + scopes + devicePubKey.

The mobile client treats the `deviceCapability` block as a strong
declaration of "you are a restricted device under this user". The UI
greys out actions absent from the scopes list and surfaces an explicit
explanation banner ("This device can browse but cannot install
services").

### 3.2 At the daemon / Worker enforcement layer

Privileged operations (install-service, vibe-code, rename, uninstall,
add-device, revoke-others) MUST be signed by a device IRK whose
DeviceCapabilityGrant covers the operation, OR by the user IRK
directly. Verification chain at the enforcement point:

1. Decode the operation envelope (e.g. InstallServiceRequest).
2. Verify the Ed25519 signature against the claimed signer pubkey.
3. If the signer pubkey == the user's IRK pubkey, allow (legacy
   single-IRK path).
4. Otherwise, look up DeviceCapabilityGrants for that signer pubkey:
   - Verify the grant's IRK signature.
   - Confirm `revoked_at IS NULL`, `now < expires_at`, scope
     coverage.
5. Reject otherwise.

For the daemon, this lookup happens against the daemon's local cache
of grants pulled from `.com`. The cache is refreshed on a TTL (60s
default; tunable) and on demand when a new grant is asserted in a
request. The same chain runs in the Worker for endpoints that have
direct device-IRK-signed bodies.

---

## 4. Real-ticket integration at `create-sample-user`

Gap 1 from the 2026-05-20 checkpoint: the CLI used `synthesizeBlob`,
which produces a self-signed install blob with no relationship to
`.com`. Fix: use `--blob-json` mode with a real `.com`-issued envelope.

### 4.1 The deterministic-IRK problem

Naively deriving the IRK private key on the operator's laptop and
posting it to `/api/usernames/claim` is dangerous: every reader of
this spec can compute alice's IRK and impersonate her. Solution:
**the Worker derives the demo IRK; it never leaves the Worker.**

Two new admin endpoints under `/api/dev/sample-user/`:

```
POST /api/dev/sample-user/admin-claim-and-issue
  Auth: FLAGSHIP_ADMIN_SECRET (bearer)
  Body: { username: string, serverName: string, scopes?: DeviceScope[] }
  Effect:
    1. Reject if the username is non-demo (no demo_users row).
    2. Derive deterministic User IRK:
         HKDF-SHA256(
           salt = 'flagship-demo-irk-v1',
           ikm  = sha256(DEMO_IRK_KEK || ':' || username),
           info = 'user-irk',
           L    = 32
         )
       where DEMO_IRK_KEK is a Worker secret (32 bytes, generated once
       and stored). Putting it through HKDF binds the derivation to
       the cluster-private secret + the demo username; the seed is
       unforgeable without the secret.
    3. Claim the username under that IRK (.com side). Mark is_demo=1.
    4. Mint AuthCode signed with the User IRK. Persist.
    5. Mint InstallBlob signed with the User IRK. Persist build-ticket.
    6. Mint a DeviceCapabilityGrant for the user's PRIMARY device
       (deviceLabel='primary', scopes=default-demo-primary).
    7. Return: { code, blob, blobSignature, primaryGrant }
  Response 200: machine-readable JSON the CLI pipes into
    personalize-iso --blob-json.

POST /api/dev/sample-user/<u>/admin-mint-device-grant
  Auth: FLAGSHIP_ADMIN_SECRET
  Body: { deviceLabel: string, scopes: DeviceScope[] }
  Effect:
    1. Verify the demo_users row exists.
    2. Derive deterministic Device IRK:
         HKDF-SHA256(
           salt = 'flagship-demo-device-irk-v1',
           ikm  = sha256(DEMO_IRK_KEK || ':' || username || '.' || deviceLabel),
           info = 'device-irk',
           L    = 32
         )
    3. Derive the User IRK by the same path as above.
    4. Sign a DeviceCapabilityGrant for (username, deviceLabel,
       devicePubKey, scopes).
    5. Persist in device_capability_grants.
    6. Return: { grant, signature, devicePubHex }
```

Both endpoints are admin-only. Deriving deterministic keys inside the
Worker is safe because:
- `DEMO_IRK_KEK` is a Worker secret with no public exposure path.
- The derivation refuses any username that isn't already in
  `demo_users` — non-demo accounts never get keys derived for them.
- Devs cannot recompute the key without `DEMO_IRK_KEK`; observers
  cannot enumerate the derivation space without it either.

### 4.2 CLI refactor

`scripts/sample-user.mjs create demoalice --display "Demo Alice"`
now executes:

1. Probe `/api/dev/sample-user/<u>` → expects 404. (Demo doesn't exist
   yet.)
2. POST `/api/dev/sample-user/create` (existing endpoint) →
   row exists with `state='none'`.
3. POST `/api/dev/sample-user/admin-claim-and-issue` (new) →
   `{ code, blob, blobSignature, primaryGrant }`.
4. Write `blob.json` to a temp file:
   `{ blob: <blob-json>, blobSignature: <hex> }`.
5. Personalize ISO: `personalize-iso --blob-json <tmp/blob.json>
   --base-iso <cached> --output <tmp/personalized.iso>`.
6. Upload personalized ISO to R2 (existing path).
7. Hetzner provision + rescue + dd (existing path).
8. `awaitDaemonReady` polling `/api/users/<u>/pods` (existing path,
   now-functional after S1).
9. `awaitCert` polling for the green padlock.
10. Hetzner snapshot via `create_image` (existing path).
11. POST `/api/dev/sample-user/<u>/install-complete` with the
    snapshot id.
12. Destroy the temp server.

The CLI never sees the IRK private key. Everything that needs the
key is on the Worker side.

For the reviewer sub-identity:

```
node scripts/sample-user.mjs grant-device demoalice reviewer \
  --scopes browse
```

→ POST `/api/dev/sample-user/demoalice/admin-mint-device-grant`
with `{ deviceLabel: 'reviewer', scopes: ['browse'] }`.

For showcasing corporate setups:

```
node scripts/sample-user.mjs grant-device demoalice work-laptop \
  --scopes browse,install-service,vibe-code
```

The `delete-sample-user` flow drops every DeviceCapabilityGrant for
that user as part of the existing teardown.

---

## 5. Demo flow integration

### 5.1 `/api/users/check` extension

Today's `usersCheck.ts:79-167` returns:
```jsonc
{
  available: false,
  testAccount: { display, ttlHours },          // legacy
  demoServer: { fqdn, status, snapshotId }     // Plan A Phase C
}
```

v2 extension: when the typed username matches `<u>.<device-label>`
AND `<u>` has a demo_users row AND device_capability_grants has a
matching row for (`<u>`, `<device-label>`):

```jsonc
{
  available: false,
  testAccount: { display, ttlHours },
  demoServer: { fqdn, status, snapshotId },
  deviceCapability: {
    label: 'reviewer',
    devicePubKey: '<hex32>',
    scopes: ['browse'],
    grantId: '<uuid>',
    expiresAt: <ms>,
    signature: '<hex64>'
  }
}
```

Backward compatibility: pre-v2 clients (iOS / Android binaries built
before this lands) ignore the `deviceCapability` block; they fall
through into the legacy demo path with no restriction surface. That's
acceptable for demos because the only failure mode is "a reviewer
sees too much" in a binary that was built before the v2 feature
existed.

Worker rejection: when the typed `<u>.<device-label>` doesn't have a
matching grant, the Worker returns 404 with
`{ error: "unknown demo device label" }`. The mobile UI surfaces
"this demo username doesn't exist" with the device-label suffix
visible so the user can correct the typo.

### 5.2 Mobile demo-mode rendering

iOS `apps/mobile/ios/Sources/FlagshipCore/DemoFixtures.swift` +
`apps/mobile/ios/Sources/FlagshipAPI/UsersCheckResponse.swift` +
Android `apps/mobile/android/.../UsersCheck.kt`: when the
`deviceCapability` block is present, materialise a device-scoped
session.

UI surface:

- Account header: under the username, show a small chip
  "`device: reviewer` · browse-only".
- Service-install button: disabled, with tooltip "this device cannot
  install services — use a primary device".
- Vibe-code button: disabled with the parallel tooltip.
- Settings → "About this device" lists every scope explicitly so
  reviewers can see WHY a given action is unavailable.

When the demo server is `up`, the reviewer's device can still see
the full home screen, run all read-only interactions, and click into
service detail pages — same content as the primary device, just no
mutating actions.

### 5.3 Mobile non-demo rendering

For real accounts: the same UI surface is reused. A device that
holds a DeviceCapabilityGrant rendering `scopes: ['browse']` shows
the same chip + tooltip pattern. The Settings → Devices screen lists
all of the user's devices with per-device scope summaries (and a
"Manage scopes" link if the current device has `add-device` +
`revoke-others` — the legacy "owner" power).

A device with no grant on file uses the legacy single-IRK path
(invisible to the user; the chip + tooltips don't appear).

---

## 6. D1 schema

Migration `packages/storage/migrations/0031_device_capability_grants.sql`:

```sql
CREATE TABLE IF NOT EXISTS device_capability_grants (
  -- SHA-256 hex of canonical bytes; deterministic from envelope content.
  grant_id        TEXT PRIMARY KEY,
  -- The user whose IRK signed the grant. Renames change this column;
  -- existing grants get a fresh row under the new username.
  username        TEXT NOT NULL,
  -- Human-meaningful device label. ASCII, RFC-1035-ish.
  device_label    TEXT NOT NULL,
  -- Device's Ed25519 pubkey, 32 bytes hex.
  device_pub_hex  TEXT NOT NULL,
  -- JSON array of DeviceScope strings (sorted; for stable representation).
  scopes_json     TEXT NOT NULL,
  -- ms since epoch.
  issued_at       INTEGER NOT NULL,
  -- ms since epoch.
  expires_at      INTEGER NOT NULL,
  -- Ed25519 over canonical bytes, 64 bytes hex.
  signature_hex   TEXT NOT NULL,
  -- ms since epoch, NULL = active. Set when a RevokeDeviceCapabilityGrant
  -- lands. The grant row is RETAINED so audit / replay paths still resolve.
  revoked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dcg_username    ON device_capability_grants(username);
CREATE INDEX IF NOT EXISTS idx_dcg_device_pub  ON device_capability_grants(device_pub_hex);
CREATE INDEX IF NOT EXISTS idx_dcg_expires_at  ON device_capability_grants(expires_at);

-- One active grant per (username, device_label). Re-issuance produces
-- a new grant row + a tombstone on the previous via revoked_at.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcg_username_label_active
  ON device_capability_grants(username, device_label)
  WHERE revoked_at IS NULL;
```

Storage interface (`packages/storage/src/types.ts`):

```ts
export interface DeviceCapabilityGrantRecord {
  grantId: string;
  username: string;
  deviceLabel: string;
  devicePubHex: string;
  scopesJson: string;
  issuedAt: number;
  expiresAt: number;
  signatureHex: string;
  revokedAt: number | null;
}

export interface DeviceCapabilityGrantStorage {
  put(rec: DeviceCapabilityGrantRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(grantId: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  listForUser(username: string): Promise<DeviceCapabilityGrantRecord[]>;
  getActiveForUserLabel(username: string, deviceLabel: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  getByDevicePub(devicePubHex: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  revoke(grantId: string, revokedAt: number): Promise<void>;
}
```

InMemory + D1 implementations live next to the existing
`Auto­UnlockLeasesStorage` shape. The `revoke()` operation MUST be
atomic with respect to the unique-index constraint: a re-issuance flow
revokes the old row, then inserts the new — D1 surfaces the unique-
index conflict if the order is wrong.

---

## 7. Open design questions — resolved with best judgment

These are answered here as starting points; the owner is asked to
sanity-check before S3.x implementation begins. Each answer is
written to be reversible — the spec's structure supports any of the
alternatives without major rework.

### 7.1 Device label assignment

**Decision:** user types the label at pairing time. The mobile UI
auto-suggests from the device model (`iPhone 15`, `iPad Pro`, `Pixel
8`). Label is editable. Regex `^[a-z0-9-]{1,24}$`; reserved words
listed in §2.

**Flag for owner:** auto-suggest needs a small platform-specific
device-name → label mapping. Specifying it inline here is overkill;
treat it as a follow-on in S3.5.

### 7.2 Default capability set for a fresh device

**Decision:** depends on account-type, per §2.2 above. Single-device
accounts get FULL (matches today). Multi-device accounts get
`['browse']` only. Owner explicitly grants more.

**Flag for owner:** the multi-device "minimal default" optimises for
corporate / restricted-device threat model. For a personal user
adding a second iPad, "browse-only by default" might feel annoying.
Counter-argument: the existing 14-day quarantine already gates
revoke-others; expanding the gate to ALL mutations is a strict
hardening — and the user adds scopes once. Watching this in practice
is worth a v1.2-cascade follow-on.

### 7.3 Demo-account scoping for multiple reviewers

**Decision:** ALL reviewer sub-identities share the underlying VPS
(one server per demo username). They differ ONLY in their
DeviceCapabilityGrant. Cost-multiplier is zero; reviewers see the
same install state.

**Flag for owner:** if reviewers want isolated environments (e.g.
each reviewer's actions don't affect the others' view), the
per-reviewer-VPS multiplier is unbounded and breaks the cost model.
The "shared VPS, capability-scoped views" model is the right v1
default. Per-reviewer isolation is a v2 concern (would need
per-reviewer snapshots + per-reviewer Hetzner servers).

### 7.4 DeviceCapabilityGrant revocation semantics

**Decision:** explicit `RevokeDeviceCapabilityGrant` envelope (IRK-
signed). On apply, `revoked_at = now`. The Worker + daemon both
check `revoked_at IS NULL` AND `now < expires_at` AND `no newer
issuedAt for the same (username, deviceLabel)`. The newer-grant-wins
rule provides automatic supersede; explicit revoke is for "stop the
old key NOW, not at the next reissue".

**Flag for owner:** no further nuance needed. Same shape as
`ServerRevocation`.

### 7.5 Pre-rename pivot

**Decision:** NO. Existing single-IRK accounts continue to work
unchanged. v2 is opt-in by minting the first DeviceCapabilityGrant.
The Worker treats "no grants on file" as legacy mode.

**Flag for owner:** the long-term tax of two modes (legacy single-IRK
+ explicit grants) is real but small — the legacy path is a single
`if (grants.length === 0) returnFullScopes()` branch. Cleaning up to
"always explicit grants" is a strict harden, deferable to whenever
all live accounts have minted at least one grant.

---

## 8. File-by-file appendix (touch list for S3.x)

Each S3.x phase is a single sub-agent / single commit, isolated in a
worktree. Tests live next to the package they touch.

### S3.1 — protocol envelopes + canonical-bytes (single commit)

Touch sites:

- `packages/protocol/src/auth.ts`:
  - Add `DeviceScope` type (line near existing `RevocationReason`).
  - Add `DeviceCapabilityGrant` interface (after `ServiceGrant`, ~line 2720).
  - Add `RevokeDeviceCapabilityGrant` interface.
  - Add `canonicalDeviceCapabilityGrant(g)` + `validateDeviceCapabilityGrantFields(g)`.
  - Add `signDeviceCapabilityGrant` + `verifyDeviceCapabilityGrant`.
  - Add `deviceCapabilityGrantId(g): Promise<string>`.
  - Add canonical bytes for `RevokeDeviceCapabilityGrant` parallel set.
- `packages/protocol/tests/deviceCapabilityGrant.test.ts`:
  - Round-trip canonical-bytes; signature verify; field-validation
    rejects `|` and control chars; expiry rejection; scope sort
    order canonicalization; grantId determinism.
- `packages/protocol/tests/canonicalBytesVectors.test.ts` (extend):
  - Two new vectors covering the new envelopes.
- `packages/protocol/src/test-vectors/canonical-bytes.json` (extend):
  - Vectors for `DeviceCapabilityGrant` + `RevokeDeviceCapabilityGrant`.

### S3.2 — storage schema + adapters (single commit)

Touch sites:

- `packages/storage/migrations/0031_device_capability_grants.sql` (new).
- `packages/storage/src/types.ts`:
  - Add `DeviceCapabilityGrantRecord` + `DeviceCapabilityGrantStorage`.
- `packages/storage/src/inMemory.ts`:
  - Add `InMemoryDeviceCapabilityGrantStorage`.
- `packages/storage/src/d1.ts`:
  - Add `D1DeviceCapabilityGrantStorage` (uses `db.prepare(...)`).
- `packages/storage/tests/deviceCapabilityGrantStorage.test.ts`:
  - InMemory + D1-fake parity; unique-index conflict on duplicate
    active (username, deviceLabel); revoke ordering; lookup paths.
- `packages/storage/src/index.ts`:
  - Re-export the new types + storage class.

### S3.3 — Worker admin endpoints + capability checks (single commit)

Touch sites:

- `packages/control-plane/src/deviceCapabilityGrants.ts` (new):
  - `handleMintDeviceGrant(deps, body)` — IRK-signed body; persists.
  - `handleListDeviceGrants(deps, username)` — paginated list.
  - `handleRevokeDeviceGrant(deps, body)` — IRK-signed revocation.
  - `requireDeviceScope(deps, signerPub, scope) → 'ok' | 'forbidden'`.
- `packages/control-plane/src/demoUsers.ts`:
  - Add `handleAdminClaimAndIssue(deps, body)` — derives demo IRK from
    `DEMO_IRK_KEK` via HKDF (Worker-side); claims username; mints
    AuthCode + InstallBlob + primary DeviceCapabilityGrant.
  - Add `handleAdminMintDeviceGrant(deps, username, body)` — derives
    deterministic device IRK; signs grant; persists.
- `packages/control-plane/src/usersCheck.ts`:
  - Parse `<u>.<device-label>` syntax; look up `device_capability_grants`;
    embed `deviceCapability` block in response.
- `packages/control-plane/src/installService.ts`:
  - Call `requireDeviceScope(signerPub, 'install-service')` before
    accepting an InstallServiceRequest signed by a device IRK.
- `apps/com/src/controlPlaneRoutes.ts`:
  - Route the two new admin endpoints under
    `/api/dev/sample-user/admin-claim-and-issue` +
    `/api/dev/sample-user/<u>/admin-mint-device-grant`.
  - Route `/api/users/:u/device-grants` (GET, public).
  - Route `/api/users/:u/device-grants/revoke` (POST, IRK-signed).
- `apps/com/wrangler.toml`:
  - Add `DEMO_IRK_KEK` to the secrets-required list (in comments;
    actual secret is set via `wrangler secret put`).
- `apps/com/src/rateLimit.ts`:
  - Add rate-limit entries for the new endpoints (5/min for admin,
    20/min/IP for public read).
- Tests:
  - `packages/control-plane/tests/deviceCapabilityGrants.test.ts`.
  - `packages/control-plane/tests/demoUsersAdminEndpoints.test.ts`.
  - `apps/com/test/devGrantsRoutes.test.ts`.

### S3.4 — CLI refactor (single commit)

Touch sites:

- `scripts/sample-user.mjs`:
  - Replace the personalize-iso `synthesizeBlob` call with a
    sequence of admin-endpoint POSTs followed by `personalize-iso
    --blob-json`.
  - Add the `grant-device <user> <label> --scopes` subcommand.
- `scripts/sample-user.test.ts`:
  - Cover the new call sequence with mocked HTTP; verify the blob
    JSON written to disk has the expected shape.
- `docs/sample-users.md` §14 (update):
  - Reference the new flow + the new admin endpoints.
- `docs/sample-user-vps-plan.md` Phase F (update):
  - Mark the gap from 2026-05-20 as resolved.

### S3.5 — mobile + webapp UI (single commit, OR three small commits)

Touch sites:

- `apps/mobile/ios/Sources/FlagshipAPI/UsersCheckResponse.swift`:
  - Add `deviceCapability: DeviceCapabilityBlock?`.
- `apps/mobile/ios/Sources/FlagshipCore/Models.swift` (or analogous):
  - `DeviceCapabilityBlock` mirror of the Worker shape.
- `apps/mobile/ios/Sources/FlagshipCore/DemoFixtures.swift`:
  - Read the new block; populate session-level
    `restrictedScopes: Set<DeviceScope>`.
- `apps/mobile/ios/Sources/FlagshipUI/AccountHeaderView.swift`:
  - Render the device-label chip + "browse-only" badge when scopes
    < full.
- `apps/mobile/ios/Sources/FlagshipUI/InstallServiceButton.swift`:
  - Disable + tooltip when `install-service` not in scopes.
- `apps/mobile/android/.../UsersCheck.kt`: parallel changes.
- `apps/mobile/android/.../DemoFixtures.kt`: parallel.
- `apps/mobile/android/.../AccountHeaderView.kt`: parallel.
- `apps/web/public/webapp/lib/usersCheck.js`:
  - Parse `deviceCapability`.
- `apps/web/public/webapp/lib/ui/installButton.js` (or analogous):
  - Disabled state when scope absent.
- Tests:
  - iOS XCTests cover the demo-fixtures path with a
    deviceCapability block.
  - Android Robolectric tests cover the parser + UI state.
  - Webapp tests under `apps/web/test/`.

---

## 9. Acceptance for v2 device-addressing

Replaces the v2 Phase F acceptance in `docs/next-session-prompt.md`:

1. `node scripts/sample-user.mjs create demoalice --display "Demo
   Alice"` completes with `{"username": "demoalice", "ready": true,
   "snapshotId": "<numeric>"}`. The personalize-iso step uses
   `--blob-json` and the daemon registers successfully on first
   boot.
2. `curl /api/users/demoalice/pods` shows
   `home.demoalice.flagship.services` (HTTP 200).
3. `curl -X POST /api/users/check -d '{"username": "demoalice"}'`
   returns `demoServer` block.
4. `curl -X POST /api/users/check -d '{"username":
   "demoalice.reviewer"}'` returns `demoServer` + `deviceCapability`
   blocks; the latter has `scopes: ['browse']`.
5. `/api/dev/sample-user/demoalice/connect` provisions from snapshot
   in <60s.
6. iOS / webapp typing `demoalice` → full demo UI, all actions
   available.
7. iOS / webapp typing `demoalice.reviewer` → reviewer chip visible,
   install button disabled with tooltip, browsing fully functional.
8. `node scripts/sample-user.mjs grant-device demoalice work-laptop
   --scopes browse,install-service,vibe-code` mints a second device
   grant; typing `demoalice.work-laptop` on mobile shows the device
   chip with the elevated scopes; install button enabled.
9. Idle teardown destroys VPS; re-connect re-provisions.
10. `delete-sample-user demoalice` cleans up snapshot + R2 + D1 row
    + every DeviceCapabilityGrant for that user.

---

## 10. Out of scope for v2

- Threshold-IRK (N-of-M existing devices bless a new one).
- Hardware-attested device IRKs (Apple Secure Enclave attestation
  bound to the device pubkey at registration).
- NFC-tap wearable as second factor (orthogonal to scopes; lives in
  Plan B v1.3+).
- Per-device-IRK migration of the EXISTING IRK-as-shared-key path
  (the v2 spec keeps both modes coexisting).
- Live-pull from `.com` to refresh grants on the daemon for
  cross-device push notifications (deferred; the existing
  paired-session-store path covers this).

---

## 11. Why this design (rationale capture)

- **One envelope, two consumers (demos AND corporate).** The
  DeviceCapabilityGrant shape is identical for `demoalice.reviewer`
  and `harry.work-laptop`. The Worker + daemon code path is one. We
  pay the design cost ONCE.
- **No deterministic-IRK leakage off the cluster.** The demo IRK is
  derived inside the Worker from a Worker-only secret (`DEMO_IRK_KEK`).
  Spec readers cannot reconstruct alice's IRK.
- **Backward-compatible.** Existing single-IRK accounts work
  unchanged. The new envelope is opt-in.
- **Modeled on ServiceGrant.** Canonical-bytes shape, validation
  rules, signature primitives, revocation semantics — all parallel to
  the existing `ServiceGrant` system (auth.ts:2695). Same review
  surface, fewer surprises.
- **Demo flow is the proving ground.** Reviewers literally see the
  device-capability UI; corporate deployments later consume the same
  endpoints. The implementation cost of "ship demos" already buys
  "ship corporate v2".

---

## 12. v2.1 additions landed 2026-05-20 evening

After the original S3.x sub-phases above shipped, four refinements
landed in the same evening as direct iterations on the design:

### 12.1 W1 — `/re-pair/object` is self-cancel only

The original v2 spec inherited v1.1's "old-IRK-signed objection" as
the cancel path. **That was a security mistake**: a device-thief
holding the legitimate owner's device + the OLD IRK could veto every
recovery attempt the legitimate owner made from a fresh device. Per
the credentials-are-the-sole-gate principle (see
`docs/v1.2-security-cascade.md` "Recovery threat model"), recovery
must be unstoppable once initiated.

Fix in `6ccef63`: `handleObjectRePair` now verifies the signature
against the **NEW IRK** (i.e., the recoverer's own fresh key). The
endpoint is preserved purely for the accidental-self-cancel UX
("oops, wrong device, undo"). The device-thief vector is closed
because the thief doesn't hold the NEW IRK.

### 12.2 W6 — per-cloud recovery-wipe policy

Migration 0032 adds `usernames.recovery_wipe_policy TEXT NOT NULL
DEFAULT 'graceful'` (`'strict' | 'graceful'`).

On `handleCompleteRePair`:

- **`'strict'`** (corporate default once opted in): every active
  DeviceCapabilityGrant on the cloud gets `revoked_at = now` after
  the IRK swap. Family / team devices are forced to re-onboard; the
  new admin must mint fresh grants. The "forced re-onboarding"
  property is the point — corporate IT proves who's still a member
  after a recovery event.
- **`'graceful'`** (family default; the migration default): the
  recovering device signs `refreshedGrants` for every existing
  device's pubkey (same scopes; new grant under the new cloud root)
  and POSTs them in the `/re-pair/complete` body. The handler
  validates each (signed-by-new-IRK, devicePubKey matches an existing
  active grant, no scope inflation), persists the new grants,
  revokes the old ones atomically.

Either way the response surfaces `wipedGrantIds` + `refreshedGrantIds`
so the new admin's UI can render concrete counts ("3 family devices
need re-onboarding" or "all 4 family devices kept working").

A graceful re-pair where the recoverer omits `refreshedGrants` is a
no-op on grants — they stay live with their now-dead OLD-IRK
signatures, and `requireDeviceScope`'s defense-in-depth re-verify
will reject them, prompting per-device re-onboarding. Safe degrade.

### 12.3 W7 — wipe-restart revokes every grant

`handleWipeRestart` (the v1.1 "nuclear option" — explicit skip of
the 7-day re-pair grace) now also revokes every active
DeviceCapabilityGrant on the cloud after the IRK rotation, surfacing
`revokedGrantIds` in the response. Per the wipe-restart semantics
this matches strict-mode: the entire cloud is wiped, family devices
must re-onboard.

### 12.4 Lock-release-on-resolution

`pending_re_pairs.username` is the PK, providing structural
single-recovery-at-a-time locking (no two concurrent admin
recoveries can race). Pre-`e94d705`, vetoed or expired-without-
complete rows persisted forever, permanently blocking every future
legitimate recovery for that cloud. The fix sweeps dead rows on the
next INITIATE: lock stays armed during a live dispute, releases
naturally on resolution.

### 12.5 Hyphenated demo usernames in `/users/check`

`validateUserLabel` rejects hyphens (the no-hyphens-in-usernames
rule that makes the `<creator>-<slug>` serviceId composite parse
unambiguously). But DEMO usernames legitimately carry hyphens
(`demoalice`). The lookup order in `handleUsersCheck` was wrong
pre-`4315993` — the hyphen rejection fired BEFORE the demoUsers
lookup, so `/users/check {"username":"demoalice"}` returned
`{available: false, reason: "no hyphens"}` even though the demo
existed. Mobile demo-mode silently broke for every hyphenated demo
name.

Fix: demoUsers + testAccounts lookup FIRST; if either matches, return
the demo-aware response (with the `demoServer` block and optionally
the `testAccount` block). Only on a miss does validateUserLabel
fire. Real accounts (which can't have hyphens by design) hit
validateUserLabel exactly as before.

### 12.6 Cumulative test count

These four refinements added 11 tests (W1 +3, W6 +13, W7 +3, lock +2,
hyphen +1; deltas overlap with W1's same file). vitest at session end:
**3104 passing across 257 files** (up from 3087 baseline before this
evening's work).

---

## 13. Multi-profile mobile model (W3 + W8)

A "cloud" is what we've been calling a "username." Each cloud has one
root key (today's IRK). One phone can host MULTIPLE profiles — e.g.
the user's personal cloud `harry`, their family cloud `jay-family`,
and a corporate cloud `work-acme`. Each profile binds the phone to
one cloud. The Phase F demo case is one profile per phone;
multi-profile is the v2 capability that makes corporate / family
setups work.

### Wire shape

Each profile descriptor carries:

```
Profile {
    cloudName         : the cloud's username
    cloudRootPubHex   : the IRK pubkey (32-byte hex). PUBLIC identifier
                        — the matching private key never leaves the
                        Keychain / Android Keystore.
    deviceLabel       : optional human label ("phone", "ipad", "reviewer")
                        from the v2 DeviceCapabilityGrant
    deviceCapability  : optional embedded DeviceCapabilityBlock (the
                        same wire shape returned from /api/users/check;
                        see §5.1)
    demoServer        : optional DemoServerBlock (Plan A demo mode)
    createdAt         : timestamp the profile was first added
}
```

iOS: `apps/mobile/ios/Sources/FlagshipCore/AppState.swift` — `Profile`
struct + `AppState.profiles` + `activeProfileCloudName`.

Android: `apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/AppState.kt`
— `Profile` data class + `AppState.profiles` + `activeCloudName`.

Webapp: `apps/web/public/webapp/lib/profiles.js` — `loadProfiles`,
`saveProfiles`, `addProfile`, `setActiveProfile`, `getActiveProfile`,
`renderProfilesDropdown`. Persisted in localStorage under
`flagship.profiles.v1`.

### Switching profiles

`setActiveProfile(cloudName)` mirrors the chosen profile's session
state into the legacy single-identity fields (`currentUser`,
`deviceCapability`) so existing callsites that read those don't need
to change. Pods are NOT carried across — the new cloud's pods are
fetched fresh from `/api/users/<u>/devices` after the switch.

### W8 — iCloud Keychain attribute split (security invariant)

iCloud Keychain syncs items across the user's Apple-ID devices when
`kSecAttrSynchronizable` is true. The cloud ROOT key (today's wrapped
UMK / IRK / ephemeral pubkey) MUST sync — otherwise iCloud-restore on
a new iPad can't pull the cloud identity through and the user is
locked out. Per-device DEVICE-IRKs (when we ship the device-IRK split)
MUST NOT sync — otherwise a freshly restored iPad clones an existing
device's identity, defeating per-device addressability.

The `Keystore` wrapper exposes a `KeychainSyncClass` enum
(`cloudRoot` / `deviceLocal`) and a `keychainWrite(..., sync:)`
variant that sets the right flag:

| `KeychainSyncClass` | `kSecAttrSynchronizable` | `kSecAttrAccessible`                                     |
| ------------------- | ------------------------ | -------------------------------------------------------- |
| `.cloudRoot`        | `true`                   | `kSecAttrAccessibleAfterFirstUnlock` (syncs across)      |
| `.deviceLocal`      | `false`                  | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`       |

Today every key the production daemon writes is cloud-root class
(we still hold the cloud IRK directly — no separate device-IRK yet).
The enum is plumbed in so the future device-IRK split has a typed
home and the cross-platform sync discipline is reviewable in one
place.

Android has no iCloud-style auto-sync of secrets across devices
sharing a Google account. `KeychainSyncClass` is carried as a
type-level marker only — every Android write is implicitly
device-local today. If we ever ship Google-Account-backed sync, the
same discipline applies.

### Test surface

- iOS: `Tests/FlagshipMobileTests/MultiProfileTests.swift` +
  `KeychainSyncClassTests.swift`.
- Android:
  `app/src/test/java/com/flagshipserver/app/core/MultiProfileTest.kt`.
- Webapp: `apps/web/tests/profiles.test.ts`.
