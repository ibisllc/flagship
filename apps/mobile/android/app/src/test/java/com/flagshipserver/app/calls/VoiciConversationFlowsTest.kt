// Call-backs, the owner's ring, delete and reveal (docs/voici-calls.md, owner 2026-11-15/16) through the app against
// the in-memory `.com` (MockVoiciClient checks the ring-back order, the ring, the delete and keeps the inbox flags):
// "Call and allow call-back" attaches the channel and the owner's inbox flags it; the caller's app opens the owner's
// ring hint for that page only; the owner's delete forgets the conversation; the caller's reveal shows on the owner's
// side only when it checks under the caller's own page key, and an unreveal removes it.

package com.flagshipserver.app.calls

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.CallVisitorOutcome
import com.flagshipserver.app.core.voici.MemoryVoiciVaultStore
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciIntegrity
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciKeyring
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciVault
import com.flagshipserver.app.core.voici.VoiciVectorsTest
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class K(val user: String, val umkSeed: ByteArray, val rootSeed: ByteArray, val deviceSeed: ByteArray) : VoiciKeyring {
    override fun username() = user
    override fun umk() = umkSeed
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = true
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = rootSeed to "admin-root"
    override fun device() = VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(VoiciJs.edPub(deviceSeed)), Ed25519Sign(deviceSeed))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = user
}

class VoiciConversationFlowsTest {
    private val aliceUmk = ByteArray(32) { 1 }
    private val aliceRoot = ByteArray(32) { 2 }
    private val bobUmk = ByteArray(32) { 9 }
    private val bobRoot = ByteArray(32) { 8 }
    private val sdp: String by lazy {
        val v = Json.parseToJsonElement(VoiciVectorsTest.vectorsFile("packages/protocol/test-vectors/voici-calls/vectors.json").readText()).jsonObject
        VoiciJs.str((v["sdp"] as JsonObject)["offerRaw"])!!
    }

    private fun center(mock: MockVoiciClient, k: K) =
        VoiciCenter(mock, k, VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    private class World(val mock: MockVoiciClient, val alice: VoiciCenter, val bob: VoiciCenter, val pageId: String, val conv: String)

    /** alice's page takes calls; bob (who has a page of his own) wrote to it once. */
    private fun world(): World = runBlocking {
        val mock = MockVoiciClient()
        mock.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), VoiciJs.hex(VoiciJs.edPub(aliceRoot)))
        mock.accounts["bob"] = VoiciAccountKeys("dd".repeat(32), VoiciJs.hex(VoiciJs.edPub(bobRoot)))
        val alice = center(mock, K("alice", aliceUmk, aliceRoot, ByteArray(32) { 3 }))
        alice.refresh()
        alice.edit("accept-messages", accepts = 1)
        alice.acceptRules()
        assertTrue(alice.publish("test"))
        assertTrue(alice.setCalls(true, VoiciCallSettings.FROM_CALLBACK, "test"))
        val bob = center(mock, K("bob", bobUmk, bobRoot, ByteArray(32) { 7 }))
        bob.refresh()
        bob.acceptRules()
        assertTrue(bob.publish("test"))
        val pageId = VoiciPage.parseVoiciPageIndex(mock.storedIndex("alice"))!!.body.pageId
        mock.visitorWrites("alice", bobUmk, "Hello Alice")
        alice.refreshInbox()
        World(mock, alice, bob, pageId, alice.messages.value.conversations.single().conv)
    }

    @Test fun callAndAllowCallBackAttachesTheChannelAndTheInboxFlagsIt() = runBlocking {
        val w = world()
        // The owner's inbox said this conversation has no channel: Call back starts disabled.
        assertTrue(w.conv in w.alice.ringBackOff())
        val call = w.bob.outgoingCall(VoiciCallTarget("alice", w.pageId), false, VoiciIntegrity.NONE, object : CallMediaEngine by StubCallMediaEngine() {
            override suspend fun offer(video: Boolean) = sdp
        }, object : VoiciCallerRoom {
            override fun connect(url: String, onMessage: (String) -> Unit, onClosed: () -> Unit) {}
            override fun send(text: String) {}
            override fun close() {}
        }, object : VoiciCallHandoffPipe {
            override suspend fun deliver(sid: String, sealed: com.flagshipserver.app.core.voici.VoiciCallHandoffSealed, openBrowser: () -> Unit) {}
        }, allowCallBack = true) {}
        call.start()
        assertEquals(VoiciOutgoingState.Ringing, call.state.value)
        assertEquals("attach", VoiciJs.str((w.mock.ringBackOrders.single()["order"] as JsonObject)["op"]))
        assertTrue(w.conv in w.mock.ringBacks)
        assertTrue(w.bob.callBackPages().contains(w.pageId))
        // A new item from that conversation carries the flag: Call back is on again.
        w.mock.visitorWrites("alice", bobUmk, "Call me", seq = 2)
        w.alice.refreshInbox()
        assertTrue(w.conv !in w.alice.ringBackOff())
        // Stop call-backs: the channel goes.
        assertNull(w.bob.setCallBack(w.pageId, false))
        assertTrue(w.conv !in w.mock.ringBacks)
    }

    @Test fun theCallersAppOpensTheOwnersRingForThatPageOnly() = runBlocking {
        val w = world()
        w.mock.ringBacks += w.conv
        w.bob.recordSignIn(w.pageId, "alice", "04" + "11".repeat(64), JsonObject(emptyMap()))
        assertTrue(w.alice.callVisitor(w.conv, video = true) is CallVisitorOutcome.Ringing)
        val ring = w.mock.rings.single()
        val hint = w.bob.openRingHint(VoiciJs.str(ring["ringId"])!!, VoiciJs.str(ring["hint"])!!)
        assertNotNull(hint)
        assertEquals(VoiciCallTarget("alice", w.pageId), hint!!.target)
        assertTrue(hint.video)
        // Another ring id (or another account's thread key) opens nothing.
        assertNull(w.bob.openRingHint("ab".repeat(16), VoiciJs.str(ring["hint"])!!))
        assertNull(w.alice.openRingHint(VoiciJs.str(ring["ringId"])!!, VoiciJs.str(ring["hint"])!!))
    }

    @Test fun aCallerWhoNeverWroteIsRungBackWithTheThreadKeyFromTheirCall() = runBlocking {
        val w = world()
        // carol called alice's page with call-back on, but never wrote: alice has no conversation with her.
        val carolUmk = ByteArray(32) { 5 }
        val carol = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(carolUmk, w.pageId)
        val conv = com.flagshipserver.app.core.voici.VoiciMessages.voiciConv(w.pageId, carol.pseudonymPub)
        assertTrue(w.alice.messages.value.conversations.none { it.conv == conv })
        // Without the thread key there is nothing to seal the hint to.
        assertEquals(CallVisitorOutcome.Failed("not-found"), w.alice.callVisitor(conv))
        // No channel at `.com`: refused, and Call back goes off for that conversation.
        assertEquals(CallVisitorOutcome.NoCallBack, w.alice.callVisitor(conv, threadPub = carol.threadPub))
        assertTrue(conv in w.alice.ringBackOff())
        // With the channel the ring goes out, sealed to carol's thread key.
        w.mock.ringBacks += conv
        assertTrue(w.alice.callVisitor(conv, video = false, threadPub = carol.threadPub) is CallVisitorOutcome.Ringing)
        val ring = w.mock.rings.last()
        assertEquals(conv, VoiciJs.str(ring["conv"]))
        val carolCenter = center(w.mock, K("carol", carolUmk, ByteArray(32) { 6 }, ByteArray(32) { 4 }))
        carolCenter.recordSignIn(w.pageId, "alice", "04" + "11".repeat(64), JsonObject(emptyMap()))
        assertNotNull(carolCenter.openRingHint(VoiciJs.str(ring["ringId"])!!, VoiciJs.str(ring["hint"])!!))
    }

    @Test fun deleteForgetsTheConversationOnBothSides() = runBlocking {
        val w = world()
        var asked = 0
        assertNull(w.alice.deleteConversation(w.conv) { asked++; true })
        assertEquals("The biometric prompt is asked once, before anything is sent.", 1, asked)
        assertEquals("owner", VoiciJs.str((w.mock.convDeletes.single()["del"] as JsonObject)["side"]))
        assertTrue(w.alice.messages.value.conversations.none { it.conv == w.conv } || w.alice.messages.value.conversations.isEmpty())
        // The caller deletes its side too: a delete signed by its pseudonym.
        assertNull(w.bob.deleteVisitorConversation(VoiciCallTarget("alice", w.pageId)) { true })
        assertEquals("caller", VoiciJs.str((w.mock.convDeletes.last()["del"] as JsonObject)["side"]))
    }

    /** A cancelled biometric / device-credential prompt deletes nothing and sends nothing, on either side
     *  (docs/voici-calls.md "Deleting a conversation"). */
    @Test fun deleteWithACancelledPromptDeletesNothing() = runBlocking {
        val w = world()
        assertNull(w.alice.accept(w.conv))
        w.alice.syncState()
        assertEquals(VoiciCenter.DELETE_NOT_CONFIRMED, w.alice.deleteConversation(w.conv) { false })
        assertTrue(w.mock.convDeletes.isEmpty())
        assertTrue(w.alice.messages.value.conversations.any { it.conv == w.conv })
        assertTrue(w.conv in w.alice.messages.value.state.accepted)
        assertTrue(w.conv !in w.alice.messages.value.state.forgotten)
        assertEquals(VoiciCenter.DELETE_NOT_CONFIRMED, w.bob.deleteVisitorConversation(VoiciCallTarget("alice", w.pageId)) { false })
        assertTrue(w.mock.convDeletes.isEmpty())
        // Passed, the same deletes go through.
        assertNull(w.alice.deleteConversation(w.conv) { true })
        assertNull(w.bob.deleteVisitorConversation(VoiciCallTarget("alice", w.pageId)) { true })
        assertEquals(2, w.mock.convDeletes.size)
    }

    /** Delete = forget on every device (docs/voici-and-messages.md §10.1.1): the owner's second device, still on the old
     *  state, syncs after the delete; the conversation is gone on both and stays gone. */
    @Test fun deleteForgetsTheConversationOnTheOwnersOtherDevices() = runBlocking {
        val w = world()
        val pseudonym = w.alice.messages.value.conversations.single().pseudonymPub
        assertNull(w.alice.accept(w.conv))
        assertNull(w.alice.rename(pseudonym, "Bob"))
        w.alice.syncState()
        val alice2 = center(w.mock, K("alice", aliceUmk, aliceRoot, ByteArray(32) { 5 }))
        alice2.refresh()
        assertTrue(alice2.messages.value.conversations.any { it.conv == w.conv })
        assertTrue(w.conv in alice2.messages.value.state.accepted)
        assertTrue(w.conv in alice2.ringBackOff())

        assertNull(w.alice.deleteConversation(w.conv) { true })
        w.alice.syncState()
        // The second device marks it read on its old copy, then syncs (a conflict and a merge).
        alice2.markRead(w.conv)
        alice2.syncState()
        alice2.refresh()
        w.alice.syncState()
        for (d in listOf(w.alice, alice2)) {
            val m = d.messages.value
            assertTrue(m.conversations.none { it.conv == w.conv })
            assertTrue(w.conv !in m.state.accepted && w.conv !in m.state.archived && w.conv !in m.state.readUpTo)
            assertNull(m.state.nicknames[pseudonym])
            assertTrue(w.conv !in d.ringBackOff())
        }
        // Stays gone after another round on both.
        alice2.refresh()
        w.alice.refresh()
        assertTrue(alice2.messages.value.conversations.none { it.conv == w.conv })
        assertTrue(w.conv !in alice2.messages.value.state.accepted)
        // The same caller writing again is a new request, and accepting it sticks against the marker.
        w.mock.visitorWrites("alice", bobUmk, "Hello again", seq = 2)
        alice2.refreshInbox()
        assertTrue(alice2.messages.value.isRequest(alice2.messages.value.conversations.single { it.conv == w.conv }))
        assertNull(alice2.accept(w.conv))
        alice2.syncState()
        w.alice.refresh()
        assertTrue(w.conv in w.alice.messages.value.state.accepted)
    }

    @Test fun theRevealShowsOnlyWhenItChecksAndAnUnrevealRemovesIt() = runBlocking {
        val w = world()
        val alicePage = VoiciCallTarget("alice", w.pageId)
        val thread = w.bob.visitorThread(alicePage)!!
        assertEquals(listOf("Hello Alice"), thread.messages.map { it.text })
        assertNull(w.bob.setReveal(alicePage, true))
        w.alice.refreshInbox()
        val shown = w.alice.reveal(w.conv)
        assertNotNull(shown)
        assertEquals("bob", shown!!.username)
        // The control is never shown as a message.
        assertEquals(1, w.alice.messages.value.conversations.single().ordered.size)
        assertNull(w.bob.setReveal(alicePage, false))
        w.alice.refreshInbox()
        assertNull(w.alice.reveal(w.conv))
        // A message the caller writes from the app arrives as text in the same conversation.
        assertNull(w.bob.sendAsVisitor(alicePage, "From the app"))
        w.alice.refreshInbox()
        assertTrue(w.alice.messages.value.conversations.single().ordered.any { it.text == "From the app" })
    }

    /** Owner decision 2026-11-16: call hours sync between the owner's devices, sealed, never in the page. */
    @Test fun callHoursSyncSealedBetweenTheOwnersDevices() = runBlocking {
        val w = world()
        val hours = com.flagshipserver.app.core.voici.VoiciCallHours("1111100", "0900", "1730", "Europe/Paris")
        assertTrue(w.alice.setCallHours(hours))
        val blob = w.mock.callSettingsBlobs["alice"]!!
        assertTrue("`.com` holds ciphertext only", !blob.toString().contains("Europe/Paris"))
        assertTrue("the page index carries no hours", !w.mock.storedIndex("alice").toString().contains("Paris"))
        // Another device of the account reads the same hours and keeps a copy for a locked phone.
        val tablet = center(w.mock, K("alice", aliceUmk, aliceRoot, ByteArray(32) { 4 }))
        var kept: com.flagshipserver.app.core.voici.VoiciCallHours? = null
        tablet.onCallHours = { kept = it }
        tablet.refreshCallHours()
        assertEquals(hours, kept)
        // A write from a device that missed the newer version merges (newer wins) and lands as the next version.
        assertTrue(tablet.setCallHours(null))
        assertTrue(w.alice.setCallHours(hours))
        assertEquals(3L, VoiciJs.time(w.mock.callSettingsBlobs["alice"]!!["version"]))
    }
}
