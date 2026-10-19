package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeviceAdmitClaim
import com.flagshipserver.app.core.FakeQrRelayServer
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LiveAdminPairingRelay
import com.flagshipserver.app.core.LiveIncomingPairingRelay
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@OptIn(ExperimentalCoroutinesApi::class)
class LiveDevicePairingFlowTest {
    private val account = "acme"
    private val dispatcher = StandardTestDispatcher()
    private val client = OkHttpClient()
    private lateinit var relay: FakeQrRelayServer

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        val ctx: Context = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("live-device-pairing-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
        relay = FakeQrRelayServer().also { it.start() }
    }

    @After fun tearDown() {
        relay.stop()
        client.dispatcher.executorService.shutdown()
        Keystore.wipeAllProfiles()
        Dispatchers.resetMain()
    }

    @Test fun adminAddsADevice_overTheLiveTransport() = runBlocking {
        withTimeout(60_000) {
            val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
            Keystore.setActiveProfile("$account-admin")
            val adminUmk = Keystore.loadOrCreateUmkSeed()
            Keystore.deriveIRK("admin")
            val irkSeed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
            server.claimUsername(
                UsernameClaimRequest(
                    request = UsernameClaimRequest.Inner(
                        username = account,
                        irkPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed).publicKey),
                        issuedAt = 1L,
                    ),
                    signature = "00".repeat(64),
                ),
            )

            val adminRelay = LiveAdminPairingRelay(client, host = { relay.host }, secure = { false })
            val incomingRelay = LiveIncomingPairingRelay(client, host = { relay.host }, secure = { false })
            val adminVm = AddDeviceViewModel(
                relay = adminRelay,
                username = account,
                umkSeed = { adminUmk },
                signAdmit = { admit ->
                    Keystore.setActiveProfile("$account-admin")
                    DeviceAdmitClaim.sign(admit, Keystore.deriveIRK("vouch"))
                },
                sessionIdGen = { "sid-live-vm" },
                now = { 1_000L },
                confirmGateMs = 0,
                canPromote = { false },
                adminRootSeed = { null },
            )
            val joinLink = JoinLink.parse(adminVm.joinUrl)!!

            val adminStart = async(Dispatchers.IO) { adminVm.start() }
            repeat(500) {
                if (relay.hasBrowser("sid-live-vm")) return@repeat
                delay(10)
            }
            Keystore.setActiveProfile("personal")
            val incomingApp = AppState()
            val incomingVm = JoinDeviceViewModel(
                joinLink = joinLink,
                relay = incomingRelay,
                server = server,
                app = incomingApp,
                providerToken = "fcm-live",
                now = { 2_000L },
            )
            incomingVm.start()
            val sas = (incomingVm.phase.first() as JoinDevicePhase.VerifySas).matchCode
            adminStart.await()
            val adminPhase = adminVm.phase.first() as AddDevicePhase.ConfirmSas
            assertEquals(sas, adminPhase.matchCode)

            dispatcher.scheduler.advanceUntilIdle()
            adminVm.confirmAndSeal()
            assertEquals(AddDevicePhase.Delivered, adminVm.phase.first())

            incomingVm.confirmDisplayName("Reviewer Android")
            incomingVm.verifyAndJoin()
            val joined = incomingVm.phase.first()
            assertTrue("incoming must JOIN over the live transport: $joined", joined is JoinDevicePhase.Joined)

            Keystore.setActiveProfile(account)
            assertArrayEquals(adminUmk, Keystore.currentUmkSeed())
            assertEquals(account, server.lastDeviceAdmit!!.first)
        }
    }
}
