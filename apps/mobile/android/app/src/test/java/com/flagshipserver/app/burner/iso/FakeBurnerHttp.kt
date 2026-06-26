package com.flagshipserver.app.burner.iso

/**
 * A scriptable [BurnerHttp] for unit tests — no OkHttp, no network. POSTs return
 * a canned body; GETs stream a canned byte payload in fixed-size chunks.
 */
class FakeBurnerHttp(
    var postStatus: Int = 200,
    var postBody: String = "{\"download\":null}",
    var downloadStatus: Int = 200,
    var downloadBytes: ByteArray = ByteArray(0),
    var contentLength: Long = -1,
    var chunkSize: Int = 4096,
) : BurnerHttp {
    val postedBodies = mutableListOf<String>()
    val requestedUrls = mutableListOf<String>()

    override suspend fun postJson(url: String, jsonBody: String): BurnerHttpResult {
        requestedUrls.add(url)
        postedBodies.add(jsonBody)
        return BurnerHttpResult(postStatus, postBody)
    }

    override suspend fun getStream(
        url: String,
        onStart: (contentLength: Long) -> Unit,
        onChunk: (buf: ByteArray, len: Int) -> Unit,
    ): Int {
        requestedUrls.add(url)
        onStart(if (contentLength >= 0) contentLength else downloadBytes.size.toLong())
        if (downloadStatus in 200..299) {
            var off = 0
            while (off < downloadBytes.size) {
                val n = minOf(chunkSize, downloadBytes.size - off)
                onChunk(downloadBytes.copyOfRange(off, off + n), n)
                off += n
            }
        }
        return downloadStatus
    }
}
