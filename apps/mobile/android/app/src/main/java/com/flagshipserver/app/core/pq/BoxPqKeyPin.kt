package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonElement

/**
 * Client pinning of a box's ML-DSA-65 key (packages/protocol/src/boxKeyPin.ts
 * `decideBoxPqKeyPin`; webapp lib/pqBinding.js + boxKeyPins.js). A box's STK binds its ML-DSA
 * key (role `box-stk`, subject = the server domain); this phone accepts that binding only under
 * the STK it PINNED, pins the ML-DSA key the first time, and treats a binding naming another
 * ML-DSA key as a key change the owner must confirm. Once the ML-DSA key is pinned the boot-key
 * binding's v2 hybrid signature
 *   flagship/boot-key-binding/v2|<serverDomain>|<bootPubHex>|<issuedAt>
 * is required too.
 */
object BoxPqKeyPin {
    const val TAG_BOOT_KEY_BINDING_V2 = "flagship/boot-key-binding/v2"
    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val HEX_MLDSA = Regex("^[0-9a-f]{3904}$")
    private val HEX_HYBRID_SIG = Regex("^[0-9a-f]{6746}$")

    sealed class Verdict {
        data class Pinned(val first: Boolean, val mldsaPubHex: String, val issuedAt: Long) : Verdict()
        data class Mismatch(val code: String, val reportedHex: String) : Verdict()
        data class Invalid(val code: String) : Verdict()
    }

    fun decide(
        stkHex: String,
        pinnedMldsaHex: String?,
        minIssuedAt: Long?,
        serverDomain: String,
        wire: JsonElement?,
        now: Long,
    ): Verdict = try {
        val b = PqTrust.verifyPqKeyBinding(
            wire,
            PqTrust.Expectation(
                role = "box-stk",
                subjectId = serverDomain.lowercase(),
                ed25519PubHex = stkHex,
                mldsaPubHex = pinnedMldsaHex,
                now = now,
                minIssuedAt = minIssuedAt,
            ),
        )
        Verdict.Pinned(first = pinnedMldsaHex == null, mldsaPubHex = b.mldsaPubHex, issuedAt = b.issuedAt)
    } catch (e: PqTrustException) {
        if (e.code == "binding-pq-key-changed") {
            val reported = runCatching { PqTrust.pqKeyBindingFromWire(wire).mldsaPubHex }.getOrDefault("")
            Verdict.Mismatch(e.code, reported)
        } else {
            Verdict.Invalid(e.code)
        }
    }

    fun canonicalBootKeyBindingV2(serverDomain: String, bootPubHex: String, issuedAt: Long): ByteArray =
        listOf(TAG_BOOT_KEY_BINDING_V2, serverDomain.lowercase(), bootPubHex, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)

    /** True only when the STK's hybrid key (pinned STK + pinned ML-DSA key) signed the v2 binding. */
    fun verifyBootKeyBindingV2(
        serverDomain: String,
        bootPubHex: String,
        issuedAt: Long,
        hybridSignatureHex: String?,
        stkHex: String,
        mldsaPubHex: String,
    ): Boolean {
        val sig = hybridSignatureHex?.lowercase() ?: return false
        if (!HEX_HYBRID_SIG.matches(sig) || !HEX32.matches(stkHex) || !HEX_MLDSA.matches(mldsaPubHex)) return false
        if (!HEX32.matches(bootPubHex) || issuedAt < 0) return false
        if (serverDomain.any { it == '|' || it.code < 0x20 || it.code == 0x7f }) return false
        return try {
            PqHybrid.hybridVerify(
                PqHex.decode(stkHex + mldsaPubHex)!!,
                TAG_BOOT_KEY_BINDING_V2,
                canonicalBootKeyBindingV2(serverDomain, bootPubHex, issuedAt),
                PqHex.decode(sig)!!,
            )
            true
        } catch (_: PqHybridException) {
            false
        }
    }
}
