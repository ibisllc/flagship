# Architecture v2: hybrid post-quantum suites

> **Status: draft — pending Q01 external cryptographic review; not enforced anywhere.**
> Nothing in a live flow seals, signs or verifies with these suites. The
> encodings below may still change. A deployed v1 byte string never changes
> because of this document (`IMPLEMENTATION-PLAN.md` §6.4).

Implements plan packages Q02 (crypto implementation and cross-language
verification) and the protocol half of A04. Code:

| Piece | Rust | TypeScript |
|---|---|---|
| Strict parsing, v1 canonical bytes, v2 envelope header, suite registry | `rust/crates/flagship-protocol` | `packages/protocol/src/pqHybrid.ts` (header, purpose grammar); v1 encoders already in `packages/protocol/src/*.ts` |
| `flagship/hybrid-seal/v1`, `flagship/hybrid-sig/ed25519-mldsa65/v1`, key ids | `rust/crates/flagship-crypto` | `packages/protocol/src/pqHybrid.ts` |
| Shared vectors | `packages/protocol/test-vectors/pq-hybrid/` | same files |

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
