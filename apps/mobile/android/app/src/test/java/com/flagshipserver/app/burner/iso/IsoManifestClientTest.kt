package com.flagshipserver.app.burner.iso

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class IsoManifestClientTest {
    private val url = "https://test.example/api/iso-manifest"

    @Test
    fun decodesDownloadOrder() = runTest {
        val http = FakeBurnerHttp(
            postBody = """
              {"download":{"url":"https://cdn/deb.iso","sha256":"ABC","version":"13.5","sizeBytes":791,"attestation":"x"}}
            """.trimIndent(),
        )
        val resp = IsoManifestClient(http, url).fetch(
            IsoManifestRequest(burnerVersion = "1.0", current = null),
        )
        val d = resp.download!!
        assertEquals("https://cdn/deb.iso", d.url)
        assertEquals("ABC", d.sha256)
        assertEquals("13.5", d.version)
        assertEquals(791L, d.sizeBytes)
    }

    @Test
    fun decodesNullDownload() = runTest {
        val http = FakeBurnerHttp(postBody = "{\"download\":null}")
        val resp = IsoManifestClient(http, url).fetch(IsoManifestRequest(burnerVersion = "1.0"))
        assertNull(resp.download)
    }

    @Test
    fun sendsPlatformAndCurrent() = runTest {
        val http = FakeBurnerHttp()
        IsoManifestClient(http, url).fetch(
            IsoManifestRequest(burnerVersion = "9.9", current = IsoManifestCurrent("13.5", "deadbeef")),
        )
        val body = http.postedBodies.single()
        assertTrue(body.contains("\"platform\":\"android\""))
        assertTrue(body.contains("\"burnerVersion\":\"9.9\""))
        assertTrue(body.contains("\"version\":\"13.5\""))
        assertTrue(body.contains("\"sha256\":\"deadbeef\""))
    }

    @Test
    fun nonOkStatusThrows() {
        val http = FakeBurnerHttp(postStatus = 503)
        assertThrows(IsoManifestException::class.java) {
            runTest { IsoManifestClient(http, url).fetch(IsoManifestRequest(burnerVersion = "1.0")) }
        }
    }

    @Test
    fun garbageBodyThrows() {
        val http = FakeBurnerHttp(postBody = "not json")
        assertThrows(IsoManifestException::class.java) {
            runTest { IsoManifestClient(http, url).fetch(IsoManifestRequest(burnerVersion = "1.0")) }
        }
    }
}
