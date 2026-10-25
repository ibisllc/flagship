package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Port of packages/protocol/src/strictReentry.ts: the evidence an admin device signs into a
 * change back to strict after a compatibility period. Each digest commits to what this phone
 * checked itself, in the fixed text form every client builds the same way
 * (packages/protocol/test-vectors/strict-reentry). The rekey receipt covers the server's PQ key
 * and a fresh nonce only; data at rest is not re-encrypted by it.
 */
object StrictReentry {
    const val TAG = "flagship/strict-reentry/v1"

    data class Binding(val role: String, val subjectId: String, val ed25519PubHex: String, val mldsaPubHex: String) {
        constructor(v: PqTrust.VerifiedBinding) : this(v.role, v.subjectId, v.ed25519PubHex, v.mldsaPubHex)
    }

    data class Inputs(
        val account: String,
        val scope: AssurancePolicy.Scope,
        val leftStrictAt: Long,
        val devices: List<Binding>,
        val deviceCount: Int,
        val adminRoot: Binding?,
        val server: Binding,
        val recoveryChecked: Boolean,
        val recoveryCheckedAt: Long?,
        val nonceHex: String,
        val checkedAt: Long,
    )

    class Refusal(val code: String, message: String) : IllegalStateException(message)

    private val TOKEN = Regex("^[A-Za-z0-9._:@-]{1,256}$")
    private val LOWER_HEX = Regex("^[0-9a-f]+$")
    private val NONCE = Regex("^[0-9a-f]{64}$")

    private fun line(b: Binding): String {
        if (!TOKEN.matches(b.role) || !TOKEN.matches(b.subjectId)) throw Refusal("bad-input", "strict-reentry: bad binding field")
        if (!LOWER_HEX.matches(b.ed25519PubHex) || !LOWER_HEX.matches(b.mldsaPubHex)) throw Refusal("bad-input", "strict-reentry: binding keys must be lowercase hex")
        return "${b.role}:${b.subjectId}:${b.ed25519PubHex}:${b.mldsaPubHex}"
    }

    /** The four canonical texts, in order (verifier checks, enrollment, rekey, recovery). */
    fun texts(i: Inputs): List<String> {
        if (!TOKEN.matches(i.account) || !TOKEN.matches(i.scope.id) || !TOKEN.matches(i.scope.kind)) throw Refusal("bad-input", "strict-reentry: bad account or scope")
        if (!NONCE.matches(i.nonceHex)) throw Refusal("bad-input", "strict-reentry: the nonce must be 32 bytes of hex")
        if (i.leftStrictAt < 0 || i.checkedAt < 0 || i.deviceCount < 0) throw Refusal("bad-input", "strict-reentry: bad number")
        if (i.devices.size != i.deviceCount || i.deviceCount == 0) {
            throw Refusal("devices-not-enrolled", FSStrings.get(R.string.every_device_on_the_account_needs))
        }
        val recAt = i.recoveryCheckedAt
        if (!i.recoveryChecked || recAt == null) throw Refusal("recovery-not-checked", FSStrings.get(R.string.test_your_recovery_before_turning_strict))
        val head = "$TAG|${i.account}|${i.scope.kind}|${i.scope.id}|${i.leftStrictAt}"
        val devices = i.devices.map(::line).sorted()
        val server = line(i.server)
        val all = (devices + listOfNotNull(i.adminRoot?.let(::line)) + server).sorted()
        return listOf(
            "$head|verifier-checks|${all.joinToString(",")}|${i.checkedAt}",
            "$head|enrollment|${i.deviceCount}|${devices.joinToString(",")}",
            "$head|rekey|$server|${i.nonceHex}|${i.checkedAt}",
            "$head|recovery|checked|$recAt",
        )
    }

    fun evidence(i: Inputs): AssurancePolicy.StrictReentryEvidence {
        val d = texts(i).map { t -> PqHex.encode(MessageDigest.getInstance("SHA-256").digest(t.toByteArray(Charsets.UTF_8))) }
        return AssurancePolicy.StrictReentryEvidence(d[0], d[1], d[2], d[3])
    }

    fun freshNonce(): String = PqHex.encode(ByteArray(32).also { SecureRandom().nextBytes(it) })
}
