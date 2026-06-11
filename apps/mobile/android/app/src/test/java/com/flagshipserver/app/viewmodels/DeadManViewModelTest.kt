// DeadManViewModel — IRK-signed SetDeadManPolicy + DeadManAffirmation. The
// recorded signatures must verify against the canonical bytes; pins the wire
// shape (enabled/window/grace/lockout in the policy; hex nonce in the affirm)
// and the lease-expiry passthrough the reminder scheduler rides.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.DeadManAffirmRequest
import com.flagshipserver.app.api.DeadManPolicyRequest
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.core.DeadManAffirmation
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.SetDeadManPolicy
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeadManViewModelTest {

    private val server = "home.alice.flagship.services"

    private fun vm(
        transport: PowerOffViewModelTest.RecordingTransport,
        kp: Ed25519Sign.KeyPair,
        nonce: ByteArray = ByteArray(16) { 0x11 },
        now: Long = 1000L,
    ) = DeadManViewModel(
        serverDomain = server,
        username = { "alice" },
        signer = { Ed25519Sign(kp.privateKey) },
        client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
        now = { now },
        nonceGen = { nonce },
    )

    @Test fun setPolicy_enable_signsCanonicalBytes_andHitsPolicyRoute() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = PowerOffViewModelTest.RecordingTransport("""{"ok":true,"enabled":true}""")
        val m = vm(transport, kp)
        m.graceMs = 6L * 3600_000
        val ok = m.setPolicy(enabled = true, window = DeadManWindow.H24, lockoutMode = PowerMode.OFF)
        assertTrue(ok)
        assertEquals("https://$server/api/deadman/policy", transport.lastUrl)

        val body = transport.decode(DeadManPolicyRequest.serializer())
        assertEquals(server, body.request.serverId)
        assertTrue(body.request.enabled)
        assertEquals(24L * 3600_000, body.request.windowMs)
        assertEquals(6L * 3600_000, body.request.graceMs)
        assertEquals("off", body.request.lockoutMode)
        assertEquals(1000L, body.request.issuedAt)

        val sig = HexUtil.decode(body.signature)!!
        Ed25519Verify(kp.publicKey).verify(
            sig,
            SetDeadManPolicy.canonicalBytes(server, true, 24L * 3600_000, 6L * 3600_000, PowerMode.OFF, 1000L),
        )
    }

    @Test fun setPolicy_tighten_usesShortWindow() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = PowerOffViewModelTest.RecordingTransport("""{"ok":true,"enabled":true}""")
        vm(transport, kp).setPolicy(true, DeadManWindow.TIGHTEN, PowerMode.RESTART)
        val body = transport.decode(DeadManPolicyRequest.serializer())
        assertEquals(DeadManWindow.M5.windowMs, body.request.windowMs)
        assertEquals("restart", body.request.lockoutMode)
    }

    @Test fun affirm_freshNonceHex_signsCanonicalBytes_andReturnsLeaseExpiry() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val nonce = ByteArray(16) { 0xAB.toByte() }
        val transport = PowerOffViewModelTest.RecordingTransport("""{"ok":true,"leaseExpiry":987654}""")
        val m = vm(transport, kp, nonce = nonce, now = 2000L)
        val exp = m.affirm()
        assertEquals(987654L, exp)
        assertEquals("https://$server/api/deadman/affirm", transport.lastUrl)

        val body = transport.decode(DeadManAffirmRequest.serializer())
        assertEquals(server, body.request.serverId)
        assertEquals("ab".repeat(16), body.request.nonce)
        assertEquals(2000L, body.request.issuedAt)
        // 16+ byte nonce requirement.
        assertTrue(HexUtil.decode(body.request.nonce)!!.size >= 16)

        val sig = HexUtil.decode(body.signature)!!
        Ed25519Verify(kp.publicKey).verify(sig, DeadManAffirmation.canonicalBytes(server, nonce, 2000L))
    }

    @Test fun noUsername_failsPolicy_withoutPosting() = runTest {
        val transport = PowerOffViewModelTest.RecordingTransport("""{"ok":true}""")
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val m = DeadManViewModel(
            serverDomain = server,
            username = { null },
            signer = { Ed25519Sign(kp.privateKey) },
            client = LockPowerClient(transport = transport),
        )
        assertFalse(m.setPolicy(true, DeadManWindow.H24, PowerMode.OFF))
        assertTrue(m.phase.value is DeadManPhase.Failed)
        assertEquals(null, transport.lastUrl)
    }

    @Test fun windowPreset_msValues() {
        assertEquals(24L * 3600_000, DeadManWindow.H24.windowMs)
        assertEquals(8L * 3600_000, DeadManWindow.H8.windowMs)
        assertEquals(1L * 3600_000, DeadManWindow.H1.windowMs)
        assertEquals(15L * 60_000, DeadManWindow.M15.windowMs)
        assertEquals(5L * 60_000, DeadManWindow.M5.windowMs)
        assertEquals(DeadManWindow.H24, DeadManWindow.DEFAULT)
        assertEquals(DeadManWindow.M5, DeadManWindow.TIGHTEN)
        assertNotNull(DeadManWindow.fromMs(24L * 3600_000))
    }
}
