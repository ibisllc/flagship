# Per-user cert + addressing — extracted work-list

Source of truth: **`docs/per-user-cert-and-addressing.md`** (owner's design spec).
This file is the derived task breakdown + open questions, extracted 2026-06-01.
Do not treat this as the design — when they disagree, the spec wins.

**Global gates (apply to nearly every task below):**
- **Sequencing: land AFTER c4.6** (the v2 de-version rename). c4.6 migrates the *same files* (`serverRegister`/DNS/cert-SAN); do not interleave. All line numbers below shift once c4.6 lands — re-grep before editing. (§0, §10)
- The cert/SAN/DNS rewrite should land as **one atomic green commit**, then be **live-smoked** (real green padlock on the new SAN shape) before trust. (§10.2–10.3)
- This is the **Let's Encrypt TLS layer**, NOT the Flagship maintainer/identity CA. Don't conflate when touching `auth.ts` envelopes. (header, §4)

---

## Summary

Move from **one LE cert per box** → **one cert per user**: SANs collapse from `[<user>, *.<user>, *.<server>.<user>]` to `[<user>, *.<user>]`. Apps stop being `<app>.<server>.<user>` (topology-in-URL) → `<label>.<user>`, served by whichever box owns the name, with a rare `--` pin-to-box escape hatch. Cert is **minted by the user's trust-root devices (phone + webapp), never `.com` or the boxes**; **revocation is enforced at the routing layer (per-box STK / RCK), not the cert**. Motivation: pin the cert to the most-stable id (username) not the renameable box label; strip machine topology from public URLs while pre-launch with zero shipped users (the one free moment). Only the user-facing *contract* ships at launch; the multi-box replication *mesh* is deferred to a user's 2nd box (§7).

## Tasks (dependency-ordered; sizes S/M/L)

1. **Collapse cert SANs to `[<user>, *.<user>]`** — daemon — S — *replaces* (`runtime.ts:449-463` has the 3-SAN literal today).
2. **Reduce DNS publishing 4→2 records** — .com/control-plane — S — *replaces* (`serverDns.ts:85-86`, `serverRegister.ts:237-254`, dup `userZoneOf` `:291-300`).
3. **Add `--` pin-operator + label rules** — protocol/services-zone — S — *net-new* (in `validateAppSlug` `validation.ts:100-109`: forbid `--` in labels+box-names, forbid 2-char segment before `--`, forbid `xn--`; add `parsePinLabel`). (§3.3)
4. **Activate per-user zone helpers; deprecate per-box** — services-zone — S — *replaces* (`userWildcardSans` active; `serverWildcardSans` → internal box-naming only; `appFqdn` → `<label>.<user>`, drop `serverName` arg). (§8)
5. **§3.4 single per-user leftmost-label resolver** — daemon — M — *extends* (`runtime.ts:510-536`/`userZoneOf`/`leftmostLabel`): 5-step precedence `--`pin → box-name → device-label → install-table app-label → disambiguation page. **Blocked on Q3.**
6. **Merged per-user name-uniqueness invariant** — storage/.com — M — *net-new* (`storage/schema.ts:12-42`: uniqueness across {app-label, box-name, device-label} per user + stable-id↔local-label map). "The one genuinely new cross-cutting invariant." **Blocked on Q3; reconcile with v2-device-addressing.**
7. **Local-label defaults to bare slug + `-author` collision fallback** — protocol/daemon/storage — M — *replaces* (keep `(slug,author)` as hidden stable-id; auto-suffix `-<author>` only on collision; nothing in routing/auth/updates/sharing reads author from URL). Retires multiplexing.md's `<slug>-<creator>` canonical. (§3.2)
8. **Update Caddy/image build for per-user addressing** — bootkey-builder/ops — S — *replaces* (`caddyfile.ts:11-39`; `buildPlan.ts` `newServerId` → internal box id). (§8)
9. **Protocol types: manifest `replication` flag + ACME-authority envelopes + CAA-pin record** — protocol — M — *net-new* (`auth.ts`: `replication:"leader"|"isolated"` declared **inert**, default `isolated`; account-key-vs-cert-key envelopes; CAA-pin record). (§4.2, §7.6, §8)
10. **Move ACME issuance authority off-box to trust-root devices** — daemon/mobile/webapp — L — *replaces* (ACME **account key** on phone+webapp only, never shared to boxes; only the disposable **cert keypair** distributed; keep `letsEncryptIssuer.ts:192-213` challenge shape). **Renewal half blocked on Q-A.** (§4.1–4.2)
11. **CAA `accounturi`+`validationmethods` pin (RFC 8657) + CT monitoring** — .com(DNS)/mobile/webapp — L — *net-new* (pin issuance to phone-held ACME account; CT monitor on trust-root device alarms on any unminted `*.<user>` cert). (§4.3)
12. **Per-box routing revocation (soft + hard)** — .com/daemon/mobile — M — *extends* (soft = Disconnect: eject from cert set + drop STK/re-point RCK, no re-mint; hard = ORDERED: routing-revoke FIRST → eject mesh → re-mint → CA-revoke; map onto Disconnect/Replace/Wipe UI). (§5.1–5.2)
13. **Debounce/rate-limit hard re-mints** — daemon/.com — S — *net-new* (all hard re-mints share the SAN set → hit LE 5-dup/7-day; stop a flapping/attacked box weaponizing re-mint into issuance DoS). (§5.4)
14. **Fold ACME account key into UMK/IRK recovery** — protocol/mobile/.com — M — *extends* (recoverable via Recovery J.3/J.4 re-pair + WebAuthn-PRF so phone loss doesn't brick issuance). **Blocked on Q-D.** (§4.4)
15. **Tests** — M — *extends* (rewrite `validation.test.ts:73-83`, `acmeLetsEncrypt.test.ts:400` PROD_SANS, `certRetryLoop.test.ts`, `serverRegisterUserZoneDns.test.ts` 4→2; add `--` parsing, §3.4 precedence, CAA-pin, account/cert-key split, soft/hard ordering). (§8)
16. **Live-smoke per-user cert e2e** — ops — S — verification gate (dev/create-server → build → daemon → real green padlock on new SAN). (§10.3)

**Deferred — DO NOT build now (§7 machinery):** cert-replication mesh (reuse `customDomainCert.ts` lead→sibling pattern, which already exists); delegated autonomous renewal; `replication:"leader"` unified-instance forwarding + Postgres/MinIO failover; leader-determinism/split-brain.

## Open questions (need owner decision before the gated tasks)

- **Q-A — Renewal availability vs. minting control (§9-A).** Phone-only minting adds a phone dependency at every renewal (regression from autonomous boxes). Options: (a) wide ~30-day window + webapp as co-equal minting peer; (b) narrow, time-boxed, per-box-revocable "renew existing namespace" capability delegated to the harness. → gates task 10's renewal half.
- **Q-B — Short-lived (~6-day) certs at launch or defer? (§9-B).** Strongest blast-radius mitigation for a shared key, but forces frequent renewal — needs Q-A's delegated autonomous renewal first.
- **Q-C — Trust-domain segmentation (§9-C).** One cert per user *per trust group* (home vs office/experimental). Doc leans defer; asks the name table not foreclose it. → defer-but-reserve, or design now?
- **Q-D — ACME account-key custody across phone+webapp peers + recovery (§9-D, §4.4).** Where does the account key live with two co-equal trust-root devices, and how is it re-established on device loss? → gates task 14.
- **Q3 — Merged per-user leftmost-label namespace (§3.4, §9).** {app-label, box-name, device-label} are 3 separate sources today; need merged table or deterministic precedence + uniqueness across all 3. **Must reconcile with `v2-device-addressing-and-real-ticket`.** Central blocker for tasks 5 + 6.
- **Q-E — Mesh ejection ↔ re-mint atomicity under partition (§9-E, §5.2).** How is "box is confirmed out of the mesh" established before re-mint under a network partition? (deferred-machinery, but §5.2 ordering depends on it.)
- **Q-flag — Manifest-flag default naming (§7.6).** Confirm `replication:"leader"|"isolated"`, default `isolated`, inert, before baking into the protocol wire (task 9) — changing a shipped manifest field later is costly.

## Owner decisions (2026-06-01)

**Global directive:** *build everything now, defer NOTHING* — except where "deferred" means **physically untestable without a 2nd box** (the cert-replication mesh / unified-instance / split-brain machinery, §7). You can't verify a peer mesh or a leader-failover with one box, so the protocol *contract + data-model reservations* land now (so it's never a migration) and the mesh *code* lands the moment box #2 exists. That's "not writing unverifiable code," not "deferring a feature." Everything security-relevant (account-key recovery, CAA-pin, CT monitor, short-lived certs) ships now.

**Q-A — RESOLVED → user-configurable "offline autonomy window."** At first-server creation (and editable in Settings) the user picks how long their servers may keep running while the phone is offline: **3 / 7 / 15 / 30 / … days, or Indefinite.** That value drives a **time-boxed, per-box-revocable delegated-renewal capability**: the trust-root device hands the box a token authorized to *renew the existing `[<user>, *.<user>]` namespace cert* (renewal only — never fresh issuance/rotation, which stays root-only per §4) valid for the chosen window; the box renews autonomously inside it; near expiry the phone/webapp must come online to re-arm. **Indefinite** = a non-expiring delegation (revoked only explicitly). Mirrors the existing two-tier boot-unlock (auto/approve + TTL) + InstallBlob TTL pattern. → unblocks task #26's renewal half; adds a new sub-task: the setting (protocol field + first-run question + Settings UI on iOS/Android/webapp + daemon honoring the window).

**Q-B — build at launch (don't defer).** Adopt LE's short-lived (~6-day) profile. It *requires* Q-A's delegated autonomous renewal, which we're now building, so the dependency is satisfied. Strongest blast-radius bound for the shared key.

**Q-D — RECOMMENDATION (awaiting confirm): derive the ACME account key from the UMK.** Make the ACME account keypair a deterministic HKDF derivation off the UMK (exactly like IRK/BAK: `acct = derive(UMK, "flagship/acme-account/v1")`). Then BOTH trust-root peers (phone + webapp, which already share the UMK via the existing pairing/recovery) independently derive the *same* account key — no separate sealing, no second ACME account, and recovery is automatic (whoever recovers the UMK has the account key; folds into J.3/J.4 + WebAuthn-PRF for free). CAA pins the single accounturi. → unblocks task #28.

**Q-C — RESOLVED → NOT a cert feature; don't build.** Trust-domain segmentation is achieved by creating a **separate Flagship user account/profile** (account picker at app open; possibly paid-tier-gated, separate convo). The cert stays strictly one-per-account; no `(user, trustGroup)` dimension. Drop it.

**DEVICE MODEL (owner clarification 2026-06-01):** "phone" and "webapp" are two **co-equal classes** of user-device; a user has arbitrarily many user-devices and grants **administrator** status to **any subset**. Admins hold the security authority (minting/renewing certs). So issuance authority = the **admin subset**, NOT a device type. Consequence: the ACME account key is **admin-held (sealed per admin device), NOT UMK-derived** — UMK-derivation would hand it to every device including non-admins, breaking the admin boundary. Likely extends the existing DeviceCapabilityGrant scope system. **Build EVERYTHING now incl. the mesh** (tested against simulated peers).

**Q-E — RESOLVED by re-framing.** §5.2 step 2 "box confirmed out of the mesh" = **"box removed from the trust-root's authorized cert-recipient set"** — a *local, atomic* operation on the phone, NOT a round-trip the partitioned box must ack. Re-mint distributes only to boxes still on the phone's authorized list; a partitioned/unreachable compromised box simply isn't on it. Partition becomes a non-issue. Consistent with §4 (phone = issuance authority) + §5.2 step 1 (routing already cut).

**Q-flag — DECIDED → keep `replication: "isolated" | "leader"`**, default `isolated`, inert at launch. Forward-extensible to `"multi-leader"`.

### Admin / mint-authority decisions (2026-06-01, owner-confirmed)
- **Admin model = a new `admin` DeviceScope** (SHIPPED, commit `3997bc1`: appended to `DEVICE_SCOPES` in `auth.ts`). A device holding the `admin` scope is an account administrator and may mint/renew certs (holds the sealed ACME account key). Reuses the existing DeviceCapabilityGrant / `requireDeviceScope` plumbing.
- **ACME account key = admin-held, NOT UMK-derived.** Generated once; sealed per admin device (sealed to each admin device's IRK when promoted, via the existing device-seal pattern). Non-admin devices never receive it.
- **Demoting/losing an admin device ROTATES the account key** — re-mint the ACME account key + re-pin CAA + re-seal to remaining admins so the removed device's copy goes dead. Debounced against flapping (security-first, matches §5.3 "when in doubt, hard").
- **Offline-autonomy window = account default + optional per-box override.** Account default set at first-server creation (+ Settings); each box's detail screen can override (e.g. locked-closet NAS = Indefinite, travel box = 3 days). Each box's delegated-renewal token carries its own window; unset = account default.

**Q3 — GREENLIT to build the merged per-user name table** ("yes, do it now"). Will reconcile with v2-device-addressing before coding the resolver (tasks #24 resolver-half + #25).

### Cert distribution semantics (owner Q&A 2026-06-01 — sharpens the mesh, task #27/§7)

**Principle: one cert per account, shared to EVERY serving box; "may mint" ≠ "holds the cert"; minting is coordinated to exactly ONE issuance per renewal cycle.**

- **Admin returns → adopt, don't reflexively re-mint.** The most-recent valid cert (whoever minted it) is the account's live cert; an admin device observes/adopts it + keeps CT-monitoring, and re-mints ONLY on need (near-expiry-with-no-recent-renewal, or a rotation event). Re-minting just because an admin came online wastes an LE duplicate-cert slot.
  - Finite window: the box never minted → the admin's return IS the renewal.
  - Indefinite: the delegated box already renewed → admin stays hands-off.
- **Share with NON-minting siblings: yes, always.** Every TLS-terminating box needs the cert+key regardless of mint rights. Non-minters are receive-only (lead→sibling pattern in `customDomainCert.ts`).
- **Share with OTHER minters: yes — and sharing PREVENTS over-minting.** A minting-capable box that receives a cert with a fresh expiry stands down (the distributed expiry is the coordination state). Plus a deterministic single-lead election among {admin devices ∪ indefinite-delegated boxes} ⇒ exactly one minter per cycle; §5.4 debounce backstops the race. So the LE 5-dup/7-day limit is never hit in normal operation.

Minters = {admin-scope devices} ∪ {boxes with an indefinite renewal delegation}. Everyone else is receive-only. One minter per cycle → fans out to all serving boxes.

**Mint coordination = a reservation LEASE, not static lead election (owner refinement 2026-06-01).** Static election is unsafe — a lead that dies before minting leaves others deferring to a corpse while the cert expires. Instead:
- A minter that sees the cert nearing expiry (comfortable margin, e.g. 1/3 life left) does an **atomic CAS reservation at `.com`**: "intent to mint, reserved until T+δ", δ ≈ one ACME order (~5 min) ≪ remaining cert life (days).
- Other minters back off while a live reservation exists; resume if it lapses with no fresh cert (the reserver died) or stand down when a fresh expiry appears.
- The reservation lease IS the dynamic election (whoever grabs the lock leads that cycle); self-healing against a dead lead because δ ≪ remaining life gives ample takeover time. `.com` holds the lock (non-secret coordination; it can stall like any control-plane availability dep but can't forge — CT-monitor catches that). → builds into task #27.

**Offline-autonomy window is PER-SERVER, not account-wide (owner refinement 2026-06-01, SUPERSEDES the earlier account-default+override).** The decision "can this box survive the phone being off, how long" is inherently per-server (trust/location is per-server). Declared at server creation ("safe always-on location? how long phone-off?"). NO account-wide functional layer — only a remembered last-choice as a UI **pre-fill convenience**. (A future account-wide *ceiling* — "no server may exceed N days" — is a distinct concept the per-server field won't foreclose; not building now.) Finite value ⇒ pre-mint only (box holds no key); Indefinite ⇒ that box gets the revocable renewal delegation.

## Pressure-test findings (red-team 2026-06-01) — flaw → fix

### CRITICAL (architecture-level)

- **PSL ceiling (scaling blocker).** LE's "certificates per *registered domain*" limit (50/week, override ~3–5k/week) keys on the public-suffix+1. If `flagship.services` is NOT on the **Public Suffix List**, EVERY user's cert counts against ONE shared limit → a hard ceiling of a few-thousand users total, regardless of per-user. **FIX: get `flagship.services` (+ the cert apex) onto the PSL**, so `<user>.flagship.services` becomes each its own registered domain → per-user 50/week. Standard multi-tenant pattern (Heroku et al.). PSL propagation takes weeks–months → **must start NOW**. (Per-user *helps* — fewer issuances than per-box — but doesn't remove the shared-registered-domain limit; PSL does. Note: the 5-duplicate/7-day limit is already per-user since each SAN set `[<user>,*.<user>]` is unique.) — **OPS ACTION, owner-gated.**
- **`.com` must NOT be a hard renewal dependency.** The mint reservation-lease at `.com` makes cert *renewal* `.com`-gated — a regression from today's autonomous boxes (a `.com` outage → eventual TLS death, not just routing disruption). **FIX: the reservation is BEST-EFFORT/advisory.** If `.com` is unreachable, minters fall back to a **deterministic local tiebreak** (e.g. lowest-pubkey-hash mints first, others wait a derived delay) + jittered mint-anyway, accepting an occasional duplicate cert (survivable; bounded by the 5/7-day dup limit). Renewal never hard-depends on `.com`.
- **Account-key recovery must be ESCROWED, not derived.** We decided the ACME account key is admin-held + sealed (NOT UMK-derived), so losing your only admin device would otherwise brick issuance forever. **FIX: escrow the account key as ciphertext in the WebAuthn-PRF / J.3-J.4 recovery envelope** (encrypted to the recovery credential; `.com` holds only ciphertext). Re-escrow on every rotation. Recoverable independent of any surviving device.

### THE ONE REAL FORK (needs owner decision) — see chat

- **"Indefinite" autonomy = that box holds the ACME ACCOUNT KEY = becomes a cert-minting authority.** Stock ACME has no clean attenuated "renew-this-SAN-set-only" delegation; a box that renews autonomously past the cert's max validity MUST hold the account key (it can then mint *any* cert for the namespace, not just renew). So the window maps to: **short (≤~6d) → short-lived cert, no box key; medium (≤90d) → standard 90-day cert, no box key (admin just surfaces every ≤90d); indefinite (>90d) → seal account key to that box (opt-in, per-box-revocable, the conscious weakening).** DECISION: allow true-indefinite (box becomes a minter), or **cap max autonomy at 90 days** (no box ever holds minting authority — cleaner invariant, costs "surface a device every ≤90 days").

### FIXES I'll bake in (no decision needed)

- **Admin demotion = a coordinated atomic sequence:** routing-revoke + revoke any renewal delegations + rotate the account key + re-pin CAA (short TTL) + re-seal to remaining admins + re-escrow recovery. The CAA-propagation TTL window is bounded by routing-revoke being instant; keep CAA TTL short.
- **Promotion to admin** = an existing admin seals the account key to the target device's IRK + grants the `admin` DeviceCapabilityGrant. Reuses the device-admit sealed-transfer pattern.
- **Cert-key distribution envelope** = seal(cert key → box STK) + sign(by minter, account-attested). Boxes are receive-only; verify the minter signature. Reuse `customDomainCert.ts` lead→sibling.
- **Renew ≠ rotate (churn fix).** Routine renewal REUSES the cert keypair (distribute just the new *public* cert blob — cheap, no re-seal). Rotate the keypair only on compromise/demotion (the rare re-seal-everything event). Relaxes §4.2 "rotated each issuance" → "rotated on compromise/demotion." Critical with short-lived certs (renew every ~2d).
- **Soft-revoke is only soft if the key is WIPED.** A decommissioned box keeps a *valid* cert key until expiry → off-path MITM risk if its disk is later recovered. Clean decommission must LUKS-wipe + destroy the cert key; a box leaving your control with the key intact is HARD (re-mint + CA-revoke). Sharpens §5.1/§5.3.
- **Delegated-box hard-revoke** has extra ordered steps: routing-revoke + **delegation-revoke** (both instant at `.com`) BEFORE re-mint, then rotate key + re-mint + CA-revoke.
- **Merged-namespace collisions** (offline cross-box installs racing for a label) resolve via a **deterministic rule** + `.com` as the serializer of phone-signed name claims (`.com` orders/dedupes; phone signs so `.com` can't invent names — routing/availability concern, not content-forge). Auto-suffix `-<author>`/`-<box>` on hard collision so an install never hard-fails.
- **Resolver returns (target, label-class, security-context)** — not just a route — so each class (app / device / box-apex / pin) applies its correct capability/security context.
- **Box quarantine** for cert participation: an admin-authorized new box may *receive + serve* the cert immediately but may NOT mint (no indefinite delegation) until its quarantine clears.
- **CA-revoke is best-effort** (browsers soft-fail OCSP); **short-lived certs are the real blast-radius bound** (reinforces Q-B=yes). Don't over-rely on OCSP/CRL.
- **Verify routing-revoke is genuinely instant** — the Fly hub must consult live routing state (not a stale cache); the whole §5 "instant cutoff" argument rests on it.
- **Renewal-reminder push** ("cert expires in N days, open the app") via the existing push infra — the admin-availability safety net for finite windows.
- **Clock-skew tolerance:** decide expiry off the cert's authoritative `notAfter`; a minter waits past the *nominal* reservation expiry before taking over a lapsed lease.
- **Privacy property (document):** usernames are enumerable via CT logs (every `<user>` cert is public) — but the `*.<user>` wildcard keeps individual **app labels OUT of CT** (a privacy WIN vs. per-app certs). State both.
- **Live-swap de-risk:** old 3-SAN certs already cover `[<user>, *.<user>]`, so the new `<label>.<user>` form works mid-transition on old certs; ONLY the deprecated two-label-deep `<app>.<server>.<user>` form breaks → inventory + migrate demo/dev pods first.

### SCOPE-HONESTY HEADS-UP

- **`replication: "leader"` is distributed-consensus, not "more code."** Single-writer-with-failover + split-brain avoidance is Raft/lease territory — famously subtle, data-loss-prone if rushed. Build the CONTRACT + a `.com` leader-lease fence now, but land the actual failover-replication INCREMENTALLY with exhaustive partition tests — this is the one piece NOT to cram. (The cert mesh itself — distribute/quarantine/revoke — is tractable and built now.)

## Risks / cross-cutting

- **Live prod cert chain:** tasks 1/2/4/8 rewrite the exact SAN+DNS paths producing the current green-padlock cert — atomic commit, c4.6-gated, live-smoked or TLS breaks for real servers.
- **LE hard rate limits:** 5-duplicate/7-day per identical SAN set; 50/7-day per registered domain (override ~3000–5000/wk, "don't design around it"). Task 13 debounce is the guard; §5 makes routing-revoke (not re-mint) the primary control for this reason.
- **RCK first-class:** the whole revocation argument rests on RCK + per-box STK being phone-held + per-box-revocable at `.com`. Any RCK regression weakens the per-user shared-key model.
- **Shared-key blast radius:** one compromised box can serve TLS for all `*.<user>` — bounded (no increase at single-box launch; boxes can't mint; routing-revocable) only if tasks 9–13 all land correctly.
- **Migration:** task 6's merged-namespace uniqueness spans 3 existing tables; pre-launch zero-users makes *public-URL* migration free, but internal demo/dev rows (`demouser734759`, orphan `demo-alice`) still need reconciliation.
