// Pod-direct delivery for the lock-&-power-off + dead-man primitives.
// Unlike most BFF traffic these go STRAIGHT to the box (`https://<pod>`),
// not through `.com` — the daemon verifies the signature locally against
// its config-pinned owner IRK. All three are owner-IRK-signed: the manual
// power surface (`/api/power`) pins the SAME box owner IRK as the dead-man
// endpoints (the dead PSK/orders path is inert on a real Debian box).
//
//   POST https://<pod>/api/power           { request, signature }  (IRK)
//   POST https://<pod>/api/deadman/policy  { request, signature }  (IRK)
//   POST https://<pod>/api/deadman/affirm  { request, signature }  (IRK)
//
// Mirrors the iOS LockPowerClient + the daemon verify shape
// (packages/server-daemon/src/deadManHttp.ts).

package com.flagshipserver.app.api

import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ---------- power-off PhoneOrder (owner-IRK-signed) --------------------

@Serializable
data class PowerOffOrderInner(
    val type: String = "power-off",
    val serverId: String,
    /** "off" | "restart" */
    val mode: String,
    val issuedAt: Long,
)

@Serializable
data class PowerOffOrderRequest(
    val request: PowerOffOrderInner,
    /** Hex Ed25519 signature over PowerOffOrder.canonicalBytes. */
    val signature: String,
)

/** Daemon `/api/power` ack — `{ ok, mode }`. */
@Serializable
data class OrderAck(val ok: Boolean = false, val mode: String? = null)

// ---------- dead-man policy (IRK-signed) -------------------------------

@Serializable
data class DeadManPolicyInner(
    val serverId: String,
    val enabled: Boolean,
    val windowMs: Long,
    val graceMs: Long,
    /** "off" | "restart" */
    val lockoutMode: String,
    val issuedAt: Long,
)

@Serializable
data class DeadManPolicyRequest(
    val request: DeadManPolicyInner,
    val signature: String,
)

@Serializable
data class DeadManPolicyAck(val ok: Boolean = false, val enabled: Boolean = false)

// ---------- dead-man affirmation (IRK-signed) --------------------------

@Serializable
data class DeadManAffirmInner(
    val serverId: String,
    /** Fresh per-affirmation nonce, lowercase hex. */
    val nonce: String,
    val issuedAt: Long,
)

@Serializable
data class DeadManAffirmRequest(
    val request: DeadManAffirmInner,
    val signature: String,
)

@Serializable
data class DeadManAffirmAck(
    val ok: Boolean = false,
    /** Epoch-ms the dead-man lease now expires at, per the daemon. */
    @SerialName("leaseExpiry") val leaseExpiry: Long? = null,
)

/** Pod-direct client. [podBaseUrl] resolves `https://<serverDomain>` (the
 *  FQDN IS the pod). Pluggable transport for tests. */
class LockPowerClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(),
    private val podBaseUrl: (serverDomain: String) -> String = { "https://$it" },
) {
    suspend fun sendPowerOff(serverDomain: String, body: PowerOffOrderRequest): OrderAck =
        transport.postJsonForResponse(
            "${podBaseUrl(serverDomain)}/api/power",
            body,
            PowerOffOrderRequest.serializer(),
            OrderAck.serializer(),
        )

    suspend fun setDeadManPolicy(serverDomain: String, body: DeadManPolicyRequest): DeadManPolicyAck =
        transport.postJsonForResponse(
            "${podBaseUrl(serverDomain)}/api/deadman/policy",
            body,
            DeadManPolicyRequest.serializer(),
            DeadManPolicyAck.serializer(),
        )

    suspend fun affirm(serverDomain: String, body: DeadManAffirmRequest): DeadManAffirmAck =
        transport.postJsonForResponse(
            "${podBaseUrl(serverDomain)}/api/deadman/affirm",
            body,
            DeadManAffirmRequest.serializer(),
            DeadManAffirmAck.serializer(),
        )
}
