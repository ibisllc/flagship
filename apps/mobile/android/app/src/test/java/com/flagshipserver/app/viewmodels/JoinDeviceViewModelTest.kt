// Focused unit tests for JoinDeviceViewModel — the INCOMING side of
// cross-device QR pairing. DevicePairingFlowTest exercises the full
// admin↔incoming relay path end-to-end; this file pins the VM contract
// in isolation: a happy-path admit transitions through Connecting →
// VerifySas → Joining → Joined, and a 4xx admit response from .com
// surfaces as Failed without joining the account.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeviceAdmit
import com.flagshipserver.app.core.DeviceAdmitClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.MockDevicePairingRelay
import com.flagshipserver.app.core.PairingBundle
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class JoinDeviceViewModelTest {

    private val account = "techstars"
    private lateinit var ctx: Context

    /** Materials carried across the staged handshake. */
    private data class Stage(
        val server: MockFlagshipServerClient,
        val relay: MockDevicePairingRelay,
        val app: AppState,
        val adminUmk: ByteArray,
        val adminIrkSeed: ByteArray,
        val adminEphemeral: QrSession,
        val vm: JoinDeviceViewModel,
    )

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("join-vm-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After fun tearDown() {
        Keystore.wipeAllProfiles()
    }

    /** Stand up an admin identity on the Mock + drive the relay forward
     *  to the point where the incoming VM is in VerifySas. The incoming
     *  device's fresh Ed25519 pubkey is captured from the buffered hello
     *  so the test can mint a binding admit. */
    private suspend fun runUpToVerifySas(): Stage {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val relay = MockDevicePairingRelay()
        val app = AppState()

        // Seed the admin's account on .com so getUsernameRecord resolves
        // its IRK pub (the verifier the VM uses).
        Keystore.setActiveProfile("$account-admin")
        val adminUmk = Keystore.loadOrCreateUmkSeed()
        Keystore.deriveIRK("admin")
        val adminIrkSeed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
        val adminIrkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(adminIrkSeed).publicKey
        server.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(
                    username = account,
                    irkPub = HexUtil.encode(adminIrkPub),
                    issuedAt = 1L,
                ),
                signature = "00".repeat(64),
            ),
        )

        // Admin's ephemeral X25519 session — drives the SAS + AEAD key
        // the VM derives against on the incoming side.
        val adminEphemeral = QrSession.fresh()
        val joinLink = JoinLink(sid = "sid-test", adminPubKey = adminEphemeral.phonePubKey)

        // Re-point the Keystore at a fresh profile for the INCOMING side
        // (mirrors a real device that doesn't yet hold this account).
        Keystore.setActiveProfile("incoming-tmp")

        val vm = JoinDeviceViewModel(
            joinLink = joinLink,
            relay = relay.incoming,
            server = server,
            app = app,
            providerToken = "fcm-tok-X",
            now = { 10_000L },
        )
        vm.start()
        assertTrue(vm.phase.first() is JoinDevicePhase.VerifySas)

        // The admin completes its half of the ECDH symmetric pair — both
        // sides now hold the same kEnc + the same matchCode.
        val helloPub = relay.admin.awaitPeerHello("sid-test")
        assertEquals("hello is x25519 pub || device pub", 64, helloPub.size)
        adminEphemeral.pair(helloPub.copyOfRange(0, 32))

        return Stage(server, relay, app, adminUmk, adminIrkSeed, adminEphemeral, vm)
    }

    @Test fun happyPath_admitsAndSurfacesQuarantine() = runTest {
        val s = runUpToVerifySas()
        val helloPub = s.relay.admin.awaitPeerHello("sid-test")
        val devicePubHex = HexUtil.encode(helloPub.copyOfRange(32, 64))

        // Admin signs the admit + seals the bundle.
        val admit = DeviceAdmit(account, devicePubHex.lowercase(), 10_000L)
        val adminSigner = Ed25519Sign(s.adminIrkSeed)
        val sealed = s.adminEphemeral.seal(
            PairingBundle(
                umkSeedHex = HexUtil.encode(s.adminUmk),
                admit = admit,
                admitSig = HexUtil.encode(DeviceAdmitClaim.sign(admit, adminSigner)),
            ).toJsonBytes(),
        )
        s.relay.admin.deliver(sealed.ciphertextB64u, sealed.nonceB64u)

        // Drive the join.
        s.vm.verifyAndJoin()
        val phase = s.vm.phase.first()
        assertTrue("happy path must JOIN: $phase", phase is JoinDevicePhase.Joined)
        val quarantineUntil = (phase as JoinDevicePhase.Joined).quarantineUntil
        assertNotNull("quarantine surfaces", quarantineUntil)
        assertTrue(quarantineUntil!! > 10_000L)

        // .com saw the admit, the new profile is active.
        assertNotNull("admit POSTed to .com", s.server.lastDeviceAdmit)
        assertEquals(account, s.server.lastDeviceAdmit!!.first)
        assertEquals(account, s.app.currentUser.first())
        assertTrue("account opened on success", s.app.isPaired.first())
    }

    @Test fun serverRejectsAdmit_failsWithoutJoining() = runTest {
        val s = runUpToVerifySas()
        // Server flips to 401-on-admit before the VM POSTs. The Mock
        // throws HttpException(401, "invalid admit proof") which the VM
        // catches and surfaces via humanize() as a Failed phase.
        s.server.admitShouldRejectProof = true

        val helloPub = s.relay.admin.awaitPeerHello("sid-test")
        val devicePubHex = HexUtil.encode(helloPub.copyOfRange(32, 64))
        val admit = DeviceAdmit(account, devicePubHex.lowercase(), 10_000L)
        val adminSigner = Ed25519Sign(s.adminIrkSeed)
        val sealed = s.adminEphemeral.seal(
            PairingBundle(
                umkSeedHex = HexUtil.encode(s.adminUmk),
                admit = admit,
                admitSig = HexUtil.encode(DeviceAdmitClaim.sign(admit, adminSigner)),
            ).toJsonBytes(),
        )
        s.relay.admin.deliver(sealed.ciphertextB64u, sealed.nonceB64u)

        s.vm.verifyAndJoin()
        val phase = s.vm.phase.first()
        assertTrue("a 4xx admit must NOT join: $phase", phase is JoinDevicePhase.Failed)
        val msg = (phase as JoinDevicePhase.Failed).message
        // humanize() rewrites 401 / invalid-admit into a user-readable
        // "the account rejected this invite" copy. Pin the user-facing
        // wording so a regression on humanize() trips this test.
        assertTrue(
            "humanized 401 must point at a fresh code: $msg",
            msg.contains("rejected", ignoreCase = true) ||
                msg.contains("fresh code", ignoreCase = true),
        )
        assertFalse("a rejected admit must not open the account", s.app.isPaired.first())
    }

    @Test fun admitBoundToWrongDevice_failsClosed() = runTest {
        val s = runUpToVerifySas()
        // Admin builds an admit binding a DIFFERENT device pubkey — i.e.
        // a captured admit re-aimed at this device. The VM must reject
        // it BEFORE calling .com (no network in the failure branch).
        val wrongDevicePub = "ab".repeat(32)
        val admit = DeviceAdmit(account, wrongDevicePub, 10_000L)
        val adminSigner = Ed25519Sign(s.adminIrkSeed)
        val sealed = s.adminEphemeral.seal(
            PairingBundle(
                umkSeedHex = HexUtil.encode(s.adminUmk),
                admit = admit,
                admitSig = HexUtil.encode(DeviceAdmitClaim.sign(admit, adminSigner)),
            ).toJsonBytes(),
        )
        s.relay.admin.deliver(sealed.ciphertextB64u, sealed.nonceB64u)

        s.vm.verifyAndJoin()
        val phase = s.vm.phase.first()
        assertTrue("wrong-device admit must fail closed: $phase", phase is JoinDevicePhase.Failed)
        assertNull("a re-aimed admit must NEVER reach .com", s.server.lastDeviceAdmit)
        assertFalse("a rejected admit must not open the account", s.app.isPaired.first())
    }
}
