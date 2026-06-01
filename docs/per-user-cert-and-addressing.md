# Per-user TLS cert + addressing — launch-architecture spec

**Status:** spec / decided. Pending implementation. The user-facing
*contract* (§2, §3, §4, §5) ships before public launch; the multi-box
*machinery* (§7 "deferred") activates with the user's second box.

**Sequencing:** land **after c4.6** (the v2 de-version rename). This
touches `serverRegister` / DNS publishing / cert-SAN construction — the
same files c4.6 is migrating. Do **not** interleave two migrations
through that surface; one atomic green commit after c4.6.

**Supersedes:** the *URL forms* table and the *per-pod user-zone
wildcard cert* assumption in [[multiplexing]]. The HELLO /
`controlledDomains` / last-HELLO-wins / sibling-WS machinery in that doc
is unchanged and load-bearing here — only the cert shape and the public
URL canonical change.

**Reconcile with:** [[v2-device-addressing-and-real-ticket]] — device
labels (`<device-label>.<user>.flagship.services`) share the *same*
`*.<user>` leftmost-label space as app labels and box-coordination
names. See §3.4: there is exactly one per-user leftmost-label resolver.

**Revocation vocabulary:** reuse the three actions already specced in
[[revocation-ui]] / [[multi-device]] / [[wipe-restart]] — Disconnect /
Replace / Wipe. §5 maps cert/key revocation onto those, it does not
invent new ones.

**NOT the maintainer CA.** This is the **Let's Encrypt TLS cert** that
terminates user content on the box. It is a *different layer* from the
Flagship identity CA in [[ca-operations]] (`UserPubKeyBinding` /
`CaEndorsement` / the maintainer YubiKey). Don't cross the wires. The
two share one design instinct, called out in §5: *the real-time control
is routing authority, re-issuance is slow secondary cleanup — there is
no "re-issue every key" privileged daemon.*

---

## §0 The decision, in one paragraph

Move from **one Let's Encrypt cert per box** to **one cert per user**.
SANs collapse from `[<user>, *.<user>, *.<server>.<user>]` (per box) to
`[<user>, *.<user>]` (per user). Apps are addressed at
`<label>.<user>.flagship.services`, served by whichever box currently
owns the name (the *leader*; with one box that box is trivially the
leader). Box names demote from public app URLs to internal box-to-box
coordination addresses, still TLS-reachable under the same `*.<user>`
wildcard. The cert is **minted by the user's trust-root devices** (phone
+ webapp), distributed to the user's boxes inside the harness trust
domain, and **never seen by service code**. Revocation is enforced at
the **routing layer** (the per-box identity key), not the cert.

---

## §1 Why — three independent drivers

Each of these is true *without* the others, and none of them needs the
multi-box replication machinery to hold.

1. **The cert must pin to the most-stable identifier, not the least.**
   Today the cert embeds `*.<server>.<user>` — the box's *renameable*
   DNS label. A box can be renamed, replaced, reinstalled, lost, or
   demoted; the username is the thing that survives. Per-user pins the
   cert to the username, so a box rename becomes a pure DNS/routing
   operation instead of a forced LE re-issuance. (Server rename is not a
   built feature today — `ServiceRename` at
   `packages/protocol/src/auth.ts:1735` renames an *app* stem and keeps
   the stable-id — so this is "design it right *before* we build rename,
   never after.")

2. **Public URLs must express user intent, not machine topology.** Once
   a user shares `<app>.<server>.<user>.flagship.services`, the box
   label is part of the product contract forever. We are pre-launch with
   zero shipped users; this is the one cheap moment to remove topology
   from the URL. Post-launch it is a live-URL migration.

3. **Rate-limit headroom (the *minor* driver — do not lead with it).**
   The LE limit is per *registered domain* (`flagship.services`), shared
   across all users; default is **50 new certs / registered-domain / 7
   days** plus **5 duplicate certs / identical-SAN-set / 7 days**. We
   hold an override to ~3000–5000/week, but **do not design the core
   path assuming a high override** (second-opinion guidance). Per-user
   reduces cert count proportional to boxes-per-user, which is small for
   the single-box majority. The real ceiling fix, if ever needed, is
   delegated per-user DNS zones — out of scope here.

---

## §2 The cert model

- **SANs:** `["<user>.flagship.services", "*.<user>.flagship.services"]`.
- **Drop:** the per-box `*.<server>.<user>.flagship.services` SAN.
- **The `*.<user>` wildcard covers two planes on one cert:**
  - **Public app plane:** `<label>.<user>.flagship.services` (one label
    deep, leader-served).
  - **Box-coordination plane:** `<server>.<user>.flagship.services` (one
    label deep). Box apexes stay TLS-reachable for `/.flagship/*`
    sibling endpoints — they are matched by `*.<user>`, *not* by the
    dropped per-box SAN. **Demoting the box name does not remove it from
    the cert.** This was the key realization: we only lose
    `<app>.<server>.<user>` (app-under-box, two labels deep), which the
    new addressing retires anyway.
- **Issuance:** still ACME DNS-01 over the `flagship.services` zone we
  control (`packages/server-daemon/src/acme/letsEncryptIssuer.ts:192`).
  Wildcards have no TLS-ALPN-01 option; non-wildcard SANs also go DNS-01
  whenever a DNS writer is configured (always, in production).
- **Renewal:** unchanged cadence (90-day cert, renew at 60-days-
  remaining → ~monthly; `runtime.ts:77`, `:651`). See §4-B on *who*
  drives renewals.

---

## §3 Addressing scheme

### §3.1 Forms

| Form | Example | Meaning | On the per-user cert? |
|---|---|---|---|
| `<label>.<user>` | `photo-album.harry` | app, leader-routed (default) | yes (`*.<user>`) |
| `<label>--<server>.<user>` | `photo-album--home.harry` | app, **pinned to a box** (rare escape hatch) | yes (`*.<user>`) |
| `<server>.<user>` | `home.harry` | box coordination apex (`/.flagship/*`) | yes (`*.<user>`) |
| `<device-label>.<user>` | `reviewer.harry` | device view — see [[v2-device-addressing-and-real-ticket]] | yes (`*.<user>`) |

All four are **one label deep** under `<user>`, so the single per-user
wildcard covers everything. There is no two-label-deep public name.

### §3.2 Label is a *local name*, not an identity

The leftmost label is **Harry's own name for his installed copy**, in
Harry's namespace. It only needs to be unique *among Harry's installs* —
`game.harry` and `game.alice` never collide because they are different
zones.

- **Default label = the bare slug** (`game.harry`).
- **`(slug, author)` is the durable stable-id**, held in metadata, *not*
  in the URL. Updates, lineage, marketplace, and access-control ride the
  stable-id (`auth.ts:2902` "Stable across author renames"); **nothing
  in routing, auth, updates, or sharing reads the author out of the URL
  string.**
- **`-author` is only a collision-breaker.** If two installed apps want
  the same local label, the user renames one (`ServiceRename` already
  exists, stable-id survives) **or** the system auto-suffixes `-<author>`
  so an install never hard-fails. The suffix is a fallback, never the
  canonical form. This *retires* multiplexing.md's
  `<slug>-<creator>.<server>.<user>` canonical.

### §3.3 The `--` pin operator and dash rules

Pinning to a specific box is a rare power-user / debug escape hatch and
**must not become the primary public URL style** (else topology leaks
back in through the side door).

- **Single `-`** is an ordinary character inside a label — labels may
  contain dashes (`photo-album`). Routing treats the label as opaque and
  looks it up; dashes don't matter for the common form.
- **Double `--`** is the reserved **pin operator**: `label--server`.
  Split the leftmost label on the *first* `--`: left = label, right =
  box name.
- **Validation rules** (new, in the slug/label validator):
  - A label must not contain `--` (reserve it for the operator).
  - A box name must not contain `--`.
  - The segment before `--` must not be exactly 2 characters, and no
    label may begin `xn--` — both avoid the IDN / punycode R-LDH
    reservation (RFC 5890: hyphens at character positions 3–4 are
    reserved).

> **Why `--` and not "ban dashes in slugs":** DNS labels are
> `[a-z0-9-]` only — no underscore (invalid in hostnames), and a `.`
> would create a deeper label needing the per-box wildcard we are
> deleting. So `-` is the *only* available separator, and the only way
> to keep readable multi-word labels (`photo-album`) is to reserve the
> *double* dash as the operator.

### §3.4 ONE per-user leftmost-label resolver (reconciliation — important)

App labels (§3.2), box-coordination names (`<server>`), pin targets
(`label--server`), and **device labels** from
[[v2-device-addressing-and-real-ticket]] all live in the *same*
`*.<user>` leftmost-label space. They MUST be resolved by a single
per-user resolver and MUST be mutually unique within a user.

Resolution order for a leftmost label `L` under `<user>`:

1. If `L` contains `--` → parse `label--server`, route to that box
   (pin). 
2. Else if `L` equals a registered **box name** for this user → box
   coordination apex (`/.flagship/*`).
3. Else if `L` is a registered **device label** → device view (v2
   device-addressing capability scopes apply).
4. Else look `L` up in the user's **install table** → leader-route to
   that service.
5. Else → the disambiguation / "not pointing at an app" page
   (`runtime.ts:1346`).

**OPEN (Q3):** the install table, the box-name registry, and the
device-label table are three sources today. The resolver above assumes a
*merged* per-user name table (or a deterministic precedence across the
three) with a uniqueness constraint spanning all of {app-label,
box-name, device-label}. Specify and enforce that uniqueness — it is the
one genuinely new cross-cutting invariant. Reconcile against the v2
device-addressing contract before implementing.

---

## §4 Cert key custody & issuance authority

### §4.1 Who mints

**The user's trust-root devices mint** — phone **and** webapp (the
webapp is a co-equal peer with its own UMK/IRK, not a phone-remote; see
[[webapp-device-family]] / memory `feedback_webapp_is_peer_not_remote`).
**Not the boxes. Not `.com`.**

Rationale: if `.com` ever held the cert key (even transiently during
issuance) it could forge user TLS, breaking the "control plane cannot
forge content" property. Minting at the trust root keeps the key out of
`.com` and originates the shared secret at the root rather than on a box
we then have to trust.

### §4.2 Split the two secrets — this is the part the proposal was missing

| Secret | Lives | Shared to boxes? | Lifetime |
|---|---|---|---|
| **ACME account key** (issuance *authority*) | trust-root devices only | **never** | durable; recovery-root material |
| **Cert keypair** (the TLS key) | trust root + authorized boxes | **yes** (the per-user shared secret) | disposable; rotated each issuance |

A box compromise then leaks a *disposable* cert key (rotate it; §5) but
**never the authority**. The phone re-issues without ever having trusted
a box to hold anything durable.

### §4.3 CAA pinning + Certificate Transparency (new — closes the active-MITM gap)

`.com` controls the `flagship.services` DNS zone, so it can *always*
satisfy DNS-01 and silently mint a cert for any user's namespace. Today
that is a latent active-MITM capability. Close it:

- **CAA `accounturi` + `validationmethods` (RFC 8657)** pinning issuance
  to the user's phone-held ACME account. LE then refuses issuance from
  any other account. `.com` could still rewrite CAA, but that is visible
  in DNS history and the resulting cert appears in CT logs.
- **CT monitoring** on the trust-root device: watch Certificate
  Transparency for `*.<user>.flagship.services`; alarm on any cert the
  user did not mint.

Net: this upgrades Flagship from "control plane can't *read* content" to
"control plane can't *forge* content without being detected" — a real
strengthening that is only coherent *because* the phone is the issuance
root.

### §4.4 Recovery

The ACME account key is now trust-root material. Fold it into the
existing UMK/IRK recovery path (Recovery J.3/J.4 re-pair; WebAuthn-PRF
cloud recovery) so phone loss does not permanently brick issuance.

### §4.5 Service code never sees the key

Already true and preserved: the daemon/harness terminates TLS, sandboxed
app containers sit behind it. Per-user only re-scopes the key from a
*per-box* secret to a *per-user* secret within the harness trust domain.

---

## §5 Revocation model

**Core principle (the load-bearing security argument):** the certificate
is **not** the access-control primitive — **routing authority is.** A
stolen cert key is *necessary but not sufficient* to impersonate a
user's apps; the attacker also needs traffic *delivered* to their box,
and delivery is gated by the per-box identity/routing key at the Fly hub
(RCK target + STK authorization at `.com`), which is phone-held and
per-box revocable. Cut the routing and the stolen key is inert.

This mirrors [[ca-operations]]'s "there is no re-issue-every-key daemon"
philosophy: the fast control is authorization/refetch, not bulk
re-issuance.

### §5.1 Soft revocation — *decommission / reformat* (box trusted)

The key was never exposed to an adversary. Steps:

1. Eject the box from the cert-replication set (stop sending it future
   cert material).
2. Revoke its routing authority (drop STK authorization at `.com` /
   re-point RCK).

**No re-mint.** The retired box's cert copy stays valid but useless (no
traffic routes to it). Maps to **Disconnect** in [[revocation-ui]].

### §5.2 Hard revocation — *stolen / compromised* (key exposed)

Four steps, and **the order is an invariant**:

1. **Revoke routing authority FIRST** — RCK re-point + drop the box's
   STK from the authorized set at `.com`. This is the *immediate,
   real-time* cutoff; no Let's Encrypt in the path; effective in
   seconds. **This is the step that actually stops the attack.**
2. **Eject the box from the cert-replication mesh** — *before* the
   re-mint, or you hand the new key straight to the attacker.
3. **Re-mint** a new cert keypair, distribute only to the remaining
   authorized boxes.
4. **CA-revoke the old cert** (OCSP/CRL) — belt-and-suspenders against
   an off-path MITM who already holds network position.

If you re-mint before steps 1–2, the leak propagates. Maps to
**Replace** (re-mint) / **Wipe** (re-mint + scrub) in [[revocation-ui]].

### §5.3 Trigger axis = "was the key ever exposed in cleartext to an untrusted party"

Anchor the soft/hard choice to the box's power state, leaning on
existing primitives:

- **Stolen powered-off** → LUKS-at-rest + unlock-lease *decay* already
  neutralize it (the box can't re-derive its unlock key on reboot
  without the phone; see `auto_unlock_lease_design`). Trends **soft**.
- **Stolen running + unlocked** → key is live in memory/disk → **hard**.
- **When in doubt, hard.** Cost asymmetry: a needless re-mint is cheap;
  a missed compromise is catastrophic.

### §5.4 Rate-limit interaction (why routing-revocation must be primary)

Every hard-revocation re-mint produces the **same** SAN set
(`[<user>, *.<user>]`) → it consumes the LE **duplicate-certificate
limit (5 / identical-SAN-set / 7 days)**. A flapping box, a re-mint
loop, or an attacker deliberately forcing rotations can exhaust a user's
issuance for the week. Therefore:

- Routing-revocation (§5.2 step 1) is the **primary, unlimited, instant**
  control.
- Re-mint + CA-revoke (steps 3–4) are **secondary, rate-limited, slow**
  cleanup.
- **Debounce / rate-limit hard-revocations** so the cleanup path can't
  be weaponized into an issuance DoS.

---

## §6 Blast-radius analysis (answering the second-opinion objection)

The objection: a per-user *shared* key means one compromised box can
serve TLS for the whole `*.<user>` namespace, not just its own apps.

True in theory; bounded in practice for Flagship specifically:

- **At launch there is no increase** — single-box users have one box
  that already serves everything.
- **Boxes can't mint** (§4) — a compromised box gets no fresh certs and
  cannot extend its own authority.
- **Routing authority is phone-held and per-box revocable** (§5) — the
  compromised box can't *deliver* traffic to itself once cut, even
  holding the key. Claiming a sibling's name requires winning the
  routing claim (last-HELLO-wins / RCK), which the phone counters.
- **Re-mint + CA-revoke** kills the stolen key; **short-lived certs**
  (§9-B) bound the window.

So the per-user key is *necessary but not sufficient* for impersonation;
routing authority is the other half, and it is the crisp, phone-held,
per-box-revocable primitive it should have been anyway. The objection
converts into a reason to make routing authority first-class.

---

## §7 Launch-vs-deferred split

**Ship now — the contract (cheap because single-box):**

1. Per-user cert SANs `[<user>, *.<user>]`; drop `*.<server>.<user>`.
2. `<label>.<user>` addressing + `--` pin operator + the §3.4 resolver.
3. Local-label-defaults-to-slug; `(slug, author)` as hidden stable-id;
   `-author` as collision fallback only.
4. Trust-root devices as issuance authority; **account-key / cert-key
   split**; CAA-pin + CT monitor.
5. Per-box routing authorization independently revocable; soft/hard
   revocation semantics (§5) with the ordering invariant.
6. The app-manifest `replication: "leader" | "isolated"` flag
   **declared but inert** (default `isolated` = today's per-pod
   behavior). The contract exists; the machinery lands later.

**Deferred — the machinery (activates with box #2, must be *anticipated*
by the contract above):**

- Cert-replication **mesh**: mutually-authenticated harness peers,
  phone-authorized enrollment, **quarantine new peers**, audit log,
  explicit "this box may serve public TLS for my namespace" capability.
  Reuse the existing lead-pod→sibling pattern in
  `packages/server-daemon/src/acme/customDomainCert.ts`.
- **Delegated autonomous renewal** (see §9-A).
- **Unified instance** under `replication:"leader"`: all reads+writes
  route to the leader; followers hold a warm replica purely for
  failover; single-writer ⇒ no distributed conflict resolution. Live
  read/write forwarding + Postgres/MinIO failover replication. (Today
  the harness explicitly does **not** replicate app state —
  `docs/app-developer-guide.md`: "Services own consistency. The harness
  owns distribution fabric." This flag is the opt-in that changes that,
  per app.)
- **Leader determinism / split-brain avoidance:** one active leader per
  label, short DNS TTLs, conflict resolution, safe failure mode.

---

## §8 Implementation inventory (file:line touchpoints)

Verified 2026-06-01. Re-grep before editing; c4.6 may have shifted lines.

**Cert SANs**
- `packages/server-daemon/src/runtime.ts:449-463` — SAN construction →
  `[userZone, "*."+userZone]`; delete the `*.${serverFqdn}` entry.

**Zone naming / validation**
- `packages/services-zone/src/validation.ts`
  - `userWildcardSans` (153-159) → make this the active path.
  - `serverWildcardSans` (168-177) → deprecate (keep for internal box
    naming only, never for the public cert).
  - `appFqdn` (183-190) → `<label>.<user>`; drop the `serverName` arg.
  - `validateAppSlug` (100-109) → add the `--` / `xn--` / 2-char-segment
    rules (§3.3); add a `parsePinLabel(label)` helper.

**Routing / SNI**
- `packages/server-daemon/src/runtime.ts:1387-1396` (`userZoneOf`),
  `:1398-1405` (`leftmostLabel`), `:510-536` (SNI route +
  disambiguation) → implement the §3.4 single resolver: parse `--`
  pins, distinguish box-name vs device-label vs install-table app-label.

**DNS publishing (2 records, not 4)**
- `packages/services-zone/src/serverDns.ts:85-86`
- `packages/control-plane/src/serverRegister.ts:237-254` (+ `userZoneOf`
  dup at `:291-300`).

**Image / Caddy**
- `packages/bootkey-builder/src/caddyfile.ts:11-39` (`CaddyContext`,
  `appFqdn`, `serverWildcardSelector`).
- `packages/bootkey-builder/src/buildPlan.ts` — `newServerId` becomes an
  internal box id, not a public-URL component.

**Identity / stable-id / manifest flag / ACME authority**
- `packages/protocol/src/auth.ts` — `ServiceRename` (1735), stable-id
  (2902), `ServiceGrant`/`ServiceEntitlement`; **add** the manifest
  `replication` flag type; **add** the ACME-issuance-authority +
  account-key-vs-cert-key envelope types and the CAA-pin record.

**ACME**
- `packages/server-daemon/src/acme/letsEncryptIssuer.ts:192-213` —
  challenge selection (unchanged shape; new: authority lives off-box).
- `packages/server-daemon/src/acme/customDomainCert.ts` — **the pattern
  to reuse** for per-user cert distribution (lead → sibling, signed,
  receive-only siblings).

**Storage**
- `packages/storage/src/schema.ts:12-42` — `servers` / `auth_codes`;
  add the per-user uniqueness invariant (§3.4) and the stable-id ↔
  local-label mapping.

**Tests to update / add**
- `packages/services-zone/tests/validation.test.ts:73-83`
  (`serverWildcardSans` "multi-server v1" — rewrite for per-user).
- `packages/server-daemon/tests/acmeLetsEncrypt.test.ts:400` (PROD_SANS).
- `packages/server-daemon/tests/certRetryLoop.test.ts:5`.
- `packages/control-plane/tests/serverRegisterUserZoneDns.test.ts`
  (4-record → 2-record).
- New: `--` pin parsing; the §3.4 resolver precedence; CAA-pin record;
  account/cert-key split; soft/hard revocation ordering.

---

## §9 Open questions / decisions still owed

- **Q-A. Renewal availability vs minting control.** Phone-only minting
  creates a phone-availability dependency at each renewal — a regression
  from today's autonomous boxes. Separate *issuance/rotation/re-mint*
  (root-only, rare) from *steady renewal* (frequent). Options: (a) wide
  renewal window (~30d) + webapp as co-equal minting peer; (b) a narrow,
  time-boxed, **per-box-revocable** "renew the existing namespace cert"
  capability delegated to the harness. **Decide which, or both.**
- **Q-B. Short-lived certs.** LE's ~6-day short-lived profile is the
  strongest blast-radius mitigation for a shared key, but forces
  frequent renewal — incompatible with phone-only minting and heavier on
  rate limits. Adopting it *requires* Q-A's delegated autonomous
  renewal. **Adopt at launch or defer?**
- **Q-C. Trust-domain segmentation** (the reviewer's rejected-for-launch
  alternative): one cert per user *per trust group* (home boxes vs
  office/experimental). Adds value later for corporate splits; probably
  defer. Note it so the name table doesn't foreclose it.
- **Q-D. ACME account-key custody across phone + webapp peers** and its
  exact recovery semantics (§4.4). Where does the account key live when
  there are two trust-root devices; how is it re-established on loss?
- **Q3 (from §3.4). The merged per-user leftmost-label namespace** —
  uniqueness spanning {app-label, box-name, device-label}, and the
  precedence across the install table / box registry / device-label
  table. Reconcile with [[v2-device-addressing-and-real-ticket]] before
  coding the resolver.
- **Q-E. Mesh ejection ↔ re-mint atomicity** (§5.2): how is "the box is
  out of the mesh" *confirmed* before step 3 in a partition?

---

## §10 Sequencing & rollout

1. **Wait for c4.6** to land (the v2 de-version rename) — shared surface.
2. **One commit, contract only** (§7 "ship now"). Single-box reality
   means no mesh/replication code; the manifest flag is inert. Green
   `npx vitest run` + `npx tsc -b` before push.
3. **Live-smoke** a fresh build chain (dev/create-server → build →
   daemon → real green padlock) on the per-user cert before trusting it.
4. **Defer §7 "machinery"** until the first real trigger fires: a user
   runs a second box, a real app needs unified data / seamless failover,
   or we ship server-rename.

**For the implementer (cold-start on another machine):** read this doc
end-to-end, then `docs/SESSION-HANDOFF.md` §0 for current gate state,
then re-grep every §8 line number (c4.6 will have moved them). Build §7
"ship now" only — the flag is declared inert; do not build the mesh or
the replication. Conventions: `CLAUDE.md` (no `Co-Authored-By` trailer;
imperative commit subject; body explains *why*).
