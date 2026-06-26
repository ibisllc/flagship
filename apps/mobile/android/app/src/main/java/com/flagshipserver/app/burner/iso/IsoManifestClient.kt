// Posts the ISO-manifest request and decodes the reply. Mirror of
// apps/burner-mac/.../IsoManifestClient.swift, over the [BurnerHttp] seam.

package com.flagshipserver.app.burner.iso

import com.flagshipserver.app.core.Endpoints
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class IsoManifestClient(
    private val http: BurnerHttp,
    private val endpointUrl: String = "${Endpoints.controlBaseUrl}/api/iso-manifest",
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) {
    /** POST the request and decode the reply. Throws [IsoManifestException] on
     *  transport / HTTP / decode failure. */
    suspend fun fetch(request: IsoManifestRequest): IsoManifestResponse {
        val body = json.encodeToString(request)
        val result = try {
            http.postJson(endpointUrl, body)
        } catch (e: Throwable) {
            throw IsoManifestException("couldn't reach the base-image service: ${e.message}")
        }
        if (result.status !in 200..299) {
            throw IsoManifestException("the base-image service returned HTTP ${result.status}")
        }
        return try {
            json.decodeFromString<IsoManifestResponse>(result.body)
        } catch (e: Throwable) {
            throw IsoManifestException("unreadable base-image response: ${e.message}")
        }
    }
}
