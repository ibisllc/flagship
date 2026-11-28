// docs/account-key-rotation.md: "Change your account key" checks the account and every server first, shows who
// keeps the account, then sends one hop and promotes the new key only once `.com` holds it.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryGrant
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.AccountKeyStateRecord
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.core.AccountKeyRotation
import com.flagshipserver.app.core.AccountKeyRotationFlow
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RotateAccountKeyViewModelTest {
    private val user = "plucky-avocet"
    private fun seed(b: Int) = ByteArray(32) { (b + it).toByte() }
    private fun pub(s: ByteArray) = PqHex.encode(PqHybrid.ed25519PublicKey(s))
    private val oldUmk = seed(1)
    private val root = seed(3)
    private val selfId = "a".repeat(32)
    private val phoneId = "b".repeat(32)
    private val webId = "c".repeat(32)
    private val removedId = "d".repeat(32)
    private val phoneSeed = seed(11)
    private val oldIrk = pub(AccountKeyRotation.irkSeed(oldUmk, AccountKeyRotation.IrkScheme.ANDROID))
    private lateinit var selfPub: String

    @Before fun setUp() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        FSStrings.init(ctx)
        Keystore.attachForTest(ctx.getSharedPreferences("akr-vm", Context.MODE_PRIVATE).also { it.edit().clear().commit() })
        Keystore.setActiveProfile(user)
        selfPub = pub(Keystore.loadOrCreateAccountDeviceSeed(selfId))
    }

    @After fun tearDown() { Keystore.setActiveProfile(null) }

    private class Keys(val oldUmk: ByteArray, val root: ByteArray, val irk: String) : RotateAccountKeyViewModel.Keys {
        var staged: String? = null
        var promoted: AccountKeyRotation.Rotation? = null
        override fun hasAdminRoot() = true
        override fun adminRootPubHex() = PqHex.encode(PqHybrid.ed25519PublicKey(root))
        override suspend fun unlock(reason: String) {}
        override fun umk() = oldUmk.copyOf()
        override fun adminRootSeed() = root.copyOf()
        override fun irkPubHex() = irk
        override fun epoch() = 0L
        override fun stage(newUmk: ByteArray, newRoot: ByteArray?, body: String) { staged = body }
        override fun clearStaged() { staged = null }
        override fun strict(user: String) = false
        override fun adminHybrid(user: String, rootSeed: ByteArray, rootPub: String): ((String, ByteArray) -> ByteArray)? = null
        override suspend fun migrateOwnKey(server: FlagshipServerClient, user: String, deviceId: String, name: String?) {}
        override suspend fun promote(server: FlagshipServerClient, user: String, deviceId: String, name: String?, r: AccountKeyRotation.Rotation) { promoted = r }
    }

    private inner class Server(private val base: MockFlagshipServerClient = MockFlagshipServerClient(simulatedLatencyMs = 0)) : FlagshipServerClient by base {
        var irk = oldIrk
        var posted: JsonObject? = null
        var answer: (() -> Unit)? = null
        override suspend fun accountKeyState(username: String) = AccountKeyStateRecord(irk, pub(root), 0)
        override suspend fun hasCloudRecovery(username: String) = true
        override suspend fun accountDirectory(accountId: String, authorization: AccountDirectoryAuthorization): AccountDirectoryResponse {
            fun d(id: String, p: String, at: Long) = AccountDirectoryDevice(user, id, p, "android", at, at, null, id.take(4))
            return AccountDirectoryResponse(
                user,
                devices = listOf(d(selfId, selfPub, 1), d(phoneId, pub(phoneSeed), 2),
                    d(webId, PqHex.encode(AccountMetadata.deriveAccountDevicePub(oldUmk, user, webId)), 3), d(removedId, pub(seed(12)), 4)),
                grants = listOf(AccountDirectoryGrant("g", user, selfId, selfPub, "[\"admin\"]", 0, Long.MAX_VALUE / 2, "00".repeat(64), null, "admin-root")),
            )
        }
        override suspend fun applyAccountKeyRotation(username: String, body: JsonObject): JsonObject {
            posted = body
            answer?.invoke()
            return JsonObject(emptyMap())
        }
    }

    private fun vm(server: Server, keys: Keys, pods: List<PodInfo> = emptyList()) =
        RotateAccountKeyViewModel(server, user, selfId, { "Pixel" }, { pods }, { null }, keys)

    @Test fun theSummaryListsWhoKeepsTheAccountAndWhoIsAddedAgain() = runBlocking {
        val v = vm(Server(), Keys(oldUmk, root, oldIrk))
        v.prepare(removedId)
        val s = v.phase.value as RotateAccountKeyViewModel.Phase.Summary
        assertEquals(2, s.kept.size)
        assertTrue(s.kept[0].name.contains("aaaa") && s.kept[1].name.contains("bbbb"))
        assertEquals(1, s.excluded.size)
        assertTrue(s.excluded.single().reason!!.contains("cccc"))
        assertTrue(s.recoveryOn)
    }

    @Test fun aServerThatCannotFollowStopsItBeforeAnythingChanges() = runBlocking {
        val v = vm(Server(), Keys(oldUmk, root, oldIrk), pods = listOf(PodInfo(podId = "p1", name = "home", fqdn = "home.plucky-avocet.flagship.services")))
        v.prepare(removedId)
        val u = v.phase.value as RotateAccountKeyViewModel.Phase.Unavailable
        assertTrue(u.message, u.message.contains("home"))
    }

    @Test fun anAcceptedHopIsPromoted() = runBlocking {
        val server = Server()
        val keys = Keys(oldUmk, root, oldIrk)
        val v = vm(server, keys)
        v.prepare(removedId)
        v.confirm()
        assertEquals(RotateAccountKeyViewModel.Phase.Done(needsRecovery = true), v.phase.value)
        val body = server.posted!!
        val r = AccountKeyRotationFlow.parseRotation(body["rotation"])!!
        AccountKeyRotation.verify(r, AccountKeyRotationFlow.parseSignatures(body["signatures"])!!, AccountKeyRotation.KeyState(user, 0, oldIrk, null, pub(root)))
        assertEquals(r, keys.promoted)
        assertNotNull("staged before it was sent", keys.staged)
    }

    @Test fun losingTheRaceToAnotherAdminDropsTheStagedHop() = runBlocking {
        val server = Server().apply { answer = { throw HttpException(409, """{"code":"rotation-conflict"}""") } }
        val keys = Keys(oldUmk, root, oldIrk)
        val v = vm(server, keys)
        v.prepare(removedId)
        v.confirm()
        assertEquals(RotateAccountKeyViewModel.Phase.Failed(FSStrings.get(com.flagshipserver.app.R.string.akr_conflict)), v.phase.value)
        assertNull(keys.staged)
        assertNull(keys.promoted)
    }

    @Test fun aConflictForAHopDotComAlreadyHoldsStillPromotes() = runBlocking {
        val server = Server()
        server.answer = {
            server.irk = AccountKeyRotationFlow.parseRotation(server.posted!!["rotation"])!!.newIrkPubHex
            throw HttpException(409, "{}")
        }
        val keys = Keys(oldUmk, root, oldIrk)
        val v = vm(server, keys)
        v.prepare(removedId)
        v.confirm()
        assertNotNull(keys.promoted)
        assertTrue(v.phase.value is RotateAccountKeyViewModel.Phase.Done)
    }
}
