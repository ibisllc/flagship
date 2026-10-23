package com.flagshipserver.app.core

import com.flagshipserver.app.api.PendingRePair
import com.flagshipserver.app.api.PendingRePairSnapshot
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.viewmodels.TrustedDevicesViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RePairVetoTest {
    private fun vectors(): kotlinx.serialization.json.JsonObject {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, "packages/protocol/test-vectors/re-pair-veto/vectors.json")
            if (f.exists()) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        error("vectors.json not found")
    }

    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test fun canonicalBytesAndSignatureMatchTheSharedVectors() {
        val v = vectors()
        val verify = Ed25519Verify(unhex(v["adminPubHex"]!!.jsonPrimitive.content))
        for (c in v["cases"]!!.jsonArray) {
            val o = c.jsonObject
            val r = o["request"]!!.jsonObject
            val veto = RePairVeto(
                r["username"]!!.jsonPrimitive.content, r["newIrkPub"]!!.jsonPrimitive.content,
                r["initiatedAt"]!!.jsonPrimitive.long, r["completesAt"]!!.jsonPrimitive.long,
                r["vetoerPub"]!!.jsonPrimitive.content, r["issuedAt"]!!.jsonPrimitive.long,
            )
            val name = o["name"]!!.jsonPrimitive.content
            assertEquals(name, o["canonical"]!!.jsonPrimitive.content, String(veto.canonicalBytes(), Charsets.UTF_8))
            val ok = try { verify.verify(unhex(o["signatureHex"]!!.jsonPrimitive.content), veto.canonicalBytes()); true } catch (_: Exception) { false }
            assertEquals(name, o["valid"]!!.jsonPrimitive.content.toBoolean(), ok)
        }
    }

    @Test fun refusesSeparatorsAndNegativeTimes() {
        assertThrows(IllegalArgumentException::class.java) { RePairVeto("a|b", "aa", 1, 2, "bb", 3).canonicalBytes() }
        assertThrows(IllegalArgumentException::class.java) { RePairVeto("a", "aa", -1, 2, "bb", 3).canonicalBytes() }
    }

    private suspend fun vm(server: MockFlagshipServerClient, pending: PendingRePair?): TrustedDevicesViewModel {
        if (pending != null) server.pendingRePairByUser = mapOf("alice" to pending)
        val vm = TrustedDevicesViewModel(server = server, username = { "alice" }, now = { 1_700_000_000_000L })
        vm.loadPendingRePair()
        return vm
    }

    private val attempt = PendingRePair("ab12", "cd34", initiatedAt = 1_699_000_000_000L, completesAt = 1_699_259_200_000L)

    @Test fun signsTheExactAttemptWithTheAdminKeyAndPosts() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = vm(server, attempt)
        val seed = ByteArray(32) { 7 }
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        val pub = kp.publicKey.joinToString("") { "%02x".format(it) }
        val out = vm.vetoPendingRecovery(adminKey = { Ed25519Sign(seed) }, adminPubHex = { pub })
        assertEquals(TrustedDevicesViewModel.RecoveryVetoOutcome.Rejected, out)
        val sent = server.lastRePairVeto!!.second
        assertEquals("ab12", sent.request.newIrkPub)
        assertEquals(attempt.completesAt, sent.request.completesAt)
        assertEquals(pub, sent.request.vetoerPub)
        val veto = RePairVeto("alice", "ab12", attempt.initiatedAt, attempt.completesAt, pub, 1_700_000_000_000L)
        Ed25519Verify(kp.publicKey).verify(unhex(sent.signature), veto.canonicalBytes())
    }

    @Test fun nothingPendingDoesNotAskForTheKey() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = vm(server, null)
        val out = vm.vetoPendingRecovery(adminKey = { error("must not ask for the key") }, adminPubHex = { "aa" })
        assertEquals(TrustedDevicesViewModel.RecoveryVetoOutcome.AlreadyOver, out)
        assertNull(server.lastRePairVeto)
    }

    @Test fun aLostRaceIsAlreadyOverAndACancelledBiometricIsAFailure() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply { rePairVetoError = ScreensError.Http(409, "x") }
        val vm = vm(server, attempt)
        val seed = ByteArray(32) { 7 }
        assertEquals(TrustedDevicesViewModel.RecoveryVetoOutcome.AlreadyOver, vm.vetoPendingRecovery(adminKey = { Ed25519Sign(seed) }, adminPubHex = { "aa" }))
        val server2 = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm2 = vm(server2, attempt)
        val out = vm2.vetoPendingRecovery(adminKey = { throw IllegalStateException("cancelled") }, adminPubHex = { "aa" })
        assertTrue(out is TrustedDevicesViewModel.RecoveryVetoOutcome.Failed)
        assertNull(server2.lastRePairVeto)
        assertFalse(out == TrustedDevicesViewModel.RecoveryVetoOutcome.Rejected)
    }
}
