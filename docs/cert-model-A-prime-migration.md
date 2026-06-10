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
| A short alias for a service | `<slug>.voi.ci` | a box-minted voi.ci cert (separate) | the box |
| A shared multi-box service | `<service>.<user>.flagship.services` | a shared cert | phone or leader box |

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

**6. "voi.ci limits — does the limit only affect the top-domain in the cert?"**
LE's limit is **per registered domain**, and a cert counts against the limit of
**every** registered domain it names. So `voi.ci` has its OWN 5000-or-default budget,
and a multi-SAN cert spanning `flagship.services` + `voi.ci` spends BOTH per issuance
— which also **couples failure domains** (a voi.ci-limit stall would block the box's
flagship cert renewal too). → Recommendation: **separate certs** per name-family
(one per-box flagship wildcard cert; one voi.ci cert), given the rate headroom — it
decouples failure domains at the cost of one extra issuance per box.

**7. "Can we expect LE to be lenient for voi.ci / tag it to the prior request?"**
Rate increases are granted per registered domain, so you file a **separate increase
request for `voi.ci`**, referencing the same use case (they were lenient for
flagship.services; likely similar). Until granted, voi.ci has the default (~50/week)
— enough for early testing, not for every box minting a voi.ci SAN at scale. Treat
the voi.ci-CNAME-cert layer as gated on that increase.

**8. "Redirector (`voi.ci/slug`) vs CNAME-cert (`slug.voi.ci`) — enough value?"**
- **Redirector** (`voi.ci/slug` → 302 → flagship URL): simplest, one voi.ci cert.
  BUT the entry point is a `.com`-controlled redirect — NOT a secure pipe (it can be
  MITM'd / re-pointed, and it can't be cert-pinned). Fine for casual link-sharing,
  WRONG for the secure pipe (key exchange / private data).
- **CNAME-cert** (`slug.voi.ci` served directly with a box-minted cert): the short
  name IS a verifiable, pinnable secure pipe (works for WSS/API, stable forever),
  because the box holds its cert. Costs voi.ci issuances + the rate increase.
- **Recommendation:** the canonical `<service>.<server>.<user>` is ALWAYS the secure
  pipe. Offer `slug.voi.ci` as an **opt-in short secure address** (CNAME-cert) for
  services that want a stable short URL; offer `voi.ci/slug` redirectors only for
  pure share-a-link discovery, explicitly NOT for secure pipes.

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
- `voi.ci` (default until raised): 1 issuance per slug-cert. Gate the voi.ci layer on
  a separate LE increase. Keep voi.ci certs SEPARATE from flagship certs (decoupled
  failure domains).

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

### Phase 3 — voi.ci CNAME-certs (gated on the voi.ci LE increase)
1. Assign each service-on-a-box a forever `<slug>.voi.ci` (slug→box-service mapping,
   stored). 2. Box mints a SEPARATE cert for its `<slug>.voi.ci` name(s). 3. DNS:
   `A <slug>.voi.ci` (or `*.voi.ci`) → passthrough; routing: slug→box tunnel.
   4. Passthrough accepts the voi.ci apex SNI. 5. Decide redirector vs CNAME-cert per
   §8 (default: canonical = pipe; voi.ci CNAME-cert opt-in; redirector for casual).

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
3. **voi.ci layer**: CNAME-cert (opt-in, gated on LE increase) vs redirector vs both?
   And: separate voi.ci certs (recommended) vs combined multi-SAN?
4. **File the voi.ci LE rate increase** now-ish (separate request)?
5. **File PSL** for flagship.services once there are real users (deferred per LE)?
6. **Shared multi-server services**: in-scope this migration (Phase 5) or later?
7. **Pinning**: pin to the STK-signed fingerprint (recommended) — confirm the clients
   should hard-fail on mismatch (vs warn).
