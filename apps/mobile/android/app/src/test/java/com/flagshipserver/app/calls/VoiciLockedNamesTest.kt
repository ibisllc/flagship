// Names on a locked phone (docs/voici-locked-caller-names.md §7): the table builder, the locked lookups, the backup
// exclusion and every erasure path, against the in-memory `.com`. Mirrors iOS VoiciLockedNamesTests.

package com.flagshipserver.app.calls

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.MemoryVoiciVaultStore
import com.flagshipserver.app.core.voici.MessagesForgotten
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciKeyring
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciRings
import com.flagshipserver.app.core.voici.VoiciVault
import com.flagshipserver.app.push.VoiciRingPush
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

private class LockedNamesKeys(val user: String, val umkSeed: ByteArray, val rootSeed: ByteArray, val admin: Boolean, val deviceSeed: ByteArray) : VoiciKeyring {
    override fun username() = user
    override fun umk() = umkSeed
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = admin
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = rootSeed to "admin-root"
    override fun device() = VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(VoiciJs.edPub(deviceSeed)), Ed25519Sign(deviceSeed))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = user
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class VoiciLockedNamesTest {
    private val day = 86_400_000L
    private val now = 1_900_000_000_000L
    private val mom = "a1".repeat(32)
    private val dad = "b2".repeat(32)
    private val pageA = "3f".repeat(16)
    private val secret = ByteArray(32) { 0x2e }

    private fun call(pub: String, at: Long, outcome: String = "answered", conv: String = pub.take(32)) =
        VoiciCallRecord(id = "r-$pub-$at", callId = "$pub$at".take(32), direction = "in", outcome = outcome, conv = conv, pseudonymPub = pub, at = at)

    private fun build(
        nicknames: Map<String, String> = emptyMap(), blocked: Set<String> = emptySet(), forgotten: Map<String, MessagesForgotten> = emptyMap(),
        records: List<VoiciCallRecord> = emptyList(), missed: List<VoiciMissedCallRow> = emptyList(), includeNames: Boolean = true,
        pages: List<VoiciLockedNames.RingPage> = emptyList(),
    ) = VoiciLockedNames.build("Alice", now, includeNames, nicknames, blocked, forgotten, records, missed, pages, secret)

    // ── the builder ──

    @Test fun aNicknameWithARecentCallIsKeptByAHashOfThePseudonym() {
        val t = build(nicknames = mapOf(mom to "Mom", dad to "Dad"), records = listOf(call(mom, now - day)))
        assertEquals("alice", t.account)
        assertEquals(mapOf(VoiciRings.lockedNameKey(mom) to VoiciLockedName("Mom", now - day)), t.names)
        assertFalse(t.toString().contains(mom))
        assertEquals("Mom", VoiciLockedNames.name(mom, t, "alice", now))
        assertNull(VoiciLockedNames.name(dad, t, "alice", now))
        assertNull(VoiciLockedNames.name(mom, t, "bob", now))
    }

    @Test fun aMissedCallCountsAFailedOneDoesNot() {
        val missed = VoiciMissedCallRow("c1", dad.take(32), dad, "no-answer", now - 2 * day, false)
        val t = build(nicknames = mapOf(mom to "Mom", dad to "Dad"), records = listOf(call(mom, now - day, "failed")), missed = listOf(missed))
        assertNull(VoiciLockedNames.name(mom, t, "alice", now))
        assertEquals("Dad", VoiciLockedNames.name(dad, t, "alice", now))
    }

    @Test fun blockedForgottenAnonymousAndOldCallersAreLeftOut() {
        val anon = "04" + "cd".repeat(64)
        val old = "c3".repeat(32)
        val gone = "d4".repeat(32)
        val t = build(
            nicknames = mapOf(mom to "Mom", anon to "Anon", old to "Old", gone to "Gone"), blocked = setOf(mom),
            forgotten = mapOf("x" to MessagesForgotten(now, gone)),
            records = listOf(call(mom, now), call(anon, now), call(old, now - 91 * day), call(gone, now)),
        )
        assertTrue(t.names.isEmpty())
        assertTrue(build(nicknames = mapOf(mom to "Mom"), records = listOf(call(mom, now)), includeNames = false).names.isEmpty())
    }

    @Test fun fiftyNewestOfEachKind() {
        val nicknames = HashMap<String, String>()
        val records = ArrayList<VoiciCallRecord>()
        val pages = ArrayList<VoiciLockedNames.RingPage>()
        for (i in 0 until 60) {
            val pub = "%064x".format(i + 1)
            nicknames[pub] = "N$i"
            records += call(pub, now - i * 1000L)
            pages += VoiciLockedNames.RingPage("page-$i", "%032x".format(i + 1), now - i * 1000L)
        }
        val t = build(nicknames = nicknames, records = records, pages = pages)
        assertEquals(50, t.names.size)
        assertEquals(50, t.rings.size)
        assertNotNull(VoiciLockedNames.name("%064x".format(1), t, "alice", now))
        assertNull(VoiciLockedNames.name("%064x".format(60), t, "alice", now))
    }

    @Test fun aRingBackIsNamedByItsTagOnly() {
        val t = build(pages = listOf(VoiciLockedNames.RingPage("brisk-quartz", pageA, now - day)))
        val key = VoiciRings.deriveRingTagKey(secret, pageA)
        val ringId = "5c".repeat(16)
        val tag = VoiciRings.ringTag(key, ringId)!!
        assertEquals(VoiciCallTarget("brisk-quartz", pageA), VoiciLockedNames.ringPage(ringId, tag, t, now))
        assertNull(VoiciLockedNames.ringPage("6d".repeat(16), tag, t, now))
        assertNull(VoiciLockedNames.ringPage(ringId, null, t, now))
        assertNull(VoiciLockedNames.ringPage(ringId, tag, t, now + 91 * day))
    }

    @Test fun theRingPushCarriesItsTag() {
        val base = mapOf("category" to "voici-ring", "ringId" to "5c".repeat(16), "hint" to "aGludA==")
        assertEquals("ab".repeat(16), VoiciRingPush.parse(base + ("tag" to "ab".repeat(16)))?.tag)
        assertNull(VoiciRingPush.parse(base + ("tag" to "AB"))?.tag)
        assertNull(VoiciRingPush.parse(base)?.tag)
    }

    // ── never in a backup or a device transfer ──

    @Test fun theTableIsExcludedFromCloudBackupAndDeviceTransfer() {
        val res = File("src/main/res/xml/data_extraction_rules.xml").takeIf { it.exists() } ?: File("app/src/main/res/xml/data_extraction_rules.xml")
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(res)
        for (section in listOf("cloud-backup", "device-transfer")) {
            val el = doc.getElementsByTagName(section).item(0) as org.w3c.dom.Element
            val excl = el.getElementsByTagName("exclude")
            val paths = (0 until excl.length).map { (excl.item(it) as org.w3c.dom.Element).let { e -> e.getAttribute("domain") to e.getAttribute("path") } }
            assertTrue(section, ("file" to "${KeystoreLockedNamesStore.DIR}/") in paths)
        }
        val manifest = (File("src/main/AndroidManifest.xml").takeIf { it.exists() } ?: File("app/src/main/AndroidManifest.xml")).readText()
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(manifest.contains("android:allowBackup=\"false\""))
    }

    // ── the center: rebuild and erasure ──

    private val ctx: Context get() = ApplicationProvider.getApplicationContext()
    private val umk = ByteArray(32) { 1 }
    private val root = ByteArray(32) { 2 }

    private fun world(): Triple<MockVoiciClient, VoiciCenter, MemoryLockedNamesStore> {
        val mock = MockVoiciClient()
        mock.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), VoiciJs.hex(VoiciJs.edPub(root)))
        mock.accounts["bob"] = VoiciAccountKeys("ef".repeat(32), VoiciJs.hex(VoiciJs.edPub(ByteArray(32) { 6 })))
        val store = MemoryLockedNamesStore()
        val settings = VoiciLockedNamesSettings(ctx.getSharedPreferences("locked-names-test-${System.nanoTime()}", Context.MODE_PRIVATE))
        val center = VoiciCenter(mock, LockedNamesKeys("alice", umk, root, true, ByteArray(32) { 3 }), VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), callKeyVault = MemoryCallKeyVault(), lockedNames = store, lockedNamesSettings = settings)
        return Triple(mock, center, store)
    }

    private suspend fun bobsPage(mock: MockVoiciClient): String {
        val bob = VoiciCenter(mock, LockedNamesKeys("bob", ByteArray(32) { 7 }, ByteArray(32) { 6 }, true, ByteArray(32) { 8 }), VoiciVault(MemoryVoiciVaultStore()),
            { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
        bob.refresh()
        bob.acceptRules()
        assertTrue(bob.publish("test"))
        return VoiciPage.parseVoiciPageIndex(mock.storedIndex("bob"))!!.body.pageId
    }

    @Test fun aCallBackSendsItsTagKeyAndNamesTheLockedRing() = runBlocking {
        val (mock, a, store) = world()
        val pid = bobsPage(mock)
        a.refresh()
        a.setShowNamesWhileLocked(true)
        assertNull(a.setCallBack(pid, true))
        val key = VoiciRings.deriveRingTagKey(VoiciMessages.deriveMessagesSecret(umk), pid)
        assertEquals(VoiciJs.hex(key), mock.ringTagKeys.values.single())
        a.recordCall(VoiciCallRecord(id = "o1", callId = "o1", direction = "out", outcome = "answered", peerUsername = "bob", peerPageId = pid, at = System.currentTimeMillis()))
        assertEquals("bob", store.load("alice")!!.rings[VoiciJs.hex(key)]?.u)
        val ringId = "5c".repeat(16)
        assertEquals(VoiciCallTarget("bob", pid), a.lockedRingPage(ringId, VoiciRings.ringTag(key, ringId)))
        // Stop call-backs: the page leaves the table at once.
        assertNull(a.setCallBack(pid, false))
        assertTrue(store.load("alice")!!.rings.isEmpty())
    }

    @Test fun aNicknameShowsOnlyWithTheAnswerSwitch() = runBlocking {
        val (_, a, store) = world()
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        a.setShowNamesWhileLocked(true)
        // The answer switch is offered here but off: the names switch is hidden, so it turns itself off.
        a.recordCall(call(mom, System.currentTimeMillis()))
        assertFalse(a.page.value.showsNamesWhileLocked)
        assertNull(store.load("alice"))
        assertNull(a.setAnswerWhileLocked(true))
        assertTrue(a.shouldOfferNamesSheet())
        a.namesSheetAnswered(true)
        assertFalse(a.shouldOfferNamesSheet())
        assertNull(a.rename(mom, "Mom"))
        assertEquals("Mom", a.lockedNickname(mom))
        // Off with the answer switch (D2): the table is erased.
        assertNull(a.setAnswerWhileLocked(false))
        assertFalse(a.page.value.showsNamesWhileLocked)
        assertNull(store.load("alice"))
        assertNull(a.lockedNickname(mom))
    }

    @Test fun theSwitchOffAndSignOutErase() = runBlocking {
        val (_, a, store) = world()
        a.refresh()
        a.setShowNamesWhileLocked(true)
        assertNotNull(store.load("alice"))
        a.setShowNamesWhileLocked(false)
        assertNull(store.load("alice"))
        a.setShowNamesWhileLocked(true)
        assertNotNull(store.load("alice"))
        // Sign out, Remove this device and account gone all run forgetLocal.
        a.forgetLocal()
        assertNull(store.load("alice"))
        assertFalse(a.page.value.showsNamesWhileLocked)
    }
}
