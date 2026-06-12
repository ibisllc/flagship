// FrontPageViewModel — loads the assignment + options from the pod, signs a
// `set-front-page` order with the OWNER IRK, POSTs it to the box's
// /api/front-page, and the recorded signature must verify against the
// canonical bytes the daemon would recompute. Pins the wire shape + endpoint
// + the phase transitions.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.FrontPageClient
import com.flagshipserver.app.api.SetFrontPageRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.SetFrontPageOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrontPageViewModelTest {

    private val server = "home.harry.flagship.services"

    @Test fun load_populatesCurrentAndOptions() = runTest {
        val transport = FrontPageTransport(
            frontPage = """{"label":"photos","active":true}""",
            services = """{"apps":[{"urlLabel":"photos","name":"Photos"},{"urlLabel":"blog","name":"Blog"}]}""",
        )
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = FrontPageClient(transport = transport),
        )
        vm.load()
        assertTrue(vm.phase.value is FrontPagePhase.Ready)
        assertEquals("photos", vm.current.value)
        assertTrue(vm.currentActive.value)
        assertEquals(listOf("photos", "blog"), vm.options.value.map { it.urlLabel })
    }

    @Test fun save_signsAndPosts_recordingExactWireValues() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = FrontPageTransport()
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = FrontPageClient(transport = transport),
            now = { 1_700_000_000_000L },
        )
        vm.save("photos")
        assertTrue(vm.phase.value is FrontPagePhase.Ready)
        assertEquals("photos", vm.current.value)
        assertEquals("https://$server/api/front-page", transport.lastUrl)

        val body = transport.decode(SetFrontPageRequest.serializer())
        assertEquals("set-front-page", body.request.type)
        assertEquals(server, body.request.serverId)
        assertEquals("photos", body.request.label)
        assertEquals(1_700_000_000_000L, body.request.issuedAt)

        val sig = HexUtil.decode(body.signature)
        assertNotNull(sig)
        // Verifies against the canonical bytes the daemon recomputes.
        Ed25519Verify(kp.publicKey).verify(
            sig!!,
            SetFrontPageOrder.canonicalBytes(server, "photos", 1_700_000_000_000L),
        )
    }

    @Test fun save_emptyLabel_clears() = runTest {
        val transport = FrontPageTransport()
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = FrontPageClient(transport = transport),
            now = { 9L },
        )
        vm.save("")
        assertNull(vm.current.value)
        val body = transport.decode(SetFrontPageRequest.serializer())
        assertEquals("", body.request.label)
    }

    @Test fun save_http422_surfacesUninstalledMessage() = runTest {
        val transport = FailingPostTransport(HttpException(422, """{"error":"unknown service label"}"""))
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = FrontPageClient(transport = transport),
        )
        vm.save("ghost")
        val p = vm.phase.value
        assertTrue(p is FrontPagePhase.Failed)
        assertTrue((p as FrontPagePhase.Failed).message.contains("no longer installed"))
    }

    @Test fun signerFailure_failsWithoutPosting() = runTest {
        val transport = FrontPageTransport()
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { error("biometric cancelled") },
            client = FrontPageClient(transport = transport),
        )
        vm.save("photos")
        assertTrue(vm.phase.value is FrontPagePhase.Failed)
        assertNull(transport.lastUrl)
    }

    @Test fun loadFailure_isGraceful() = runTest {
        val transport = FailingPostTransport(RuntimeException("down"))
        val vm = FrontPageViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = FrontPageClient(transport = transport),
        )
        vm.load()
        assertTrue(vm.phase.value is FrontPagePhase.Failed)
    }

    /** GETs serve canned front-page/services JSON; POST records + acks. */
    class FrontPageTransport(
        private val frontPage: String = """{"label":null,"active":false}""",
        private val services: String = """{"apps":[]}""",
    ) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastUrl: String? = null
        var lastBody: String? = null
        fun <T> decode(serializer: KSerializer<T>): T = json.decodeFromString(serializer, lastBody!!)

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse =
            HttpResponse(200, "{}".toByteArray(), emptyMap())
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) {
            lastUrl = url; lastBody = json.encodeToString(serializer, body)
        }
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            lastUrl = url; lastBody = json.encodeToString(serializer, body)
            return json.decodeFromString(responseSerializer, """{"ok":true}""")
        }
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            val canned = if (url.endsWith("/api/front-page")) frontPage else services
            return json.decodeFromString(responseSerializer, canned)
        }
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    class FailingPostTransport(private val error: Throwable) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse = throw error
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) { throw error }
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = throw error
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = throw error
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) { throw error }
    }
}
