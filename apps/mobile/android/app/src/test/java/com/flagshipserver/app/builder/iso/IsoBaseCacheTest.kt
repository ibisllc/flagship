package com.flagshipserver.app.builder.iso

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class IsoBaseCacheTest {
    private lateinit var dir: File
    private val json = Json { encodeDefaults = true }

    @Before
    fun setUp() {
        dir = File.createTempFile("flagship-cache", "").let {
            it.delete(); it.mkdirs(); it
        }
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun sha256Hex(b: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun cache(http: FakeBuilderHttp): IsoBaseCache =
        IsoBaseCache(IsoManifestClient(http, "https://test/api/iso-manifest"), http, dir, "1.0")

    private fun orderJson(d: IsoManifestDownload): String =
        json.encodeToString(IsoManifestResponse(d))

    @Test
    fun downloadsVerifiesAndCaches() = runTest {
        val iso = ByteArray(10_000) { (it % 97).toByte() }
        val sha = sha256Hex(iso)
        val http = FakeBuilderHttp(
            postBody = orderJson(IsoManifestDownload("https://cdn/d.iso", sha, "13.5", iso.size.toLong(), "")),
            downloadBytes = iso,
        )
        val phases = mutableListOf<IsoBaseCache.Phase>()
        val file = cache(http).ensure { phases.add(it) }

        assertTrue(file.exists())
        assertEquals("flagship-base-13.5.iso", file.name)
        assertArrayEquals(iso, file.readBytes())
        val ready = phases.last() as IsoBaseCache.Phase.Ready
        assertFalse(ready.fromCache)
        assertEquals(sha, ready.sha256)
    }

    @Test
    fun shaMismatchDiscardsAndThrows() {
        val iso = ByteArray(5000) { 1 }
        val http = FakeBuilderHttp(
            postBody = orderJson(IsoManifestDownload("https://cdn/d.iso", "0".repeat(64), "13.5", iso.size.toLong(), "")),
            downloadBytes = iso,
        )
        assertThrows(IsoCacheException::class.java) {
            runTest { cache(http).ensure() }
        }
        // No cached ISO left behind, and no leftover .partial.
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".iso") || it.name.endsWith(".partial") })
    }

    @Test
    fun keepsCacheWhenServerOrdersNull() = runTest {
        val iso = ByteArray(8000) { (it % 13).toByte() }
        val existing = File(dir, "flagship-base-13.5.iso")
        existing.writeBytes(iso)
        val http = FakeBuilderHttp(postBody = "{\"download\":null}")

        val phases = mutableListOf<IsoBaseCache.Phase>()
        val file = cache(http).ensure { phases.add(it) }
        assertEquals(existing.canonicalPath, file.canonicalPath)
        val ready = phases.last() as IsoBaseCache.Phase.Ready
        assertTrue(ready.fromCache)
        // The manifest POST reported the cached version + sha.
        val body = http.postedBodies.single()
        assertTrue(body.contains("\"version\":\"13.5\""))
        assertTrue(body.contains(sha256Hex(iso)))
    }

    @Test
    fun emptyCacheAndNoOrderThrows() {
        val http = FakeBuilderHttp(postBody = "{\"download\":null}")
        assertThrows(IsoCacheException::class.java) {
            runTest { cache(http).ensure() }
        }
    }

    @Test
    fun freshDownloadPrunesStaleBase() = runTest {
        File(dir, "flagship-base-13.4.iso").writeBytes(ByteArray(100))
        val iso = ByteArray(2000) { 7 }
        val sha = sha256Hex(iso)
        val http = FakeBuilderHttp(
            postBody = orderJson(IsoManifestDownload("https://cdn/d.iso", sha, "13.5", iso.size.toLong(), "")),
            downloadBytes = iso,
        )
        cache(http).ensure()
        val isos = dir.listFiles()!!.filter { it.name.endsWith(".iso") }.map { it.name }
        assertEquals(listOf("flagship-base-13.5.iso"), isos)
    }
}
