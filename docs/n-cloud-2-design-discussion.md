# N-CLOUD-2 — design discussion

**Status**: open (decisions deferred; this doc collects the questions
N-CLOUD-2 has now made load-bearing).

**Scope**: operational implications of (a) serializing every branded
box at manufacture, and (b) exposing `/api/serial/activate` to retail
or distribution partners.

Wire-in landed in commit *(see commit log; this doc tracks the design
trade-offs the code commit deliberately deferred)*. The code chose the
minimum-risk path on every dimension so the trade-offs could be argued
on paper before we lock in.

---

## 1. The picture today (what N-CLOUD-2 actually does)

- Box hardware ships with a unique `serial` (e.g. `BX0042`) inserted
  into the `box_serials` D1 table at manufacture time.
- At point-of-sale (or first activation), a retailer hits
  `POST /api/serial/activate` with an HMAC over
  `flagship/serial-activate/v1|<serial>|<sku>|<retailerId>|<at>`,
  signed with `FLAGSHIP_RETAILER_HMAC_SECRET`. The row's `activatedAt`
  flips from `null`.
- On first registration, the daemon's `POST /api/server/register` body
  includes `boxSerial`. The Worker calls `enforceActivated` →
  `boxSerials.bindStk()`, which atomically:
  - 403 `unknown box serial` if the serial isn't in `box_serials`.
  - 403 `box serial not activated` if `activatedAt` is null.
  - 403 `box serial already bound to a different server identity` if
    the row's `stkPubHex` is set to a different Ed25519 key.
  - Otherwise binds `stkPubHex` to the server's Ed25519 identity, sets
    `suffix6` to its last 6 hex chars, and proceeds with registration.
- Self-built / Debian / Alpine boxes (no `boxSerial` in the body)
  skip the entire block — no behaviour change.
- The Worker config that doesn't inject `boxSerials` into the deps
  is **fail-closed** for any incoming `boxSerial`: 403
  `box serial enforcement not configured`. The wire-in won't silently
  accept a branded-box claim that nobody verified.

The wire-in's `boxSerial` field is **carried unsigned** at the body's
top level, sibling to the signed `request`/`signature` envelope. The
integrity of "this box owns this identity" comes from
`bindStk`'s atomic first-claim semantic — a MITM cannot **swap**
identity for a known-bound serial without losing the existing bind,
and a MITM that **strips** the boxSerial from a branded-box claim
just downgrades that box to the self-built path, which is the SAME
posture as a real self-built box (no security regression).

That's the floor. Everything below is a question this commit didn't
need to answer to ship.

---

## 2. Operational impact of serializing every branded box

### 2.1 Cost per unit at manufacture

The marginal cost of inserting a row into `box_serials` is negligible
(D1 writes batch cheaply; ~$0 at any reasonable scale). The real costs:

| Item | Estimate | Notes |
|---|---|---|
| Pre-allocating SKUs + serials in CI | ~0 | A scripted batch insert per production run. |
| Embedding the serial in the box image | 0 cost in code, ~5 min process per SKU | The serial gets baked into the box's identity blob at imaging time. SKU-specific image per production batch. |
| QA: every box exits the line with a unique serial | $0–0.50/unit | If the manufacturer already has a unique-ID step (most do for serial numbers etched on cases), reuse it. Otherwise add a station. |
| Anti-collision: SKU/serial uniqueness across batches | 0 cost in code | Composite primary key on `(sku, serial)`; CI rejects a batch with collisions before manufacture starts. |

**Punch line**: the per-unit cost is essentially "the marginal cost of
having a unique serial at all," which most contract manufacturers do
already. The novel cost is operational discipline (`scripts/mint-serials.sh`
+ a wrangler-d1 upload step before each production run) rather than
hardware.

### 2.2 Secret distribution at scale

The `FLAGSHIP_RETAILER_HMAC_SECRET` is the load-bearing thing here. As
of this commit it's a **single shared secret** — every retailer who
activates serials uses the same secret. Trade-offs:

| Issue | Shared secret (today) | Per-retailer secret |
|---|---|---|
| Leak of one retailer's terminal | ALL retailers' activations forgeable | Only that retailer's bucket |
| Revocation | Roll the secret + re-deploy + redistribute to every retailer atomically | Rotate one row in a secrets table |
| Audit | `retailerId` is self-asserted in the body; no cryptographic binding to a real retailer | HMAC key tied to retailer identity in the table |
| Deploy complexity | One Cloudflare secret | A new D1 table `retailer_secrets` + a key-management surface |

**The shared-secret v1 is fine for a single-channel direct-sell launch**
(you control every terminal that activates). The moment a second
distributor exists, we should move to per-retailer secrets. The
migration path is straightforward — the canonical bytes already include
`retailerId`; we just stop trusting a single global secret and start
keying lookups on `retailerId`. See §3 for the API-shape changes that
follow.

### 2.3 Scale (how many serials, how often)

Back-of-envelope:

- 100K boxes/year ⇒ ~273 activations/day average, ~3 per peak hour at
  the worst quarterly distribution. The Worker handles this with the
  existing rate limit; nothing exotic needed.
- 1M boxes/year ⇒ ~2740 activations/day. Still trivial for D1 writes.
- `box_serials` table at 100M rows: ~10GB at our schema (serial +
  sku + activated_at + activated_by + stk_pub + suffix6 + bound_at +
  created_at, with composite indices). Within D1's per-database limit,
  but starts wanting a read-replica strategy if we ever ship
  `GET /api/serial/:serial/status` at higher fan-out.
- Suffix6 collisions (rendezvous lookup): with 1M activated boxes,
  expected collisions per suffix6 = 1M / 2^24 ≈ 0.06 — i.e. the
  rendezvous lookup almost always returns a single candidate, and the
  phone's NFC-captured full key disambiguates the rare collision. Even
  at 100M boxes (6 candidates per suffix on average) the disambiguation
  set fits in one response.

**Capacity is not a question. Operational discipline is.**

### 2.4 Failure modes the wire-in introduces

| Failure | Trigger | Surfaced as | Recoverable? |
|---|---|---|---|
| Box's serial gets corrupted between manufacture + first boot | Bad write to the box's identity blob during imaging | 403 `unknown box serial` | Re-image the box; the recipe is still good. |
| Retailer never activated this serial | Box was sold but the PoS step skipped | 403 `box serial not activated` | Retailer (or owner via a self-service "activate via app" path we haven't built) hits `/api/serial/activate`. Recipe still valid. |
| Same serial registered with a different identity (resale, factory reset) | User wipes box → new identity key → reuses old serial | 403 `box serial already bound to a different server identity` | **No clean recovery path today.** See §5.1. |
| Worker rejects because `boxSerials` storage not configured | Mis-deployed Worker | 403 `box serial enforcement not configured` | Fix the deployment; recipe still valid. |
| Worker slow on the `bindStk` D1 round-trip | D1 hot-spot | Existing rate limit kicks in; user's daemon retries on next backoff | Self-healing. |

The wire-in adds **one extra D1 write** per branded-box registration.
Latency impact: ~10-30ms on a cold registration; <5ms on a warm one
(D1 caches). Self-built registrations see zero additional latency.

---

## 3. Sharing the activation API with partners

The shape of `/api/serial/activate` today (Section 1) assumes the
caller is trusted — a single HMAC secret authenticates "anyone who has
the secret can activate any serial." Two distinct partner shapes have
fundamentally different security postures:

### 3.1 Retail partners (POS terminals at brick-and-mortar)

**Threat model**: terminal compromise. A leaked secret can forge
activations for serials that haven't been sold yet. Practical attack:
attacker activates a batch of unsold serials, takes possession of
those physical boxes via theft or supply-chain interception, registers
them with their own identity, sells the registrations as "pre-paired"
servers.

**Per-partner secret + activation budget per terminal**:
- New D1 table `retailer_secrets(retailer_id PK, hmac_secret, daily_budget, revoked_at)`.
- The Worker looks up the secret by the body's `retailerId`, rate-
  limits per `retailer_id`, and rejects activations beyond
  `daily_budget` (operational sanity-check that no one terminal is
  burning through serials).
- Revocation: set `revoked_at` and all future activations from that
  retailer return 403. Existing activations are unaffected — they're
  already nailed to box serials with no way to undo.

**Audit**: every activation writes a row to a new
`serial_activations_audit(serial, retailer_id, at, ip, user_agent)`
table. We can already infer the retailer from the existing
`activated_by` column on `box_serials`, but the audit table captures
**every attempt** including rejections, which is what you need for
incident response.

### 3.2 Distribution partners (drop-shippers, OEM bundlers)

**Threat model**: bulk pre-activation. A distributor might want to
activate a thousand serials in a batch before drop-shipping them. The
risk: if the distributor's secret leaks, the attacker has thousands
of pre-activated serials that look legitimate to the registration
path.

**Mitigations beyond the retail model**:
- `retailer_secrets.daily_budget` lets us put hard ceilings per
  partner (e.g. 500/day) so a leaked secret only burns through that
  much before someone notices the spike in
  `serial_activations_audit`.
- A second-factor approval for bulk batches: distributor signs a
  `BatchActivation` envelope listing N serials; we require an
  out-of-band confirmation (e.g. signed by a separate maintainer key
  Apple-Notes style) before flipping the batch.
- Alternative: distributors **never** activate — they ship
  unactivated, and the owner activates via the app on first boot.
  Simpler trust model; downside is the owner sees a "this box needs
  activation" UX step they wouldn't otherwise see.

**Recommendation**: ship retail partners with per-partner secrets +
budgets first. Drop-ship partners stay on the "owner activates via
app" model until volume justifies the bulk-activation surface.

### 3.3 Owner-driven activation (the consumer fallback)

A box that arrives unactivated (retailer skipped the step, or the
distributor never activated, or the box was a hand-off from another
user) needs a way for the owner to activate it.

**Two designs we'd pick between**:

1. **Pre-activated SKU**: a SKU that ships with `activatedAt`
   pre-filled at manufacture. The "branded box" check passes but
   the bind step still nails the serial to the first identity that
   claims it. Loses the retailer-attribution signal but keeps the
   first-claim binding security.

2. **In-app activation flow**: the app calls `/api/serial/activate`
   with a different auth path — not the retailer HMAC, but a
   user-IRK signature over the same canonical bytes. The Worker
   accepts EITHER auth path; the row records `activated_by = "user-<irk>"`
   so audit can distinguish.

Option 2 is the cleaner long-term answer; Option 1 is the cheap
launch hack if we need it sooner.

---

## 4. Hot-path effect on `handleServerRegister`

### 4.1 Latency

| Path | Extra D1 ops vs. pre-N-CLOUD-2 | Worst-case extra latency |
|---|---|---|
| Self-built (no boxSerial) | 0 | 0 ms |
| Branded box (boxSerial), happy path | 1 (`bindStk`) | ~10-30 ms cold, <5 ms warm |
| Branded box, rejected | 1 (`bindStk` read-only on `unknown`/`not activated`/`already bound`) | ~10-30 ms |

Registration is a one-shot per-server event (not a polled hot path),
so even cold-path 30ms is invisible in the UX. The Live Activity
timeline shows "Registering with Flagship" → tick before the user
notices.

### 4.2 Rate-limiting

Today the registration handler shares the existing
`/api/server/register` bucket. The wire-in **does not add a new
bucket**. Two future-work items the spec leaves open:

1. **Failed-activation abuse**: an attacker could probe the existence
   of valid serials by sending registrations with guessed
   `boxSerial`s and observing 403 reasons (`unknown serial` vs
   `not activated`). Mitigations:
   - Collapse both reasons into a single opaque
     `box serial activation check failed` on the wire (we already
     keep the structured reason in the storage layer; the handler
     just doesn't surface it).
   - Add a SECOND rate-limit bucket keyed on `boxSerial` so brute-
     force enumeration is capped independently of the global
     registration bucket.

2. **Bind-attempt abuse**: an attacker who knows a valid (serial,
   identity) bind could try to re-register with a fresh identity in
   hopes of racing the original bind. The atomic `bindStk` prevents
   the race; the storage row's `stkPubHex` is set in a single D1
   write. No further mitigation needed beyond not surfacing the
   distinction publicly.

**Recommendation**: deferred. Ship the wire-in as-is; revisit if
abuse signals appear in audit.

### 4.3 The "factory reset" question (§2.4 already flagged)

`bindStk` is one-shot. Once a serial is nailed to an Ed25519
identity, a different identity can never claim it again. Use cases
that break:

- User wipes their box, gets a new identity key, tries to re-register
  → 403 `already bound`.
- User sells the box to another person → buyer's new identity can't
  claim the serial.
- Owner's UMK rotates → if the rotation also rotates the server
  identity, the box can't re-register.

**What's needed**: an "unbind" path. A signed `UnbindBoxSerial`
envelope from the **current** bound identity (the only key that can
authorize relinquishing the serial), which clears `stkPubHex` so the
next claim wins. Out of scope for the wire-in commit; tracked as a
follow-up.

**Interim**: an admin endpoint `/api/admin/unbind-serial` gated by
the maintainer-CA chain (the same chokepoint as
`/api/admin/mint-device-grant`) for one-off support cases. Not
user-self-service.

---

## 5. Things the wire-in deliberately deferred (the punch list)

1. **`boxSerial` in the signed envelope.** Promoting it into the
   signed `ServerRegisterRequest` canonical bytes (append-only,
   same pattern as `bootUnlockMode`) gives a MITM no way to strip
   a branded-box claim. The current "strip = downgrade to self-built"
   isn't a security regression (§1) but it does mean we don't get
   audit-quality "branded box X registered with identity Y" data
   unless we trust the body field. Decision needed when the audit
   trail becomes load-bearing.

2. **Audit log entry.** The handler doesn't currently take an
   audit-event storage dep. Adding one means threading a new dep
   through `handleServerRegister` + every test that constructs it.
   Worth doing alongside the per-retailer secrets work (§3.1) so the
   audit table can record both activation attempts AND registration
   rejections in one schema.

3. **Per-retailer HMAC secrets.** §3.1 above.

4. **Failed-activation rate-limit bucket.** §4.2 above.

5. **Owner-driven activation path.** §3.3 above.

6. **UnbindBoxSerial envelope.** §4.3 above.

7. **`box_serials` table read-replica strategy.** Only relevant at
   100M+ rows; not a v1 concern.

---

## 6. Recommendation summary

| Decision | Recommendation | Defer to |
|---|---|---|
| Ship N-CLOUD-2 wire-in | ✅ done | — |
| Sign `boxSerial` in the envelope | Defer; revisit when audit becomes load-bearing | Hardware-shipping decision (Q3 in the NFC review) |
| Per-retailer HMAC + audit | Build before any second retailer exists | Before first non-direct-sale channel |
| Daily activation budget per retailer | Build alongside per-retailer secrets | Same |
| Owner-driven activation fallback | Build option 2 (IRK-signed activation) | Before any non-retail SKU launches |
| Unbind path | Admin-only first; user-self-service later | Before the second branded SKU exists |
| New rate-limit bucket | Build only if abuse appears in audit | Reactive |
| `box_serials` read-replica | None | 10M+ activated rows |

This wire-in is the floor. Every deferred item above is a deliberate
"ship the smallest correct thing first, instrument it, then evolve."
