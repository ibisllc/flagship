# Financial analysis — multi-device as a paid / subscription feature

**Status:** analysis + recommendation. Companion to
`monetization-free-tier-first.md` (canonical). Requested 2026-05-22.

> ⚠️ **Tension to resolve up front.** The canonical monetization doc
> *explicitly* lists as free-forever: **"Number of paired devices /
> sessions — phone, two laptops, an iPad: free"** and **"Recovery flows
> … part of the free identity layer."** So *blanket*-charging for
> "multi-device" contradicts the canonical stance and the trust pitch
> ("your data, your hardware, your keys"). This analysis therefore does
> NOT recommend gating personal multi-device. It evaluates the narrower,
> defensible question: **can the business / collaborator use case become
> a paid surface without breaking the free-tier-first promise to
> individuals?** The answer is a qualified yes, via segmentation.

## 1. Segment the use case (this is the whole game)

"Multi-device" is two very different products wearing one name:

| | **Personal multi-device** | **Business / collaborator multi-device** |
|---|---|---|
| Who | One person, their own devices (iPhone + iPad + laptop) | An org/owner adding *other people's* devices (teammates) |
| Mechanism | Same iCloud/passkey sync, or QR-pair your own 2nd device | Cross-device QR pairing (Phase 3b): admin adds collaborator seats |
| Identity | One human, ≤~3 devices | N humans, per-seat |
| Canonical doc says | **Free** ("phone, two laptops, an iPad: free") | Not addressed — it's a *new* surface (collaborators ≠ "paired devices") |
| WTP | Low (it's table stakes; users expect it free) | Real (orgs pay per-seat for collaboration tooling routinely) |

**Recommendation preview:** keep **personal multi-device free** (honors
the doc, protects the trust pitch, and it's a weak revenue lever
anyway). Treat **business/collaborator seats** as a *potential fifth
paid surface* — convenience-premium, per-seat — and run it through the
canonical decision recipe before committing.

## 2. Run it through the canonical decision recipe

The doc's four-question test, applied to **business collaborator seats**:

1. **On the core user loop (vibe → install → run → share → recover)?**
   No. A single user's full loop never requires adding *other people's*
   devices. Collaboration is additive. → not auto-free.
2. **Does the OSS escape hatch hold?** Partially. The multi-device crypto
   (IRK sharding, cross-device pairing) is in the OSS client, but the
   *enforcement* point (account_type=multi, seat counting) is the `.com`
   identity/state plane. A determined org could self-host the whole
   `.com` Worker + D1 + R2 identity layer to avoid seat fees — that's a
   real but **high** bar (it's the one centralized piece). So the fee is
   a genuine convenience premium, consistent with the doc's logic for
   custom domains / relay overage. ✅ acceptable.
3. **Matches one of the existing four surfaces?** No — it's a new
   (fifth) surface. The doc allows new surfaces if they pass #2 and #4.
4. **Would charging erode the trust pitch?** For *individuals*: yes, if
   we touched personal multi-device — so we don't. For *orgs adding
   teammates*: no — per-seat team pricing is a normal, expected SaaS
   shape and doesn't implicate "your data on your hardware." ✅ as long
   as the boundary is "your own devices free; other people's seats paid."

**Verdict:** business/collaborator seats are a *legitimate* paid surface
under the existing principles; blanket multi-device gating is not.

## 3. Pricing models considered

| Model | Fit | Notes |
|---|---|---|
| **Per-seat subscription** (monthly/annual per collaborator beyond the owner) | **Best fit** | Matches the value (each added human), scales with org size, predictable. Free: owner + their own devices. Paid: each *additional person*. |
| One-time "unlock multi-device" | Poor | Underprices ongoing support/infra for active teams; no recurring value capture; and it'd be tempting to apply to personal multi-device (which must stay free). |
| Flat "Teams" tier (e.g. up to N seats) | OK as packaging | Bundle seats + reserved name + custom domain + relay headroom into a "Business" tier; simpler to sell than metered seats. |
| Usage/bandwidth only (status quo) | Insufficient alone | Relay overage already exists; it doesn't capture collaboration value (a 5-person team can be low-bandwidth). |

**Lead recommendation:** a **per-seat monthly/annual subscription**
(owner + own devices free; +$X/active collaborator/mo), optionally
packaged as a **"Business" tier** that also folds in the existing paid
surfaces (custom domain, reserved name, relay headroom) so there's one
SKU to reason about. 2FA is *required* for multi-device anyway (security
model), so "Business" naturally bundles the stronger-security profile.

## 4. Cost drivers (what a seat actually costs us)

To set a floor under per-seat pricing (real numbers needed — placeholders):

- **Support** — the dominant variable cost for a security product with
  account recovery, takeover, quarantine, lost-2FA. Teams generate more
  support per account than individuals.
- **Identity-plane infra** — D1 rows, R2 (recovery envelopes, audit),
  Worker invocations, push fan-out (re-pair/quarantine alerts go to ALL
  trusted devices — scales with seats × devices).
- **Demo/trial infra** — the Hetzner demo-VPS (`sample-user`) costs real
  €/hour; if "try Business with collaborators" uses live demo pods, that
  cost attaches to the funnel, not steady-state.
- **2FA/TOTP + recovery-code storage + verification** — cheap per unit,
  but adds support surface (lost authenticator).
- **Trust/abuse** — cross-device QR pairing shares the UMK; the
  safeguards (no-screenshot, quarantine, alerts) add eng + monitoring
  cost. Abuse (a leaked org account) is a support/reputation cost.

> **Data needed for a real model:** avg support tickets/seat/mo × cost/
> ticket; Worker+D1+R2+push $/account/mo at target scale; demo-VPS $/
> trial; blended gross-margin target. Without these, pricing is a guess.

## 5. Willingness-to-pay & competitive frame

- **Individuals (own devices):** WTP ≈ $0 for multi-device — it's an
  expectation, not a feature. Charging here loses trust + converts
  poorly. (Keep free.)
- **Prosumers / families:** low WTP for "seats"; family sharing is
  better as a free trust-builder (peer-backup is already free). Don't
  monetize.
- **SMBs / teams (the target):** routinely pay per-seat for collab/
  security tooling. Anchors: Tailscale (~$6/user/mo business), 1Password
  Teams (~$8/user/mo), Bitwarden Teams (~$4/user/mo), Google Workspace
  (~$6–12/user/mo). A Flagship "Business" seat in the **$4–8/user/mo**
  band is defensible IF the value (self-owned infra + collaboration +
  the four bundled surfaces) is clear.
- **Differentiator vs all of the above:** Flagship's pitch is
  *self-owned* infra. The paid layer must be framed as "we run the
  convenience/identity edge for your team," never "we hold your data
  hostage" — or it collapses the core differentiator.

## 6. Free-tier boundary (the line to hold)

- **FREE forever:** single-device; personal multi-device (your own
  iPhone+iPad+laptop); iCloud/Block-Store recovery; takeover; peer-backup;
  the whole core loop. (Unchanged from canonical doc.)
- **PAID (proposed "Business" tier / per-seat):** adding *other people's*
  devices as collaborators (cross-device QR seats beyond the owner);
  org-oriented extras (audit retention, admin controls, SSO later) +
  the existing four surfaces bundled.
- **The test for the boundary:** "Am I paying to use my own devices?" →
  must always be **no**. "Am I paying to bring teammates onto an org
  account?" → that's the paid line.

## 7. Conversion funnel (qualitative)

Free single/personal-multi → hits a *collaboration* need (wants to add a
teammate's phone) → cross-device QR flow surfaces a "this adds a
collaborator seat — start a Business trial" prompt → trial (time-boxed,
seats capped) → convert. The cross-device QR pairing (Phase 3b) is the
natural in-product upsell trigger; instrument it.

## 8. Risks

- **Brand/trust risk** (highest): any perception that "Flagship now
  charges for multi-device" — even if only org seats — damages the
  free-tier-first reputation. Messaging must be surgically clear:
  *your own devices are free; team seats are the paid part.*
- **Canonical-doc conflict:** pursuing this **amends**
  `monetization-free-tier-first.md` (the "paired devices free" line must
  be clarified to "your own devices free; collaborator seats paid"). That
  edit is itself an owner decision, not a silent change.
- **OSS bypass at scale:** a sophisticated org self-hosts `.com` to avoid
  seats. Acceptable (matches the doc's logic) and rare, but caps upside.
- **Support cost underestimation** could make seats unprofitable at low
  price points — needs the real cost model before pricing.

## 9. Recommendation

1. **Do NOT gate personal multi-device.** Keep it free; it protects the
   trust pitch and is a poor revenue lever. (Aligns with canonical doc.)
2. **Introduce a per-seat "Business" tier** for *collaborator* seats
   (other people's devices), $4–8/user/mo band (pending the cost model),
   2FA-required, bundling the existing four paid surfaces.
3. **Gate the boundary on "whose device,"** not "how many devices."
4. **Trigger the upsell at the cross-device QR pairing flow** (Phase 3b).
5. **Before committing:** (a) build the real cost model (§4 data), (b)
   get owner sign-off to amend the canonical monetization doc's
   "paired devices free" line into the clarified boundary, (c) defer
   Stripe/billing plumbing (already out-of-scope this cycle per the
   canonical doc) until the core loop ships.

**Bottom line:** "multi-device as a paid feature" is the wrong frame and
conflicts with the canonical stance; **"collaborator seats as a Business
tier" is the right frame** and fits the free-tier-first principles — if
the boundary stays "your own devices are always free."
