package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.DebugAccessView
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugAccessViewModelTest {
    private val server = "home.bright-maple.flagship.services"
    private val key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3"
    private val seed = ByteArray(32) { 0x5a }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val t0 = 1_760_000_000_000L

    private fun vm(
        client: MockScreensClient,
        admin: Boolean = true,
        confirm: suspend (String) -> Unit = {},
        revokeSigner: suspend (String) -> Ed25519Sign = { Ed25519Sign(seed) },
    ) = DebugAccessViewModel(
        serverDomain = server,
        client = client,
        initial = DebugAccessView(on = false),
        isAdminDevice = { admin },
        confirmGrant = confirm,
        adminKey = { Ed25519Sign(seed) },
        revokeSigner = revokeSigner,
        now = { t0 },
    )

    @Test fun everyGrantAsksForItsOwnBiometricEvenInAnUnlockedSession() = runTest {
        var prompts = 0
        val auth = BiometricAuthority.forTest { _, _ -> prompts++ }
        auth.markFresh()
        val client = mock()
        val m = vm(client, confirm = { auth.confirmNow("Authorize Flagship", it) }, revokeSigner = {
            auth.ensureFresh("Authorize Flagship", it)
            Ed25519Sign(seed)
        })
        m.turnOn(key, DebugAccess.Duration.DAY)
        assertEquals(1, prompts)
        m.turnOn(key, DebugAccess.Duration.WEEK)
        assertEquals(2, prompts)
        m.turnOff()
        assertEquals("turning off rides the unlocked session", 2, prompts)
        assertEquals(3, client.debugAccessBodies.size)
    }

    @Test fun noBoundPromptMeansNoGrant() = runTest {
        BiometricAuthority.set(null)
        val client = mock()
        val m = DebugAccessViewModel(server, client, null, isAdminDevice = { true }, adminKey = { Ed25519Sign(seed) }, now = { t0 })
        assertFalse(m.turnOn(key, DebugAccess.Duration.DAY))
        assertEquals("Open Flagship to confirm this.", m.state.value.error)
        assertTrue(client.debugAccessBodies.isEmpty())
    }

    private fun mock() = MockScreensClient(simulatedLatencyMs = 0)

    @Test fun turnsOnWithASignedV2GrantForThePastedKey() = runTest {
        val client = mock()
        val m = vm(client)
        assertTrue(m.turnOn("$key harry@laptop", DebugAccess.Duration.HOUR))
        val body = Json.parseToJsonElement(client.debugAccessBodies.single()).jsonObject
        val g = body["grant"]!!.jsonObject
        val grant = DebugAccess.Grant(
            g["serverDomain"]!!.jsonPrimitive.content,
            g["sshPublicKey"]!!.jsonPrimitive.content,
            g["issuedAt"]!!.jsonPrimitive.long,
            g["expiresAt"]!!.jsonPrimitive.long,
        )
        assertEquals(DebugAccess.Grant(server, key, t0, t0 + DebugAccess.HOUR_MS), grant)
        assertTrue(DebugAccess.verify(grant, body["signatureHex"]!!.jsonPrimitive.content, pub))
        assertTrue(m.state.value.view!!.on)
        assertEquals(DebugAccess.fingerprint(key), m.state.value.view!!.keyFingerprint)
        assertTrue(m.isOn(t0 + 1))
        assertEquals("Debug access is on.", m.state.value.notice)
    }

    @Test fun renewsWhenAlreadyOn() = runTest {
        val client = mock()
        val m = vm(client)
        m.turnOn(key, DebugAccess.Duration.DAY)
        assertTrue(m.turnOn(key, DebugAccess.Duration.WEEK))
        assertEquals("Debug access renewed.", m.state.value.notice)
        assertEquals(t0 + DebugAccess.MAX_MS, m.state.value.view!!.expiresAt)
    }

    @Test fun turnsOffWithASignedRevoke() = runTest {
        val client = mock()
        val m = vm(client)
        m.turnOn(key, DebugAccess.Duration.DAY)
        assertTrue(m.turnOff())
        val body = Json.parseToJsonElement(client.debugAccessBodies.last()).jsonObject
        val r = body["revoke"]!!.jsonObject
        val revoke = DebugAccess.Revoke(r["serverDomain"]!!.jsonPrimitive.content, r["issuedAt"]!!.jsonPrimitive.long)
        assertEquals(DebugAccess.Revoke(server, t0), revoke)
        assertTrue(DebugAccess.verifyRevoke(revoke, body["signatureHex"]!!.jsonPrimitive.content, pub))
        assertFalse(m.state.value.view!!.on)
        assertFalse(m.isOn())
    }

    @Test fun aNonAdminDeviceCantChangeIt() = runTest {
        val client = mock()
        val m = vm(client, admin = false)
        assertFalse(m.canChange)
        assertFalse(m.turnOn(key, DebugAccess.Duration.DAY))
        assertEquals(DebugAccess.ADMIN_ONLY, m.state.value.error)
        assertFalse(m.turnOff())
        assertTrue(client.debugAccessBodies.isEmpty())
    }

    @Test fun refusesAMissingOrBadKeyBeforeSigning() = runTest {
        var asked = false
        val m = vm(mock(), confirm = { asked = true })
        assertFalse(m.turnOn(" ", DebugAccess.Duration.DAY))
        assertEquals("Debug access needs an SSH public key.", m.state.value.error)
        assertFalse(m.turnOn("not a key", DebugAccess.Duration.DAY))
        assertEquals("That isn't an SSH public key this server can use.", m.state.value.error)
        assertFalse(asked)
    }

    @Test fun showsTheBoxsOwnSentence() = runTest {
        val client = object : com.flagshipserver.app.api.ScreensClient by mock() {
            override suspend fun debugAccessGrant(bodyJson: String) =
                throw ScreensError.Http(403, """{"error":"This server takes debug access only from an admin device of this account."}""")
        }
        val m = DebugAccessViewModel(server, client, null, isAdminDevice = { true }, confirmGrant = {}, adminKey = { Ed25519Sign(seed) }, now = { t0 })
        assertFalse(m.turnOn(key, DebugAccess.Duration.DAY))
        assertEquals("This server takes debug access only from an admin device of this account.", m.state.value.error)
        assertNull(m.state.value.view)
    }

    @Test fun aCancelledPromptChangesNothing() = runTest {
        val client = mock()
        val m = vm(client, confirm = { throw BiometricCancelled() })
        assertFalse(m.turnOn(key, DebugAccess.Duration.DAY))
        assertEquals("Debug access not changed: you didn't confirm it.", m.state.value.error)
        assertTrue(client.debugAccessBodies.isEmpty())
    }

    @Test fun serverDetailCarriesTheState() = runTest {
        val client = mock()
        vm(client).turnOn(key, DebugAccess.Duration.DAY)
        val detail = client.serverDetail()
        assertTrue(detail.debugAccess!!.on)
        assertEquals(t0 + DebugAccess.DEFAULT_MS, detail.debugAccess!!.expiresAt)
    }
}
