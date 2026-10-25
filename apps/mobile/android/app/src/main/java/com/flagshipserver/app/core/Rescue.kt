package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Data rescue and basic offline control (docs/data-sovereignty.md): the messages the owner's phone
 * and its box exchange on the local network with `.com` and the relay out of reach. Wire parity with
 * packages/protocol/src/rescue.ts; pinned by packages/protocol/test-vectors/rescue/ (vectors.json,
 * offline-control.json, pq-vectors.json).
 *
 *   flagship/rescue-hello/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>       (box STK)
 *   flagship/rescue-session/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>     (owner)
 *   flagship/offline-control/v1|<serverDomain>|<sessionNonce>|<action>|<target>|<nonce>|<issuedAt> (owner)
 *
 * The phone trusts the box by its PINNED key, never by DNS or a certificate authority: the hello
 * names the leaf certificate the connection presented, so a machine in the middle is caught before
 * the phone signs anything.
 */
object Rescue {
    const val HELLO_TAG = "flagship/rescue-hello/v1"
    const val SESSION_TAG = "flagship/rescue-session/v1"
    const val CONTROL_TAG = "flagship/offline-control/v1"
    private const val DISCOVERY_TAG = "flagship/lan-discovery/v1"
    const val HELLO_TTL_MS = 2 * 60_000L
    private const val CLOCK_SKEW_MS = 2 * 60_000L
    /** The Bonjour/NSD service type a box announces (lanDiscovery.ts). */
    const val SERVICE_TYPE = "_flagship._tcp."
    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val LABEL = Regex("^[a-z0-9][a-z0-9-]{0,62}$")
    private const val MAX_SAFE = 9_007_199_254_740_991L

    @Serializable
    data class Exchange(
        val serverDomain: String,
        val clientNonce: String,
        val boxNonce: String,
        val certSha256: String,
        val issuedAt: Long,
    ) {
        private fun canonical(tag: String): ByteArray {
            require(serverDomain.isNotEmpty() && clean(serverDomain)) { "serverDomain" }
            require(HEX32.matches(clientNonce)) { "clientNonce" }
            require(HEX32.matches(boxNonce)) { "boxNonce" }
            require(HEX64.matches(certSha256)) { "certSha256" }
            require(issuedAt in 0..MAX_SAFE) { "issuedAt" }
            return listOf(tag, serverDomain, clientNonce, boxNonce, certSha256, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
        }

        fun helloCanonical(): ByteArray = canonical(HELLO_TAG)
        fun sessionCanonical(): ByteArray = canonical(SESSION_TAG)
    }

    fun clean(s: String): Boolean = s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

    fun verifyEd25519(pub: ByteArray, sig: ByteArray, msg: ByteArray): Boolean = try {
        pub.size == 32 && sig.size == 64 && run { Ed25519Verify(pub).verify(sig, msg); true }
    } catch (_: Exception) {
        false
    }

    /**
     * What the phone checks before it signs anything. Returns the refusal, or null when the hello
     * is good: signed by the pinned key, answers this phone's nonce, current, and naming the
     * certificate this connection presented.
     */
    fun checkHello(h: Exchange, signature: ByteArray, stkPub: ByteArray, serverDomain: String, clientNonce: String, seenCertSha256: String, now: Long): String? {
        val bytes = try { h.helloCanonical() } catch (_: IllegalArgumentException) { return "bad-signature" }
        if (!verifyEd25519(stkPub, signature, bytes)) return "bad-signature"
        if (!h.serverDomain.equals(serverDomain, ignoreCase = true)) return "wrong-server"
        if (h.clientNonce != clientNonce) return "wrong-nonce"
        if (h.certSha256 != seenCertSha256.lowercase()) return "cert-mismatch"
        if (h.issuedAt > now + CLOCK_SKEW_MS) return "not-yet-valid"
        if (now - h.issuedAt > HELLO_TTL_MS) return "expired"
        return null
    }

    /** The hello's post-quantum half under the pinned STK and its ML-DSA key; strict needs it. */
    fun checkHelloPq(h: Exchange, suite: String?, signatureHex: String?, stkHex: String, pinnedMldsaHex: String?, strict: Boolean): String? {
        if (suite == null || signatureHex == null) return if (strict) "strict-requires-hybrid" else null
        if (pinnedMldsaHex == null) return if (strict) "strict-requires-binding" else null
        val sig = PqHex.decode(signatureHex.lowercase()) ?: return "bad-signature"
        val pk = PqHex.decode(stkHex.lowercase() + pinnedMldsaHex.lowercase()) ?: return "bad-signature"
        if (suite != "hybrid-ed25519-mldsa65/v1" || sig.size != 3373) return "bad-signature"
        return try {
            PqHybrid.hybridVerify(pk, HELLO_TAG, h.helloCanonical(), sig)
            null
        } catch (_: Exception) {
            "bad-signature"
        }
    }

    /** First 8 bytes of HMAC-SHA256(key = the STK public key, "flagship/lan-discovery/v1|" + lowercase name), hex. */
    fun discoveryId(stkPub: ByteArray, serverDomain: String): String? {
        if (!clean(serverDomain)) return null
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(stkPub, "HmacSHA256")) }
        return HexUtil.encode(mac.doFinal("$DISCOVERY_TAG|${serverDomain.lowercase()}".toByteArray(Charsets.UTF_8)).copyOf(8))
    }

    fun newNonce(): String = HexUtil.encode(ByteArray(16).also { SecureRandom().nextBytes(it) })

    /** `<creator>--<slug>` or a bare `<slug>`, each half a lowercase DNS label. */
    fun isServiceId(id: String): Boolean {
        val parts = id.split("--")
        return parts.size <= 2 && parts.all { LABEL.matches(it) }
    }

    enum class Action(val wire: String) {
        APP_START("app-start"), APP_STOP("app-stop"), APP_RESTART("app-restart"),
        SERVER_RESTART("server-restart"), SERVER_SHUTDOWN("server-shutdown");

        val isServerAction: Boolean get() = this == SERVER_RESTART || this == SERVER_SHUTDOWN

        companion object {
            fun of(wire: String): Action? = entries.firstOrNull { it.wire == wire }
        }
    }

    /** One offline action, signed by the owner, bound to the rescue session it is sent on, spent once. */
    @Serializable
    data class ControlOrder(
        val serverDomain: String,
        val sessionNonce: String,
        val action: String,
        val target: String,
        val nonce: String,
        val issuedAt: Long,
    ) {
        fun canonical(): ByteArray {
            require(serverDomain.isNotEmpty() && serverDomain == serverDomain.lowercase() && clean(serverDomain)) { "serverDomain" }
            require(HEX32.matches(sessionNonce)) { "sessionNonce" }
            val a = Action.of(action) ?: throw IllegalArgumentException("action")
            if (a.isServerAction) require(target == serverDomain) { "target" } else require(isServiceId(target)) { "target" }
            require(HEX32.matches(nonce)) { "nonce" }
            require(issuedAt in 0..MAX_SAFE) { "issuedAt" }
            return listOf(CONTROL_TAG, serverDomain, sessionNonce, action, target, nonce, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
        }

        companion object {
            fun of(serverDomain: String, sessionNonce: String, action: Action, target: String, issuedAt: Long) =
                ControlOrder(serverDomain, sessionNonce, action.wire, target, newNonce(), issuedAt)
        }
    }
}
