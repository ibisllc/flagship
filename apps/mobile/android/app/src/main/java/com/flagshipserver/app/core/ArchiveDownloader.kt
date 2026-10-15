// Downloads a server backup in fixed-size parts, several at once, writing each
// part straight to its place in the file and remembering which parts are in,
// so an interrupted download picks up where it stopped; the finished file is
// checked against the SHA-256 the server reported.
// MIRRORS: apps/mobile/shared/Sources/FlagshipCore/ArchiveDownloader.swift

package com.flagshipserver.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

object ArchiveDownloader {
    /** What the box hands out per `GET .../chunk?offset=` (serverArchive/service.ts). */
    const val CHUNK_BYTES: Long = 4L * 1024 * 1024
    const val PARALLEL = 4

    @Serializable
    internal data class State(val total: Long, val sha256: String? = null, val done: Set<Long> = emptySet())

    class DownloadException(message: String) : Exception(message)

    private val json = Json { ignoreUnknownKeys = true }

    suspend fun download(
        total: Long,
        sha256: String?,
        file: File,
        stateFile: File,
        chunkBytes: Long = CHUNK_BYTES,
        parallel: Int = PARALLEL,
        fetch: suspend (offset: Long) -> ByteArray,
        progress: (received: Long) -> Unit = {},
    ) = withContext(Dispatchers.IO) {
        var state = runCatching { json.decodeFromString(State.serializer(), stateFile.readText()) }.getOrNull()
        if (state == null || state.total != total || state.sha256 != sha256 || !file.exists()) {
            file.delete()
            state = State(total, sha256)
        }
        val done = state.done.toMutableSet()
        fun length(offset: Long) = minOf(chunkBytes, total - offset)
        val pending = ArrayDeque((0 until total step chunkBytes).filter { it !in done })
        var received = done.sumOf { length(it) }
        progress(received)
        val lock = Mutex()
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(total)
            coroutineScope {
                repeat(maxOf(1, parallel)) {
                    launch {
                        while (true) {
                            val offset = lock.withLock { pending.removeFirstOrNull() } ?: break
                            val data = fetch(offset)
                            if (data.size.toLong() != length(offset)) {
                                throw DownloadException("The server sent a short piece of the backup. Try again; the download resumes.")
                            }
                            lock.withLock {
                                raf.seek(offset)
                                raf.write(data)
                                done += offset
                                stateFile.writeText(json.encodeToString(State.serializer(), State(total, sha256, done.toSet())))
                                received += data.size
                                progress(received)
                            }
                        }
                    }
                }
            }
            raf.fd.sync()
        }
        if (!sha256.isNullOrEmpty() && fileSha256(file) != sha256.lowercase()) {
            file.delete()
            stateFile.delete()
            throw DownloadException("The downloaded backup doesn't match the server's copy. Try downloading it again.")
        }
        stateFile.delete()
    }

    internal fun fileSha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
