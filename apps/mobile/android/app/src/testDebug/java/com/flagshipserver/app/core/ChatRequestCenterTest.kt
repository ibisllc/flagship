// App chat requests (N08): the phone lists every box's held requests, raises one dialog each,
// and answers with an owner-signed flagship/chat-approval/v1; Ask me each time ends an Always
// allow without a signature. The sender is only ever a claim.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ChatAlwaysRevokeBody
import com.flagshipserver.app.api.ChatAlwaysWire
import com.flagshipserver.app.api.ChatAppIdentity
import com.flagshipserver.app.api.ChatRequestWire
import com.flagshipserver.app.api.MockScreensClient
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatRequestCenterTest {
    private val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val issuedAt = 1_760_000_000_000L

    private fun setup(canAnswer: Boolean = true, alerts: Boolean = true): Pair<ChatRequestCenter, MockScreensClient> {
        val screens = MockScreensClient().apply { seedChat() }
        val box = AccessBox("pod-1", "home.bright-maple.flagship.services", screens)
        val reasons = mutableListOf<String>()
        val center = ChatRequestCenter(
            boxes = { listOf(box) },
            canAnswer = { canAnswer },
            alertsEnabled = { alerts },
            signer = { r -> reasons += r; Ed25519Sign(kp.privateKey) },
            now = { issuedAt },
        )
        return center to screens
    }

    @Test fun theSenderIsAClaimAndNotesSayWhatTheAnswerDoes() = runBlocking {
        val (center, _) = setup()
        val l = center.load()
        val incoming = l.requests.first { it.kind == ChatApproval.Kind.INCOMING }
        assertEquals(
            "A remote machine claiming to run riverside/garden-club wants to start a chat with your app plants.",
            ChatText.title(incoming),
        )
        val notes = ChatText.notes(incoming)
        assertTrue(notes.first().startsWith("Flagship can't confirm who runs that machine."))
        assertTrue(notes.contains("The sender's recognition phrase: blue heron"))
        assertTrue(notes.contains("It asked 2 times."))
        val outgoing = l.requests.first { it.kind == ChatApproval.Kind.OUTGOING }
        assertEquals("Your app wiki wants to start a chat with northwind/atlas, an app on another owner's server.", ChatText.title(outgoing))
    }

    @Test fun malformedEntriesAreDropped() {
        val box = AccessBox(null, "home.x.flagship.services", MockScreensClient())
        val (items, apps) = ChatText.read(
            box,
            listOf(
                ChatRequestWire("a", "sideways", ChatAppIdentity("x", "y"), ChatAppIdentity("a", "b")),
                ChatRequestWire("", "incoming", ChatAppIdentity("x", "y"), ChatAppIdentity("a", "b")),
                ChatRequestWire("b", "incoming", null, ChatAppIdentity("a", "b")),
                ChatRequestWire("c", "incoming", ChatAppIdentity("x", "y"), ChatAppIdentity("a", "b"), count = 0),
            ),
            listOf(
                ChatAlwaysWire(ChatAppIdentity("ok", "app"), ChatAppIdentity("them", "bot")),
                ChatAlwaysWire(ChatAppIdentity("bad name", "app"), ChatAppIdentity("them", "bot")),
                ChatAlwaysWire(ChatAppIdentity("ok", "app"), null),
            ),
        )
        assertEquals(listOf("c"), items.map { it.requestId })
        assertEquals(1, items.single().count)
        assertEquals(listOf("ok"), apps.map { it.app.author })
        assertEquals("them/bot → app", ChatText.alwaysTitle(apps.single()))
    }

    @Test fun allowSignsTheApprovalForThisBoxAndRequest() = runBlocking {
        val (center, screens) = setup()
        val r = center.load().requests.first { it.kind == ChatApproval.Kind.INCOMING }
        assertNull(center.answer(r, ChatApproval.Decision.ALLOW))
        val sent = screens.chatAnswers.single()
        assertEquals("allow", sent.decision)
        assertEquals("incoming", sent.kind)
        assertEquals(issuedAt, sent.issuedAt)
        Ed25519Verify(kp.publicKey).verify(
            HexUtil.decode(sent.signature)!!,
            ChatApproval.canonicalBytes(screens.boxFqdn(), r.requestId, r.kind, ChatApproval.Decision.ALLOW, issuedAt),
        )
        assertTrue(center.listing.value.requests.none { it.requestId == r.requestId })
    }

    @Test fun alwaysAllowIsPerSenderAndAskMeEachTimeEndsThatOne() = runBlocking {
        val (center, screens) = setup()
        // Another sender's Always allow to the same app stays when this one ends.
        screens.chatAlwaysFixture += ChatAlwaysWire(ChatAppIdentity("bright-maple", "plants"), ChatAppIdentity("hilltop", "seeds"))
        val r = center.load().requests.first { it.kind == ChatApproval.Kind.INCOMING }
        assertNull(center.answer(r, ChatApproval.Decision.ALWAYS))
        assertEquals(2, center.load().always.size)
        val always = center.listing.value.always.first { it.sender.author == "riverside" }
        assertEquals(ChatAppIdentity("bright-maple", "plants"), always.app)
        assertEquals("riverside/garden-club → plants", ChatText.alwaysTitle(always))
        assertEquals(
            "A remote machine claiming to run riverside/garden-club can start a chat with plants without asking you.",
            ChatText.alwaysLine(always),
        )
        assertNull(center.revoke(always))
        assertEquals(
            listOf(ChatAlwaysRevokeBody("bright-maple", "plants", ChatAppIdentity("riverside", "garden-club"))),
            screens.chatRevokes,
        )
        assertEquals(listOf("hilltop"), center.load().always.map { it.sender.author })
    }

    @Test fun alwaysIsNeverSentForAnOutgoingRequest() = runBlocking {
        val (center, screens) = setup()
        val out = center.load().requests.first { it.kind == ChatApproval.Kind.OUTGOING }
        assertNull(center.answer(out, ChatApproval.Decision.ALWAYS))
        assertTrue(screens.chatAnswers.isEmpty())
    }

    @Test fun theDialogAsksEachRequestInTurn() = runBlocking {
        val (center, screens) = setup()
        assertEquals(2, center.refresh())
        val first = center.shown.value!!
        assertEquals(ChatRequestCenter.Phase.Asking, first.phase)
        center.answerShown(ChatApproval.Decision.DENY)
        assertEquals(ChatRequestCenter.Phase.Done("Chat request denied"), center.shown.value!!.phase)
        center.close()
        val second = center.shown.value!!
        assertTrue(second.item.requestId != first.item.requestId)
        center.notNow()
        assertNull(center.shown.value)
        assertEquals("not now keeps it on the box", 1, screens.chatFixture.size)
        assertEquals(0, center.refresh())
        assertNull("snoozed for a day", center.shown.value)
    }

    @Test fun aRequestAnsweredElsewhereSaysSoAndLeaves() = runBlocking {
        val (center, screens) = setup()
        val r = center.load().requests.first()
        screens.chatFixture.clear()
        assertEquals("That request is no longer waiting.", center.answer(r, ChatApproval.Decision.ALLOW))
        assertTrue(center.listing.value.requests.none { it.key == r.key })
    }

    @Test fun aDeviceThatCantSignSeesTheListButNoDialog() = runBlocking {
        val (center, _) = setup(canAnswer = false)
        assertEquals(0, center.refresh())
        assertNull(center.shown.value)
        assertEquals(2, center.listing.value.requests.size)
        val (quiet, _) = setup(alerts = false)
        assertEquals(0, quiet.refresh())
        assertNull(quiet.shown.value)
    }
}
