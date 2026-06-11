// PowerOffViewModel — signs a `power-off` order with the OWNER IRK, POSTs it
// to the box's /api/power, and the recorded signature must verify against the
// canonical bytes the daemon would recompute. Pins the wire shape + endpoint +
// the phase transitions.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.api.PowerOffOrderRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.PowerOffOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PowerOffViewModelTest {

    private val server = "home.harry.flagship.services"

    @Test fun off_signsAndPosts_recordingExactWireValues() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = RecordingTransport("""{"ok":true}""")
        val vm = PowerOffViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
            now = { 1_700_000_000_000L },
        )
        vm.run(PowerMode.OFF)
        assertTrue(vm.phase.value is PowerOffPhase.Completed)
        assertEquals("https://$server/api/power", transport.lastUrl)

        val body = transport.decode(PowerOffOrderRequest.serializer())
        assertEquals("power-off", body.request.type)
        assertEquals(server, body.request.serverId)
        assertEquals("off", body.request.mode)
        assertEquals(1_700_000_000_000L, body.request.issuedAt)

        val sig = HexUtil.decode(body.signature)
        assertNotNull(sig)
        // Verifies against the canonical bytes the daemon recomputes.
        Ed25519Verify(kp.publicKey).verify(
            sig!!,
            PowerOffOrder.canonicalBytes(server, PowerMode.OFF, 1_700_000_000_000L),
        )
    }

    @Test fun restart_landsRestartOnTheWire() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = RecordingTransport("""{"ok":true}""")
        val vm = PowerOffViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport),
            now = { 7L },
        )
        vm.run(PowerMode.RESTART)
        val phase = vm.phase.value
        assertTrue(phase is PowerOffPhase.Completed && phase.mode == PowerMode.RESTART)
        assertEquals("restart", transport.decode(PowerOffOrderRequest.serializer()).request.mode)
    }

    @Test fun signerThrows_failsWithoutPosting() = runTest {
        // E.g. the user cancels the biometric prompt inside deriveIRK.
        val transport = RecordingTransport("""{"ok":true}""")
        val vm = PowerOffViewModel(
            serverDomain = server,
            signer = { throw IllegalStateException("biometric cancelled") },
            client = LockPowerClient(transport = transport),
        )
        vm.run(PowerMode.OFF)
        assertTrue(vm.phase.value is PowerOffPhase.Failed)
        assertEquals(null, transport.lastUrl) // never posted
    }

    @Test fun signerReceivesLockReasonForBiometricPrompt() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = RecordingTransport("""{"ok":true}""")
        var reason: String? = null
        val vm = PowerOffViewModel(
            serverDomain = server,
            signer = { r -> reason = r; Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.run(PowerMode.OFF)
        assertEquals("Lock and turn off $server", reason)
    }

    @Test fun http403_mapsToFriendlyMessage() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = ThrowingTransport(HttpException(403, "stale"))
        val vm = PowerOffViewModel(
            serverDomain = server,
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport),
        )
        vm.run(PowerMode.OFF)
        val p = vm.phase.value as PowerOffPhase.Failed
        assertTrue(p.message.lowercase().contains("rejected"))
    }

    // ---- transports ----

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
