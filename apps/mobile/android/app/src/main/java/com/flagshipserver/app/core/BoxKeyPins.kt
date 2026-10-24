package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Verify

/**
 * Box key pins (packages/protocol/src/boxKeyPin.ts; shared vectors in
 * packages/protocol/test-vectors/box-key-pin/).
 *
 * Everything this phone seals for a server (the disk-key reply, an
 * auto-unlock lease, the SWK / CGK / pairing deposits) goes to the key this
 * phone pinned for it, so a `.com` that turns hostile can't swap in its own key
 * and collect the disk key. The pin itself lives in [ServerKeyPins], the one
 * pin store, and is made only by first contact (docs/first-contact.md): the
 * first blessing, with the code shown above Approve, or the owner's explicit
 * re-trust. Nothing here pins a key because `.com` lists it.
 */
class BoxKeyChangedException(
    val username: String,
    val serverDomain: String,
    val pinnedHex: String,
    val reportedHex: String,
) : Exception(FSStrings.get(R.string.server_key_changed))

/** [store] null: the process-wide [ServerKeyPins.shared], read at each call. */
class BoxKeyPins(private val store: ServerKeyPins? = null, private val now: () -> Long = { System.currentTimeMillis() }) {
    enum class Verdict { FIRST, MATCH, MISMATCH, INVALID }

    private val pins: ServerKeyPins get() = store ?: ServerKeyPins.shared

    companion object {
        @Volatile var shared: BoxKeyPins = BoxKeyPins()

        const val BOOT_KEY_BINDING_TAG = "flagship/boot-key-binding/v1"
        private val HEX32 = Regex("^[0-9a-f]{64}$")

        fun decide(pinned: String?, reported: String): Verdict {
            val r = reported.lowercase()
            if (!HEX32.matches(r)) return Verdict.INVALID
            if (pinned == null) return Verdict.FIRST
            return if (pinned.lowercase() == r) Verdict.MATCH else Verdict.MISMATCH
        }

        fun canonicalBootKeyBinding(serverDomain: String, bootPubHex: String, issuedAt: Long): ByteArray? {
            if (!HEX32.matches(bootPubHex) || issuedAt < 0) return null
            if (serverDomain.any { it == '|' || it.code < 0x20 || it.code == 0x7f }) return null
            return listOf(BOOT_KEY_BINDING_TAG, serverDomain.lowercase(), bootPubHex, issuedAt.toString())
                .joinToString("|").toByteArray(Charsets.UTF_8)
        }

        /** The STK's v2 hybrid signature over a boot-key binding, under the pinned STK + ML-DSA keys. */
        fun verifyBootKeyBindingV2(
            bindingDomain: String, bootPubHex: String, issuedAt: Long,
            hybridSignatureHex: String?, stkHex: String, mldsaPubHex: String,
        ): Boolean = com.flagshipserver.app.core.pq.BoxPqKeyPin.verifyBootKeyBindingV2(
            bindingDomain, bootPubHex, issuedAt, hybridSignatureHex, stkHex, mldsaPubHex,
        )

        fun verifyBootKeyBinding(
            bindingDomain: String, bootPubHex: String, issuedAt: Long,
            signature: ByteArray, pinnedStkPub: ByteArray, forServer: String,
        ): Boolean {
            if (bindingDomain.lowercase() != forServer.lowercase()) return false
            val msg = canonicalBootKeyBinding(bindingDomain, bootPubHex, issuedAt) ?: return false
            return try {
                Ed25519Verify(pinnedStkPub).verify(signature, msg)
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    fun pinned(username: String, serverDomain: String): String? = pins.pinnedHex(serverDomain)

    fun pinnedBootKey(username: String, serverDomain: String): String? = pins.record(serverDomain)?.boot

    /** The key this phone may seal to: the pin, while [reportedHex] matches it. Throws
     *  [BoxKeyChangedException] when it differs and [ServerKeyNotPinnedException] when this phone
     *  has not pinned the server yet ("first" never pins here). */
    fun require(username: String, serverDomain: String, reportedHex: String): String {
        val domain = serverDomain.lowercase()
        val reported = reportedHex.lowercase()
        val pin = pins.pinnedHex(domain)
        when (decide(pin, reported)) {
            Verdict.INVALID, Verdict.MISMATCH ->
                throw BoxKeyChangedException(username.lowercase(), domain, pin.orEmpty(), reported)
            Verdict.FIRST -> throw ServerKeyNotPinnedException()
            Verdict.MATCH -> Unit
        }
        return reported
    }

    /** The listed servers whose key differs from this phone's pin. Never pins. */
    fun observe(username: String, pods: List<PodDirectoryEntry>): List<String> =
        pods.filter { p ->
            val stk = p.identityPubKey.lowercase()
            p.revokedAt == null && HEX32.matches(stk) &&
                pins.check(p.serverDomain, stk) is ServerKeyPins.Check.Changed
        }.map { it.serverDomain.lowercase() }

    /** The owner's explicit re-pin (this phone created or reinstalled the server). Drops the old
     *  pin and anything its STK had bound. */
    fun repin(username: String, serverDomain: String, stkHex: String) {
        val stk = stkHex.lowercase()
        if (!HEX32.matches(stk)) return
        forget(username, serverDomain)
        pins.recordFirstSeen(serverDomain, stk)
    }

    /** The explicit re-trust: the server's next request goes through first contact again. */
    fun forget(username: String, serverDomain: String) {
        pins.forget(serverDomain)
        verifiedPq.keys.removeIf { it.endsWith("|${serverDomain.lowercase()}") }
    }

    /** Adopt a box's boot-only key only through a binding the PINNED STK signed. Once this
     *  server's ML-DSA key is pinned (or its installation is [strict]), the STK's v2 hybrid
     *  signature is required too, so stripping it cannot downgrade the server. */
    fun acceptBootKeyBinding(
        username: String,
        serverDomain: String,
        bootPubHex: String,
        issuedAt: Long,
        signatureHex: String,
        hybridSignatureHex: String? = null,
        strict: Boolean = false,
    ): String? {
        val domain = serverDomain.lowercase()
        val pin = pins.record(domain) ?: return null
        val stk = HexUtil.decode(pin.stk) ?: return null
        val sig = HexUtil.decode(signatureHex) ?: return null
        if (!verifyBootKeyBinding(domain, bootPubHex, issuedAt, sig, stk, domain)) return null
        if ((pin.bootIssuedAt ?: -1) > issuedAt) return null
        if (strict && pin.mldsa == null) return null
        if (pin.mldsa != null && !verifyBootKeyBindingV2(domain, bootPubHex, issuedAt, hybridSignatureHex, pin.stk, pin.mldsa)) return null
        if (!pins.update(domain, pin.stk) { it.copy(boot = bootPubHex, bootIssuedAt = issuedAt) }) return null
        return bootPubHex
    }

    /**
     * Pin the ML-DSA key a box's STK bound, through a binding the PINNED STK and that key both
     * signed. Returns the ML-DSA key, or null when there is no STK pin or the binding is refused.
     * A binding naming another ML-DSA key than the pinned one throws [BoxKeyChangedException].
     */
    fun acceptStkPqBinding(username: String, serverDomain: String, wire: kotlinx.serialization.json.JsonElement?): String? {
        val domain = serverDomain.lowercase()
        val pin = pins.record(domain) ?: return null
        val v = com.flagshipserver.app.core.pq.BoxPqKeyPin.decide(pin.stk, pin.mldsa, pin.mldsaIssuedAt, domain, wire, now())
        when (v) {
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Pinned -> {
                if (pin.mldsa != v.mldsaPubHex || pin.mldsaIssuedAt != v.issuedAt) {
                    if (!pins.update(domain, pin.stk) { it.copy(mldsa = v.mldsaPubHex, mldsaIssuedAt = v.issuedAt) }) return null
                }
                runCatching {
                    com.flagshipserver.app.core.pq.PqTrust.verifyPqKeyBinding(wire, com.flagshipserver.app.core.pq.PqTrust.Expectation("box-stk", domain, pin.stk, v.mldsaPubHex, Long.MAX_VALUE / 2))
                }.getOrNull()?.let { verifiedPq["${username.lowercase()}|$domain"] = it }
                return v.mldsaPubHex
            }
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Mismatch ->
                throw BoxKeyChangedException(username.lowercase(), domain, pin.mldsa.orEmpty(), v.reportedHex)
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Invalid -> return null
        }
    }

    fun pinnedBoxPqKey(username: String, serverDomain: String): String? = pins.record(serverDomain)?.mldsa

    private val verifiedPq = java.util.concurrent.ConcurrentHashMap<String, com.flagshipserver.app.core.pq.PqTrust.VerifiedBinding>()

    /** The box's verified `box-stk` binding under the pinned keys, once seen this run: the PQ session's pin. */
    fun verifiedBoxPqBinding(username: String, serverDomain: String): com.flagshipserver.app.core.pq.PqTrust.VerifiedBinding? =
        verifiedPq["${username.lowercase()}|${serverDomain.lowercase()}"]
}
