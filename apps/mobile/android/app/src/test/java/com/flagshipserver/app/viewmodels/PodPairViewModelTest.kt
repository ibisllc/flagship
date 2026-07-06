// Slice B — PodPairViewModel (single-pod manual pairing, iOS parity) +
// PodAutoPairCoordinator (background auto-pair on unlock). The idempotency guard
// mirrors iOS PodPairViewModelTests: a pod with a stored token is skipped, with
// NO biometric (the signer is never invoked) and NO POST.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AddPairedSessionRequest
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.core.AddPairedSessionOrder
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.PodInfo
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PodPairViewModelTest {
    private val server = "home.alice.flagship.services"

    private fun onlinePod(fqdn: String) =
        PodInfo(podId = PodInfo.podId(fqdn), name = fqdn, fqdn = fqdn, status = PodInfo.Status.ONLINE)

    // ── PodPairViewModel (single pod) ───────────────────────────────────────

    @Test fun pair_signsPostsAndPersistsPerPodToken() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val store = InMemorySessionStore()
        val transport = RecordingTransport("""{"ok":true}""")
        val vm = PodPairViewModel(
            store = store,
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
            label = "Pixel 9",
            now = { 1_700L },
            makeToken = { "00".repeat(32) },
        )
        vm.pair()
        assertTrue(vm.phase.value is PodPairPhase.Paired)
        assertEquals("https://$server/api/orders-from-user", transport.lastUrl)

        val body = transport.decode(AddPairedSessionRequest.serializer())
        assertEquals(server, body.request.serverId)
        assertEquals("00".repeat(32), body.request.token)
        Ed25519Verify(kp.publicKey).verify(
            HexUtil.decode(body.signature)!!,
            AddPairedSessionOrder.canonicalBytes(server, "00".repeat(32), "Pixel 9", 1_700L),
        )
        assertEquals("00".repeat(32), store.sessionToken(forPodId = PodInfo.podId(server)))
        assertEquals("00".repeat(32), store.sessionToken.value)     // active slot mirrored
    }

    @Test fun pair_idempotent_noBiometricNoPost_whenTokenExists() = runTest {
        val store = InMemorySessionStore().apply { setSessionToken("existing", forPodId = PodInfo.podId(server)) }
        val transport = RecordingTransport("""{"ok":true}""")
        var signerCalled = false
        val vm = PodPairViewModel(
            store = store,
            serverDomain = server,
            signer = { signerCalled = true; Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.pair()
        assertTrue(vm.phase.value is PodPairPhase.AlreadyPaired)
        assertFalse(signerCalled)
        assertNull(transport.lastUrl)
        assertEquals("existing", store.sessionToken(forPodId = PodInfo.podId(server)))
    }

    @Test fun pair_failure_doesNotPersist() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val store = InMemorySessionStore()
        val vm = PodPairViewModel(
            store = store,
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = ThrowingTransport(HttpException(403, "no"))),
        )
        vm.pair()
        assertTrue(vm.phase.value is PodPairPhase.Failed)
        assertNull(store.sessionToken(forPodId = PodInfo.podId(server)))
    }

    // ── PodAutoPairCoordinator (background, one biometric) ──────────────────

    @Test fun pairAll_pairsOnlyMissing_withOneBiometric() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val second = "work.alice.flagship.services"
        val store = InMemorySessionStore().apply { setSessionToken("have", forPodId = PodInfo.podId(server)) }
        var deriveCount = 0
        val coordinator = PodAutoPairCoordinator(
            store = store,
            client = LockPowerClient(transport = RecordingTransport("""{"ok":true}"""), podBaseUrl = { "https://$it" }),
            now = { 1_700L },
            makeToken = { "ab".repeat(32) },
        )
        val paired = coordinator.pairAll(listOf(onlinePod(server), onlinePod(second))) {
            deriveCount++; Ed25519Sign(kp.privateKey)
        }
        assertEquals(listOf(second), paired)              // only the un-paired one
        assertEquals(1, deriveCount)                      // ONE biometric for the batch
        assertEquals("have", store.sessionToken(forPodId = PodInfo.podId(server)))    // untouched
        assertEquals("ab".repeat(32), store.sessionToken(forPodId = PodInfo.podId(second)))
    }

    @Test fun pairAll_noPending_neverDerivesTheIrk() = runTest {
        // The idempotency guard mirroring iOS: all pods already have tokens ⇒ no
        // biometric prompt, no POST.
        val store = InMemorySessionStore().apply { setSessionToken("t", forPodId = PodInfo.podId(server)) }
        val transport = RecordingTransport("""{"ok":true}""")
        var deriveCount = 0
        val coordinator = PodAutoPairCoordinator(store = store, client = LockPowerClient(transport = transport))
        val paired = coordinator.pairAll(listOf(onlinePod(server))) {
            deriveCount++; Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        }
        assertTrue(paired.isEmpty())
        assertEquals(0, deriveCount)
        assertNull(transport.lastUrl)
    }

    @Test fun pairAll_perPodFailureIsSilent_othersProceed() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val bad = "down.alice.flagship.services"
        val good = "up.alice.flagship.services"
        val store = InMemorySessionStore()
        // Transport that fails ONLY for the `bad` box's URL.
        val transport = object : JsonHttpTransport {
            override val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
            override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>) = error("unused")
            override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) { error("unused") }
            override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
                if (url.contains(bad)) throw HttpException(503, "down")
                return json.decodeFromString(responseSerializer, """{"ok":true}""")
            }
            override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
            override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        }
        val coordinator = PodAutoPairCoordinator(
            store = store,
            client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
            now = { 1L },
            makeToken = { "cd".repeat(32) },
        )
        val paired = coordinator.pairAll(listOf(onlinePod(bad), onlinePod(good))) { Ed25519Sign(kp.privateKey) }
        assertEquals(listOf(good), paired)
        assertNull(store.sessionToken(forPodId = PodInfo.podId(bad)))                 // failure not persisted
        assertEquals("cd".repeat(32), store.sessionToken(forPodId = PodInfo.podId(good)))
    }

    // ── transports (mirror AddControlDeviceViewModelTest) ───────────────────

    class RecordingTransport(private val canned: String) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastUrl: String? = null
        var lastBody: String? = null
        fun <T> decode(serializer: KSerializer<T>): T = json.decodeFromString(serializer, lastBody!!)

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            lastUrl = url; return HttpResponse(200, canned.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) {
            lastUrl = url; lastBody = json.encodeToString(serializer, body)
        }
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            lastUrl = url; lastBody = json.encodeToString(serializer, body)
            return json.decodeFromString(responseSerializer, canned)
        }
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    class ThrowingTransport(private val error: Throwable) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse = throw error
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) { throw error }
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = throw error
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = throw error
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) { throw error }
    }
}
