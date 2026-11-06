// The page's controls (docs/voici-and-messages.md §3.3, §11): the public-warning steps, and VoiciCenter's Public
// switch, quick name edit and "Remove my page" against MockVoiciClient (which runs `.com`'s checks, including
// checkVoiciPageRemove). Mirrors iOS PageControlsTests.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class Keys(val admin: Boolean, val root: ByteArray) : VoiciKeyring {
    private val umk = ByteArray(32) { 1 }
    private val deviceSeed = ByteArray(32) { 3 }
    override fun username() = "alice"
    override fun umk() = umk
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = admin
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = root to "admin-root"
    override fun device() = VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(VoiciJs.edPub(deviceSeed)), Ed25519Sign(deviceSeed))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = "Private label"
}

class PageControlsTest {
    private val root = ByteArray(32) { 2 }
    private val rootPub = VoiciJs.hex(VoiciJs.edPub(root))
    private val mock = MockVoiciClient().also { it.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), rootPub) }
    private val store = MemoryVoiciVaultStore()

    private fun center(admin: Boolean = true, vault: VoiciVaultStore = store) =
        VoiciCenter(mock, Keys(admin, root), VoiciVault(vault), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    private fun stored() = mock.storedIndex("alice")?.let(VoiciPage::parseVoiciPageIndex)

    /** Rules and the warning answered, as the dialogs do. */
    private suspend fun ready(c: VoiciCenter) {
        c.refresh()
        c.acceptRules()
        c.acknowledgePublicWarning()
    }

    @Test fun warningSteps() {
        assertEquals(PagePublicStep.Refuse, PagePublicStep.next(isAdmin = false, rulesAccepted = true, acknowledged = true))
        assertEquals(PagePublicStep.Rules, PagePublicStep.next(isAdmin = true, rulesAccepted = false, acknowledged = true))
        assertEquals(PagePublicStep.Warning, PagePublicStep.next(isAdmin = true, rulesAccepted = true, acknowledged = false))
        assertEquals(PagePublicStep.Publish, PagePublicStep.next(isAdmin = true, rulesAccepted = true, acknowledged = true))
    }

    @Test fun theWarningIsRememberedForTheAccountOnThisDevice() = runBlocking {
        val c = center()
        c.refresh()
        c.acceptRules()
        assertEquals(PagePublicStep.Warning, c.publicStep())
        c.acknowledgePublicWarning()
        assertEquals(PagePublicStep.Publish, c.publicStep())
        val again = center()
        again.refresh()
        assertEquals("a relaunch remembers it", PagePublicStep.Publish, again.publicStep())
        assertEquals("another device asks again", PagePublicStep.Warning, center(vault = MemoryVoiciVaultStore()).also { it.refresh(); it.acceptRules() }.publicStep())
    }

    @Test fun switchOnPublishesTheNameAndLeavesOtherDraftsAsDrafts() = runBlocking {
        val c = center()
        ready(c)
        assertEquals("the first page carries the username, never a private label", "alice", c.page.value.working!!.profile.displayName)
        assertNull(c.setQuickProfile("Bright Maple", null, "test"))
        assertEquals("before the page is public a name change is a draft", 1, c.page.value.pendingCount)
        assertEquals(0, mock.publishCount)
        c.edit("post-add", post = VoiciPost(VoiciOwner.randomHex(16), System.currentTimeMillis(), null, "Not yet.", emptyList()))
        assertTrue(c.goPublic("test"))
        assertTrue(c.page.value.isPublic)
        assertEquals(1L, stored()!!.body.seq)
        assertEquals("Bright Maple", c.page.value.published!!.profile.displayName)
        assertTrue("the post draft was not published", c.page.value.published!!.chunks.flatten().isEmpty())
        assertEquals("only the post waits", 1, c.page.value.pendingCount)

        assertNull(c.setQuickProfile("Maple", null, "test"))
        assertEquals("while public the quick edit publishes at once, and only that", 2L, stored()!!.body.seq)
        assertEquals("Maple", c.page.value.published!!.profile.displayName)
        assertEquals(1, c.page.value.pendingCount)

        assertTrue(c.publish("test"))
        assertEquals(3L, stored()!!.body.seq)
        assertEquals(listOf("Not yet."), c.page.value.published!!.chunks.flatten().map { it.text })
        assertEquals(0, c.page.value.pendingCount)
    }

    @Test fun editsAreDraftsUntilPublishAndSettingBackDropsTheDraft() = runBlocking {
        val c = center()
        ready(c)
        assertTrue(c.goPublic("test"))
        val before = mock.publishCount
        c.edit("accept-messages", accepts = 1)
        c.refresh()
        assertEquals("neither the edit nor a refresh publishes", before, mock.publishCount)
        assertEquals(1, c.page.value.pendingCount)
        c.edit("accept-messages", accepts = 0)
        assertEquals(0, c.page.value.pendingCount)
    }

    @Test fun removeSignsTheNextSeqAndRepublishingContinuesTheLadder() = runBlocking {
        val c = center()
        ready(c)
        c.setQuickProfile("Bright Maple", null, "test")
        assertTrue(c.goPublic("test"))
        c.edit("post-add", post = VoiciPost(VoiciOwner.randomHex(16), System.currentTimeMillis(), null, "Kept here.", emptyList()))
        val idx = stored()!!

        assertTrue(c.removePage("test"))
        assertFalse(c.page.value.isPublic)
        assertTrue(c.page.value.removed)
        val r = VoiciPageRemove.parse(mock.removals.single())!!
        assertEquals(idx.body.seq + 1, r.seq)
        assertEquals(idx.body.pageId, r.pageId)
        assertEquals("signed by the key that signs the index", "admin-root", r.signerKind)
        assertEquals(rootPub, r.signerPub)
        assertNull("visitors see no page", mock.page("alice"))
        assertEquals("drafts stay", 1, c.page.value.pendingCount)

        val again = center()
        again.refresh()
        assertTrue("a relaunch remembers the removal", again.page.value.removed)
        assertEquals("Bright Maple", again.page.value.published!!.profile.displayName)
        assertTrue(again.goPublic("test"))
        assertEquals("republishing takes the removal's seq + 1", r.seq + 1, stored()!!.body.seq)
        assertEquals(idx.body.pageId, stored()!!.body.pageId)
        assertEquals("the page comes back as it was", "Bright Maple", stored()!!.let { VoiciOwner.readPublished(it) { p -> mock.pieces["${it.body.pageId}/${p.sha256}"] } }!!.profile.displayName)
    }

    @Test fun aRemovalElsewhereIsSeenAndAQuickEditDoesNotBringThePageBack() = runBlocking {
        val c = center()
        ready(c)
        assertTrue(c.goPublic("test"))
        val idx = stored()!!
        mock.removed["alice"] = (idx.body.seq + 1) to idx.body.pageId
        c.setQuickProfile("Oak", null, "test")
        assertTrue(c.page.value.removed)
        assertNull("only the Public switch brings a removed page back", mock.page("alice"))
        assertTrue(c.goPublic("test"))
        assertEquals(idx.body.seq + 2, stored()!!.body.seq)
    }

    @Test fun aNewDeviceRepublishesARemovedPageOnItsLadderAndPageId() = runBlocking {
        val c = center()
        ready(c)
        assertTrue(c.goPublic("test"))
        assertTrue(c.removePage("test"))
        val r = VoiciPageRemove.parse(mock.removals.single())!!
        val fresh = center(vault = MemoryVoiciVaultStore())
        ready(fresh)
        assertTrue(fresh.goPublic("test"))
        assertEquals(r.seq + 1, stored()!!.body.seq)
        assertEquals(r.pageId, stored()!!.body.pageId)
    }

    @Test fun removeAfterAnotherAdminPublishedRetriesOnceOnTheNewIndex() = runBlocking {
        val c = center()
        ready(c)
        assertTrue(c.goPublic("test"))
        val other = center(vault = MemoryVoiciVaultStore())
        ready(other)
        other.setQuickProfile("Other device", null, "test")
        assertEquals(2L, stored()!!.body.seq)
        assertTrue(c.removePage("test"))
        assertEquals(3L, VoiciPageRemove.parse(mock.removals.single())!!.seq)
    }

    @Test fun aWipeForgetsTheRemovedPagesCopy() = runBlocking {
        val c = center()
        ready(c)
        assertTrue(c.goPublic("test"))
        assertTrue(c.removePage("test"))
        c.forgetLocal()
        val again = center()
        again.refresh()
        assertNull("nothing of the removed page stays on the device", again.page.value.published)
        assertFalse(again.page.value.removed)
    }

    @Test fun aDeviceWithoutTheAdminKeyCanNeitherPublishNorRemove() = runBlocking {
        val c = center(admin = false)
        c.refresh()
        assertEquals(PagePublicStep.Refuse, c.publicStep())
        assertFalse(c.goPublic("test"))
        assertFalse(c.removePage("test"))
        assertEquals(0, mock.publishCount)
        assertTrue(mock.removals.isEmpty())
    }
}
