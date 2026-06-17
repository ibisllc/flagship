// Maintainers protocol — native Kotlin trust port (#10, Android half).
//
// This is a byte-for-byte reimplementation of the TypeScript reference
// in `maintainers/packages/protocol/src/{canonical,verifier,endorsement,
// caEndorsement}.ts` and a 1:1 mirror of the just-landed iOS Swift port
// `apps/mobile/ios/Sources/FlagshipCore/MaintainersTrust.swift`. It MUST
// produce the identical verdict for every vector in
// `maintainers/conformance/`. The whole model in one sentence: "pin a
// mandate, verify FORWARD; the mandate carries its own succession rule;
// there is no privileged self-renewal."
//
// Crypto reuses the project's existing deps only (no new Gradle dep):
// Ed25519 via `com.google.crypto.tink.subtle.Ed25519Verify` over the
// canonical UTF-8 bytes, SHA-256 (lower-hex) via `java.security.
// MessageDigest` for the pin. PIV-Ed25519 == standard Ed25519, so
// verification is plain Tink Ed25519Verify.
//
// Every public entry point is TOTAL: it never throws on adversarial
// input. A field that fails canonicalization, an unparseable timestamp,
// a malformed number — every such case is a rejection / rootError, never
// a propagated exception. Fail-closed is a return value, not a throw.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.MessageDigest

object MaintainersTrust {

    /** The pinned mandate hash baked into this surface (#30 generalised,
     *  the Android half of #10). This is the `mandatePinHash` (SHA-256
     *  lower-hex of a mandate's canonical bytes) of the Flagship
     *  maintainers genesis mandate. It mirrors the TypeScript
     *  `MAINTAINER_PINNED_MANDATE_HASH` and iOS
     *  `MaintainersTrust.pinnedMandateHash` exactly.
     *
     *  Invariant (preserved from the TS side): an EMPTY pin ⇒ fail-closed
     *  (reject all, reason `no-pin`); a non-empty pin ⇒ verify forward
     *  from it; NEVER fall back to an env / previously-seen pin. This
     *  constant is the default pin the Android verify-forward consumer
     *  uses. */
    const val pinnedMandateHash =
        "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae"

    /** Shared-contract alias for [pinnedMandateHash] (the BAKED_PIN the
     *  maintainer-trust-enforcement feature names across all surfaces). Same
     *  literal; one name to grep for. */
    const val bakedPin = pinnedMandateHash
}

// ---------------------------------------------------------------------------
// Envelope models
// ---------------------------------------------------------------------------

data class MaintainersSignature(val pubkey: String, val sig: String)

data class MaintainersApprovalRule(val kind: String, val threshold: Int)

data class MaintainersProject(
    val name: String?,
    val contact: String?,
    val homepage: String?,
    val tracks: List<String>?,
)

data class Mandate(
    val kind: String,
    val version: Int,
    val mandateId: String,
    val track: String,
    val holder: String,
    val issuedAt: String,
    val expiresAt: String,
    val successors: List<String>,
    val approvalRule: MaintainersApprovalRule,
    val minSuccessors: Int,
    val maxDurationSeconds: Int,
    val defaultDurationSeconds: Int,
    val project: MaintainersProject?,
    val signedBy: String,
    val signatures: List<MaintainersSignature>,
)

data class ReleaseEndorsement(
    val kind: String,
    val version: Int,
    val releaseId: String,
    val semverTag: String,
    val commitHash: String,
    val previousReleaseId: String?,
    val previousCommitHash: String?,
    val intermediateCommits: List<String>,
    val intermediateMerkleRoot: String,
    val endorsedNotes: String?,
    val issuedAt: String,
    val signedBy: String,
    val signatures: List<MaintainersSignature>,
)

data class CaEndorsement(
    val kind: String,
    val version: Int,
    val endorsementId: String,
    val track: String,
    val caPubkey: String,
    val scope: String,
    val notBefore: String,
    val notAfter: String,
    val issuedAt: String,
    val signedBy: String,
    val signatures: List<MaintainersSignature>,
)

// ---------------------------------------------------------------------------
// Canonical-bytes derivation (mirrors canonical.ts exactly)
//
// Convention: `maintainers/<kind>/v1|<f1>|<f2>|...`, UTF-8 encoded.
// Every field is validated to not contain `|` (0x7C), any C0 control
// byte (0x00-0x1F) or DEL (0x7F).
// ---------------------------------------------------------------------------

private class CanonicalBytesException : Exception()

internal object MaintainersCanonical {

    private const val SEP = "|"
    private const val TAG_PREFIX = "maintainers"
    private const val VERSION = "v1"

    /** Reject `|`, all C0 control chars, and DEL — mirrors canonical.ts
     *  `validateField`. TS iterates UTF-16 code units via `charCodeAt`;
     *  Kotlin `String` is also UTF-16, so iterating `Char`s (.code) is
     *  equivalent for these code points. */
    fun validateField(value: String) {
        for (ch in value) {
            val c = ch.code
            if (c == 0x7c) throw CanonicalBytesException()
            if (c <= 0x1f || c == 0x7f) throw CanonicalBytesException()
        }
    }

    /** Reject `,` in addition to `|`/control — mirrors `validateNoComma`. */
    fun validateNoComma(value: String) {
        validateField(value)
        if (value.indexOf(',') != -1) throw CanonicalBytesException()
    }

    /** Exactly `length` lower-case hex digits. Mirrors `validateHex`. */
    fun validateHex(value: String, length: Int) {
        if (value.length != length) throw CanonicalBytesException()
        for (ch in value) {
            val c = ch.code
            val ok = (c in 0x30..0x39) || (c in 0x61..0x66)
            if (!ok) throw CanonicalBytesException()
        }
    }

    fun validateHexOrEmpty(value: String?, length: Int) {
        if (value == null || value.isEmpty()) return
        validateHex(value, length)
    }

    /** Deterministic encoding of a non-negative safe integer. The TS uses
     *  `Number.MAX_SAFE_INTEGER` (2^53-1); enforce the same upper bound to
     *  stay byte-identical. */
    fun canonicalUint(n: Int): String {
        val maxSafe = 9_007_199_254_740_991L
        if (n < 0 || n.toLong() > maxSafe) throw CanonicalBytesException()
        return n.toString()
    }

    private fun joinTagged(kind: String, parts: List<String>): ByteArray {
        val tag = "$TAG_PREFIX/$kind/$VERSION"
        val all = (listOf(tag) + parts).joinToString(SEP)
        return all.toByteArray(Charsets.UTF_8)
    }

    /** Mandate canonical bytes. Tag `maintainers/mandate/v1`, 15 slots:
     *    mandateId | track | holder | issuedAt | expiresAt
     *    | successors(,) | threshold | minSuccessors
     *    | maxDurationSeconds | defaultDurationSeconds
     *    | projectName | projectContact | projectHomepage
     *    | projectTracks(,) | signedBy */
    fun canonicalMandate(m: Mandate): ByteArray {
        if (m.kind != "Mandate" || m.version != 1) throw CanonicalBytesException()
        validateField(m.mandateId)
        validateField(m.track)
        validateHex(m.holder, 64)
        validateField(m.issuedAt)
        validateField(m.expiresAt)
        for (s in m.successors) validateHex(s, 64)
        if (m.approvalRule.kind != "threshold") throw CanonicalBytesException()
        val threshold = canonicalUint(m.approvalRule.threshold)
        val minSucc = canonicalUint(m.minSuccessors)
        val maxDur = canonicalUint(m.maxDurationSeconds)
        val defDur = canonicalUint(m.defaultDurationSeconds)
        val p = m.project
        val projName = p?.name ?: ""
        val projContact = p?.contact ?: ""
        val projHome = p?.homepage ?: ""
        val projTracks = p?.tracks ?: emptyList()
        validateField(projName)
        validateField(projContact)
        validateField(projHome)
        for (t in projTracks) validateNoComma(t)
        validateHex(m.signedBy, 64)
        return joinTagged(
            "mandate",
            listOf(
                m.mandateId,
                m.track,
                m.holder,
                m.issuedAt,
                m.expiresAt,
                m.successors.joinToString(","),
                threshold,
                minSucc,
                maxDur,
                defDur,
                projName,
                projContact,
                projHome,
                projTracks.joinToString(","),
                m.signedBy,
            ),
        )
    }

    /** ReleaseEndorsement canonical bytes (tag `maintainers/release/v1`). */
    fun canonicalReleaseEndorsement(e: ReleaseEndorsement): ByteArray {
        validateField(e.releaseId)
        validateField(e.semverTag)
        validateHex(e.commitHash, 40)
        validateField(e.previousReleaseId ?: "")
        validateHexOrEmpty(e.previousCommitHash, 40)
        validateHex(e.intermediateMerkleRoot, 64)
        validateField(e.endorsedNotes ?: "")
        validateField(e.issuedAt)
        validateHex(e.signedBy, 64)
        return joinTagged(
            "release",
            listOf(
                e.releaseId,
                e.semverTag,
                e.commitHash,
                e.previousReleaseId ?: "",
                e.previousCommitHash ?: "",
                e.intermediateMerkleRoot,
                e.endorsedNotes ?: "",
                e.issuedAt,
                e.signedBy,
            ),
        )
    }

    /** CaEndorsement canonical bytes (tag `maintainers/ca-endorsement/v1`). */
    fun canonicalCaEndorsement(e: CaEndorsement): ByteArray {
        validateField(e.endorsementId)
        validateField(e.track)
        validateHex(e.caPubkey, 64)
        validateField(e.scope)
        validateField(e.notBefore)
        validateField(e.notAfter)
        validateField(e.issuedAt)
        validateHex(e.signedBy, 64)
        return joinTagged(
            "ca-endorsement",
            listOf(
                e.endorsementId,
                e.track,
                e.caPubkey,
                e.scope,
                e.notBefore,
                e.notAfter,
                e.issuedAt,
                e.signedBy,
            ),
        )
    }

    /** SHA-256 (lower-hex) of a mandate's canonical bytes — the pin. */
    fun mandatePinHash(m: Mandate): String {
        val bytes = canonicalMandate(m)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** Canonical Merkle root of intermediate commits: SHA-256 over the
     *  concatenated 20-byte raw representations. Mirrors crypto.ts
     *  `intermediateMerkleRoot` (throws on a bad commit hash). */
    fun intermediateMerkleRoot(commitHashes: List<String>): String {
        val buf = ArrayList<Byte>(commitHashes.size * 20)
        for (h in commitHashes) {
            if (h.length != 40) throw CanonicalBytesException()
            val bytes = MaintainersHex.toBytes(h)
                ?: throw CanonicalBytesException()
            if (bytes.size != 20) throw CanonicalBytesException()
            for (b in bytes) buf.add(b)
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(buf.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}

// ---------------------------------------------------------------------------
// Hex + Ed25519 (Tink)
// ---------------------------------------------------------------------------

internal object MaintainersHex {
    /** Lower/upper hex string → bytes, or null on any malformed input
     *  (odd length, non-hex). Mirrors crypto.ts `hexToBytes` failure
     *  behaviour folded into null so the verifier stays total. */
    fun toBytes(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        val out = ByteArray(hex.length / 2)
        var i = 0
        while (i < hex.length) {
            val hi = nibble(hex[i]) ?: return null
            val lo = nibble(hex[i + 1]) ?: return null
            out[i / 2] = ((hi shl 4) or lo).toByte()
            i += 2
        }
        return out
    }

    private fun nibble(c: Char): Int? = when (c.code) {
        in 0x30..0x39 -> c.code - 0x30
        in 0x61..0x66 -> c.code - 0x61 + 10
        in 0x41..0x46 -> c.code - 0x41 + 10
        else -> null
    }
}

internal object MaintainersEd25519 {
    /** Verify an Ed25519 signature (hex) over `message` under
     *  `pubKeyHex`. Total: any malformed hex / bad key length / bad sig ⇒
     *  false (never throws). Mirrors crypto.ts `verify` (try/catch ⇒
     *  false). Tink `Ed25519Verify.verify` throws GeneralSecurityException
     *  on an invalid signature; we treat any throw as `false`. */
    fun verify(sigHex: String, message: ByteArray, pubKeyHex: String): Boolean {
        val sig = MaintainersHex.toBytes(sigHex) ?: return false
        val pub = MaintainersHex.toBytes(pubKeyHex) ?: return false
        if (pub.size != 32) return false
        return try {
            Ed25519Verify(pub).verify(sig, message)
            true
        } catch (_: Throwable) {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Timestamps
//
// The TS verifier uses `Date.parse(iso)` and arithmetic on the resulting
// epoch ms. The conformance vectors only ever use `...Z` ISO-8601
// instants. We parse to epoch milliseconds; an unparseable string ⇒ null
// (mirrors `Date.parse` returning NaN ⇒ `isFinite` false ⇒ reject path).
// ---------------------------------------------------------------------------

internal object MaintainersTime {
    fun epochMs(iso: String): Long? = try {
        java.time.Instant.parse(iso).toEpochMilli()
    } catch (_: Throwable) {
        null
    }
}

// ---------------------------------------------------------------------------
// Verify-forward-from-pin (verifier.ts)
// ---------------------------------------------------------------------------

enum class V2FailReason(val raw: String) {
    EnvelopeShapeInvalid("envelope-shape-invalid"),
    DuplicateMandateId("duplicate-mandate-id"),
    WrongTrack("wrong-track"),
    ExpiresBeforeIssuance("expires-before-issuance"),
    IssuedBeforePredecessor("issued-before-predecessor"),
    SignatureInvalid("signature-invalid"),
    SignedByNotInSignatures("signed-by-not-in-signatures"),
    SignerNotInSuccessorSet("signer-not-in-successor-set"),
    ApprovalThresholdUnmet("approval-threshold-unmet"),
    UnderMinSuccessors("under-min-successors"),
    OverMaxDuration("over-max-duration"),
}

enum class V2RootFailReason(val raw: String) {
    NoPin("no-pin"),
    PinNotInLog("pin-not-in-log"),
    RootShapeInvalid("root-shape-invalid"),
    RootExpiresBeforeIssuance("root-expires-before-issuance"),
    RootSignatureInvalid("root-signature-invalid"),
    RootNotSelfSigned("root-not-self-signed"),
}

data class V2Rejection(val mandate: Mandate, val reason: V2FailReason)

data class VerifiedChain(
    val pin: String,
    val root: Mandate?,
    val rootError: V2RootFailReason?,
    val validMandates: List<Mandate>,
    val rejections: List<V2Rejection>,
)

object MaintainersVerifier {

    private fun canonicalOrNull(m: Mandate): ByteArray? = try {
        MaintainersCanonical.canonicalMandate(m)
    } catch (_: Throwable) {
        null
    }

    private fun pinHashOrNull(m: Mandate): String? = try {
        MaintainersCanonical.mandatePinHash(m)
    } catch (_: Throwable) {
        null
    }

    private fun windowMs(issuedAt: String, expiresAt: String): Long? {
        val i = MaintainersTime.epochMs(issuedAt) ?: return null
        val e = MaintainersTime.epochMs(expiresAt) ?: return null
        return e - i
    }

    /** Every signature verifies over the mandate's canonical bytes?
     *  Mirrors `allSignaturesValid`: empty sig list ⇒ false; any bad
     *  sig ⇒ false; canonicalization failure ⇒ false. */
    private fun allSignaturesValid(m: Mandate): Boolean {
        val bytes = canonicalOrNull(m) ?: return false
        if (m.signatures.isEmpty()) return false
        for (s in m.signatures) {
            if (!MaintainersEd25519.verify(s.sig, bytes, s.pubkey)) return false
        }
        return true
    }

    /** Verify a single forward step K → K+1 against the predecessor's
     *  embedded policy (the L3 ONE rule). Mirrors `verifyForwardStep`. */
    private fun verifyForwardStep(pred: Mandate, m: Mandate): V2FailReason? {
        // isMandateShape is enforced by typed decoding upstream; the one
        // dynamic shape failure the TS catches here (a non-hex holder
        // causing canonicalization to throw) surfaces as a signature
        // failure below, exactly like the reference.
        if (m.track != pred.track) return V2FailReason.WrongTrack
        val w = windowMs(m.issuedAt, m.expiresAt)
            ?: return V2FailReason.EnvelopeShapeInvalid
        if (w <= 0) return V2FailReason.ExpiresBeforeIssuance
        val mi = MaintainersTime.epochMs(m.issuedAt)
            ?: return V2FailReason.EnvelopeShapeInvalid
        val pi = MaintainersTime.epochMs(pred.issuedAt)
            ?: return V2FailReason.EnvelopeShapeInvalid
        if (mi < pi) return V2FailReason.IssuedBeforePredecessor
        if (!allSignaturesValid(m)) return V2FailReason.SignatureInvalid

        val signerPubkeys = m.signatures.map { it.pubkey }
        if (!signerPubkeys.contains(m.signedBy)) {
            return V2FailReason.SignedByNotInSignatures
        }

        val successorSet = pred.successors.toHashSet()
        for (pk in signerPubkeys) {
            if (!successorSet.contains(pk)) return V2FailReason.SignerNotInSuccessorSet
        }
        val distinctAuthorised = HashSet<String>()
        for (pk in signerPubkeys) {
            if (successorSet.contains(pk)) distinctAuthorised.add(pk)
        }
        if (pred.approvalRule.kind != "threshold" ||
            pred.approvalRule.threshold < 1 ||
            distinctAuthorised.size < pred.approvalRule.threshold
        ) {
            return V2FailReason.ApprovalThresholdUnmet
        }
        if (m.successors.size < pred.minSuccessors) {
            return V2FailReason.UnderMinSuccessors
        }
        if (pred.maxDurationSeconds < 0 ||
            w > pred.maxDurationSeconds.toLong() * 1000L
        ) {
            return V2FailReason.OverMaxDuration
        }
        return null
    }

    /** Verify a track's mandate log FORWARD from a baked pin. Mirrors
     *  `verifyMandateChainFromPin` accept/reject + reason strings. */
    fun verifyMandateChainFromPin(
        pinnedHash: String,
        mandates: List<Mandate>,
    ): VerifiedChain {
        if (pinnedHash.isEmpty()) {
            return VerifiedChain(pinnedHash, null, V2RootFailReason.NoPin, emptyList(), emptyList())
        }

        var rootIdx = -1
        for ((i, m) in mandates.withIndex()) {
            if (pinHashOrNull(m) == pinnedHash) {
                rootIdx = i
                break
            }
        }
        if (rootIdx == -1) {
            return VerifiedChain(
                pinnedHash, null, V2RootFailReason.PinNotInLog, emptyList(), emptyList(),
            )
        }

        val root = mandates[rootIdx]
        val rw = windowMs(root.issuedAt, root.expiresAt)
            ?: return VerifiedChain(
                pinnedHash, null, V2RootFailReason.RootShapeInvalid, emptyList(), emptyList(),
            )
        if (rw <= 0) {
            return VerifiedChain(
                pinnedHash, null, V2RootFailReason.RootExpiresBeforeIssuance,
                emptyList(), emptyList(),
            )
        }
        if (!allSignaturesValid(root)) {
            return VerifiedChain(
                pinnedHash, null, V2RootFailReason.RootSignatureInvalid,
                emptyList(), emptyList(),
            )
        }
        if (root.signatures.none { it.pubkey == root.signedBy }) {
            return VerifiedChain(
                pinnedHash, null, V2RootFailReason.RootNotSelfSigned,
                emptyList(), emptyList(),
            )
        }

        val accepted = ArrayList<Mandate>()
        accepted.add(root)
        val rejections = ArrayList<V2Rejection>()
        val seenIds = HashSet<String>()
        seenIds.add(root.mandateId)

        var i = rootIdx + 1
        while (i < mandates.size) {
            val m = mandates[i]
            i += 1
            // Cross-track interleave is legitimate — silently skip a
            // well-formed other-track mandate (mirrors the TS skip).
            if (m.track != root.track) continue
            if (seenIds.contains(m.mandateId)) {
                rejections.add(V2Rejection(m, V2FailReason.DuplicateMandateId))
                continue
            }
            val pred = accepted[accepted.size - 1]
            val fail = verifyForwardStep(pred, m)
            if (fail != null) {
                rejections.add(V2Rejection(m, fail))
            } else {
                accepted.add(m)
                seenIds.add(m.mandateId)
            }
        }

        return VerifiedChain(pinnedHash, root, null, accepted, rejections)
    }

    data class CurrentAuthority(
        val holder: String,
        val mandate: Mandate,
        val successors: List<String>,
    )

    /** The operational authority at `now` (epoch ms): holder of the
     *  most-recent valid mandate whose [issuedAt, expiresAt) contains
     *  `now`. null ⇒ no live authority (consumers fail closed). Mirrors
     *  `currentAuthority`. */
    fun currentAuthority(chain: VerifiedChain, nowMs: Long): CurrentAuthority? {
        for (m in chain.validMandates.asReversed()) {
            val issued = MaintainersTime.epochMs(m.issuedAt) ?: continue
            val expiry = MaintainersTime.epochMs(m.expiresAt) ?: continue
            if (issued <= nowMs && nowMs < expiry) {
                return CurrentAuthority(m.holder, m, m.successors)
            }
        }
        return null
    }
}

// ---------------------------------------------------------------------------
// ReleaseEndorsement verification (endorsement.ts)
// ---------------------------------------------------------------------------

enum class EndorsementFailReason(val raw: String) {
    SignatureInvalid("signature-invalid"),
    ApprovalRuleUnsatisfied("approval-rule-unsatisfied"),
    SignerNotAuthorized("signer-not-authorized"),
    NoAuthorityAtIssuance("no-authority-at-issuance"),
    MerkleRootMismatch("merkle-root-mismatch"),
    PredecessorMismatch("predecessor-mismatch"),
    GenesisMustHaveNoPredecessor("genesis-must-have-no-predecessor"),
    NonGenesisMustHavePredecessor("non-genesis-must-have-predecessor"),
    DuplicateReleaseId("duplicate-release-id"),
}

data class VerifiedEndorsements(
    val validEndorsements: List<ReleaseEndorsement>,
    val rejections: List<Pair<ReleaseEndorsement, EndorsementFailReason>>,
)

object MaintainersReleaseVerifier {

    private fun verifySingle(
        e: ReleaseEndorsement,
        prev: ReleaseEndorsement?,
        releaseChain: VerifiedChain,
        seenIds: Set<String>,
    ): EndorsementFailReason? {
        if (seenIds.contains(e.releaseId)) return EndorsementFailReason.DuplicateReleaseId

        if (prev == null) {
            if (e.previousReleaseId != null || e.previousCommitHash != null) {
                return EndorsementFailReason.GenesisMustHaveNoPredecessor
            }
        } else {
            if (e.previousReleaseId == null || e.previousCommitHash == null) {
                return EndorsementFailReason.NonGenesisMustHavePredecessor
            }
            if (e.previousReleaseId != prev.releaseId ||
                e.previousCommitHash != prev.commitHash
            ) {
                return EndorsementFailReason.PredecessorMismatch
            }
        }

        val expectedRoot: String = try {
            MaintainersCanonical.intermediateMerkleRoot(e.intermediateCommits)
        } catch (_: Throwable) {
            return EndorsementFailReason.MerkleRootMismatch
        }
        if (expectedRoot != e.intermediateMerkleRoot) {
            return EndorsementFailReason.MerkleRootMismatch
        }

        val bytes: ByteArray = try {
            MaintainersCanonical.canonicalReleaseEndorsement(e)
        } catch (_: Throwable) {
            return EndorsementFailReason.SignatureInvalid
        }
        for (s in e.signatures) {
            if (!MaintainersEd25519.verify(s.sig, bytes, s.pubkey)) {
                return EndorsementFailReason.SignatureInvalid
            }
        }

        val issuedMs = MaintainersTime.epochMs(e.issuedAt)
            ?: return EndorsementFailReason.NoAuthorityAtIssuance
        val authority = MaintainersVerifier.currentAuthority(releaseChain, issuedMs)
            ?: return EndorsementFailReason.NoAuthorityAtIssuance

        val signerPubkeys = e.signatures.map { it.pubkey }.toHashSet()
        if (!signerPubkeys.contains(e.signedBy)) {
            return EndorsementFailReason.SignerNotAuthorized
        }
        if (e.signedBy != authority.holder) {
            return EndorsementFailReason.SignerNotAuthorized
        }

        return null
    }

    /** Mirrors `verifyChainOfEndorsements`. Endorsements MUST be in
     *  canonical-log order (oldest first). */
    fun verifyChainOfEndorsements(
        endorsements: List<ReleaseEndorsement>,
        releaseChain: VerifiedChain,
    ): VerifiedEndorsements {
        val seenIds = HashSet<String>()
        val valid = ArrayList<ReleaseEndorsement>()
        val rejections = ArrayList<Pair<ReleaseEndorsement, EndorsementFailReason>>()

        for (e in endorsements) {
            val prev = valid.lastOrNull()
            val reason = verifySingle(e, prev, releaseChain, seenIds)
            if (reason != null) {
                rejections.add(e to reason)
            } else {
                valid.add(e)
                seenIds.add(e.releaseId)
            }
        }
        return VerifiedEndorsements(valid, rejections)
    }
}

// ---------------------------------------------------------------------------
// CaEndorsement verification (caEndorsement.ts)
// ---------------------------------------------------------------------------

enum class CaEndorsementFailReason(val raw: String) {
    WrongEnvelope("wrong-envelope"),
    LeaseWindowMalformed("lease-window-malformed"),
    LeaseNotYet("lease-not-yet"),
    LeaseExpired("lease-expired"),
    SignatureInvalid("signature-invalid"),
    NoCaAuthorityAtNow("no-ca-authority-at-now"),
    SignerNotAuthorized("signer-not-authorized"),
    ApprovalRuleUnsatisfied("approval-rule-unsatisfied"),
}

data class VerifiedCaEndorsements(
    val validEndorsements: List<CaEndorsement>,
    val rejections: List<Pair<CaEndorsement, CaEndorsementFailReason>>,
    val currentCaPubkey: String?,
)

object MaintainersCaVerifier {

    /** ±5 min window-edge tolerance — spec §7 default (DEFAULT_CLOCK_SKEW_MS). */
    const val defaultClockSkewMs: Long = 5L * 60L * 1000L

    private fun verifyOne(
        e: CaEndorsement,
        caChain: VerifiedChain,
        nowMs: Long,
        skewMs: Long,
    ): CaEndorsementFailReason? {
        if (e.kind != "CaEndorsement" || e.version != 1) {
            return CaEndorsementFailReason.WrongEnvelope
        }

        val nb = MaintainersTime.epochMs(e.notBefore)
            ?: return CaEndorsementFailReason.LeaseWindowMalformed
        val na = MaintainersTime.epochMs(e.notAfter)
            ?: return CaEndorsementFailReason.LeaseWindowMalformed
        if (na <= nb) return CaEndorsementFailReason.LeaseWindowMalformed
        if (nowMs < nb - skewMs) return CaEndorsementFailReason.LeaseNotYet
        if (nowMs >= na + skewMs) return CaEndorsementFailReason.LeaseExpired

        val bytes: ByteArray = try {
            MaintainersCanonical.canonicalCaEndorsement(e)
        } catch (_: Throwable) {
            return CaEndorsementFailReason.SignatureInvalid
        }
        for (s in e.signatures) {
            if (!MaintainersEd25519.verify(s.sig, bytes, s.pubkey)) {
                return CaEndorsementFailReason.SignatureInvalid
            }
        }

        val authority = MaintainersVerifier.currentAuthority(caChain, nowMs)
            ?: return CaEndorsementFailReason.NoCaAuthorityAtNow
        val signerPubkeys = e.signatures.map { it.pubkey }.toHashSet()
        if (!signerPubkeys.contains(e.signedBy)) {
            return CaEndorsementFailReason.SignerNotAuthorized
        }
        if (e.signedBy != authority.holder) {
            return CaEndorsementFailReason.SignerNotAuthorized
        }
        return null
    }

    /** Mirrors `verifyCaEndorsements`. Order does not matter; each judged
     *  independently at the verifier's clock `now` (epoch ms). */
    fun verifyCaEndorsements(
        endorsements: List<CaEndorsement>,
        caChain: VerifiedChain,
        nowMs: Long,
        clockSkewMs: Long? = null,
    ): VerifiedCaEndorsements {
        val skew = clockSkewMs ?: defaultClockSkewMs
        val valid = ArrayList<CaEndorsement>()
        val rejections = ArrayList<Pair<CaEndorsement, CaEndorsementFailReason>>()

        for (e in endorsements) {
            val reason = verifyOne(e, caChain, nowMs, skew)
            if (reason != null) {
                rejections.add(e to reason)
            } else {
                valid.add(e)
            }
        }

        var current: CaEndorsement? = null
        for (e in valid) {
            if (current == null) {
                current = e
            } else {
                val eIss = MaintainersTime.epochMs(e.issuedAt)
                val cIss = MaintainersTime.epochMs(current.issuedAt)
                if (eIss != null && cIss != null && eIss > cIss) {
                    current = e
                }
            }
        }

        return VerifiedCaEndorsements(valid, rejections, current?.caPubkey)
    }

    /** §9 link-3: the operational CA keys a consumer may currently accept
     *  CA-signed artifacts under (deduped, insertion order preserved). Empty
     *  ⇒ fail closed (reject all). Mirrors `authorizedCaKeys`. */
    fun authorizedCaKeys(
        endorsements: List<CaEndorsement>,
        caChain: VerifiedChain,
        nowMs: Long,
        clockSkewMs: Long? = null,
    ): List<String> {
        val result = verifyCaEndorsements(endorsements, caChain, nowMs, clockSkewMs)
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for (e in result.validEndorsements) {
            if (seen.add(e.caPubkey)) out.add(e.caPubkey)
        }
        return out
    }
}

// ---------------------------------------------------------------------------
// Control-server blessing (the feature's top-level verdict)
// ---------------------------------------------------------------------------

/** The `GET /api/maintainer-blessing` payload `.com` serves so a client can
 *  run the full `pin → chain → authorizedCaKeys(now)` check itself. */
data class MaintainerBlessing(
    val pinnedMandateHash: String,
    val caPubkey: String,
    val mandates: List<Mandate>,
    val caEndorsements: List<CaEndorsement>,
)

object MaintainersComTrust {
    /** Run the full control-server-trust check on a fetched blessing using the
     *  CALLER's clock `nowMs` (never the response's `now`). Returns true iff
     *  the CA pubkey `.com` actually serves is in `authorizedCaKeys` live now.
     *
     *  The baked pin is the FLOOR: a `.com`-asserted `pinnedMandateHash` that
     *  disagrees with our baked pin is rejected outright — we never let `.com`
     *  re-anchor the chain. An empty baked pin ⇒ fail closed.
     *
     *  IMPORTANT: this is the "valid response → verdict" half only. A NETWORK
     *  failure must NOT call this with a fabricated blessing; the caller leaves
     *  the trust verdict UNKNOWN on a network error (never untrusted). */
    fun verifyComBlessing(
        blessing: MaintainerBlessing,
        nowMs: Long,
        bakedPinOverride: String? = null,
    ): Boolean {
        val pin = bakedPinOverride ?: MaintainersTrust.bakedPin
        if (pin.isEmpty()) return false
        // `.com` cannot lower the floor: its asserted pin must equal ours.
        if (blessing.pinnedMandateHash != pin) return false
        val chain = MaintainersVerifier.verifyMandateChainFromPin(pin, blessing.mandates)
        val keys = MaintainersCaVerifier.authorizedCaKeys(blessing.caEndorsements, chain, nowMs)
        return keys.contains(blessing.caPubkey)
    }
}
