// Pod-direct client for the owner-assignable apex ("front page").
//
// Two unauthenticated reads + one owner-IRK-signed write, straight to the
// box (`https://<pod>`), mirroring LockPowerClient + the daemon shapes in
// packages/server-daemon/src/frontPage.ts:
//
//   GET  https://<pod>/api/front-page   → { label, active }
//   GET  https://<pod>/api/services     → { apps: [{ urlLabel, name, … }] }
//   POST https://<pod>/api/front-page   { request, signature }  (IRK)

package com.flagshipserver.app.api

import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.Serializable

@Serializable
data class FrontPageState(
    /** Assigned service url-label; null = default Flagship page. */
    val label: String? = null,
    /** Whether the assigned label currently resolves to an installed service. */
    val active: Boolean = false,
)

@Serializable
data class FrontPageServiceEntry(
    val urlLabel: String,
    val name: String? = null,
)

@Serializable
data class FrontPageServicesResponse(
    val apps: List<FrontPageServiceEntry> = emptyList(),
)

@Serializable
data class SetFrontPageInner(
    val type: String = "set-front-page",
    val serverId: String,
    /** Service url-label to front-page; "" clears (default page). */
    val label: String,
    val issuedAt: Long,
)

@Serializable
data class SetFrontPageRequest(
    val request: SetFrontPageInner,
    /** Hex Ed25519 signature over SetFrontPageOrder.canonicalBytes. */
    val signature: String,
)

/** Daemon `/api/front-page` ack — `{ ok, label }`. */
@Serializable
data class FrontPageAck(val ok: Boolean = false, val label: String? = null)

/** Pod-direct client. [podBaseUrl] resolves `https://<serverDomain>` (the
 *  FQDN IS the pod). Pluggable transport for tests. */
class FrontPageClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(),
    private val podBaseUrl: (serverDomain: String) -> String = { "https://$it" },
) {
    suspend fun getFrontPage(serverDomain: String): FrontPageState =
        transport.getJson(
            "${podBaseUrl(serverDomain)}/api/front-page",
            FrontPageState.serializer(),
        )

    suspend fun listOptions(serverDomain: String): List<FrontPageServiceEntry> =
        transport.getJson(
            "${podBaseUrl(serverDomain)}/api/services",
            FrontPageServicesResponse.serializer(),
        ).apps

    suspend fun setFrontPage(serverDomain: String, body: SetFrontPageRequest): FrontPageAck =
        transport.postJsonForResponse(
            "${podBaseUrl(serverDomain)}/api/front-page",
            body,
            SetFrontPageRequest.serializer(),
            FrontPageAck.serializer(),
        )
}
