// The owner's server order (docs/server-order.md). Kotlin mirror of
// packages/protocol/src/serverOrder.ts; the pinned vectors in
// packages/protocol/test-vectors/server-order/ lock the bytes.
//
// The first server in the order that is up leads; the role passes down the
// list while higher servers are down. Servers the order doesn't list rank
// after it, oldest first.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

@Serializable
data class ServerOrder(
    val user: String,
    /** The servers' STK public keys, lowercase hex, first = leader. */
    val stks: List<String>,
    val issuedAt: Long,
    /** 32 random bytes, lowercase hex. */
    val nonce: String,
)

/** A signed order as it travels: `/pods`, `POST /api/accounts/<u>/server-order`. */
@Serializable
data class ServerOrderWire(val order: ServerOrder, val signature: String)

object ServerOrderProtocol {
    const val TAG = "flagship/server-order/v1"
    const val MAX = 64
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX128 = Regex("^[0-9a-f]{128}$")

    fun path(username: String): String = "/api/accounts/${username.lowercase()}/server-order"

    /** Throws IllegalArgumentException on anything the TS reference refuses. */
    fun canonicalBytes(o: ServerOrder): ByteArray {
        require(o.user.isNotEmpty() && o.user.none { it == '|' || it.code < 0x20 || it.code == 0x7f }) { "bad user" }
        require(o.stks.isNotEmpty() && o.stks.size <= MAX) { "stks must list 1..$MAX servers" }
        require(o.stks.all { HEX64.matches(it) }) { "each stk must be 32-byte lowercase hex" }
        require(o.stks.toSet().size == o.stks.size) { "stks must not repeat" }
        require(HEX64.matches(o.nonce)) { "nonce must be 32-byte lowercase hex" }
        require(o.issuedAt > 0) { "issuedAt must be positive" }
        return listOf(TAG, o.user.lowercase(), o.stks.joinToString(","), o.issuedAt.toString(), o.nonce)
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }

    fun sign(o: ServerOrder, signer: Ed25519Sign): String = HexUtil.encode(signer.sign(canonicalBytes(o)))

    fun verify(o: ServerOrder, signatureHex: String, pub: ByteArray): Boolean = runCatching {
        if (!HEX128.matches(signatureHex)) return false
        Ed25519Verify(pub).verify(HexUtil.decode(signatureHex)!!, canonicalBytes(o))
        true
    }.getOrDefault(false)

    /** True for a pod that can be named in an order: a registered, unrevoked
     *  server with a known STK. */
    fun orderable(pod: PodInfo): Boolean =
        pod.status != PodInfo.Status.PENDING && !pod.isRevoked &&
            HEX64.matches(pod.identityPubKeyHex.lowercase())

    /** Every pod ranked by [stks]: servers that can be ordered first (listed
     *  ones in list order, then the rest), then pending and revoked ones;
     *  within each, oldest first (registration time), then by fqdn. Pods with
     *  no known registration time come last, in the order given. */
    fun rank(pods: List<PodInfo>, stks: List<String>?): List<PodInfo> {
        val pos = (stks ?: emptyList()).withIndex().associate { (i, s) -> s.lowercase() to i }
        return pods.sortedWith(
            compareBy<PodInfo>(
                { if (orderable(it) || (it.status != PodInfo.Status.PENDING && !it.isRevoked)) 0 else 1 },
                { pos[it.identityPubKeyHex.lowercase()] ?: Int.MAX_VALUE },
                { if (it.registeredAt > 0) it.registeredAt else Long.MAX_VALUE },
            ).thenComparator { a, b ->
                if (a.registeredAt > 0 && b.registeredAt > 0) a.fqdn.lowercase().compareTo(b.fqdn.lowercase()) else 0
            },
        )
    }

    /** True when the pod counts as up for leadership. */
    fun isUp(pod: PodInfo): Boolean =
        pod.status == PodInfo.Status.ONLINE && pod.cameOnline && !pod.isRevoked

    /** The leader of an already-ranked list: the first pod that is up, else
     *  the first unrevoked one, else the first. */
    fun leader(ranked: List<PodInfo>): PodInfo? =
        ranked.firstOrNull(::isUp) ?: ranked.firstOrNull { !it.isRevoked } ?: ranked.firstOrNull()
}
