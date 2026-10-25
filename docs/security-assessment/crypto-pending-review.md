# Cryptographic compositions pending external review

None of the compositions below has had an external cryptographic review. Each is **pending external
review (Q01)**, and no product text may call the protection "quantum-safe" without that qualifier.
The primitives come from maintained libraries: noble (TS), RustCrypto / aws-lc-rs (Rust),
mldsa-native / mlkem-native (Swift C target), BouncyCastle 1.86 (Android). The compositions are
Flagship's own.

The detailed specification, the reasons behind each choice and the specific questions for the
reviewer are in `docs/architecture-v2/pq-suites.md`. Its "Open questions for the Q01 reviewer"
sections (§8, §10.5, §11.5, §12.5, §15.1, §19.6) are part of this package; please answer them.

## 1. Post-quantum and hybrid (architecture v2)

| # | Composition | Spec | Code (TS / Rust / Swift / Kotlin) | Vectors | What to look at first |
|---|---|---|---|---|---|
| C1 | `flagship/envelope/v2` header and suite registry | §2–§3 | `packages/protocol/src/pqHybrid.ts`, `flagship-crypto` | `test-vectors/pq-hybrid` | decode order, suite stripping, key ids (32 bytes of SHA-512) |
| C2 | `flagship/hybrid-seal/v1`: X-Wing (draft-connolly-cfrg-xwing-kem-11) + HKDF-SHA-512 + AES-256-GCM, not sender-authenticated | §4 | as above | `pq-hybrid` | KDF over an already-binding KEM secret, non-committing AEAD, hedged randomness, seal-then-sign composition (§8 q2–q4) |
| C3 | `flagship/hybrid-sig/ed25519-mldsa65/v1`: AND-signature over one transcript binding both public keys | §5 | as above | `pq-hybrid` | compare with the LAMPS composite draft; non-separability; strict Ed25519 (§8 q5–q7) |
| C4 | `flagship/pq-key-binding/v1`: mutual proof of possession binding an ML-DSA key to an existing Ed25519 identity | §9 | `pqTrust.ts`, `flagship-crypto` `trust.rs`, Swift/Kotlin ports | `test-vectors/pq-binding` | binding a new PQ key under an identity that a quantum attacker could forge (bootstrap) |
| C5 | `verifyCriticalSignature`: the strict gate deciding when classical-only is refused | §10 | `pqTrust.ts`, `flagship-crypto::trust` | `pq-binding`, `assurance-policy` | the rule order; stale binding; the compatibility profile |
| C6 | Phone-held PQ identities: Secure Enclave ML-DSA on iOS 26+, software seed wrapped by the Secure Enclave or by a Keystore AES key (StrongBox when present); the owner's policy chain | §11 | `apps/mobile/*`, `assurancePolicy.ts` | `assurance-policy`, `strict-reentry` | labels "hardware PQ" vs "PQ, hardware-wrapped"; policy anti-rollback (see AT-DWN-14/15 in adversarial-tests.md) |
| C7 | `flagship/release-endorsement/v2`: YubiKey Ed25519 + ML-DSA-65 companion; the key ceremony (seed only as age to two YubiKeys + checksummed paper code) | §12 | `releaseEndorsementPq.ts`, `releasePqPin.ts`, `scripts/pq-release-key.mjs` | `release-endorsement-v2` | the age layer is classical (X25519 inside the YubiKey plugin): the at-rest protection of the PQ seed is classical |
| C8 | `flagship/pq-session/v1`: an inner channel inside classical TLS; X-Wing confidentiality, hybrid AND-signed handshake under pinned keys, HMAC confirms, transcript hashing | §13 | `pqSession.ts`, `session.rs`, `PqSession.swift`, `PqSession.kt`; box `pqChannel.ts` | `pq-session` (35 refusal cases) | a new protocol assembled from independent pieces, which plan §6.7 says needs external review before anyone relies on it; replay and key confirmation; record layer |
| C9 | Security notice PQ half | §14 | `securityNotice.ts`, four client verifiers | `security-notice` | cut-over handling |
| C10 | Strict opt-in, scoped compatibility, strict re-entry evidence | §15 | `assurancePolicy.ts`, `strictReentry.ts`, clients | `assurance-policy`, `strict-reentry` | whether re-entry evidence is verified by anyone (today: commitments the box does not recompute) |
| C11 | Gap closures: siblings vouched for by `pqKeyIds` in the hybrid-signed server order; box artifact PQ companion; CA lease PQ companion; owner-signed keyd slot delivery; fixed-shape identity assertions | §16 | `boxArtifactPq.ts`, `caLeasePq.ts`, keyd | `box-artifact`, `ca-lease-pq`, `master-evidence` | the empty pins: nothing is enforced until the ceremony fills them |
| C12 | Authenticated time `POST /api/time`: CA-signed, nonce-bound, with a persisted floor | §17 | `signedTime.ts`, `TrustedClock` | — | classical (the CA lease is Ed25519) |
| C13 | Boot unlock v2: hybrid boot key (ML-DSA half + X-Wing lease key), per-boot reply key, hybrid-sealed replies, v3 leases signed by the owner, the lease key sealed to the TPM under PolicyPCR (software fallback) | §19 | `bootUnlockV2.ts`, Go `unseal`, `flagship-boot`, premount, `bootPqTpm.ts`, `tpm.rs` | `boot-unlock-v2` | the downgrade rule in §19.3 (a missing `/boot` policy file reads as compatibility), the unreviewed PCR set (N10), no quote and no fresh-release policy |

## 2. Classical compositions that also need review

These predate architecture v2 and are deployed. Breaking them is in scope; replacing them is the
Q-track's job.

| # | Composition | Code |
|---|---|---|
| K1 | `flagship.seal.v1`: Ed25519→X25519 conversion, ephemeral X25519, HKDF-SHA256, AES-256-GCM (disk-key deposit to the IRK, deposits to the STK, unlock replies) | `packages/protocol/src/encryption.ts`, `installer/unseal-helper` |
| K2 | Cloud recovery: UMK wrapped by AES-GCM under HKDF of a passkey PRF output; a fetch-token hash from the passphrase; record v2 signed by the IRK; the `.com` check of a passkey assertion before release | `apps/web/public/recovery/recoveryWrap.js`, `packages/protocol/src/recoveryRecord.ts`, `packages/control-plane/src/passkeyAssertion.ts` |
| K3 | Device pairing over `.com`'s `/qr-pipe`: ephemeral X25519 + a six-digit SAS, the sealed bundle carrying the UMK | client pairing code (webapp, iOS, Android), `test-vectors/device-pairing`, `test-vectors/device-pairing-relay.json` |
| K4 | First contact: one-time `enrollmentKeyHex` HMAC proof of the box key; Studio's `serverSeenMacHex` | `enrollment.ts`, `docs/first-contact.md` |
| K5 | Server backups: random content key; slots for an Argon2id passcode (m=64 MiB, t=3, p=4) and an account slot under HKDF(UMK) | `serverBackup.ts` |
| K6 | Peer backup space tokens (blind RSA) and the PBK derivation | `packages/control-plane/src/peerBackupNetwork.ts` |
| K7 | Per-app visitor identity `deriveAppAccountId(UMK, serviceRef)` and the box's per-app stable id | `packages/protocol/src/keys.ts` (`deriveAppAccountId`), the app proxy |
| K8 | Cross-owner chat carrier `flagship/chat-wire/v1` and owner approval | `chatWire.ts`, `server-daemon/src/chat` |
| K9 | Release catalog (TUF-shaped roles, thresholds, root rotation, rollout buckets) | `releaseMetadata.ts`; see AT-CAT-07/09/12/20 in adversarial-tests.md |
| K10 | Update receipts: rollout cohort from `SHA-256("flagship/rollout/v1"‖box secret salt‖commit)`; no owner data | `updateReceipt.ts`; privacy review rather than cryptographic |

## 3. Not covered by any review yet

- **Constant time.** JavaScript (noble) offers no constant-time guarantee. Private-key operations
  on the webapp are a declared exception (N06). Verification-only use on Workers is assumed
  acceptable (§8 q9).
- **The TPM** algorithms are classical (RSA/ECC). Any PQ protection comes from the hybrid seal
  around the TPM-held key, never from the TPM itself.
- **Third-party implementations** pinned in the build: `x-wing 0.1.1`, `ml-dsa`, `ed25519-dalek`,
  `@noble/post-quantum 0.7.1`, mldsa-native/mlkem-native v2.0.0, BouncyCastle 1.86. The review should
  say whether each is acceptable at that version.
