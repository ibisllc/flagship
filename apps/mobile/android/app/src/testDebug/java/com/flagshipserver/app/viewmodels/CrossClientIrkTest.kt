// A device whose account another client made (webapp, iOS) holds that client's IRK, adopted from
// IrkLineage (packages/protocol/test-vectors/irk-lineage). Every later IRK ceremony on this device
// must sign with that key and rotate into this app's own scheme: Replace device and Wipe & restart
// here, after recovery or a join adopted it.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RePairInitiateClaim
import com.flagshipserver.app.keystore.IrkLineage
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CrossClientIrkTest {
    private val umk = ByteArray(32) { (it * 7 + 3).toByte() }

    @Before fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("cross-client-irk-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After fun tearDown() = Keystore.wipeAllProfiles()

    private suspend fun adopt(scheme: IrkLineage.Scheme, version: Int): String {
        Keystore.setActiveProfile("harry")
        Keystore.installUmk(umk)
        val key = IrkLineage.key(umk, scheme, version)
        Keystore.adoptRegisteredIrk(key)
        return key.pubHex
    }

    @Test fun adoptedKeyIsTheCurrentIrk_andARotationLandsInThisAppsScheme() = runTest {
        for (scheme in IrkLineage.Scheme.entries) {
            val pub = adopt(scheme, 2)
            assertEquals("$scheme", pub, Keystore.irkPubHex())
            Keystore.deriveIRK("test", 3)
            val next = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPairFromSeed(Keystore.requireIrkSeedForVersion(3)).publicKey
            assertEquals("$scheme", IrkLineage.key(umk, IrkLineage.Scheme.ANDROID, 3).pubHex, HexUtil.encode(next))
            Keystore.setCurrentIrkVersion(3)
            assertEquals("$scheme: the rotated key is this app's", IrkLineage.key(umk, IrkLineage.Scheme.ANDROID, 3).pubHex, Keystore.irkPubHex())
            Keystore.wipeAllProfiles()
        }
    }

    @Test fun replaceDevice_onAnAccountMadeOnTheWebapp_displacesItsKey() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val webV1 = adopt(IrkLineage.Scheme.WEB, 1)
        server.claimUsername(UsernameClaimRequest(UsernameClaimRequest.Inner("harry", webV1, 1L), signature = ""))
        val vm = ReplaceDeviceViewModel(server = server, username = { "harry" })

        vm.initiate(currentEtag = null)

        val body = assertNotNull(server.lastRePairInitiate).let { server.lastRePairInitiate!!.second }
        assertEquals(webV1, body.request.oldIrkPub)
        assertEquals(IrkLineage.key(umk, IrkLineage.Scheme.ANDROID, 2).pubHex, body.request.newIrkPub)
        val canonical = RePairInitiateClaim.canonicalBytes(
            username = "harry", newIrkPubHex = body.request.newIrkPub, oldIrkPubHex = body.request.oldIrkPub,
            issuedAt = body.request.issuedAt,
        )
        // The credential is made by the key `.com` stores (it throws on a bad signature).
        Ed25519Verify(HexUtil.decode(webV1)!!).verify(HexUtil.decode(body.oldIrkSignature!!)!!, canonical)
    }
}
