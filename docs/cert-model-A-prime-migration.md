# Cert model migration: C → A′ (per-box wildcard) + voi.ci + pinning

Status: PLAN (execute next session). Pre-launch (all prod users wiped, only test
boxes), so this is a forward CUTOVER — no live-user data migration needed; stale
test boxes (abc*) get decommissioned, not migrated.

## The invariant we are protecting

> `<server>.<user>.flagship.services` (and everything under it) is served with a
> certificate **minted on the box's own metal** — the private key is generated on
> the box and NEVER transmitted. Opening an HTTPS/WSS connection to that name is,
> by construction, a secure pipe to that specific box (key exchange, private data,
> anything). Let's Encrypt handles the issuance MITM; CAA + CT + client-side
> cert-fingerprint **pinning** make it verifiable that we are not cheating.

## Model recap (how we got here)

- **A** (original, security-first): per-box, box's own name, box-local key. Clean,
  but no service subdomains.
- **B** (the call you made for rate reasons): one per-user wildcard, mint-once +
  replicate the key to the user's boxes. Rate-cheap, but the **key travels**.
- **C** (what we actually shipped): per-box key BUT per-user wildcard name
  `[<user>, *.<user>]`, each box re-mints it → **Duplicate-Certificate limit
  (~5/week identical names)** at >5 boxes, *and* forced the `--` name-flattening.
  Worst-of-both on rate; has A's security but C's rate penalty.
- **A′ (TARGET): per-box WILDCARD.** Each box mints `[<server>.<user>.flagship.services,
  *.<server>.<user>.flagship.services]` — its own key, never shared, **distinct per
  box** (the name contains `<server>`), so NO duplicate-cert collision, and the
  box-scoped wildcard covers `<service>.<server>.<user>` natively. This is A,
  extended with a box-scoped wildcard so services work. It is the security-first
  stance you started from, made service-capable.

## Name forms under A′

| Thing | Name | Cert that covers it | Who mints |
|---|---|---|---|
| A box | `<server>.<user>.flagship.services` | per-box cert (apex SAN) | the box |
| A service on a box | `<service>.<server>.<user>.flagship.services` | per-box **wildcard** `*.<server>.<user>` | the box |
| A shared multi-box service | `<service>.<user>.flagship.services` | a shared cert | phone or leader box |
| A short share-link for a service | `voi.ci/<blurb>` (PATH redirector) | none for the service — voi.ci has ONE cert for itself; it 302-redirects to the cert-bearing URL | the voi.ci worker |

## Three explicit trust tiers (the share-URL encodes the assurance)

The address you choose to share declares how much you trust us:
1. **Full canonical** `<service>.<server>.<user>.flagship.services` — **security + HARDWARE
   assurance**. You're talking to THIS box; its per-box cert is pinnable to the
   box's STK-signed fingerprint. Use for key exchange / private data when you care
   which metal.
2. **service+user** `<service>.<user>.flagship.services` — **security, hardware-AGNOSTIC**.
   Real cert, still verifiable, but the leader-selection harness picks which box
   answers. Use when you want the service securely and don't care which box runs it.
3. **voi.ci/blurb** — **convenience; you trust US for the security+hardware juggling.**
   A short path link that VISIBLY 302-redirects to tier 1 or 2 (the user lands on,
   and sees, the real cert-bearing flagship.services URL). NOT a zero-trust pipe (the
   redirector is flagship-controlled) — that's the explicit trade for a short link.
   For zero-trust, share tier 1 or 2 directly.

voi.ci stays exactly as it is today: `voi.ci/<blurb>` assigned once per service (in
lieu of the `<service>.<user>` URL, presupposing leader-selection), redirecting to the
cert-bearing address. It carries NO per-service certs and NO Let's-Encrypt exposure of
its own beyond the single cert voi.ci needs to serve the redirector over HTTPS.

## Answers to your specific questions

**1. "A needs wildcards for `<service>.<server>.<user>` — does that work in limits?"**
Yes. A′ mints a **box-scoped** wildcard `*.<server>.<user>` (one cert per box,
distinct name). It does NOT hit the duplicate-cert limit (names differ per box) and
costs exactly the same against the 5000/week per-registered-domain budget as C did
(both mint once per box). At ~60-day renewals, 5000/week sustains ~42k boxes on
renewals alone; PSL (per-user budgets) is the later lever when you have the users
LE asked for.

**2. "Multi-server shared service `<service>.<user>` — can the phone mint it?"**
Yes, this is the clean way. `<service>.<user>` is NOT under any one box, so a per-box
wildcard can't cover it. Mint it ONCE and distribute via the trust root:
the **phone (or a leader box) mints `<service>.<user>`** and **seals the cert key to
each serving box's STK** (reusing the existing sealed-to-STK delivery primitive —
`.com` only ever holds ciphertext, I1). The leader-selection harness routes
`<service>.<user>` requests to the current leader. This is the ONLY place a key is
shared, it is opt-in (only for genuinely multi-box services), the channel is
trust-root-sealed (not `.com`-readable), and the blast radius is one service (not the
whole user). Phone-as-minter needs the phone to run ACME (DNS-01 via `.com`
publishing the TXT) — heavier, so this is the last phase.

**3. "Does the `--` flattening (`messenger-facebook--home.john`) need reverting?"**
Yes. The `--` was a workaround so a service could sit as ONE label under `*.<user>`
(the per-user wildcard only covers one level). A′'s per-box wildcard `*.<server>.<user>`
covers the natural HIERARCHY, so revert to `messenger-facebook.home.john.flagship.services`.
Meaningful names stay meaningful — `<service>.<server>.<user>` is the canonical,
human-readable, secure name.

**4. "Do meaningful names go away if we move to voi.ci routing?"**
No. voi.ci slugs are an ADDITIONAL short alias, never a replacement. Canonical
hierarchical name = the verifiable secure pipe; voi.ci slug = a short convenience
address that ALSO terminates on the box (if CNAME-cert) or redirects (if redirector).
You keep both.

**5. "Idempotent root domains — `*.voi.ci` also routes to `*.flagship.services`
automatically?"** Routing-wise yes (the SNI passthrough can accept the voi.ci apex
and route by the box, same as flagship.services). But it is NOT free/automatic at the
TLS layer: each presented name still needs (a) a cert that covers it and (b) a DNS A
record. So `<slug>.voi.ci` works as a secure pipe only if the box holds a cert for
`<slug>.voi.ci`. "Idempotent" = same routing fabric, but per-name cert + DNS still required.

**6/7/8. voi.ci — DECIDED: stays a path redirector, NOT CNAME-certs.**
(Owner direction.) Asking LE to bless `voi.ci` certs would smear the security root
across two registered domains and defeat the purpose of `flagship.services` being THE
security root. So: **voi.ci carries no per-service certs** — `voi.ci/<blurb>` simply
302-redirects to the cert-bearing flagship.services URL. Consequences:
- **No voi.ci LE rate-limit exposure** beyond the single cert voi.ci needs for itself
  (the redirector host). No separate LE increase. No PSL question for voi.ci.
- The redirect is **visible** — the client lands on (and sees) the real
  flagship.services URL, where the cert + pinning apply.
- The three trust tiers (above) make the trust trade explicit: zero-trust users share
  the canonical or service+user URL; "just give me a short link, I trust you" users
  share voi.ci/blurb. The redirector being flagship-controlled is the acknowledged
  price of the convenience tier, not a hidden weakness.
- Keep CURRENT behavior: one `voi.ci/<blurb>` per service, in lieu of `<service>.<user>`
  (so it presupposes leader-selection). Migration touches only its redirect TARGETS,
  to match the post-`--`-revert names.

## Cert-fingerprint pinning (the "we're not cheating" proof)

This is what defends the pipe against a malicious `.com` (which controls DNS and
could mint a rogue cert): **the client pins the box's real cert fingerprint and
rejects anything else.**
- The box already reports its leaf-cert `certSha256` in the **STK-signed daemon-status
  heartbeat** (built this session). Because it's STK-signed, `.com` can RELAY it but
  cannot FORGE it.
- The phone pinned the box's STK at setup → it verifies the STK signature on the
  fingerprint → trusts the fingerprint even though it arrived via `.com`.
- On connect to `<server>.<user>` (or `slug.voi.ci`), the client pins the served leaf
  == the STK-signed fingerprint. A `.com` rogue cert (different key) fails the pin →
  no MITM. CT monitoring is the after-the-fact backstop; CAA blocks external CAs.

## Rate-limit accounting under A′ (per registered domain, /week)

- `flagship.services` (raised to 5000/week): per-box wildcard = 1 issuance/box/~60d;
  shared-service cert = 1/service; all DISTINCT names → no duplicate-cert limit.
  Comfortable to tens of thousands of boxes; PSL later for per-user budgets.
- `voi.ci`: NO per-service certs (redirector only) → no LE rate exposure beyond the
  one cert voi.ci needs to serve the redirector. No increase, no PSL needed for voi.ci.

## Migration phases (next session)

### Phase 0 — lock decisions (below) + scout
Confirm the decisions list. Scout the current cert/name code so the cutover is exact:
- daemon ACME name construction (`packages/server-daemon/src/acme/*`,
  `letsEncryptIssuer.ts` — currently `[<user>, *.<user>]`).
- DNS publish (`serverRegister.ts` user-zone A/AAAA + `remoteDnsChallengeWriter.ts`
  `_acme-challenge.<user>` TXT) → must repoint to the box subdomain.
- SNI routing / passthrough: confirm `*.<server>.<user>` SNI routes to the box's
  tunnel (services-zone validation + the SNI parser/router).
- Everywhere the `--`-flattened service FQDN is built/parsed (apps, daemon service
  runner, manifest, voi.ci appId encoding, webapp/iOS/Android service URLs).

### Phase 1 — per-box wildcard issuance (the core C→A′)
1. Daemon ACME: mint `[<server>.<user>.flagship.services, *.<server>.<user>.flagship.services]`
   (DNS-01; box-local key; persist + renew as today).
2. DNS: `.com` publishes per box — `A/AAAA <server>.<user>`, `A/AAAA *.<server>.<user>`
   (wildcard, so any service name resolves to the passthrough), and the DNS-01 TXT at
   `_acme-challenge.<server>.<user>`. Repoint `remoteDnsChallengeWriter` + the
   register-time zone writer from `<user>` to `<server>.<user>`.
3. SNI routing: ensure `*.<server>.<user>` SNI maps to the box's tunnel (likely a
   prefix/suffix match on the registered `<server>.<user>` routing key).
4. CAA: keep per-zone CA-restriction; attach at `<server>.<user>` (or keep the
   user-zone CAA — it walks down). No accounturi (per-box accounts; CT covers `.com`).
5. Gate: a fresh burn → box serves `<server>.<user>` AND `x.<server>.<user>` green.

### Phase 2 — revert `--` to hierarchical
Switch `<service>--<server>.<user>` → `<service>.<server>.<user>` everywhere it's
constructed/parsed/displayed/routed. Lossless; pre-launch so no stored back-compat
needed, but grep exhaustively (URL builders, voi.ci appId, manifests, all 3 clients).

### Phase 3 — voi.ci redirect targets (light; keep the existing redirector)
voi.ci stays the existing path redirector (NO certs per service). Only update the
redirect-target construction so `voi.ci/<blurb>` 302s to the post-`--`-revert
cert-bearing URL (tier 1 canonical or tier 2 service+user, as today). Verify the
existing voi.ci appId/blurb encoding still maps correctly after the name change.

### Phase 4 — client cert-fingerprint pinning
Surface the STK-signed `certSha256` to the clients; pin on connect to
`<server>.<user>` (+ voi.ci). The daemon heartbeat already reports it.

### Phase 5 — shared multi-server services `<service>.<user>` (most complex; can defer)
Phone (or leader) mints `<service>.<user>`, seals the key to each serving box's STK,
delivers via `.com` (ciphertext only); leader-selection harness routes the name to
the current leader. Opt-in, one-service blast radius. Build last.

## Decisions to lock before executing

1. **A′ confirmed** as the model (per-box wildcard, box-local key, no sharing)? (Y/N)
2. **Revert `--`** to hierarchical names? (Y/N — recommended Y)
3. **voi.ci = redirector only** (DECIDED): no per-service certs, no LE increase, no
   PSL for voi.ci; just keep the path redirector and update its targets. ✓ locked.
4. **File PSL** for flagship.services once there are real users (deferred per LE)?
5. **Shared multi-server services**: in-scope this migration (Phase 5) or later?
   (rec: later — A′ + redirector cover the common case first.)
6. **Pinning**: pin to the STK-signed fingerprint (recommended) — confirm the clients
   should hard-fail on mismatch (vs warn). (rec: hard-fail.)
7. **Tier 2 (`<service>.<user>`) availability**: is it offered for EVERY service
   (every service gets leader-selection + a shared cert, so voi.ci/blurb always has a
   service+user target), or ONLY for services the owner opts into hardware-agnostic
   mode (single-box services stay canonical-only, and voi.ci/blurb → canonical)?
   This decides how early Phase 5 (shared cert + leader) is actually needed.
