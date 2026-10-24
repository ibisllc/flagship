package com.flagshipserver.app.core.pq

import java.security.MessageDigest

/**
 * Strict quantum-resistant vs Compatibility per scope, the Kotlin twin of
 * packages/protocol/src/assurancePolicy.ts (vectors: test-vectors/assurance-policy/).
 *
 * rollout  legacy → capable → prepared → enforced → retired, forward only; `enforced` only
 *          through an owner-signed change to strict.
 * profile  strict or compatibility, changed only by an owner-signed change, each a new
 *          generation chained to the previous change's digest (an opt-out is a new epoch).
 */
class PolicyException(val code: String, message: String) : Exception(message)

object AssurancePolicy {
    const val TAG_ASSURANCE_POLICY = "flagship/assurance-policy/v1"
    val SCOPE_KINDS = listOf("installation", "service", "data", "connector", "device")
    val ROLLOUT_STATES = listOf("legacy", "capable", "prepared", "enforced", "retired")
    val SIGNATURE_SUITES = listOf(PqTrust.SUITE_ED25519, PqTrust.SUITE_HYBRID)
    val PROTECTION_LOSS_CODES = listOf(
        "classical-signatures-accepted",
        "classical-key-exchange-accepted",
        "browser-without-pq-authentication",
        "connector-classical-last-leg",
        "firmware-root-classical",
        "legacy-recovery-path",
    )
    const val MAX_POLICY_GENERATION = 2147483647L
    val GENESIS_DIGEST = "0".repeat(64)
    private val OWNER_SIGNERS = listOf("admin-device", "admin-root")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val KEY_ID = Regex("^[0-9a-f]{16,128}$")

    data class Scope(val kind: String, val id: String)

    data class StrictReentryEvidence(
        val verifierChecksDigest: String,
        val enrollmentDigest: String,
        val rekeyReceiptDigest: String,
        val recoveryTestDigest: String,
    )

    data class Change(
        val account: String,
        val scope: Scope,
        val prior: String,
        val next: String,
        val generation: Long,
        val prevDigest: String,
        val affectedPeersDigest: String,
        val acknowledgedLoss: List<String>,
        val reentry: StrictReentryEvidence? = null,
        val signerKind: String,
        val signerKeyId: String,
        val suite: String,
        val issuedAt: Long,
    )

    data class PolicyState(
        val scope: Scope,
        val profile: String,
        val rollout: String,
        val generation: Long,
        val headDigest: String,
        val enforcedEver: Boolean,
    )

    private fun bad(msg: String): Nothing = throw IllegalArgumentException("assurance-policy: $msg")

    private fun canonicalField(v: String, field: String) {
        if (v.isEmpty()) bad("empty \"$field\"")
        for (ch in v) if (ch == '|' || ch.code <= 0x1f || ch.code == 0x7f) bad("field \"$field\" is not canonical")
    }

    fun canonical(c: Change): ByteArray {
        canonicalField(c.account, "account")
        canonicalField(c.scope.id, "scope.id")
        if (c.scope.kind !in SCOPE_KINDS) bad("bad scope kind")
        for (p in listOf(c.prior, c.next)) if (p != "strict" && p != "compatibility") bad("bad profile")
        if (c.generation < 1 || c.generation > MAX_POLICY_GENERATION) bad("bad generation")
        if (c.issuedAt < 0 || c.issuedAt > PqHybrid.MAX_SAFE_INTEGER) bad("bad issuedAt")
        if (!HEX64.matches(c.prevDigest)) bad("prevDigest must be 32-byte hex")
        if (!HEX64.matches(c.affectedPeersDigest)) bad("affectedPeersDigest must be 32-byte hex")
        if (!KEY_ID.matches(c.signerKeyId)) bad("bad signerKeyId")
        if (c.suite !in SIGNATURE_SUITES) bad("bad suite")
        val loss = c.acknowledgedLoss.toSortedSet().toList()
        if (loss.size != c.acknowledgedLoss.size) bad("repeated loss code")
        for (l in loss) if (l !in PROTECTION_LOSS_CODES) bad("unknown loss code")
        val r = c.reentry
        if (r != null) {
            for (d in listOf(r.verifierChecksDigest, r.enrollmentDigest, r.rekeyReceiptDigest, r.recoveryTestDigest)) {
                if (!HEX64.matches(d)) bad("reentry digests must be 32-byte hex")
            }
        }
        val reentry = r?.let { listOf(it.verifierChecksDigest, it.enrollmentDigest, it.rekeyReceiptDigest, it.recoveryTestDigest).joinToString(",") } ?: "-"
        return listOf(
            TAG_ASSURANCE_POLICY, c.account, c.scope.kind, c.scope.id, c.prior, c.next, c.generation.toString(),
            c.prevDigest, c.affectedPeersDigest, if (loss.isEmpty()) "-" else loss.joinToString(","), reentry,
            c.signerKind, c.signerKeyId, c.suite, c.issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun digest(c: Change): String = PqHex.encode(MessageDigest.getInstance("SHA-256").digest(canonical(c)))

    /** An existing installation before any migration: classical accepted, nothing enforced. */
    fun legacyState(scope: Scope) = PolicyState(scope, "compatibility", "legacy", 0, GENESIS_DIGEST, false)

    /** True when this scope's strict profile is in force: classical-only messages are refused. */
    fun strictInForce(s: PolicyState): Boolean = s.profile == "strict" && (s.rollout == "enforced" || s.rollout == "retired")

    fun acceptsClassicalOnly(s: PolicyState): Boolean = !strictInForce(s)

    data class SignatureVerdict(val suiteVerified: Boolean, val signerActive: Boolean)

    /** Verifies the change's signature with the suite it names, and whether the signer is active. */
    fun interface SignatureCheck {
        fun check(msg: ByteArray, change: Change): SignatureVerdict
    }

    fun applyChange(state: PolicyState, change: Change, check: SignatureCheck): PolicyState {
        if (change.scope != state.scope) throw PolicyException("wrong-scope", "the change is for another scope")
        if (change.generation <= state.generation) throw PolicyException("stale-generation", "the change is older than the policy in force")
        if (change.generation != state.generation + 1) throw PolicyException("stale-generation", "the change skips a generation")
        if (change.prevDigest != state.headDigest) throw PolicyException("broken-chain", "the change does not follow the policy in force")
        if (change.prior != state.profile) throw PolicyException("wrong-prior", "the change starts from another profile")
        if (change.next == change.prior) throw PolicyException("no-change", "the change does not change the profile")
        if (change.signerKind !in OWNER_SIGNERS) throw PolicyException("not-owner-authority", "only the owner's admin device or admin root can change protection")

        val verdict = check.check(canonical(change), change)
        if (!verdict.suiteVerified) throw PolicyException("bad-signature", "the signature does not verify")
        if (!verdict.signerActive) throw PolicyException("signer-not-active", "the signer is not an active device of the account")
        if (strictInForce(state) && change.suite != PqTrust.SUITE_HYBRID) {
            throw PolicyException("classical-signer-refused", "a strict scope can only be changed by a signer that meets strict")
        }
        if (change.next == "compatibility") {
            if (change.acknowledgedLoss.isEmpty()) throw PolicyException("loss-not-acknowledged", "the owner must be told what protection is lost")
        } else {
            if (change.suite != PqTrust.SUITE_HYBRID) throw PolicyException("classical-signer-refused", "turning on strict needs a strict signer")
            if (state.rollout == "legacy" || state.rollout == "capable") throw PolicyException("not-prepared", "new keys, recipients and recovery are not ready")
            val r = change.reentry
            val complete = r != null && r.verifierChecksDigest.isNotEmpty() && r.enrollmentDigest.isNotEmpty() &&
                r.rekeyReceiptDigest.isNotEmpty() && r.recoveryTestDigest.isNotEmpty()
            if (state.enforcedEver && !complete) {
                throw PolicyException("reentry-incomplete", "returning to strict needs fresh checks, enrollment, rekeying and a tested recovery")
            }
        }
        val rollout = if (change.next == "strict" && state.rollout == "prepared") "enforced" else state.rollout
        return PolicyState(
            scope = state.scope,
            profile = change.next,
            rollout = rollout,
            generation = change.generation,
            headDigest = digest(change),
            enforcedEver = state.enforcedEver || rollout == "enforced" || rollout == "retired",
        )
    }

    data class RolloutEvidence(
        val capabilityAdvertised: Boolean = false,
        val boundPublicKeys: Boolean = false,
        val recipientsVerified: Boolean = false,
        val recoveryChecked: Boolean = false,
        val compatibilityGatePassed: Boolean = false,
    )

    /** Moves a scope's rollout forward by evidence. Enforcement itself only comes from a policy change. */
    fun advanceRollout(state: PolicyState, to: String, ev: RolloutEvidence): PolicyState {
        val from = ROLLOUT_STATES.indexOf(state.rollout)
        val target = ROLLOUT_STATES.indexOf(to)
        if (target <= from) throw PolicyException("rollback-refused", "rollout cannot go from ${state.rollout} to $to")
        if (target != from + 1) throw PolicyException("missing-evidence", "rollout moves one step at a time")
        when (to) {
            "capable" -> if (!ev.capabilityAdvertised) throw PolicyException("missing-evidence", "no capability advertisement")
            "prepared" -> if (!(ev.boundPublicKeys && ev.recipientsVerified && ev.recoveryChecked)) {
                throw PolicyException("missing-evidence", "prepared needs bound keys, verified recipients and a recovery check")
            }
            "enforced" -> throw PolicyException("needs-policy-change", "enforcement needs the owner's signed change to strict")
            "retired" -> if (state.profile != "strict" || !ev.compatibilityGatePassed) {
                throw PolicyException("missing-evidence", "retiring old readers needs strict in force and the compatibility gate passed")
            }
        }
        return state.copy(rollout = to)
    }

    /** Taking a stored state (restore, reboot, a copy from another device) never moves backwards. */
    fun adoptStoredState(current: PolicyState?, stored: PolicyState): PolicyState {
        if (current == null) return stored
        if (stored.scope != current.scope) throw PolicyException("wrong-scope", "stored state is for another scope")
        val older = stored.generation < current.generation ||
            ROLLOUT_STATES.indexOf(stored.rollout) < ROLLOUT_STATES.indexOf(current.rollout) ||
            (stored.generation == current.generation && stored.headDigest != current.headDigest) ||
            (current.enforcedEver && !stored.enforcedEver)
        if (older) throw PolicyException("rollback-refused", "the stored policy is older than the one in force")
        return stored
    }

    /** Picks the signature suite for a message in this scope; a strict scope never falls back. */
    fun selectSignatureSuite(state: PolicyState, offered: List<String>): String {
        if (PqTrust.SUITE_HYBRID in offered) return PqTrust.SUITE_HYBRID
        if (strictInForce(state)) throw PolicyException("upgrade-required", "this scope needs a quantum-resistant signature; update the app on that device")
        if (PqTrust.SUITE_ED25519 in offered) return PqTrust.SUITE_ED25519
        throw PolicyException("upgrade-required", "no signature suite in common")
    }

    data class ExportAuthorization(val subjectDigest: String, val generation: Long)

    /** Two scopes over a classical-only channel: the stricter side decides. */
    fun classicalExchangeAllowed(a: PolicyState, b: PolicyState, subjectDigest: String, auth: ExportAuthorization?): Boolean {
        if (!strictInForce(a) && !strictInForce(b)) return true
        return auth != null && auth.subjectDigest == subjectDigest && HEX64.matches(subjectDigest)
    }

    /** One served chain entry: the change and its signature envelope. */
    data class SignedChange(val change: Change, val signature: PqTrust.SignatureEnvelope)

    /**
     * Replays a served chain from [start] (the legacy state, or rollout evidence already
     * applied), checking every signature with [verify]. Stops at the first refusal and throws it,
     * so a chain with a fork, a gap or a forged link never yields a state.
     */
    fun replay(start: PolicyState, chain: List<SignedChange>, verify: (SignedChange, PolicyState) -> SignatureVerdict): PolicyState {
        var state = start
        for (entry in chain) {
            val before = state
            state = applyChange(before, entry.change) { _, _ -> verify(entry, before) }
        }
        return state
    }

    /**
     * The signature check `.com`, the box and every client run for one change: the gate, with
     * the scope's state before the change as the policy, the signer's trusted Ed25519 key, and
     * its verified binding (or null).
     */
    fun gateCheck(
        entry: SignedChange,
        before: PolicyState,
        trustedSigner: (Change) -> Pair<String, PqTrust.VerifiedBinding?>?,
    ): SignatureVerdict {
        val signer = trustedSigner(entry.change) ?: return SignatureVerdict(suiteVerified = false, signerActive = false)
        if (entry.signature.suite != entry.change.suite) return SignatureVerdict(false, true)
        return try {
            PqTrust.verifyCriticalSignature(canonical(entry.change), TAG_ASSURANCE_POLICY, entry.signature, signer.first, signer.second, before)
            SignatureVerdict(suiteVerified = true, signerActive = true)
        } catch (_: PqTrustException) {
            SignatureVerdict(suiteVerified = false, signerActive = true)
        }
    }
}
