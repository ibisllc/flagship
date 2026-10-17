package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.Serializable

/** No-op transmit for previews/tests — reports success without a network call. */
class MockTrustExceptionClient(
    var lastPosted: Pair<String, TrustExceptionWire>? = null,
) : TrustExceptionClient {
    override suspend fun post(username: String, wire: TrustExceptionWire): Boolean {
        lastPosted = username to wire
        return true
    }
}
