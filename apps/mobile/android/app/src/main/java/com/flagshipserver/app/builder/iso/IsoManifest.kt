// The /api/iso-manifest wire contract + the HTTP seam the builder's ISO layer
// talks through. Kotlin mirror of
// apps/builder-mac/.../IsoManifestClient.swift.
//
// LOCKED WIRE CONTRACT:
//   POST <controlHost>/api/iso-manifest
//   Request:  { "platform":"android", "builderVersion":"<s>",
//               "current": { "version":"<s>", "sha256":"<hex64>" } | null }
//   Response: { "download": { "url","sha256","version","sizeBytes","attestation" } }
//        or:  { "download": null }
//
// The builder is a DUMB EXECUTOR: it reports what it has cached (or null) and
// obeys the order, then verifies the bytes it downloads against the quoted sha.

package com.flagshipserver.app.builder.iso

import kotlinx.serialization.Serializable

@Serializable
data class IsoManifestCurrent(
    val version: String,
    val sha256: String,
)

@Serializable
data class IsoManifestRequest(
    val platform: String = "android",
    val builderVersion: String,
    val current: IsoManifestCurrent? = null,
)

@Serializable
data class IsoManifestDownload(
    val url: String,
    val sha256: String,
    val version: String,
    val sizeBytes: Long = 0,
    val attestation: String = "",
)

@Serializable
data class IsoManifestResponse(
    val download: IsoManifestDownload? = null,
)

/** Result of a plain HTTP POST. */
data class BuilderHttpResult(val status: Int, val body: String)

/**
 * The narrow HTTP capability the builder's ISO layer needs. Injectable so the
 * manifest client + base cache are unit-testable with a fake (no OkHttp, no
 * network). The real impl ([OkHttpBuilderHttp]) wraps OkHttp.
 */
interface BuilderHttp {
    /** POST a JSON body; return status + response body. Never throws on non-2xx. */
    suspend fun postJson(url: String, jsonBody: String): BuilderHttpResult

    /**
     * GET [url] and stream the body. [onStart] is called once with the
     * content length (or -1 if unknown). [onChunk] is called per chunk with the
     * buffer + valid length. Returns the HTTP status (the body is delivered via
     * the callbacks, not buffered).
     */
    suspend fun getStream(
        url: String,
        onStart: (contentLength: Long) -> Unit,
        onChunk: (buf: ByteArray, len: Int) -> Unit,
    ): Int
}

class IsoManifestException(message: String) : RuntimeException(message)
