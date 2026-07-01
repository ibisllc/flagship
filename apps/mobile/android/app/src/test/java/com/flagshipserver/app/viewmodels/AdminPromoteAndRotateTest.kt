// Slice D Phase 3 (docs/device-admin-tier-spec.md §4.2/§5) — the Android half:
//   1. PROMOTE-A-DEVICE (D-4, assurance-gated): the admin's synchronous SAS
//      ceremony seals the admin master root into the bundle ONLY when promote is
//      ON; the incoming device unwraps it → becomes a bare-root admin. OFF (the
//      default) ⇒ no admin root travels + the joiner stays non-admin.
//   2. ROTATE-ADMIN-ROOT (§5): OLD signs OLD→NEW with byte-identical canonical
//      bytes; the client POSTs the proof + re-stores the NEW root.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AdminRootRotationRequest
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AdminRootRotation
import com.flagshipserver.app.core.AdminRootRotationClaim
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeviceAdmit
import com.flagshipserver.app.core.DeviceAdmitClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.MockDevicePairingRelay
import com.flagshipserver.app.core.PairingBundle
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@OptIn(ExperimentalCoroutinesApi::class)
class AdminPromoteAndRotateTest {

    private val account = "acme"
    private lateinit var ctx: Context
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        ctx = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("admin-promote-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After
    fun tearDown() {
        Keystore.wipeAllProfiles()
        Dispatchers.resetMain()
    }

    private suspend fun seedAdmin(server: MockFlagshipServerClient): ByteArray {
        Keystore.setActiveProfile("$account-admin")
        val umk = Keystore.loadOrCreateUmkSeed()
        Keystore.deriveIRK("admin")
        val seed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
        val irkPubHex = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        server.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(username = account, irkPub = irkPubHex, issuedAt = 1L),
                signature = "00".repeat(64),
            ),
        )
        return umk
    }

    /** Drive the admin↔incoming handshake to completion. [promote] toggles the
     *  promote-to-admin choice; [adminRootSeedHex] is the admin master root the
     *  seal carries when promote is on. */
    private suspend fun TestScope.runJoin(
        server: MockFlagshipServerClient,
        adminUmk: ByteArray,
        promote: Boolean,
        adminRootSeed: ByteArray?,
    ): JoinDevicePhase {
        val relay = MockDevicePairingRelay()
        val incomingApp = AppState()

        Keystore.setActiveProfile("$account-admin")
        val adminVm = AddDeviceViewModel(
            relay = relay.admin,
            username = account,
            umkSeed = { adminUmk },
            signAdmit = { admit ->
                Keystore.setActiveProfile("$account-admin")
                DeviceAdmitClaim.sign(admit, Keystore.deriveIRK("vouch"))
            },
            sessionIdGen = { "sid-promote" },
            now = { 1_000L },
            canPromote = { adminRootSeed != null },
            adminRootSeed = { adminRootSeed },
        )
        adminVm.setPromoteToAdmin(promote)

        Keystore.setActiveProfile("personal")
        val incomingVm = JoinDeviceViewModel(
            joinLink = JoinLink.parse(adminVm.joinUrl)!!,
            relay = relay.incoming,
            server = server,
            app = incomingApp,
            providerToken = "fcm-token",
            now = { 2_000L },
        )

        incomingVm.start()
        adminVm.start()
        advanceUntilIdle()
        adminVm.confirmAndSeal()
        assertEquals(AddDevicePhase.Delivered, adminVm.phase.first())
        incomingVm.verifyAndJoin()
        return incomingVm.phase.first()
    }

    @Test fun promoteOn_incomingBecomesBareRootAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val adminUmk = seedAdmin(server)

        // The admin device holds a real admin master root.
        Keystore.setActiveProfile("$account-admin")
        Keystore.generateAdminRoot()
        val adminRootSeed = Keystore.adminRootSeed()!!
        val expectedPub = Keystore.adminRootPubHex()!!

        val joined = runJoin(server, adminUmk, promote = true, adminRootSeed = adminRootSeed)
        assertTrue("must join: $joined", joined is JoinDevicePhase.Joined)

        // The joined (account) profile now holds the SAME admin root ⇒ admin.
        Keystore.setActiveProfile(account)
        assertTrue("promoted device must hold the admin root", Keystore.hasAdminRoot())
        assertEquals(expectedPub, Keystore.adminRootPubHex())
        assertArrayEquals(adminRootSeed, Keystore.adminRootSeed())
    }

    @Test fun promoteOff_incomingStaysNonAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val adminUmk = seedAdmin(server)

        Keystore.setActiveProfile("$account-admin")
        Keystore.generateAdminRoot()
        val adminRootSeed = Keystore.adminRootSeed()!!

        // Promote OFF (default) even though the admin CAN offer it.
        val joined = runJoin(server, adminUmk, promote = false, adminRootSeed = adminRootSeed)
        assertTrue("must join: $joined", joined is JoinDevicePhase.Joined)

        Keystore.setActiveProfile(account)
        assertFalse("a non-promoted join must NOT hold the admin root", Keystore.hasAdminRoot())
        assertNull(Keystore.adminRootSeed())
    }

    @Test fun bundle_carriesWrappedAdminRoot_onlyWhenPresent() {
        val admit = DeviceAdmit(account, "aa".repeat(32), 1L)
        val withRoot = PairingBundle(
            umkSeedHex = "11".repeat(32),
            admit = admit,
            admitSig = "22".repeat(64),
            wrappedAdminRoot = "33".repeat(32),
        )
        val roundTripped = PairingBundle.fromJsonBytes(withRoot.toJsonBytes())
        assertEquals("33".repeat(32), roundTripped.wrappedAdminRoot)

        val withoutRoot = PairingBundle(
            umkSeedHex = "11".repeat(32),
            admit = admit,
            admitSig = "22".repeat(64),
        )
        assertNull("default bundle carries no admin root", withoutRoot.wrappedAdminRoot)
        assertNull(PairingBundle.fromJsonBytes(withoutRoot.toJsonBytes()).wrappedAdminRoot)
    }

    @Test fun rotation_canonicalBytes_and_signOldToNew() {
        val old = Ed25519Sign.KeyPair.newKeyPair()
        val new = Ed25519Sign.KeyPair.newKeyPair()
        val oldPub = HexUtil.encode(old.publicKey)
        val newPub = HexUtil.encode(new.publicKey)
        val rotation = AdminRootRotation(account, oldPub, newPub, 1_735_689_600_000L)

        // Byte-identical to the TS spine's `flagship/admin-root-rotation/v1|...`.
        val expected =
            "flagship/admin-root-rotation/v1|$account|$oldPub|$newPub|1735689600000"
                .toByteArray(Charsets.UTF_8)
        assertArrayEquals(expected, AdminRootRotationClaim.canonicalBytes(rotation))

        // OLD signs OLD→NEW; verifies under the OLD pub, not the NEW one.
        val sig = AdminRootRotationClaim.sign(rotation, Ed25519Sign(old.privateKey))
        assertTrue(AdminRootRotationClaim.verify(rotation, sig, old.publicKey))
        assertFalse(AdminRootRotationClaim.verify(rotation, sig, new.publicKey))
    }

    @Test fun rotateViewModel_signsOldToNew_posts_reStores_reEscrows() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val old = Ed25519Sign.KeyPair.newKeyPair()
        val newSeed = ByteArray(32) { 0x42 }
        val newPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(newSeed).publicKey)

        var stored: ByteArray? = null
        var escrowed: ByteArray? = null
        val vm = RotateAdminRootViewModel(
            server = server,
            username = account,
            mintSeed = { newSeed },
            now = { 1_735_689_600_000L },
            hasAdminRoot = { true },
            loadOldSigner = { Ed25519Sign(old.privateKey) },
            oldPubHex = { HexUtil.encode(old.publicKey) },
            storeNewRoot = { stored = it },
            reEscrowNewRoot = { escrowed = it },
        )

        vm.rotate()

        val phase = vm.phase.first()
        assertTrue("rotate must succeed: $phase", phase is RotateAdminRootPhase.Done)
        assertEquals(newPub, (phase as RotateAdminRootPhase.Done).newAdminRootPubHex)
        // The Mock verifies the proof against the OLD pub before recording it, so
        // a recorded new-root is proof the sign old→new bytes were correct.
        assertEquals(newPub, server.rotatedAdminRootByUser[account])
        assertArrayEquals("NEW root re-stored device-local", newSeed, stored)
        assertArrayEquals("NEW root re-escrowed", newSeed, escrowed)
    }

    @Test fun rotateViewModel_refusesOnNonAdminDevice() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = RotateAdminRootViewModel(
            server = server,
            username = account,
            hasAdminRoot = { false },
        )
        vm.rotate()
        assertTrue(vm.phase.first() is RotateAdminRootPhase.Failed)
        assertNull(server.rotatedAdminRootByUser[account])
    }
}
