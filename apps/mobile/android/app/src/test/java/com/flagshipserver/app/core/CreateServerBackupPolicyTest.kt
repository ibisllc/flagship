// The create wizard's backup policy is signed with the admin root and rides
// beside the pairing order the box consumes (docs/server-backup-and-clone.md,
// "Backup policy"). Mirrors the iOS CreateServerViewModel backup-policy test.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.screens.BackupPolicyChoice
import com.flagshipserver.app.ui.screens.mintRecipeBundle
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CreateServerBackupPolicyTest {
    private lateinit var ctx: Context

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("create-backup-policy-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
        Keystore.setActiveProfile("harry")
        Keystore.loadOrCreateUmkSeed()
    }

    @After fun tearDown() = Keystore.wipeAllProfiles()

    private fun store() = PendingPairingDepositStore(ctx.getSharedPreferences("create-backup-policy-pairing", Context.MODE_PRIVATE).also { it.edit().clear().commit() })

    @Test fun thePolicyIsSignedBesideThePairingOrder() = runTest {
        val root = Keystore.generateAdminRoot()
        val pairing = store()
        val minted = mintRecipeBundle(
            username = "harry",
            serverName = "home",
            pairingDepositStore = pairing,
            backupPolicy = BackupPolicyChoice("phone", 16 * BackupsText.GB),
        )
        val json = Json.parseToJsonElement(pairing.pendingOrder(minted.serverDomain)!!).jsonObject
        val bp = json["backupPolicy"]!!.jsonObject
        val o = bp["order"]!!.jsonObject
        val order = BackupPolicyOrder(
            o["serverDomain"]!!.jsonPrimitive.content,
            o["policy"]!!.jsonPrimitive.content,
            o["phoneReserveBytes"]!!.jsonPrimitive.long,
            o["issuedAt"]!!.jsonPrimitive.long,
        )
        assertEquals("home.harry.flagship.services", order.serverDomain)
        assertEquals("phone", order.policy)
        assertEquals(16 * BackupsText.GB, order.phoneReserveBytes)
        Ed25519Verify(HexUtil.decode(root)!!).verify(HexUtil.decode(bp["signatureHex"]!!.jsonPrimitive.content)!!, order.canonicalBytes())
        // The pairing order itself is unchanged beside it.
        assertEquals(true, json.containsKey("signature"))
    }

    @Test fun peerAndNoneCarryNoReserve() = runTest {
        Keystore.generateAdminRoot()
        val pairing = store()
        val minted = mintRecipeBundle(username = "harry", serverName = "lab", pairingDepositStore = pairing, backupPolicy = BackupPolicyChoice("none", 9))
        val o = Json.parseToJsonElement(pairing.pendingOrder(minted.serverDomain)!!).jsonObject["backupPolicy"]!!.jsonObject["order"]!!.jsonObject
        assertEquals("none", o["policy"]!!.jsonPrimitive.content)
        assertEquals(0L, o["phoneReserveBytes"]!!.jsonPrimitive.long)
    }

    @Test fun noChoiceNoSibling() = runTest {
        Keystore.generateAdminRoot()
        val pairing = store()
        val minted = mintRecipeBundle(username = "harry", serverName = "old", pairingDepositStore = pairing)
        assertNull(Json.parseToJsonElement(pairing.pendingOrder(minted.serverDomain)!!).jsonObject["backupPolicy"])
    }

    @Test fun theDraftMapsPhoneOnlyToPhone() {
        assertEquals("phone", CreateServerDraftStore.BackupPolicy.PHONE_ONLY.order)
        assertEquals(CreateServerDraftStore.BackupPolicy.PEER, CreateServerDraftStore.BackupPolicy.fromOrder("peer"))
        val d = CreateServerDraftStore(ctx.getSharedPreferences("draft-reserve-test", Context.MODE_PRIVATE))
        assertNull(d.reserveGb())
        d.setReserveGb(24)
        assertEquals(24, d.reserveGb())
        d.reset()
        assertNull(d.reserveGb())
    }
}
