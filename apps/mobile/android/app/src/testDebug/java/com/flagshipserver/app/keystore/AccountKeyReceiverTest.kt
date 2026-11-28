// docs/account-key-rotation.md: a kept phone notices `.com` serves another account key, replays the lane from the
// admin root it pinned, opens its delivery with its receive key, installs the new key (the old one retired) and
// acknowledges; a lane under a root it never pinned changes nothing.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryGrant
import com.flagshipserver.app.api.AccountDirectoryReceiveKey
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.AccountKeyStateRecord
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.core.AccountKeyRotation
import com.flagshipserver.app.core.AccountKeyRotationFlow
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AccountKeyReceiverTest {
    private val user = "plucky-avocet"
    private val adminId = "a".repeat(32)
    private val selfId = "b".repeat(32)
    private val removedId = "d".repeat(32)
    private fun seed(b: Int) = ByteArray(32) { (b + it).toByte() }
    private fun pub(s: ByteArray) = PqHex.encode(PqHybrid.ed25519PublicKey(s))
    private val root = seed(3)
    private val newUmk = seed(2)

    @Before fun setUp() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        FSStrings.init(ctx)
        Keystore.attachForTest(ctx.getSharedPreferences("akr-receiver", Context.MODE_PRIVATE).also { it.edit().clear().commit() })
        PqSessionKek.openForTest(ByteArray(32) { 4 })
        Keystore.setActiveProfile(user)
        AccountKeyService.setStatusForTest(AccountKeyService.Status.Idle)
    }

    @After fun tearDown() {
        PqSessionKek.openForTest(null)
        Keystore.setActiveProfile(null)
    }

    private inner class Server(val body: JsonObject, val newIrk: String) : FlagshipServerClient by MockFlagshipServerClient(simulatedLatencyMs = 0) {
        val acked = mutableListOf<Long>()
        override suspend fun accountKeyState(username: String) = AccountKeyStateRecord(newIrk, pub(root), 1)
        override suspend fun umkRotationDeliveries(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization) = body
        override suspend fun ackUmkRotation(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, toEpoch: Long) { acked += toEpoch }
    }

    /** What an admin device would send for this phone, signed by [signingRoot]. */
    private fun rotation(signingRoot: ByteArray): Pair<JsonObject, String> {
        val oldUmk = Keystore.currentUmkSeed()
        val selfPub = pub(Keystore.storedAccountDeviceSeed(selfId)!!)
        val rk = Keystore.ensureReceiveKey()!!
        val rkSig = PqHex.encode(PqHybrid.ed25519Sign(Keystore.storedAccountDeviceSeed(selfId)!!, AccountKeyRotation.canonicalDeviceReceiveKey(user, selfId, selfPub, rk, 1)))
        fun d(id: String, p: String, at: Long) = AccountDirectoryDevice(user, id, p, "android", at, at, null, id.take(4))
        val dir = AccountDirectoryResponse(
            user,
            devices = listOf(d(adminId, pub(seed(10)), 1), d(selfId, selfPub, 2), d(removedId, pub(seed(12)), 3)),
            grants = listOf(AccountDirectoryGrant("g", user, selfId, selfPub, "[\"browse\"]", 0, Long.MAX_VALUE / 2, "00".repeat(64), null, "admin-root")),
            receiveKeys = listOf(AccountDirectoryReceiveKey(selfId, selfPub, rk, 1, rkSig)),
        )
        val now = System.currentTimeMillis()
        val plan = AccountKeyRotationFlow.plan(AccountKeyRotationFlow.devices(dir, user, { it.deviceId }, now), adminId, removedId, oldUmk, user, false)
        val b = AccountKeyRotationFlow.build(AccountKeyRotationFlow.Inputs(
            user, 0, Keystore.irkPubHexIfKnown()!!, oldUmk, newUmk, AccountKeyRotation.IrkScheme.IOS, plan,
            AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(signingRoot), pub(signingRoot)), false, dir, now,
        ))
        val lane = JsonArray(listOf(buildJsonObject {
            put("kind", "account-key-rotation")
            put("rotation", AccountKeyRotationFlow.rotationJson(b.rotation))
            put("signatures", b.body["signatures"]!!)
            put("kept", b.body["kept"]!!)
        }))
        val deliveries = JsonArray((b.body["deliveries"] as JsonArray).map { e ->
            buildJsonObject { (e as JsonObject).forEach { (k, v) -> put(k, v) }; put("toEpoch", 1) }
        })
        return buildJsonObject { put("keyEpoch", 1); put("deliveries", deliveries); put("lane", lane) } to b.rotation.newIrkPubHex
    }

    @Test fun aKeptPhoneInstallsTheNewAccountKey() = runBlocking {
        val oldUmk = Keystore.loadOrCreateUmkSeed().copyOf()
        Keystore.loadOrCreateAccountDeviceSeed(selfId)
        Keystore.setAdminRootPin(pub(root))
        val (body, newIrk) = rotation(root)
        val server = Server(body, newIrk)
        AccountKeyService.receive(server, user, selfId, deviceName = null)
        assertArrayEquals(newUmk, Keystore.currentUmkSeed())
        assertArrayEquals(oldUmk, Keystore.retiredUmkSeed(0))
        assertEquals(1L, Keystore.accountKeyEpoch())
        // The rotator was an iPhone: this phone now derives the account's IRK the iOS way.
        assertEquals(newIrk, Keystore.irkPubHexIfKnown())
        assertEquals(listOf(1L), server.acked)
        assertEquals(AccountKeyService.Status.Done, AccountKeyService.status.value)
    }

    @Test fun aHopUnderARootThisPhoneNeverPinnedChangesNothing() = runBlocking {
        val oldUmk = Keystore.loadOrCreateUmkSeed().copyOf()
        Keystore.loadOrCreateAccountDeviceSeed(selfId)
        Keystore.setAdminRootPin(pub(root))
        val (body, newIrk) = rotation(seed(40))
        val server = Server(body, newIrk)
        AccountKeyService.receive(server, user, selfId, deviceName = null)
        assertArrayEquals(oldUmk, Keystore.currentUmkSeed())
        assertEquals(0L, Keystore.accountKeyEpoch())
        assertFalse(server.acked.isNotEmpty())
        assertEquals(AccountKeyService.Status.Failed, AccountKeyService.status.value)
    }
}
