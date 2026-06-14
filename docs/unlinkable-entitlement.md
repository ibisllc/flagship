# Unlinkable client-side entitlement + optional push

**Status:** design spec, awaiting founder ratification on the monetization
tension (§2). Companion to `monetization-free-tier-first.md` (canonical)
and `multi-device-monetization.md`. Drafted 2026-06-13.

## 0. Goal (the claim we want to be able to make truthfully)

> *"Buy the app on the App Store like anything else. We hold no record
> linking your account to your identity or your device. If authorities
> come to us — even together with Apple — we cannot tell them who holds
> a given server. We can only take the relay down."*

This is a **retrospective-unlinkability** claim and it is achievable. It is
**not** "we can never help identify a live user," because we run a relay
that transits the box's home IP and can be compelled *prospectively* (a
pen-register going forward). Do not market more than the retrospective
claim. See §5.

## 1. Why it works — the join key

A joint *Flagship + Apple* order only works if both sides share a column to
join on. After the changes in this spec:

| Apple holds | Flagship holds |
|---|---|
| Apple ID, app downloaded, Pro IAP purchased, device APNs tokens | username, servername `<server>.<user>`, box identity pubkey, transient IPs |

Apple never sees a servername (it never leaves the device toward Apple).
Flagship never sees an Apple ID. The **only** value that can appear on both
sides is the **APNs push token** (`push_tokens.provider_token` → username
on our side; token → Apple ID on theirs). **That token is the join key.**
Remove it and the two graphs have no common column — a combined subpoena
returns nothing joinable.

Two hard requirements make it airtight:

1. **Client-side IAP only.** StoreKit 2 on-device verification. The receipt
   is **never** sent to our backend, and we **never** set StoreKit's
   `appAccountToken` to anything identity-bearing — that UUID is visible to
   Apple in the transaction and would become a *new* join key. Leave it nil.
2. **Push off ⇒ no `push_tokens` row exists** for that account. Turning push
   off must actively DELETE the server-side row, not just stop sending.

Client-side enforcement is *ideal* for multi-account: because the check is
on-device, `.com` is never told "these two accounts are one paying
customer." Requirement: each account uses independent keypairs and the app
reuses no device identifier across accounts (else that becomes the join key).

## 2. ⚠️ Monetization tension to ratify (founder call)

The proposed paid features are **"multiple servers"** and **"multiple
accounts."** Run through the canonical decision recipe:

1. **On the core user loop?** No — one user's vibe→install→run→share→recover
   loop never needs a 2nd server or a 2nd distinct identity. *Gateable.*
2. **OSS escape hatch holds?** Yes — self-host a second dispatcher / run the
   OSS app again. Fee is convenience, not access. *OK.*
3. **Matches one of the four surfaces?** No. This is a proposed **5th paid
   surface.** The canon's rule when nothing matches is *"default to free."*
4. **Erodes the trust pitch?** This is the live risk. The canon explicitly
   lists **"number of paired devices / sessions … free"** and a reasonable
   user conflates "multiple accounts" with "multiple devices." Gating
   *compartmentalization* can read as "pay us for privacy."

**Recommendation:** distinguish the axes cleanly so we don't break the
free-multi-device promise:
- **Personal multi-device (one identity, many devices):** stays FREE (canon).
- **Multiple servers / multiple distinct accounts:** the new 5th paid
  surface — defensible as a power-user convenience premium, but it is an
  **amendment to the canonical doc** and needs an explicit founder yes.

Until ratified, build the *mechanism* (client-side entitlement gate) without
hard-wiring *which* features it gates — drive it from a small config list so
the policy decision stays reversible.

## 3. Notification redesign (decided)

- **First-launch consent** (no silent default). On first run, present the
  tradeoff and let the user choose push on/off. Copy must state BOTH costs of
  enabling: (a) *"your account becomes permanently linkable to your phone's
  identity"* and (b) — for the off path — *"alerts may be delayed."*
- **Push off fallback = both:** always check on foreground; plus a
  best-effort `BGAppRefreshTask` background poll → `UNUserNotificationCenter`
  **local** notification (never via Apple's relay). Background timing is
  OS-throttled and unreliable by design — alerts can be minutes-to-hours
  late. Say so in the consent copy.
- **Settings toggle** mirrors the first-launch choice; flipping to off
  DELETEs the `push_tokens` row server-side.

## 4. Work by surface

1. **`.com` / control-plane + storage**
   - Remove the deliberate tier↔username binding: drop reliance on
     `tier_subscriptions.irk_receipt_hex` / `irk_signature_hex` for gating.
     Entitlement leaves the backend entirely.
   - Decide LLM-promo credits' fate (the one thing reading tier today):
     either free-tier-only, or move to anonymous tokens later (out of scope
     here).
   - Add `DELETE /api/push/token/<token_id>` (IRK-signed) for hard opt-out.
   - Add a lightweight events endpoint the phone polls when push is off.
2. **iOS** — StoreKit 2 product + on-device verification; local `entitlement`
   flag; gate multi-server / multi-account UI on it; first-launch consent
   screen; Settings toggle; BGAppRefreshTask poll + local notifications.
3. **Android** — Play Billing equivalent; same gate, consent, toggle,
   WorkManager periodic poll + local notifications.
4. **Shared core** — entitlement model + config list of gated features;
   poll/notify plumbing.
5. **Docs** — ratify §2 into `monetization-free-tier-first.md` once decided.

## 5. Honest caveats (must stay in the marketing brief)

- **Prospective relay logging.** Box→`.services` and phone→`.com` transit
  real IPs. Not stored, but compellable going-forward while the service is
  live. The claim is retrospective only.
- **Client enforcement is bypassable** (jailbreak / patched APK). Accepted —
  a cracker who unlocks Pro for free still reveals nothing extra to us, so
  unlinkability is unaffected; only revenue leaks.
- **Anonymity-set, not cryptographic, hiding of "is Pro."** We can infer a
  username is Pro from behavior (it has 2 servers); Apple knows an Apple ID
  is Pro. Neither is a join key — "is Pro" is a crowd, not an identity — but
  if very few users are Pro the crowd is small.

## 6. What needs the founder / cannot be built blind

- App Store Connect: create the IAP product(s) + sandbox testers (manual).
- Play Console: equivalent.
- Ratify §2 (monetization amendment).
- Until products exist, the entitlement gate can be built and tested against
  a mock entitlement provider end-to-end.
