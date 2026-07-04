// Trust-exception directory client — POSTs a signed, per-cert TrustException to
// `.com` so the owner's override FANS OUT to every box the user owns.
//
// This is the LOAD-BEARING transmit for the maintainer-trust override: `.com`
// stores the device-key-signed, cert-hash-scoped envelope (it can drop/replay
// but not forge it), and every box pulls it via resolveTrustExceptions, so one
// biometric override on the phone silences the warning on ALL affected servers.
//
// Wire shape mirrors packages/control-plane/src/serviceBlessing.ts
// `handleStoreTrustException` + the protocol TrustException (kind/version/
// certClass/certHash/grantedAt/grantedByDevicePub/signatures[]) — the SAME
// shape the webapp (lib/trustException.js) and iOS (wireEnvelope) post.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.Serializable

/** One attached signature `{ pubkey, sig }` (lower-hex). */
@Serializable
data class TrustExceptionSignature(val pubkey: String, val sig: String)

/** The full wire envelope `POST /api/users/:u/trust-exceptions` reads. */
@Serializable
data class TrustExceptionWire(
    val kind: String = "TrustException",
    val version: Int = 1,
    val certClass: String,
    val certHash: String,
    val grantedAt: Long,
    val grantedByDevicePub: String,
    val signatures: List<TrustExceptionSignature>,
)

interface TrustExceptionClient {
    /** POST the signed exception. Best-effort → returns whether `.com` accepted
     *  it; a failed transmit never undoes the local override. Never throws. */
    suspend fun post(username: String, wire: TrustExceptionWire): Boolean
}

class LiveTrustExceptionClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(),
    baseUrl: String = Endpoints.controlBaseUrl,
) : TrustExceptionClient {
    private val base = baseUrl.trimEnd('/')

    override suspend fun post(username: String, wire: TrustExceptionWire): Boolean {
        if (username.isEmpty()) return false
        return try {
            val encoded = java.net.URLEncoder.encode(username, "UTF-8")
            transport.postJson(
                "$base/api/users/$encoded/trust-exceptions",
                wire,
                serializer = TrustExceptionWire.serializer(),
                accept = setOf(200),
            )
            true
        } catch (_: Throwable) {
            false
        }
    }
}

/** No-op transmit for previews/tests — reports success without a network call. */
class MockTrustExceptionClient(
    var lastPosted: Pair<String, TrustExceptionWire>? = null,
) : TrustExceptionClient {
    override suspend fun post(username: String, wire: TrustExceptionWire): Boolean {
        lastPosted = username to wire
        return true
    }
}
