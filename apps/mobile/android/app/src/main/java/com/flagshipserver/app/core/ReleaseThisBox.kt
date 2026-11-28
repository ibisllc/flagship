// "Release this box" (docs/retail-box-setup.md §8.2; Kotlin mirror of packages/protocol/src/boxRelease.ts):
// the account's admin root orders a retail box wiped back to unclaimed. Releasing always wipes.
//
//   flagship/box-release/v1|<serverDomain>|<stkPubHex>|<issuedAt>|<nonceHex>
//
// Signed by the admin root only. A strict box also needs the admin root's hybrid signature over the
// same bytes (`pqSignature`). Pinned by packages/protocol/test-vectors/box-release/vectors.json.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

object ReleaseThisBox {
    const val TAG = "flagship/box-release/v1"
    const val HYBRID_SUITE = "hybrid-ed25519-mldsa65/v1"

    data class Order(val serverDomain: String, val stkPubHex: String, val issuedAt: Long, val nonceHex: String)

    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private val STK = Regex("^[0-9a-f]{64}$")
    private val NONCE = Regex("^[0-9a-f]{32}$")

    /** "domain", "stk", "time", "nonce" or null. */
    fun problem(o: Order): String? = when {
        !DOMAIN.matches(o.serverDomain) -> "domain"
        !STK.matches(o.stkPubHex) -> "stk"
        o.issuedAt <= 0 -> "time"
        !NONCE.matches(o.nonceHex) -> "nonce"
        else -> null
    }

    fun canonicalBytes(o: Order): ByteArray {
        problem(o)?.let { throw IllegalArgumentException("box release order: bad $it") }
        return "$TAG|${o.serverDomain}|${o.stkPubHex}|${o.issuedAt}|${o.nonceHex}".toByteArray(Charsets.UTF_8)
    }

    fun make(serverDomain: String, stkPubHex: String, issuedAt: Long): Order {
        val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }
        return Order(serverDomain.lowercase(), stkPubHex.lowercase(), issuedAt, HexUtil.encode(nonce))
    }

    fun sign(o: Order, adminRoot: Ed25519Sign): String = HexUtil.encode(adminRoot.sign(canonicalBytes(o)))

    fun verify(o: Order, signatureHex: String, adminRootPub: ByteArray): Boolean = runCatching {
        CheckedEd25519Verify(adminRootPub).verify(HexUtil.decode(signatureHex)!!, canonicalBytes(o))
        true
    }.getOrDefault(false)

    fun verifyHybrid(o: Order, signatureHex: String, hybridPub: ByteArray): Boolean = runCatching {
        PqHybrid.hybridVerify(hybridPub, TAG, canonicalBytes(o), HexUtil.decode(signatureHex)!!)
        true
    }.getOrDefault(false)

    /** `POST /api/screens/box-release {order, signatureHex, pqSignature?}`. */
    fun bodyJson(o: Order, signatureHex: String, pqSuite: String? = null, pqSignature: String? = null): String = buildJsonObject {
        put("order", buildJsonObject {
            put("serverDomain", o.serverDomain)
            put("stkPubHex", o.stkPubHex)
            put("issuedAt", o.issuedAt)
            put("nonceHex", o.nonceHex)
        })
        put("signatureHex", signatureHex)
        if (pqSuite != null && pqSignature != null) {
            put("pqSignature", buildJsonObject {
                put("suite", JsonPrimitive(pqSuite))
                put("signature", JsonPrimitive(pqSignature))
            })
        }
    }.toString()

    /** The box's refusal code as a sentence in the owner's language. */
    fun refusal(code: String): String = FSStrings.get(
        when (code) {
            "release-not-admin", "release-no-admin-root" -> R.string.release_box_not_admin
            "release-needs-hybrid" -> R.string.release_box_needs_hybrid
            "release-other-server" -> R.string.release_box_other_server
            "release-clock" -> R.string.release_box_clock
            "release-replayed" -> R.string.release_box_replayed
            "release-not-claimed" -> R.string.release_box_already
            else -> R.string.release_box_failed
        },
    )
}
