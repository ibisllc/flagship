# Architecture v2: hybrid post-quantum suites

> **Status: draft — pending Q01 external cryptographic review.** Milestone 1
> (§9-§10) pilots the hybrid signature on the box: keyd signs with it, `.com`
> verifies it through the critical-signature gate, and the webapp pins the
> box's ML-DSA key. Strict is enforced only where an installation's stored
> policy says so; no deployed installation has such a row. The encodings may
> still change. A deployed v1 byte string never changes because of this
> document (`IMPLEMENTATION-PLAN.md` §6.4).

Implements plan packages Q02 (crypto implementation and cross-language
verification) and the protocol half of A04. Code:

| Piece | Rust | TypeScript |
|---|---|---|
| Strict parsing, v1 canonical bytes, v2 envelope header, suite registry | `rust/crates/flagship-protocol` | `packages/protocol/src/pqHybrid.ts` (header, purpose grammar); v1 encoders already in `packages/protocol/src/*.ts` |
| `flagship/hybrid-seal/v1`, `flagship/hybrid-sig/ed25519-mldsa65/v1`, key ids | `rust/crates/flagship-crypto` | `packages/protocol/src/pqHybrid.ts` |
| Shared vectors | `packages/protocol/test-vectors/pq-hybrid/` | same files |
| Key bindings, critical-signature gate (§9-§10) | `rust/crates/flagship-crypto/src/trust.rs` | `packages/protocol/src/pqTrust.ts`; webapp `lib/pqBinding.js` (verify only) |
| Binding and gate vectors | `packages/protocol/test-vectors/pq-binding/` | same file (`npx tsx tools/pq-binding-vectors.ts [--check]`) |

## 1. Notation

- `u8(n)`, `u16be(n)`, `u32be(n)`, `u64be(n)`: unsigned big-endian integers.
- `lp8(x) = u8(len x) || x`; `x` is at most 255 bytes wherever `lp8` is used.
- `||` is byte concatenation. ASCII strings are their bytes, no terminator.
- Integers carried in any v2 structure are at most `2^53 - 1`
  (`Number.MAX_SAFE_INTEGER`), so every port represents them exactly. Larger
  values are refused, not truncated.
- Error codes are stable strings, identical in Rust (`code()`) and TypeScript
  (`PqHybridError.code`), and are what the vectors' `expect` fields name.

## 2. Common rules

### 2.1 v1 canonical bytes (unchanged)

`tag|field|...|field`, UTF-8, as the TypeScript encoders build them with
`[...].join("|")`. The Rust builder (`flagship_protocol::CanonicalV1`)
reproduces every vector in `test-vectors/canonical-bytes.json` and the
`app-api-key`, `llm-promo-issue`, `backup-policy`, `service-env-change` and
`server-order` sets byte for byte. It accepts a strict subset of what the TS
encoders accept:

- text fields refuse `|` and control characters (0x00-0x1F, 0x7F) always,
  even where an older TS encoder did not guard;
- integers are `0..=2^53-1` (`int` allows `±(2^53-1)` for the `-1` marker);
- `js_number` accepts only values whose JavaScript `String(n)` and Rust
  rendering agree: integers up to `2^53-1`, and non-integers with
  `|n| >= 1e-6` (smaller ones switch to exponent form in JavaScript);
- list items are non-empty and contain no `,`; sorted lists sort by UTF-16
  code unit, as `Array.prototype.sort` does;
- bytes render as lowercase hex.

The strict parsing helpers (`flagship_protocol::parse`) are for every crate
that reads wire data: `parse_lower_hex(s, min, max)` (lowercase only, even
length, byte bounds checked before decoding), `parse_decimal_u64(s, max)`
(no sign, no leading zero), `split_fields_exact(s, n)` (exactly `n` fields),
`check_field_text`, `validate_purpose_tag`, `purpose_tag_of`.

### 2.2 Purpose tags

`<ns>/<segment>(/<segment>)*/v<N>`: `ns` is `flagship` (v2 always; v1 also
admits the legacy `pb`), 1 to 6 segments of `[a-z0-9][a-z0-9-]*` of at most
48 bytes, `N` in `1..=9999` without a leading zero, the whole tag at most 128
bytes. Every tag literal in `packages/protocol/src` passes (a Rust test scans
them). Error: `bad-purpose` (or `header-bad-value` inside a header).

### 2.3 Suite registry and key ids

| Id | Tag | Construction |
|---|---|---|
| `0x0001` | `flagship/hybrid-seal/v1` | X-Wing KEM, HKDF-SHA-512, AES-256-GCM |
| `0x0002` | `flagship/hybrid-sig/ed25519-mldsa65/v1` | Ed25519 AND ML-DSA-65 |

A suite id names one complete construction; there is no negotiation inside a
suite and no fallback between suites. Any other id is refused.

`keyId(suite, pk) = SHA-512(lp8("flagship/pq-key-id/v1") || u16be(suite) ||
u16be(len pk) || pk)[0..32]`. The suite is part of the input, so the same
bytes can never share an id across suites.

## 3. v2 envelope header (`flagship/envelope/v2`)

### 3.1 Wire

```
header = lp8("flagship/envelope/v2") || u16be(tlv_len) || TLV*
TLV    = u8(type) || u16be(len) || value
```

The whole header (21 + 2 + `tlv_len`) is at most **1024** bytes.

| Type | Field | Value | Presence |
|---|---|---|---|
| 0x01 | purpose | UTF-8 tag, 1..=128 bytes, §2.2 with ns `flagship` | required |
| 0x02 | suite | `u16be`, registered (§2.3) | required |
| 0x03 | sender key id | 32 bytes | required |
| 0x04 | recipient key id | 32 bytes | required for suite 0x0001, optional otherwise |
| 0x05 | installation id | 16 bytes | optional |
| 0x06 | authority generation | `u64be`, ≤ 2^53-1 | optional |
| 0x07 | session nonce | 32 bytes | optional |
| 0x08 | policy digest | 64 bytes (SHA-512) | optional |
| 0x09 | issued at (ms) | `u64be`, ≤ 2^53-1 | required |
| 0x0A | expires at (ms) | `u64be`, ≤ 2^53-1, > issued at | optional |
| 0x0B | body length | `u32be`, ≤ 1,048,576 + 4096 | required |

### 3.2 Rules

- Types appear in strictly ascending order. A repeated type is
  `header-duplicate-field`; a decrease is `header-field-order`.
- **Unknown types are refused** (`header-unknown-field`), including 0x00 and
  anything above 0x0B. There is no ignorable extension range: a new field
  needs a new header tag (`flagship/envelope/v3`), so an old verifier can
  never silently skip a field a new signer meant to be binding.
- Optional fields are absent or full length. A present-but-empty field is
  `header-field-length`; "unset" has exactly one encoding, absence.
- Fixed-size fields must have exactly their size (`header-field-length`).
- Decoders re-encode and compare with the input bytes; there is exactly one
  encoding per header.
- `decode_envelope` requires the bytes after the header to be exactly
  `body_len` long (`body-length`): no trailing data, no short bodies.
- Freshness (issued/expires against a clock), replay (session nonce) and
  generation policy are the caller's checks; the header only carries and
  binds them.

### 3.3 Decode check order (both ports)

1. fewer than 21 bytes: `header-truncated`; first 21 bytes not the magic:
   `header-bad-magic`; no length: `header-truncated`;
2. 23 + `tlv_len` > 1024: `header-too-large`; fewer bytes than that:
   `header-truncated`;
3. per TLV, in order: incomplete type/length/value `header-truncated`;
   unknown type; duplicate; order; length (`header-field-length`);
   value (`header-bad-value`: non-UTF-8 purpose, unregistered suite);
4. missing required field, checked purpose, suite, sender, issued at, body
   length: `header-missing-field`;
5. semantic checks: purpose length, purpose grammar, integers ≤ 2^53-1,
   expires > issued, body length bound (`header-bad-value`), seal without a
   recipient (`header-missing-field`);
6. re-encode mismatch: `header-bad-value`.

## 4. `flagship/hybrid-seal/v1`

Public-key encryption of one message to one recipient. **Not sender
authenticated**: the sender key id is bound into the key schedule but nothing
proves who sealed. Authority requires a signature (§5) over the sealed bytes
or inside the plaintext; that composition is an open question (§8).

### 4.1 X-Wing revision

The KEM is X-Wing as specified in **draft-connolly-cfrg-xwing-kem-11**
(2026-09-23, the newest revision when this was written).

- RustCrypto `x-wing 0.1.1` says it matches draft **06**; `@noble/post-quantum
  0.7.1` (`ml_kem768_x25519` in `hybrid.js`) cites the draft without a
  revision.
- The algorithm text of drafts 06 and 11 differs only editorially (SHAKE256
  output given in bits instead of bytes, ASN.1 module, implementation list);
  the change log since 06 lists no computational change. The Appendix C
  known-answer vectors of 06 and 11 are byte-identical, and identical to
  `x-wing`'s own `tests/test-vectors.json`.
- **Both implementations pass the draft-11 Appendix C vectors**
  (`xwing-draft11-kats.json`): key generation from the seed, derandomized
  encapsulation, decapsulation. Their combiners are the same:
  `SHA3-256(ss_M || ss_X || ct_X || pk_X || "\.//^\")`.
- One behavioural difference was found and closed: the draft says nothing
  about an all-zero X25519 shared secret. noble throws on it (in encapsulation
  and decapsulation); `x-wing`'s default `DecapsulationKey` accepts it. The
  Rust side therefore uses `DecapsulationKeyRejectNonContrib` and validates
  recipient public keys (§4.2), so both refuse identically. CFRG has said the
  RFC will pick one behaviour; revisit when it does.

Sizes: public key 1216 (`pk_M` 1184 || `pk_X` 32), secret key 32 (the seed),
encapsulation 1120 (`ct_M` 1088 || `ct_X` 32), shared secret 32.

### 4.2 Keys

- Secret key: the 32-byte X-Wing seed. Generated from the OS RNG; never
  derived from an Ed25519 or other seed.
- Public key validation (`bad-public-key`): exactly 1216 bytes; the ML-KEM
  part passes the FIPS 203 §7.2 modulus check (every 12-bit coefficient below
  3329); the X25519 part is not in the small-order subgroup (checked as
  X25519 with a fixed clamped scalar yielding zero, which happens exactly for
  small-order points).
- `recipient key id = keyId(0x0001, pk)`.

### 4.3 Key schedule

```
(ss, enc) = X-Wing.Encapsulate(pk)              eseed = 64 fresh bytes:
                                                  [0..32) ML-KEM coins,
                                                  [32..64) X25519 ephemeral
header    = envelope header: suite 0x0001, recipient key id, sender key id,
            purpose, caller fields, body_len = 1120 + len(plaintext) + 16
info      = lp8("flagship/hybrid-seal/v1") || u16be(0x0001)
         || lp8(purpose) || sender_key_id (32) || recipient_key_id (32)
         || u32be(len header) || header
         || u8(n) || (u16be(len c_i) || c_i) for i in 1..n     caller context
         || enc (1120)
PRK       = HKDF-Extract(salt = "flagship/hybrid-seal/v1", IKM = ss)   SHA-512
OKM       = HKDF-Expand(PRK, info, 44)
key       = OKM[0..32]     nonce = OKM[32..44]
ct || tag = AES-256-GCM(key, nonce, aad = header || enc, plaintext)
```

The info binds suite id, purpose, sender id, recipient key id, every header
field, the caller's context fields (count and each length, so fields cannot be
merged, split, dropped or added) and the full encapsulation. The suite id,
purpose and key ids appear both inside the header and explicitly so the
binding does not depend on the header layout. The context is not transmitted:
both sides supply it (e.g. server name, boot session id).

**Nonce.** Every message has its own encapsulation, so each AES key encrypts
exactly one plaintext and any fixed nonce would be safe. The nonce is derived
from the same HKDF output rather than fixed so the construction has no
special constant and a future multi-message mode cannot silently inherit a
constant nonce. This does not protect against an RNG failure: a repeated
`eseed` with the same recipient and transcript repeats key and nonce, which
breaks GCM. `seal_with_randomness` / `hybridSealWithRandomness` exist only for
vectors (§8 asks whether to hedge).

### 4.4 Wire and bounds

`sealed = header || enc (1120) || ct || tag (16)`, with `len ct = len
plaintext`.

| Bound | Value | Error |
|---|---|---|
| plaintext | ≤ 1,048,576 bytes | `plaintext-too-large` |
| context | ≤ 16 fields, each ≤ 1024 bytes | `context-too-large` |
| header | ≤ 1024 bytes | `header-too-large` |
| body | exactly `body_len`, ≥ 1136 | `body-length` |

### 4.5 Opening, in order

1. caller inputs: expected purpose grammar (`bad-purpose`), context bounds;
2. header and body (§3.3);
3. suite is 0x0001 (`suite-mismatch`); purpose equals the expected purpose
   exactly (`purpose-mismatch`); recipient key id equals the opener's
   (`recipient-mismatch`);
4. body at least 1136 bytes (`body-length`); plaintext bound;
5. X-Wing decapsulation, refusing a non-contributory X25519 result; HKDF;
   AES-GCM open.

Every failure in step 5 is the single code `decrypt-failed` (ML-KEM's
implicit rejection, a low-order `ct_X`, wrong context, any tampered byte of
header, encapsulation, ciphertext or tag). Steps 1-4 refuse only on public
data and may name their cause.

## 5. `flagship/hybrid-sig/ed25519-mldsa65/v1`

### 5.1 Keys and encodings

| | Bytes | Layout |
|---|---|---|
| secret key | 64 | Ed25519 RFC 8032 seed (32) `||` ML-DSA-65 `KeyGen_internal` seed ξ (32) |
| public key | 1984 | Ed25519 key (32) `||` ML-DSA-65 key (1952) |
| signature | 3373 | Ed25519 signature (64) `||` ML-DSA-65 signature (3309) |

The two seeds are independent random values; neither is derived from the
other or from any existing Flagship key. Signer key id = `keyId(0x0002, pk)`.
Private material zeroizes on drop (Rust: `ed25519-dalek` and `ml-dsa` with
`zeroize`; TS: expanded ML-DSA keys are wiped after use, best effort).

### 5.2 Signed message

```
M' = lp8("flagship/hybrid-sig/ed25519-mldsa65/v1") || u16be(0x0002)
  || ed25519_pk (32) || mldsa65_pk (1952)
  || lp8(purpose) || u32be(len payload) || payload
```

- Ed25519 signs `M'` (pure Ed25519).
- ML-DSA-65 signs `M'` with the FIPS 204 context string
  `"flagship/hybrid-sig/ed25519-mldsa65/v1"` (38 bytes). The vectors use the
  deterministic variant (rnd = 32 zero bytes); production signing is hedged
  (32 fresh bytes). Verification is the same for both.

Binding both public keys into the message both components sign follows the
association-binding idea of the IETF LAMPS composite-signature drafts, so a
component cannot be lifted into a signature under a different key pairing.
Unlike those drafts there is no pre-hash: payloads are bounded at 1 MiB.

For a v2 envelope the payload is the encoded header followed by the body and
`purpose` is the header's purpose.

### 5.3 Verification

1. Public key (`bad-public-key`): 1984 bytes; the Ed25519 part is canonical,
   torsion-free and not the identity. The ML-DSA part is decoded as FIPS 204
   `pkDecode` (no further validity condition exists).
2. Purpose grammar (`bad-purpose`); payload ≤ 1 MiB (`payload-too-large`).
3. Signature exactly 3373 bytes, else `bad-signature`.
4. **Both** components must verify over `M'`; either failing is
   `bad-signature`. There is no classical-only or PQ-only mode.

**Strict Ed25519 profile.** Ports must agree on every signature, including
ones a malicious key holder crafts. `ed25519-dalek`'s `verify_strict` is
cofactorless and refuses small-order R and A; noble's verify is cofactored.
They can disagree only when R or A carries a torsion component. Both ports
therefore refuse non-canonical, small-order and torsion-carrying A (step 1)
and R (TS checks R explicitly; Rust's cofactorless equation cannot hold for a
torsion-carrying R once A is torsion-free), and refuse S ≥ L. The vector
`ed25519-cofactored-only` is a signature noble's plain verify accepts and both
strict verifiers refuse.

**Suite stripping.** Neither component signs anything but `M'`, which starts
with the hybrid suite tag. The vectors check that the Ed25519 half does not
verify over the payload, `purpose|payload`, `purpose || payload` or `M'`
without its tag, and that the ML-DSA half does not verify with an empty
context or over the bare payload. A verifier that only knows classical
Ed25519 cannot be handed a hybrid signature's component as a valid signature
on the payload.

## 6. Vectors

| File | Contents |
|---|---|
| `pq-hybrid/xwing-draft11-kats.json` | draft-11 Appendix C, transcribed verbatim |
| `pq-hybrid/vectors.json` | key ids, raw X-Wing cases, envelope headers (2 valid, 21 invalid), seals (3 valid, 24 invalid, 5 bad recipient keys, 3 bad inputs), signatures (3 valid, 18 invalid, oversize payload, suite-stripping checks) |

**The TypeScript port generates** `vectors.json` (`npx tsx
tools/pq-hybrid-vectors.ts`; `--check` fails if stale). The Rust tests
(`cargo test -p flagship-protocol -p flagship-crypto`) reproduce every
deterministic output byte for byte (public keys, key ids, sealed bytes,
signatures, `M'` digests) and refuse every invalid case with its exact code;
the TS tests (`npx vitest run packages/protocol/tests/pqHybridVectors.test.ts`)
do the same. Both run the draft KATs through their own X-Wing.

Negative coverage: each signature component zeroed, missing, reordered or
tampered; swapped key association (genuine halves from two signers under a
mixed public key); another signer's key; wrong purpose or payload; bad
Ed25519 keys (identity, torsion, non-canonical); tampered `ct_M`, `ct_X`,
all-zero `ct_X`, ciphertext, tag, header fields, stripped optional field,
rewritten purpose, suite or recipient id; wrong, dropped, added and merged
context; wrong recipient; truncation and trailing bytes; oversize inputs;
every header rule in §3.

## 7. Implementations and versions

All pinned exactly and at least two weeks old on 2026-10-23.

- Rust: `x-wing =0.1.1` (with `ml-kem 0.3.2`, `x25519-dalek =3.0.0`),
  `ml-dsa =0.1.1`, `ed25519-dalek =3.0.0`, `hkdf =0.13.0`, `sha2 =0.11.0`,
  `aes-gcm =0.11.1`, `zeroize =1.9.1`, `getrandom =0.4.3`, `rand_core
  =0.10.1`. Too-new transitive releases were held back in `Cargo.lock`
  (`ml-kem 0.3.3`, `ctutils 0.4.5`, `inout 0.2.5`, `libc 0.2.191`, `syn
  3.0.9`, `unicode-ident 1.0.27`).
- TypeScript: `@noble/post-quantum 0.7.1` (bundles `@noble/curves`,
  `hashes`, `ciphers` 2.4.0 for itself); the port's own Ed25519, HKDF, SHA-512
  and AES-GCM use the package's existing `@noble/curves 2.2.0`, `@noble/hashes
  1.8.0` and `@noble/ciphers 1.3.0`.
- None of these has had an independent audit of the versions pinned; the
  `x-wing` README says so, and noble's `hybrid.ts` header calls its hybrid
  *API* "flawed and likely redundant" (its X-Wing preset still matches the
  KATs). Randomness failure is a returned error in Rust (`randomness`), never
  a panic: provider APIs draw from a pre-filled buffer and a draw of the wrong
  size is refused.

## 8. Open questions for the Q01 reviewer

1. **Non-contributory X25519.** Both ports refuse an all-zero X25519 secret
   and small-order recipient keys. Confirm, and track CFRG's final choice.
2. **KDF over X-Wing.** X-Wing's output is already a binding KEM secret. Is the
   extra HKDF-SHA-512 with the full transcript in `info` (and the header again
   as AAD) sound and sufficient domain separation, and is the salt choice
   right?
3. **AEAD.** AES-256-GCM is not key-committing. Does any intended use (several
   recipients, key-search partitioning oracles) need a committing AEAD or a key
   commitment in the body? Should encapsulation randomness be hedged (e.g.
   mixed with a hash of the plaintext and a long-term secret) against RNG
   failure, or should the AEAD be nonce-misuse resistant?
4. **Sender authentication.** Specify how seal and signature compose (sign the
   sealed bytes with the sender key id as signer, or sign inside the
   plaintext), including replay windows for the session nonce and the issued
   and expires fields.
5. **Hybrid signature transcript.** Compare `M'` with the current LAMPS
   composite draft (prefix, label, pre-hash, context handling). Is binding both
   public keys plus the ML-DSA context string enough for non-separability and
   for preventing a component from being reused under another suite? Should
   the payload be pre-hashed for constrained devices?
6. **Key ids.** 32 bytes of SHA-512 over suite and key. Adequate as a binding
   identifier (collisions), or should the full key digest be bound where key
   ids appear?
7. **Strict Ed25519.** Refusing torsion components and the identity cannot
   affect honestly generated keys. Confirm the profile is acceptable for every
   planned verifier (boot client, Swift, Kotlin, Workers).
8. **Independent seeds.** Two independent 32-byte seeds versus one root seed
   expanded under documented labels: which is preferable for custody, backup
   and recovery?
9. **Bounds and side channels.** 1 MiB payload/plaintext, 16 × 1024-byte
   context, 1 KiB header. JavaScript offers no constant-time guarantee; are the
   noble implementations acceptable on the webapp and Workers for verification
   only (the keyless-web rule keeps private keys out of website JavaScript)?
10. **Error oracle.** `decrypt-failed` merges every post-header failure, but
    timing differs between an X25519 refusal and a GCM tag failure. It only
    reveals what the submitter chose; confirm that is acceptable.
11. **Rollout.** Nothing here implements the `legacy → capable → prepared →
    enforced → retired` state machine (§6.5). Suite ids are bound into every
    transcript so stripping is detectable, but anti-downgrade enforcement lives
    with Q03/Q04.

## 9. Key bindings: `flagship/pq-key-binding/v1`

Every identity that signs critical messages gets an ML-DSA-65 key bound to its
existing Ed25519 key. The binding is a mutual proof of possession: the two
keys sign one statement together with the hybrid suite (§5) under the public
key `ed25519_pk || mldsa65_pk`, so neither key can be paired with a key whose
holder did not sign.

### 9.1 Statement and wire

```
statement = "flagship/pq-key-binding/v1|<role>|<subjectId>|<ed25519PubHex>|<mldsa65PubHex>|<issuedAt>"
signature = hybrid-sig(sk = ed25519 seed || ML-DSA seed,
                       purpose = "flagship/pq-key-binding/v1", payload = statement)
wire      = { v: 1, role, subjectId, ed25519PubHex, mldsaPubHex, issuedAt, signature }
```

- `role` is one of `account-irk`, `admin-root`, `device`, `box-stk`,
  `boot-key`. The subject is the account name (IRK, admin root), the device id,
  or the server domain (STK, boot key).
- `subjectId` matches `^[a-z0-9][a-z0-9._:@-]{0,252}$` (so it is already
  canonical: lower case, no `|`).
- Hex is lowercase; `ed25519PubHex` 64 characters, `mldsaPubHex` 3904,
  `signature` 6746 (3373 bytes). `issuedAt` is milliseconds, `0..=2^53-1`.
- The wire object has exactly those seven keys and `v: 1`; anything else is
  `binding-malformed`.
- The ML-DSA seed is 32 fresh bytes from the OS RNG, never derived from the
  Ed25519 seed or any other key (§5.1, open question 8).

### 9.2 Verification, in order (TS, Rust and webapp agree on every code)

The verifier supplies what it already trusts: `role`, `subjectId`, the
trusted Ed25519 key (pinned or registered), optionally the ML-DSA key it has
already pinned, `now`, and optionally `minIssuedAt`.

1. Wire shape, then the signature, Ed25519 and ML-DSA hex, then `issuedAt`:
   `binding-malformed`. An unknown role is `binding-role`; a subject outside
   the grammar is `binding-subject`.
2. Role and subject differ from the expected ones: `binding-role`,
   `binding-subject`.
3. `ed25519PubHex` is not the trusted key: `binding-key-mismatch`.
4. A pinned ML-DSA key exists and differs: `binding-pq-key-changed`.
5. `issuedAt > now + 300000`: `binding-future`. `issuedAt < minIssuedAt`:
   `binding-stale` (a binding older than the one already pinned).
6. The hybrid public key fails §5.3 step 1: `bad-public-key`.
7. The hybrid signature fails over the statement: `bad-signature`. A
   classical-only signature, either half alone, a half zeroed, a half lifted
   from another binding (substituted Ed25519 or ML-DSA key), or a relabelled
   role, subject or time all end here.

A binding is never re-used under another role or subject; a verified binding
is an in-memory value the gate accepts only from the verifier (TS: a
module-private registry; Rust: a type with private fields).

### 9.3 Where bindings live (milestone 1)

- **Box STK.** keyd generates `identity-mldsa.key` (hex, 0400) next to the
  STK on its first `serve`, in both backends, and signs with both keys through
  `sign.hybrid` under the same purpose list as `sign` (`docs/keyd.md`). keyd
  signs `flagship/pq-key-binding/v1` only as `box-stk`, only naming its own two
  keys, and never with `sign` alone.
- **`.com`** stores bindings in D1 `pq_key_bindings` (migration 0111) only
  when they verify under the key it already trusts (for `box-stk`, the
  registered STK), keeps the first ML-DSA key per Ed25519 key (a different one
  is `409 pq-key-changed`: whoever can forge the classical half must not be able
  to rebind it), and serves one only while its Ed25519 key is the identity's
  current key: `PUT`/`GET /api/server/:host/pq-key-binding`. `.com` is a relay,
  not a trust root.
- **Clients** verify under the STK they pinned and pin the ML-DSA key
  (`decideBoxPqKeyPin` in `boxKeyPin.ts`; webapp `acceptStkPqBinding`). A
  different ML-DSA key is a key change the owner must confirm, as for the STK.
- **Account IRK, admin root, device**: milestone 2, §11.
- **Boot key**: the format and vectors cover it; issuing it needs the boot
  client (the boot key's private half lives on `/boot`, outside the daemon).

## 10. The critical-signature gate: `verifyCriticalSignature`

### 10.1 Inputs

| Input | Meaning |
|---|---|
| `message` | v1-style canonical bytes, `<purpose>|...` |
| `expectedPurpose` | the purpose the verifier expects; §2.2 grammar with ns `flagship` |
| `envelope` | `{ suite, signature }`; `suite` is `ed25519/v1` (64-byte signature) or `hybrid-ed25519-mldsa65/v1` (3373 bytes), lowercase hex |
| signer | the Ed25519 key the verifier trusts for this signer |
| `binding` | the signer's verified binding (§9), or none |
| `policy` | the scope's `PolicyState` (`assurancePolicy.ts`); strict is in force when `profile = strict` and `rollout` is `enforced` or `retired` |

For a hybrid envelope the purpose passed to §5 is the message's own tag, so
the hybrid transcript binds it.

### 10.2 Rules, in order

1. `expectedPurpose` fails the grammar: `bad-purpose`. The message's tag
   (bytes before the first `|`, strict UTF-8) differs: `purpose-mismatch`.
2. Any other suite: `unknown-suite`. Signature not lowercase even-length hex:
   `bad-signature`. Signer key not 32 bytes of hex: `bad-public-key`.
3. A binding for another Ed25519 key: `binding-key-mismatch`.
4. **Strict in force**: a classical envelope is `strict-requires-hybrid`; no
   binding is `strict-requires-binding`.
5. Hybrid envelope: no binding is `no-binding`; otherwise both components must
   verify (§5.3) under the binding's key, else `bad-signature`.
6. Classical envelope (only outside strict): strict-profile Ed25519 over the
   message, else `bad-signature`.

The verdict names the suite accepted and whether strict was in force.

**No downgrade by stripping.** Which suite is required comes from the policy,
never from the envelope: removing the hybrid signature, relabelling it
`ed25519/v1`, or presenting its Ed25519 half as a classical signature is
refused under strict (step 4) and fails verification otherwise (the Ed25519
half signs `M'`, not the message; §5.3). A signature whose length does not
match its claimed suite fails. A hybrid signature that is offered must verify
even outside strict: a verifier never falls back to the classical signature
beside it.

### 10.3 Where the gate runs (milestone 1)

- `POST /api/daemon-status`: the box sends its classical `signature` (still
  verified, for clients that read it) and `pqSignature: { suite:
  "hybrid-ed25519-mldsa65/v1", signature }` once `.com` holds its STK binding.
  `.com` runs the gate whenever `pqSignature` is present or the installation
  is strict; a refusal is `403 signature refused: <code>`.
- `PUT /api/server/:host/boot-key`: beside the v1 signature the box sends
  `hybridSignature`, the STK's hybrid key over
  `flagship/boot-key-binding/v2|<serverDomain>|<bootPubHex>|<issuedAt>` (the
  same fields as v1, which stays readable). `.com` gates it (D1
  `server_boot_key_hybrid`) and serves it with the v1 wire. A client that has
  pinned the box's ML-DSA key refuses a boot-key binding without it.
- Policy state comes from D1 `assurance_policy_states` (scope `installation`,
  the server domain). No row is legacy; a row with a profile or rollout this
  code does not know is read as strict and enforced, so a corrupt or newer row
  never weakens a scope. Owner-signed changes write these rows (§11.3).

### 10.4 Vectors

`test-vectors/pq-binding/vectors.json`: three signers with fixed seeds; five
valid bindings (one per role) with their statements; 31 refusals (substituted
Ed25519 or ML-DSA key, swapped fields, either signature half missing or zeroed,
classical-only, wrong or relabelled role, subject, key, stale, future, every
malformed shape, an identity Ed25519 key); 27 gate cases (classical and hybrid
under compatibility, strict and the not-yet-in-force states, a stripped or
relabelled suite, no binding, another signer's binding, tampered messages,
wrong purpose, unknown suite, the boot-key binding v2). TS, Rust and the
webapp check every case; Rust re-signs every binding byte for byte.

### 10.5 Open questions for the Q01 reviewer (additions)

12. The binding statement repeats both keys that `M'` already binds; is the
    redundancy useful (explicit association in the signed text) or noise?
13. Freshness: bindings carry `issuedAt` but no expiry; anti-rollback is the
    verifier's `minIssuedAt` (its pin). Is a lifetime needed for long-lived
    identity keys?
14. First-ML-DSA-key-wins on `.com` and on clients means a lost keyd state
    needs an STK change to rebind. Is that the right recovery boundary?
15. A box reports `pqSignature` only after its binding is confirmed on `.com`,
    and `.com` refuses a hybrid signature it cannot check. Confirm that a
    failure to verify an offered hybrid signature must never fall back to the
    classical one.

## 11. Milestone 2: phone-held identities and the owner's policy

### 11.1 Ports

Swift (`apps/mobile/shared`) and Kotlin (`apps/mobile/android`) port §3–§5,
§9, §10 and `assurancePolicy.ts`, and read the same vector files as TS, Rust
and the webapp (`pq-hybrid` with the X-Wing KATs, `pq-binding`,
`assurance-policy`). The webapp ports the gate and the policy, verify-only
(`lib/pqBinding.js`, `lib/assurancePolicy.js`); it never holds an ML-DSA seed
(keyless-web rule) and seals nothing hybrid yet.

### 11.2 Keys on user devices

- One ML-DSA-65 key per identity per holding device: 32 fresh bytes from the
  OS RNG, never derived from the UMK, the admin root or any other key, never
  exported, escrowed, put in a pairing bundle or a recovery record.
- Custody, labelled exactly: a software seed wrapped by a hardware key that
  needs biometric-or-credential authentication is **"PQ, hardware-wrapped"**
  (Android: an Android Keystore AES-GCM key; iOS 18–25: the Secure Enclave
  wrap the app already uses for the UMK). A key generated inside the Secure
  Enclave (`SecureEnclave.MLDSA65`, iOS 26 and later) is **"hardware PQ"**;
  it is used only for the `device` role, the only one that never leaves the
  device by design. Android 16's Keystore offers no ML-DSA.
- Roles: `account-irk` (subject = account name, key = the account IRK),
  `admin-root` (subject = account name, key = the pinned admin root),
  `device` (subject = the 32-hex device id, key = that device's grant key).
  The device that first holds the IRK or admin root binds it; `.com` keeps the
  first ML-DSA key per Ed25519 key, so the other devices act under strict
  through their own `device` bindings (policy changes take `admin-device`
  signers).
- When: account creation (IRK, device, admin root), device enrollment
  (device), admin-root setup or rotation (admin root). Existing accounts bind
  at the next unlock in the background with the keys that unlock already
  opened; nothing prompts again, and a refusal or a network failure waits for
  a later unlock.
- Studio (Mac, Windows, Linux) never signs as an account device (it only
  agrees an X25519 key for pairing and verifies recipes), so it holds no
  ML-DSA key.

### 11.3 `.com`

- `PUT /api/accounts/:u/pq-key-bindings` (no other auth: the binding proves
  possession) stores a binding only under the key `.com` already trusts for
  the identity: the account's current IRK, its pinned admin root, the live
  device row's key. `200`; `409 stale` (already stored); `409 pq-key-changed`
  (another ML-DSA key holds this Ed25519 key); `403 <code>`; `404` unknown
  device. `GET` (account read token) serves the current ones; the device-grant
  book (`GET /api/users/:u/device-grants`) carries them too: `pqKeyBinding` on
  each grant and `pqKeyBindings: { accountIrk, adminRoot }`.
- **Recovery** cannot install strict authority classically: a re-paired IRK
  becomes the current IRK only when the re-pair's wait/veto completes
  (`rePair.ts`), so the new IRK's binding is refused until then
  (`binding-key-mismatch`); an unrotated recovered root cannot rebind
  (`pq-key-changed`). Old bindings stop being served once their key is no
  longer current.
- **Policy** (D1 `assurance_policy_changes`, migration 0112):
  `POST /api/accounts/:u/assurance-policy` `{ change, signature: { suite,
  signature } }`. The scope must be the account's (installation = a server of
  the account; `service`/`data`/`connector` ids are `<serverDomain>:<name>`;
  `device` = a live device). The signer is the pinned admin root or a live
  device with an admin-root-signed `admin` grant; `signerKeyId` is its 64-hex
  Ed25519 key. The signature runs through the gate (purpose
  `flagship/assurance-policy/v1`, the signer's binding, the scope's current
  state), then `applyPolicyChange`; the change is appended by compare-and-swap
  at head + 1, so a second change for a generation is `409 fork` and an old
  one `409 stale-generation`.
- Rollout evidence `.com` can see moves a scope through `capable`
  (the box's STK binding verifies) and `prepared` (also: the boot-key binding
  is hybrid, the admin root or an admin device is bound, the account holds a
  signed N03 recovery record) before a change is applied. `GET
  /api/accounts/:u/assurance-policy/:kind/:id` (read token) serves the state,
  the chain and `evidence.recoveryChecked`.

### 11.4 Box and clients

- The device book verifies every binding it syncs under the key the box pins
  (grant key, config IRK, config admin root) and pins the first ML-DSA key per
  Ed25519 key on disk; `.com` cannot swap it.
- The box replays its installation's chain from legacy itself
  (`assurancePolicySync.ts`): each change through the gate under its own pins,
  only admin-root or admin-device signers, its own evidence for `prepared`
  (its STK binding is on `.com`, its boot-key binding is hybrid) plus
  `.com`'s `recoveryChecked`, which can only let the owner turn strict on. It
  keeps a verified prefix, refuses a chain older than what it holds
  (`adoptStoredState`), and reads an unreadable state file as strict until a
  verified chain arrives.
- While strict is in force, `authorizeSensitiveOrder` (every sensitive box
  order) needs the identified signer's hybrid signature by its bound key.
  Clients do not sign hybrid orders yet, and no client offers the strict
  opt-in yet (milestone 4), so nothing is strict outside tests.
- Clients replay a served chain with their port of `assurancePolicy.ts`; a
  strict server's boot-key binding needs the hybrid signature even before the
  client has pinned the box's ML-DSA key.

### 11.5 Open questions for the Q01 reviewer (additions)

16. The IRK's and admin root's ML-DSA halves live only on the device that
    bound them; losing that device leaves those roots classical until a
    rotation rebinds them. Is per-device strict authority (admin devices)
    enough, or should the roots' PQ halves travel in a hybrid-sealed
    device-to-device enrollment?
17. `recoveryChecked` is `.com`'s claim; it can only enable strict. Should
    the box require its own evidence of a tested recovery?


## 12. Milestone 3: release endorsements (`flagship/release-endorsement/v2`)

Code: TS `packages/protocol/src/releaseEndorsementPq.ts` (pin in
`releasePqPin.ts`), Rust `rust/crates/flagship-crypto/src/release.rs`;
vectors `test-vectors/release-endorsement-v2/vectors.json`
(`npx tsx tools/release-pq-vectors.ts [--check]`); ceremony and signing
`scripts/pq-release-key.mjs`, `scripts/endorse-release.mjs`; runbook
`docs/runbooks/pq-release-key.md`.

### 12.1 Keys

The release key is a hybrid pair: the existing Ed25519 release key (YubiKey
PIV slot 9c, the ca-track holder that signs v1 endorsements) and a fresh
ML-DSA-65 key. The ML-DSA seed is 32 bytes from the OS RNG, kept only
encrypted with age to two YubiKeys (age-plugin-yubikey, PIN and touch) and on
paper. Label, exactly: **"PQ release signature (software key,
YubiKey-encrypted at rest)"**. The age file's own protection is classical
(the YubiKeys' P-256 key agreement), so the file stays private on the owner's
Mac: published, it would reduce the PQ half to classical security.

The two keys are bound with `flagship/pq-key-binding/v1` (§9), role
`release-key`, subject `flagship-release`; the YubiKey signs the Ed25519 half
of `M'` and the in-memory seed the ML-DSA half (`hybridSignExternal`). The
binding lives in `.maintainers/release-pq/bindings/`. What the verifiers trust
is the **pin**, a code constant (`RELEASE_PQ_PIN`): the binding's hybrid key id
(`keyId(0x0002, ed25519 || mldsa65)`) and the cutover marker. It is code, like
`MAINTAINER_PINNED_MANDATE_HASH`, because the update gate reads `.maintainers/`
from fetched refs that nothing has verified yet.

### 12.2 Statement and wire

```
statement = "flagship/release-endorsement/v2|<releaseId>|<semverTag>|<commitHash>|<previousReleaseId>|<previousCommitHash>|<intermediateMerkleRoot>|<v1Digest>|<signedBy>|<keyId>"
v1Digest  = hex(SHA-256(maintainers v1 canonical bytes, "maintainers/release/v1|..."))
signature = hybrid-sig(purpose = "flagship/release-endorsement/v2", payload = statement)
wire      = { kind: "ReleaseEndorsementPq", version: 2, releaseId, commitHash, v1Digest, keyId, suite, signature }
```

Absent previous fields are empty. The wire has exactly those eight keys; it
sits beside the v1 file in `.maintainers/release-pq/endorsements/`. The v1
endorsement is unchanged, so old boxes keep verifying it.

### 12.3 Verification, in order (TS and Rust agree on every code)

1. No companion: `pq-missing`. Wire shape: `pq-malformed`.
2. `releaseId`, `commitHash` or `v1Digest` differ from the v1 endorsement's:
   `pq-mismatch`. A v1 that cannot be encoded: `v1-malformed`.
3. `keyId` not in the pin: `pq-key-not-pinned`. No verified binding with
   that key id: `no-binding`.
4. The v1 `signedBy` is not the binding's Ed25519 key:
   `binding-key-mismatch`. The v1 signature by `signedBy` fails strict
   Ed25519: `v1-signature`.
5. The gate (§10) over the statement under a fixed strict, enforced policy:
   `strict-requires-hybrid` for a suite relabelled classical,
   `unknown-suite`, `bad-signature` for either half stripped or zeroed.

A binding is considered only if its key id is pinned
(`pq-key-not-pinned` otherwise), then verified as §9.2 with its own Ed25519
key as the trusted one (the pin fixes both halves).

### 12.4 The rule

- Pin empty (today): every v1 endorsement that passes the maintainers chain
  check is a target, exactly as before.
- Pin names a key: an endorsement is a target only when its v1 signature AND a
  companion verify. Endorsements on the chain that ends at the pin's
  `requirePqAfter` (`releaseId` and `commitHash`, followed back through
  `previousReleaseId`) stay valid as predecessors but are never offered or
  applied. The marker is fixed by the pin rather than by a date, so a forger
  of the classical signature cannot backdate a new endorsement into the
  legacy set. Everything else without a companion is refused
  (`pq-signature-required` in the box's `endorsementErrors`).
- Where it runs: the box's `verifyStore` (`releaseVerifier.ts`), which feeds
  the update gate (`buildMaintainersReleaseGate`, used by
  `applyEndorsedUpdate` for owner orders, share updates and first-boot
  update), the box's release list (`updateReleases.ts`) and
  `scripts/latest-endorsed-release.mjs` (the appliance build); `.com`'s
  `/api/releases` catalog, which offers only eligible releases; Rust
  `flagship_crypto::release` for the future Rust updater and boot client.
  Native clients and the webapp verify no release endorsements, so they have
  no port. The 0.3 signed box artifact (`boxArtifact.ts`) is a separate,
  k-of-n classical signature and is not covered yet.

### 12.5 Open questions for the Q01 reviewer (additions)

18. The ML-DSA release key is a software key whose at-rest protection is the
    YubiKeys' classical P-256 key agreement plus physical custody of the
    file and the paper. Is that acceptable until PQ-capable signing hardware
    is procured (Q04), or must the ciphertext also be hybrid-sealed (for
    example age's ML-KEM recipients next to the YubiKey ones)?
19. The companion is a second signature beside the unchanged v1 one rather
    than a single hybrid signature replacing it, so old boxes keep working.
    Is binding the v1 digest into the hybrid statement sufficient to make
    the pair an AND-signature over the same release?
20. Security notices (`flagship/security-notice/v1`) are signed by the same
    YubiKey and are still classical only; clients would need the pin baked
    into four ports to require a PQ half.

## 13. Milestone 4: the PQ-authenticated session (`flagship/pq-session/v1`)

Code: TS `packages/protocol/src/pqSession.ts`, Rust `rust/crates/flagship-crypto/src/session.rs`,
Swift `apps/mobile/shared/Sources/FlagshipCore/PqSession.swift`, Kotlin
`apps/mobile/android/.../core/pq/PqSession.kt`; vectors `test-vectors/pq-session/vectors.json`
(`npx tsx tools/pq-session-vectors.ts [--check]`; 2 transcripts, 13 hello, 9 accept, 6 finish and
7 record refusals). The box: `packages/server-daemon/src/pqChannel.ts`. DRAFT, pending Q01.

### 13.1 Why an inner channel

Native clients cannot read a TLS exporter (URLSession, OkHttp), and the box's certificate is
WebPKI (classical). The session therefore runs inside the existing TLS connection and does not
depend on it: confidentiality comes from X-Wing, authentication from hybrid AND-signatures under
keys pinned through `flagship/pq-key-binding/v1`. Breaking X25519, Ed25519 and the certificate
together reveals nothing and authorizes nothing.

### 13.2 Messages

```
hello  = { v:1, responder, initiatorRole ("device"|"box-stk"), initiatorSubject,
           initiatorKeyId, responderKeyId, ephemeralPub (X-Wing, 1216), nonce (32), issuedAt }
helloBytes = lp8(hello tag) || lp8(responder) || lp8(role) || lp8(subject) || initiatorKeyId
           || responderKeyId || ephemeralPub || nonce || u64be(issuedAt)

(ss, enc) = X-Wing.Encaps(ephemeralPub)                        responder, fresh 64-byte eseed
tbsA  = "flagship/pq-session-accept/v1|<responder>|" || hex(SHA-512(SHA-512(helloBytes) || enc || nonceR || u64be(issuedAtR)))
sigR  = hybrid-sign(responder STK key, purpose accept tag, tbsA)
PRK   = HKDF-Extract(SHA-512, salt "flagship/pq-session/v1", ss)
X(l, th) = HKDF-Expand(PRK, lp8("flagship/pq-session-keys/v1") || lp8(l) || th, 32)
confirmR = HMAC-SHA-512(X("responder-confirm", th1), th1)[0..32],  th1 = SHA-512(tbsA || sigR)
accept = { v:1, enc, nonce, issuedAt, signature: sigR, confirm: confirmR }

tbsF  = "flagship/pq-session-finish/v1|<initiatorSubject>|" || hex(SHA-512(tbsA || sigR || confirmR))
sigI  = hybrid-sign(initiator key, purpose finish tag, tbsF)
confirmI = HMAC(X("initiator-confirm", th3), th3)[0..32],  th3 = SHA-512(tbsF || sigI)
finish = { v:1, signature: sigI, confirm: confirmI }

th4 = SHA-512(tbsF || sigI || confirmI)
sessionId = X("session-id", th4); k(i→r) = X("initiator-to-responder", th4); k(r→i) = X("responder-to-initiator", th4)
record(dir, seq, pt) = u64be(seq) || AES-256-GCM(k(dir), nonce = u32be(dir) || u64be(seq),
                       aad = lp8(record tag) || sessionId || u8(dir) || u64be(seq), pt)
```

Both signed messages are v1-style text so keyd's purpose check applies: keyd (TS and Rust) signs
the two session tags with both keys only, naming one server and one 128-hex digest. A response
carries its request's sequence number in the other direction; the responder accepts each request
number once inside a window of 1024 (concurrent calls arrive out of order). Hello and accept are
fresh within 5 minutes; a pending handshake lives 60 s and is single use; a session idles out
after 15 minutes and lives at most 12 hours. Records are at most 16 MiB.

### 13.3 Refusals, in order (all four ports)

Hello: shape, hex and lengths (`session-malformed`); responder name or pinned responder key not
this box (`responder-mismatch`); time (`session-stale`); initiator not a key this box trusts
under that role, subject and key id (`unknown-initiator`); ephemeral key fails the X-Wing check
(`bad-public-key`). Accept: shape (`session-malformed`, also a classical-length signature); time;
the hybrid signature under the pinned box key (`bad-signature`: either half zeroed, another box,
a tampered `enc` or nonce); decapsulation or confirmation (`confirm-failed`). Finish: shape;
signature; confirmation. Records: `decrypt-failed`, `replay`, `session-expired`.

### 13.4 Where it runs

- **Box** (`pqChannel.ts`): `POST /api/pq-session/{hello,finish,call}`. A call's record carries
  one inner HTTP request (`{method, path, headers, body}`, base64 body; never another session
  path), dispatched through the box's own handler chain and marked as having arrived over the
  channel. Phones are looked up in the device book (role `device`, their bound key); the account's
  other servers by `box-stk` bindings fetched from `.com`, verified under the STK `/pods` names and
  pinned on first sight per server (`pq-sibling-pins.json`; first ML-DSA key wins).
- **Strict guard**: while the installation is strict, a request with a paired-session token that
  did not come over the channel is refused (`403 pq-channel-required`), unless the owner's change
  to strict acknowledged `browser-without-pq-authentication` (then browser sessions pass);
  `/api/access-sync/*` needs a `box-stk` channel. Access sync to the other servers goes over the
  channel while strict (`pqSessionFetch`).
- **iOS / Android**: requests to a server the phone holds as strict go through the session from
  the request funnel (`PqBoxTunnel` / `PqChannelInterceptor`); a `pq-channel-required` answer
  marks the server strict and the request is asked again over the channel. With no pinned box key
  or no usable device key nothing is sent; the person gets a sentence.
- **Webapp**: no session (no PQ key in website JavaScript). A strict server refuses it unless the
  owner allowed browsers.

## 14. Security notices: the PQ half

`SecurityNotice.pq = { binding, signature }`: the release key's hybrid signature (purpose
`flagship/security-notice/v1`) over the notice's unchanged canonical bytes and its
`release-key` binding to `signedBy`. Pin empty (today): a notice without it is accepted as
before; one with it must verify. Pin set: required (`pq-missing`), its key id must be pinned
(`pq-key-not-pinned`), and it must verify (`pq-signature-invalid`). TS, webapp, Swift and Kotlin
check `test-vectors/security-notice/pq-vectors.json` (10 cases under both pins;
`npx tsx tools/security-notice-pq-vectors.ts`). `scripts/security-notice.mjs --sign` adds the half
once a release-key binding exists and refuses `--no-pq` once the pin is set;
`pq-release-key.mjs pin` writes the key ids into the three client copies too.

## 15. Milestone 4: the strict opt-in and what it enforces

- **The owner's act.** Strict is turned on per server (and per app or connector) by an
  owner-signed `flagship/assurance-policy/v1` change with the hybrid suite: iOS and Android sign
  with the admin root (iOS also with an admin device's bound key). The screen requires an answer
  to "Can browsers still reach this server?"; "Also browsers" is the loss code
  `browser-without-pq-authentication` signed into the change itself, so the box enforces exactly
  what the owner saw. Each classical connector (Flagship Inference, own AI keys) needs a choice:
  "Block it in strict" signs that connector's scope to strict; content-free pushes stay allowed.
  Leaving strict lists the losses (`classical-signatures-accepted`,
  `classical-key-exchange-accepted`, `browser-without-pq-authentication`) and signs them.
- **Readiness** shown before: this device is an admin device and bound, every device of the
  account is bound, recovery is checked (`.com`'s `recoveryChecked`), the server's STK binding is
  on `.com`.
- **Phones** replay each served chain under the pinned admin root (and their own device key)
  through the gate and keep the newest verified state per scope; an older chain is refused
  (anti-rollback). Sensitive orders (server order, update order) carry `pqSignature` beside the
  classical signature while any server is strict; `.com` passes it through opaque (server orders:
  D1 migration 0113; update deposits: the carrier) and the box verifies it.
- **Box**: connector scopes `<server>:ai-<provider>` gate every AI provider call
  (`connectorGate`); a service scope whose strict change did not allow browsers refuses browser
  requests to that app.
- **Custody labels**: "hardware PQ" only for a Secure Enclave ML-DSA key (iOS 26+ device keys);
  otherwise "PQ, hardware-wrapped". The webapp is verify-only and says it cannot change strict.
- **Wipe**: iOS `Keystore.wipe()` and Android `Keystore.wipe()` erase the profile's PQ seeds,
  Secure Enclave ML-DSA records and the held policy; sign out and Remove this device call it.
- **Rate limits** on `.com`: `pq-binding-put` (the three binding PUTs) and
  `assurance-policy-post`, per source and per server or account.

### 15.1 Open questions for the Q01 reviewer (additions)

21. The session is a new composition (signed-KEM, SIGMA-style, two confirmation MACs); §6.7 asks
    for external review before relying on it. Is binding the transcript by hash into a v1 text
    message (for keyd's purpose check) sound, and is the ephemeral-KEM-only design (no static
    responder KEM key) adequate for forward secrecy and KCI?
22. Sibling boxes are pinned on first sight from `/pods` + `.com`'s binding: a malicious `.com`
    at first contact can introduce an impostor sibling. Should sibling STKs come from the signed
    server order instead?
23. Phones take rollout evidence as given when replaying (the box re-checks its own). Is a phone
    that believes "strict" when the box is not a safe failure in all paths?
