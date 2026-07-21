// Manifest-driven base-ISO cache. Kotlin mirror of
// apps/builder-mac/.../IsoBaseCache.swift.
//
// On every ensure(): inspect the cached ISO (compute its sha256), report
// {version, sha256} (or null) to the manifest endpoint, and OBEY the reply —
// either download a specific URL (stream-verifying the bytes against the quoted
// sha256) or keep the cache. The client never compares shas itself.
//
// Cache lives under the app's cache dir: <cacheDir>/flagship-base-<version>.iso.

package com.flagshipserver.app.builder.iso

import java.io.File
import java.security.MessageDigest

class IsoCacheException(message: String) : RuntimeException(message)

class IsoBaseCache(
    private val client: IsoManifestClient,
    private val http: BuilderHttp,
    private val cacheDir: File,
    private val builderVersion: String,
    private val log: (String) -> Unit = {},
) {
    sealed interface Phase {
        /** Reported once with the cache path + sha (or null) before contacting the server. */
        data class Inspected(val path: String?, val sha256: String?) : Phase

        /** A download was ordered; carries the URL + fractional progress. */
        data class Downloading(val url: String, val version: String, val progress: Double) : Phase

        /** Done — freshly downloaded or served from cache. */
        data class Ready(val path: String, val sha256: String, val fromCache: Boolean) : Phase
    }

    /** Inspect the cache, ask the server, obey, return the local base-ISO file. */
    suspend fun ensure(progress: (Phase) -> Unit = {}): File {
        if (!cacheDir.exists()) cacheDir.mkdirs()
        val existing = existingCachedIso(cacheDir)

        // (a) Inspect + compute sha256.
        val current: IsoManifestCurrent? = if (existing != null) {
            val sha = sha256OfFile(existing.file)
            log("base-iso cache: ${existing.file.path} sha256=$sha version=${existing.version}")
            progress(Phase.Inspected(existing.file.path, sha))
            IsoManifestCurrent(existing.version, sha)
        } else {
            log("base-iso cache: empty")
            progress(Phase.Inspected(null, null))
            null
        }

        // (b) POST the manifest.
        val response = client.fetch(
            IsoManifestRequest(platform = "android", builderVersion = builderVersion, current = current),
        )

        // (c) Obey: download or keep.
        val order = response.download
        if (order == null) {
            if (existing == null) {
                throw IsoCacheException("no base image is available yet (server ordered no download, nothing cached)")
            }
            val sha = current?.sha256 ?: sha256OfFile(existing.file)
            log("base-iso: server ordered no change — keeping ${existing.file.path}")
            progress(Phase.Ready(existing.file.path, sha, fromCache = true))
            return existing.file
        }
        return download(order, progress)
    }

    private suspend fun download(order: IsoManifestDownload, progress: (Phase) -> Unit): File {
        val dest = cachedFile(cacheDir, order.version)
        val tmp = File(dest.path + ".partial")
        tmp.delete()

        progress(Phase.Downloading(order.url, order.version, 0.0))

        val digest = MessageDigest.getInstance("SHA-256")
        var received = 0L
        var expected = if (order.sizeBytes > 0) order.sizeBytes else -1L
        var lastPct = -1

        tmp.outputStream().use { out ->
            val status = http.getStream(
                order.url,
                onStart = { len -> if (expected <= 0) expected = len },
                onChunk = { buf, len ->
                    out.write(buf, 0, len)
                    digest.update(buf, 0, len)
                    received += len
                    if (expected > 0) {
                        val pct = ((received * 100) / expected).toInt()
                        if (pct != lastPct) {
                            lastPct = pct
                            progress(Phase.Downloading(order.url, order.version, (received.toDouble() / expected).coerceIn(0.0, 1.0)))
                        }
                    }
                },
            )
            if (status !in 200..299) {
                tmp.delete()
                throw IsoCacheException("base-image download failed (HTTP $status)")
            }
        }

        progress(Phase.Downloading(order.url, order.version, 1.0))

        // Stream-verify the sha256.
        val got = digest.digest().toHex()
        if (got != order.sha256.lowercase()) {
            tmp.delete()
            throw IsoCacheException(
                "base image failed its integrity check (expected ${order.sha256.take(12)}…, got ${got.take(12)}…). Discarded.",
            )
        }

        // Atomic-ish move into place + prune older bases.
        dest.delete()
        if (!tmp.renameTo(dest)) {
            // renameTo can fail across some filesystems; fall back to copy.
            tmp.copyTo(dest, overwrite = true)
            tmp.delete()
        }
        pruneOtherBases(dest, cacheDir)

        log("downloaded ${dest.path} sha256=$got from ${order.url}")
        progress(Phase.Ready(dest.path, got, fromCache = false))
        return dest
    }

    data class Cached(val file: File, val version: String)

    companion object {
        private const val PREFIX = "flagship-base-"
        private const val SUFFIX = ".iso"

        fun cachedFile(dir: File, version: String): File = File(dir, "$PREFIX$version$SUFFIX")

        fun existingCachedIso(dir: File): Cached? {
            val entries = dir.listFiles() ?: return null
            return entries.sortedBy { it.name }
                .firstOrNull { it.isFile && it.name.startsWith(PREFIX) && it.name.endsWith(SUFFIX) }
                ?.let { Cached(it, it.name.removePrefix(PREFIX).removeSuffix(SUFFIX)) }
        }

        fun pruneOtherBases(keep: File, dir: File) {
            val entries = dir.listFiles() ?: return
            for (f in entries) {
                if (f.isFile && f.name.startsWith(PREFIX) && f.name.endsWith(SUFFIX) &&
                    f.canonicalPath != keep.canonicalPath
                ) {
                    f.delete()
                }
            }
        }

        fun sha256OfFile(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(1 shl 20)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().toHex()
        }

        private fun ByteArray.toHex(): String {
            val sb = StringBuilder(size * 2)
            for (b in this) {
                val v = b.toInt() and 0xFF
                sb.append("0123456789abcdef"[v ushr 4])
                sb.append("0123456789abcdef"[v and 0xF])
            }
            return sb.toString()
        }
    }
}
