// AddControlDeviceViewModel — signs an `add-paired-session` order with the
// OWNER IRK and POSTs it to the box's /api/orders-from-user. The recorded
// signature must verify against the EXACT canonical bytes the daemon
// recomputes; the bytes are pinned to the cross-platform vector shared with
// iOS (AddPairedSessionCanonicalTests) + TS (addPairedSessionVector.test.ts).

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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AddControlDeviceViewModelTest {

    private val server = "home.alice.flagship.services"

    @Test fun canonicalBytes_matchPinnedCrossPlatformVector() {
        // Identical to the Swift pin in AddPairedSessionCanonicalTests + the TS
        // vector — any drift breaks live pairing on every surface.
        val bytes = AddPairedSessionOrder.canonicalBytes(
            serverId = server,
            token = "deadbeef",
            issuedAt = 1700,
        )
        assertEquals(
            "flagship/order/add-paired-session/v2|home.alice.flagship.services|deadbeef|1700",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun freshToken_is32BytesHex() {
        val t = AddPairedSessionOrder.freshToken()
        assertEquals(64, t.length)
        assertNotNull(HexUtil.decode(t))
        assertTrue(t != AddPairedSessionOrder.freshToken())
    }

    @Test fun resolveServerDomain_acceptsBareFqdnHttpsUrlAndPath() {
        val vm = AddControlDeviceViewModel(store = InMemorySessionStore())
        assertEquals(server, vm.resolveServerDomain(server))
        assertEquals(server, vm.resolveServerDomain("https://$server"))
        assertEquals(server, vm.resolveServerDomain("https://$server/settings?x=1"))
        assertEquals(server, vm.resolveServerDomain(" $server "))
        assertNull(vm.resolveServerDomain(""))
        assertNull(vm.resolveServerDomain("not a host"))
    }

    @Test fun send_signsAndPosts_recordingExactWireValues_andPersists() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val store = InMemorySessionStore()
        val transport = RecordingTransport("""{"ok":true}""")
        val vm = AddControlDeviceViewModel(
            store = store,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
            now = { 1_700_000_000_000L },
            makeToken = { "00".repeat(32) },
        )
        vm.send(server)
        assertTrue(vm.phase.value is AddControlDevicePhase.Paired)
        assertEquals("https://$server/api/orders-from-user", transport.lastUrl)

        val body = transport.decode(AddPairedSessionRequest.serializer())
        assertEquals("add-paired-session", body.request.type)
        assertEquals(server, body.request.serverId)
        assertEquals("00".repeat(32), body.request.token)
        assertEquals(1_700_000_000_000L, body.request.issuedAt)

        val sig = HexUtil.decode(body.signature)
        assertNotNull(sig)
        Ed25519Verify(kp.publicKey).verify(
            sig!!,
            AddPairedSessionOrder.canonicalBytes(server, "00".repeat(32), 1_700_000_000_000L),
        )

        // Token persisted ONLY after the 200 — both the active slot AND the
        // per-pod store (Fix B), keyed by this box's pod id.
        assertEquals("00".repeat(32), store.sessionToken.value)
        assertEquals("https://$server", store.podBaseUrl.value)
        assertEquals("00".repeat(32), store.sessionToken(forPodId = PodInfo.podId(server)))
    }

    @Test fun send_idempotent_whenTokenAlreadyPresent() = runTest {
        // MULTI-POD (Fix B): idempotency now keys on THIS pod's per-pod token, so
        // seed it under the pod id (not the legacy single slot — that no longer
        // implies "paired with this box", which is the whole point of Fix B).
        val store = InMemorySessionStore().apply {
            setSessionToken("existing", forPodId = PodInfo.podId(server))
        }
        val transport = RecordingTransport("""{"ok":true}""")
        var signerCalled = false
        val vm = AddControlDeviceViewModel(
            store = store,
            signer = { signerCalled = true; Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.send(server)
        assertTrue(vm.phase.value is AddControlDevicePhase.AlreadyPaired)
        assertEquals(null, transport.lastUrl) // never posted
        assertEquals(false, signerCalled) // never prompted the biometric
        assertEquals("existing", store.sessionToken(forPodId = PodInfo.podId(server)))
    }

    @Test fun send_pairingSecondBox_doesNotOverwriteFirstBoxToken() = runTest {
        // A 1st box is paired (its token under its own pod id). Pairing a DIFFERENT
        // box must NOT be blocked by the 1st's token, and must write the new token
        // under the NEW pod id while leaving the 1st box's token intact.
        val secondBox = "work.alice.flagship.services"
        val firstPodId = PodInfo.podId(server)
        val secondPodId = PodInfo.podId(secondBox)
        val store = InMemorySessionStore().apply { setSessionToken("first-token", forPodId = firstPodId) }
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val vm = AddControlDeviceViewModel(
            store = store,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = RecordingTransport("""{"ok":true}"""), podBaseUrl = { "https://$it" }),
            now = { 1_700_000_000_000L },
            makeToken = { "ab".repeat(16) },
        )
        vm.send(secondBox)
        assertTrue(vm.phase.value is AddControlDevicePhase.Paired)
        assertEquals("first-token", store.sessionToken(forPodId = firstPodId))    // intact
        assertEquals("ab".repeat(16), store.sessionToken(forPodId = secondPodId)) // new
    }

    @Test fun send_unresolvableQr_failsWithoutSigning() = runTest {
        val store = InMemorySessionStore()
        val transport = RecordingTransport("""{"ok":true}""")
        var signerCalled = false
        val vm = AddControlDeviceViewModel(
            store = store,
            signer = { signerCalled = true; Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.send("not a host")
        assertTrue(vm.phase.value is AddControlDevicePhase.Failed)
        assertEquals(null, transport.lastUrl)
        assertEquals(false, signerCalled)
    }

    @Test fun send_box403_failsAndDoesNotPersist() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val store = InMemorySessionStore()
        val transport = ThrowingTransport(HttpException(403, "rejected"))
        val vm = AddControlDeviceViewModel(
            store = store,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.send(server)
        val p = vm.phase.value as AddControlDevicePhase.Failed
        assertTrue(p.message.lowercase().contains("rejected"))
        assertNull(store.sessionToken.value) // a token the daemon never stored
    }

    // ---- transports (mirror PowerOffViewModelTest) ----

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
