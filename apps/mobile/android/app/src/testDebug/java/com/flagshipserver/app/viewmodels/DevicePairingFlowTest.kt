// Phase 3b — END-TO-END cross-device pairing through the Mock relay.
//
// Pins the contract that started this work:
//   1. The ADMIN signs a valid DeviceAdmit binding the incoming device's
//      FRESH pubkey, seals { umkSeedHex, admit, admitSig } over the
//      relay.
//   2. The INCOMING device verifies the admit under the account IRK pub
//      (resolved from .com), installs the recovered UMK into a NEW
//      profile slot (an EXISTING profile is left untouched — multi-
//      profile #9), registers + admits to .com, and surfaces the 14-day
//      quarantine.
//
// The admin's account IRK is derived from a per-profile UMK in the
// Keystore; the Mock resolves getUsernameRecord → that IRK pub so the
// incoming verify passes. A forged-admit / wrong-device-pub case fails
// closed (the device is NOT added).

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
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
@OptIn(ExperimentalCoroutinesApi::class)
class DevicePairingFlowTest {

    private val account = "acme"
    private lateinit var ctx: Context
    // viewModelScope (Dispatchers.Main) backs the L10 anti-double-tap gate's
    // delayed un-gate; route it through a test dispatcher so advanceUntilIdle()
    // drives that timer under virtual time.
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        ctx = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("device-pairing-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After
    fun tearDown() {
        Keystore.wipeAllProfiles()
        Dispatchers.resetMain()
    }

    /** Seed an admin identity: a per-profile UMK + IRK for [account] in
     *  the Keystore, claim the username on the Mock with that IRK pub so
     *  the incoming verify resolves the right key. Returns the admin's
     *  UMK seed (the secret the bundle must carry). */
    private suspend fun seedAdmin(server: MockFlagshipServerClient): ByteArray {
        Keystore.setActiveProfile("$account-admin")
        val umk = Keystore.loadOrCreateUmkSeed()
        Keystore.deriveIRK("admin")  // populate the per-version IRK cache
        val seed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
        val irkPubHex = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        server.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(
                    username = account,
                    irkPub = irkPubHex,
                    issuedAt = 1L,
                ),
                signature = "00".repeat(64),
            ),
        )
        return umk
    }

    @Test fun adminVouches_incomingVerifiesAndInstallsIntoNewProfile() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val adminUmk = seedAdmin(server)
        val relay = MockDevicePairingRelay()

        // The incoming phone ALREADY hosts another profile ("personal").
        // It must survive the join intact (multi-profile #9).
        Keystore.setActiveProfile("personal")
        val personalUmk = Keystore.loadOrCreateUmkSeed()
        val incomingApp = AppState()
        incomingApp.addProfile(Profile(cloudName = "personal"), setActive = true)

        // ── ADMIN side: build the VM with the seeded admin identity ──
        Keystore.setActiveProfile("$account-admin")
        val adminVm = AddDeviceViewModel(
            relay = relay.admin,
            username = account,
            umkSeed = { adminUmk },
            signAdmit = { admit ->
                // Single-JVM test: the incoming side shares this Keystore
                // and flips the active profile, so pin the admin profile
                // before deriving its IRK. On a real device these are two
                // separate phones with separate Keystores.
                Keystore.setActiveProfile("$account-admin")
                val irk = Keystore.deriveIRK("vouch")
                DeviceAdmitClaim.sign(admit, irk)
            },
            sessionIdGen = { "sid-xyz" },
            now = { 1_000L },
        )

        // ── INCOMING side: parse the admin's join link, run the VM ──
        val adminLink = JoinLink.parse(adminVm.joinUrl)!!
        // The incoming VM operates against the incoming phone's Keystore +
        // app; reset the active profile to the existing one to prove the
        // VM re-points to a NEW slot itself.
        Keystore.setActiveProfile("personal")
        val incomingVm = JoinDeviceViewModel(
            joinLink = adminLink,
            relay = relay.incoming,
            server = server,
            app = incomingApp,
            providerToken = "fcm-token-123",
            now = { 2_000L },
        )

        // Drive the handshake. Order matters: admin opens + waits, incoming
        // connects (buffers its hello), admin reads it → SAS, incoming
        // derives SAS, admin seals + delivers, incoming opens + joins.
        incomingVm.start()                       // sends hello (x25519 || device pub)
        assertTrue(incomingVm.phase.first() is JoinDevicePhase.VerifySas)

        adminVm.start()                          // reads peer hello → ConfirmSas
        val adminPhase = adminVm.phase.first()
        assertTrue(adminPhase is AddDevicePhase.ConfirmSas)

        // SAS must match on both screens (the anti-MitM check).
        val incomingSas = (incomingVm.phase.first() as JoinDevicePhase.VerifySas).matchCode
        assertEquals((adminPhase as AddDevicePhase.ConfirmSas).matchCode, incomingSas)

        // L10 — Confirm is gated for the anti-double-tap window right after the
        // SAS appears: a confirm now is a no-op (still ConfirmSas, not yet
        // delivered). Mirrors iOS confirmMatch ignoring a pre-gate tap.
        adminVm.confirmAndSeal()
        assertTrue(
            "confirm before the gate elapses must be ignored",
            adminVm.phase.first() is AddDevicePhase.ConfirmSas,
        )

        // Elapse the gate (virtual time) → gateExpired flips true.
        advanceUntilIdle()
        assertTrue((adminVm.phase.first() as AddDevicePhase.ConfirmSas).gateExpired)

        adminVm.confirmAndSeal()                 // signs admit + seals + delivers
        assertEquals(AddDevicePhase.Delivered, adminVm.phase.first())

        incomingVm.confirmDisplayName("Reviewer Android")
        incomingVm.verifyAndJoin()               // opens + verifies + installs + admits
        val joined = incomingVm.phase.first()
        assertTrue("incoming must JOIN, not fail: $joined", joined is JoinDevicePhase.Joined)

        // ── Assertions ──
        // (a) The recovered UMK landed in the NEW profile slot (== admin's
        //     account UMK, so the device joins the same identity).
        Keystore.setActiveProfile(account)
        assertArrayEquals(
            "incoming installed the account UMK into the new profile slot",
            adminUmk, Keystore.currentUmkSeed(),
        )
        // (b) The pre-existing "personal" profile is UNTOUCHED.
        Keystore.setActiveProfile("personal")
        assertArrayEquals(
            "existing profile must NOT be clobbered",
            personalUmk, Keystore.currentUmkSeed(),
        )

        // (c) The admit POSTed to .com binds the incoming device's FRESH
        //     pubkey and verifies under the admin IRK.
        val (acct, req) = server.lastDeviceAdmit!!
        assertEquals(account, acct)
        val record = server.getUsernameRecord(account)
        val verified = DeviceAdmitClaim.verify(
            DeviceAdmit(req.admit.username, req.admit.deviceId, req.admit.newDevicePubHex, req.admit.issuedAt),
            HexUtil.decode(req.admitSig)!!,
            HexUtil.decode(record.irkPub)!!,
        )
        assertTrue("the POSTed admit must verify under the account IRK", verified)

        // (d) The new device is non-admin (no admin label) + the profile
        //     was added active, and the 14-day quarantine is surfaced.
        assertEquals(account, incomingApp.currentUser.first())
        assertNull("a scanned-in device is NOT admin", run {
            val label = incomingApp.activeProfile?.deviceDisplayName
            if (label == "admin") "is-admin" else null
        })
        val quarantineUntil = (joined as JoinDevicePhase.Joined).quarantineUntil
        assertNotNull("quarantine deadline surfaced", quarantineUntil)
        assertTrue(quarantineUntil!! > 2_000L)
        // The personal profile still exists alongside the new one.
        assertEquals(2, incomingApp.profiles.first().size)
    }

    @Test fun incoming_rejectsForgedAdmit_doesNotJoin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedAdmin(server)  // the REAL account IRK is registered on .com
        val relay = MockDevicePairingRelay()

        val incomingApp = AppState()
        // The "admin" here is an ATTACKER: it shares the relay + derives
        // the same kEnc (so the AEAD opens), but signs the admit with a
        // throwaway key the account never registered. The incoming verify
        // (under the REAL account IRK from .com) must fail closed.
        val attackerSession = QrSession.fresh()

        val incomingVm = JoinDeviceViewModel(
            joinLink = JoinLink("sid-evil", attackerSession.phonePubKey),
            relay = relay.incoming,
            server = server,
            app = incomingApp,
            now = { 5_000L },
        )
        incomingVm.start()  // buffers the incoming hello in the relay

        // The attacker reads the incoming's hello: [x25519 pub || device pub].
        val hello = relay.admin.awaitPeerHello("sid-evil")
        val peerX25519 = hello.copyOfRange(0, 32)
        val devicePubHex = HexUtil.encode(hello.copyOfRange(32, 64))
        val deviceId = HexUtil.encode(hello.copyOfRange(64, 80))
        attackerSession.pair(peerX25519)  // same kEnc as the incoming

        val attackerKey = Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        val admit = DeviceAdmit(account, deviceId, devicePubHex, 5_000L)
        val forgedGrant = com.flagshipserver.app.core.PairingGrant(
            "forged", account, deviceId, devicePubHex,
            listOf("view-directory"), 5_000L, 10_000L, "membership",
        )
        val forged = PairingBundle(
            umkSeedHex = "33".repeat(32),
            admit = admit,
            admitSig = HexUtil.encode(DeviceAdmitClaim.sign(admit, attackerKey)),
            grant = forgedGrant,
            grantSignature = HexUtil.encode(attackerKey.sign(
                com.flagshipserver.app.core.DeviceCapabilityGrant.canonicalBytes(
                    forgedGrant.grantId, forgedGrant.username, forgedGrant.deviceId,
                    forgedGrant.devicePubHex, forgedGrant.scopes,
                    forgedGrant.issuedAt, forgedGrant.expiresAt,
                ),
            )),
        )
        val sealed = attackerSession.seal(forged.toJsonBytes())
        relay.admin.deliver(sealed.ciphertextB64u, sealed.nonceB64u)

        incomingVm.confirmDisplayName("Reviewer Android")
        incomingVm.verifyAndJoin()
        val phase = incomingVm.phase.first()
        assertTrue("forged admit must fail closed: $phase", phase is JoinDevicePhase.Failed)
        assertFalse("a rejected join must NOT open the account", incomingApp.isPaired.first())
        assertNull("a forged admit must never reach .com", server.lastDeviceAdmit)
    }

    /** L10 — the "codes match" Confirm is gated for the anti-double-tap window
     *  right after the SAS appears (parity with iOS AddDeviceViewModel's 600ms
     *  `gateExpired`). A confirm fired inside the window is ignored; once the
     *  window elapses, `gateExpired` flips true and confirm proceeds. */
    @Test fun confirmIsGatedForTheAntiDoubleTapWindow() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val adminUmk = seedAdmin(server)
        val relay = MockDevicePairingRelay()

        // Drive an incoming side just far enough to buffer a valid hello so the
        // admin's awaitPeerHello resolves into ConfirmSas.
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
            sessionIdGen = { "sid-gate" },
            now = { 1_000L },
        )
        val incomingVm = JoinDeviceViewModel(
            joinLink = JoinLink.parse(adminVm.joinUrl)!!,
            relay = relay.incoming,
            server = server,
            app = incomingApp,
            providerToken = "fcm-gate",
            now = { 2_000L },
        )

        incomingVm.start()            // buffers hello
        adminVm.start()               // reads hello → ConfirmSas(gateExpired=false)

        // (a) The SAS panel is shown but Confirm is still gated.
        val gated = adminVm.phase.first()
        assertTrue(gated is AddDevicePhase.ConfirmSas)
        assertFalse(
            "Confirm must be gated immediately after the SAS appears",
            (gated as AddDevicePhase.ConfirmSas).gateExpired,
        )

        // (b) A confirm DURING the gate is a no-op — still ConfirmSas.
        adminVm.confirmAndSeal()
        assertTrue(
            "a pre-gate confirm must be ignored",
            adminVm.phase.first() is AddDevicePhase.ConfirmSas,
        )
        assertNull("a gated confirm must not deliver to .com", server.lastDeviceAdmit)

        // (c) Elapse the 600ms window → gateExpired flips, confirm proceeds.
        advanceUntilIdle()
        assertTrue((adminVm.phase.first() as AddDevicePhase.ConfirmSas).gateExpired)
        adminVm.confirmAndSeal()
        assertEquals(AddDevicePhase.Delivered, adminVm.phase.first())
    }
}
