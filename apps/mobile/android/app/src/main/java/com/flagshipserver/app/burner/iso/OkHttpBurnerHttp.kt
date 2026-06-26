// Real [BurnerHttp] over OkHttp — the production transport for the burner's ISO
// layer. The manifest POST is a small JSON round-trip; the download streams the
// body so a ~700 MB ISO is never buffered in memory.

package com.flagshipserver.app.burner.iso

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class OkHttpBurnerHttp(
    private val client: OkHttpClient = defaultClient(),
) : BurnerHttp {
    override suspend fun postJson(url: String, jsonBody: String): BurnerHttpResult = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(url)
            .post(jsonBody.toRequestBody("application/json".toMediaType()))
            .header("Accept", "application/json")
            .build()
        client.newCall(req).execute().use { resp ->
            BurnerHttpResult(resp.code, resp.body?.string() ?: "")
        }
    }

    override suspend fun getStream(
        url: String,
        onStart: (contentLength: Long) -> Unit,
        onChunk: (buf: ByteArray, len: Int) -> Unit,
    ): Int = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url).get().build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body
            if (body == null) {
                onStart(-1)
                return@use resp.code
            }
            onStart(body.contentLength())
            if (resp.isSuccessful) {
                body.byteStream().use { input ->
                    val buf = ByteArray(1 shl 20)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (n > 0) onChunk(buf, n)
                    }
                }
            }
            resp.code
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            // Generous read timeout — large ISO download over a slow link.
            .readTimeout(10, TimeUnit.MINUTES)
            .build()
    }
}
