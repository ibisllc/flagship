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

## Risks / cross-cutting

- **Live prod cert chain:** tasks 1/2/4/8 rewrite the exact SAN+DNS paths producing the current green-padlock cert — atomic commit, c4.6-gated, live-smoked or TLS breaks for real servers.
- **LE hard rate limits:** 5-duplicate/7-day per identical SAN set; 50/7-day per registered domain (override ~3000–5000/wk, "don't design around it"). Task 13 debounce is the guard; §5 makes routing-revoke (not re-mint) the primary control for this reason.
- **RCK first-class:** the whole revocation argument rests on RCK + per-box STK being phone-held + per-box-revocable at `.com`. Any RCK regression weakens the per-user shared-key model.
- **Shared-key blast radius:** one compromised box can serve TLS for all `*.<user>` — bounded (no increase at single-box launch; boxes can't mint; routing-revocable) only if tasks 9–13 all land correctly.
- **Migration:** task 6's merged-namespace uniqueness spans 3 existing tables; pre-launch zero-users makes *public-URL* migration free, but internal demo/dev rows (`demouser734759`, orphan `demo-alice`) still need reconciliation.
