// The app side of voi.ci pages and Messages (docs/voici-and-messages.md §5-§11) against the in-memory `.com`
// (MockVoiciClient, which runs chunk A's own checks): an admin device publishes and wins a seq race, a non-admin
// device's change reaches the admin device through the drafts lane, a visitor's message is read and answered (the
// visitor's thread key opens the reply), block/report/rename and the state blob across two devices, the phone
// endpoint's deliver, and "Sign in with Flagship" end to end through a scripted voi.ci tab.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.DeviceCapabilityGrant
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeKeyring(
    val user: String,
    val umkSeed: ByteArray,
    val rootSeed: ByteArray,
    val admin: Boolean,
    val deviceSeed: ByteArray,
    val deviceId: String = "d0".repeat(16),
) : VoiciKeyring {
    override fun username() = user
    override fun umk() = umkSeed
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = admin
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = rootSeed to "admin-root"
    val devicePub: String get() = VoiciJs.hex(VoiciJs.edPub(deviceSeed))
    override fun device() = VoiciDeviceSigner(deviceId, devicePub, Ed25519Sign(deviceSeed))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = "Alice"
}

class VoiciAppTest {
    private val umk = ByteArray(32) { 1 }
    private val root = ByteArray(32) { 2 }
    private val rootPub = VoiciJs.hex(VoiciJs.edPub(root))
    private val visitorUmk = ByteArray(32) { 9 }

    private fun mock() = MockVoiciClient().also { it.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), rootPub) }

    private fun center(mock: MockVoiciClient, k: FakeKeyring) =
        VoiciCenter(mock, k, VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    private fun admin(seed: Byte = 3) = FakeKeyring("alice", umk, root, true, ByteArray(32) { seed })

    private fun post(text: String, at: Long = System.currentTimeMillis()) = VoiciPost(VoiciOwner.randomHex(16), at, null, text, emptyList())

    private fun published(mock: MockVoiciClient, user: String = "alice"): Pair<VoiciPageIndex, VoiciPageState> {
        val idx = VoiciPage.parseVoiciPageIndex(mock.storedIndex(user))!!
        val state = VoiciOwner.readPublished(idx) { mock.pieces["${idx.body.pageId}/${it.sha256}"] }!!
        return idx to state
    }

    @Test fun piecesRoundTripThroughAPublishedIndex() {
        val avatar = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 1, 2, 3)
        val card = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xdb.toByte(), 4, 5)
        val avSha = WebEnvelopes.sha256Hex(avatar)
        val cardSha = WebEnvelopes.sha256Hex(card)
        val state = VoiciPageState(
            VoiciOwner.defaultProfile("Alice").copy(avatar = avSha, links = listOf(VoiciProfileLink("https://github.com/alice", "Code", "github"))),
            1,
            listOf((1..21).map { post("Post $it", 1_000L + it) }.take(20), listOf(post("Last", 5_000).copy(links = listOf(VoiciPostLink("https://example.com/a", VoiciCard("A page", "example.com", "", cardSha)))))),
            0,
        )
        val images = mapOf(avSha to avatar, cardSha to card)
        val plan = VoiciOwner.planPieces(state, { images[it] })
        assertEquals(listOf("profile", "avatar", "chunk-0", "chunk-1", VoiciPage.voiciCardRole(cardSha)), plan.map { it.role })
        val keys = VoiciOwnerKeys.derive(umk, "ab".repeat(16), 1)
        val idx = VoiciPage.signVoiciPageIndex(
            VoiciPageIndexBody("alice", "ab".repeat(16), 1, 1_000, 1, 1, keys.inboxPub, keys.signPub, plan.map { it.ref }, "admin-root"), root,
        )
        assertTrue(VoiciPage.checkVoiciPageIndex(idx.toJson(), "alice", "admin-root", rootPub).ok)
        val bytes = plan.associate { it.sha256 to it.bytes!! }
        val back = VoiciOwner.readPublished(idx) { bytes[it.sha256] }
        assertEquals(state.copy(issuedAt = 1_000), back)
        // An image only the published index knows keeps its listed size.
        val again = VoiciOwner.planPieces(state, { null }, idx.body.pieces)
        assertEquals(plan.map { it.ref }, again.map { it.ref })
        assertNull(again.first { it.role == "avatar" }.bytes)
    }

    @Test fun adminPublishesAndASecondAdminWinsTheSeqRaceByMerging() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.edit("profile", profile = VoiciOwner.defaultProfile("Alice A").copy(bio = "Hi"))
        assertTrue("the first publish waits for the Publish button", a.page.value.publishedSeq == 0L)
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertEquals(1L, published(mock).first.body.seq)
        a.edit("post-add", post = post("First"))
        assertEquals("an edit is a draft until Publish", 1L, published(mock).first.body.seq)
        assertTrue(a.publish("test"))
        assertEquals(2L, published(mock).first.body.seq)
        assertEquals(0, a.page.value.pendingCount)
        assertEquals(2L, a.page.value.publishedSeq)

        // Another admin device that never saw the page publishes a post: 409, merge, seq 3.
        val b = center(mock, admin(4))
        b.edit("post-add", post = post("From B"))
        assertTrue(b.publish("test"))
        val (idx, state) = published(mock)
        assertEquals(3L, idx.body.seq)
        assertEquals(listOf("First", "From B"), state.chunks.flatten().map { it.text })
        assertEquals("Alice A", state.profile.displayName)
        assertEquals(3, mock.publishCount)
    }

    @Test fun aNonAdminDeviceHandsItsChangeToTheAdminThroughTheDraftsLane() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.edit("profile", profile = VoiciOwner.defaultProfile("Alice"))
        assertTrue("the first publish waits for the Publish button", a.page.value.publishedSeq == 0L)
        a.acceptRules()
        assertTrue(a.publish("test"))
        val member = FakeKeyring("alice", umk, root, false, ByteArray(32) { 5 }, deviceId = "d5".repeat(16))
        val now = System.currentTimeMillis()
        val grantBytes = DeviceCapabilityGrant.canonicalBytes("g1", "alice", member.deviceId, member.devicePub, listOf("member"), now - 1000, now + 86_400_000)
        mock.grants["alice"] = listOf(
            JsonObject(
                linkedMapOf(
                    "grantId" to JsonPrimitive("g1"), "username" to JsonPrimitive("alice"), "deviceId" to JsonPrimitive(member.deviceId),
                    "devicePubHex" to JsonPrimitive(member.devicePub), "scopes" to JsonArray(listOf(JsonPrimitive("member"))),
                    "issuedAt" to JsonPrimitive(now - 1000), "expiresAt" to JsonPrimitive(now + 86_400_000),
                    "signatureHex" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(root, grantBytes))), "signerRoot" to JsonPrimitive("admin-root"),
                ),
            ),
        )
        val m = center(mock, member)
        m.refresh()
        assertFalse(m.page.value.canPublish)
        m.edit("post-add", post = post("From the tablet"))
        assertEquals(1, mock.drafts["alice"]!!.size)
        assertEquals(1, m.page.value.pendingCount)
        assertEquals(1L, published(mock).first.body.seq)

        a.refresh()
        assertEquals("the other device's change waits for Publish here", 1L, published(mock).first.body.seq)
        assertEquals(1, a.page.value.pendingCount)
        assertTrue(a.publish("test"))
        assertEquals(listOf("From the tablet"), published(mock).second.chunks.flatten().map { it.text })
        assertEquals(1, mock.consumed.size)
        assertTrue(mock.drafts["alice"]!!.isEmpty())

        m.refresh()
        assertEquals(0, m.page.value.pendingCount)
        assertEquals(listOf("From the tablet"), m.page.value.working!!.chunks.flatten().map { it.text })

        // A draft whose grant names another key is refused by the admin side.
        val forged = VoiciOwner.draftEnvelope(
            VoiciMessages.deriveVoiciDraftsKey(umk), "alice",
            VoiciDraftOp(VoiciOwner.randomHex(16), "post-delete", now, "x", postId = "ab".repeat(16)), VoiciJs.hex(VoiciJs.edPub(ByteArray(32) { 8 })),
            { VoiciJs.edSign(ByteArray(32) { 8 }, it) }, (mock.grants["alice"]!![0].filterKeys { it != "signatureHex" && it != "signerRoot" }).let(::JsonObject),
            VoiciJs.str(mock.grants["alice"]!![0]["signatureHex"])!!, 1,
        )
        val acc = mock.accounts["alice"]!!
        assertEquals("bad-grant", VoiciMessages.checkVoiciDraft(forged.toJson(), "alice", { g, s, p -> VoiciOwner.grantOk(g, s, p, "alice", acc, now) }).code)
    }

    @Test fun aVisitorsMessageIsReadAnsweredBlockedReportedAndTheStateFollowsTheAccount() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.edit("accept-messages", accepts = 1)
        assertTrue("the first publish waits for the Publish button", a.page.value.publishedSeq == 0L)
        a.acceptRules()
        assertTrue(a.publish("test"))
        val sent = mock.visitorWrites("alice", visitorUmk, "Hello, see https://example.com/x.")
        a.refreshInbox()
        val c = a.messages.value.conversations.single()
        assertEquals("Hello, see https://example.com/x.", c.messages.single().text)
        assertTrue(a.messages.value.isRequest(c))
        assertEquals(1, a.messages.value.unreadCount)
        a.markRead(c.conv)
        assertEquals(0, a.messages.value.unreadCount)

        assertNull(a.reply(c.conv, "Thanks!"))
        val reply = mock.sent.last()
        assertEquals("voici-reply", VoiciJs.str(reply["kind"]))
        val v = VoiciVisitorKeys.derive(visitorUmk, published(mock).first.body.pageId)
        val opened = VoiciMessages.openVoiciBody(WebEnvelopes.b64Decode(reply["bodyB64"])!!, c.conv, VoiciJs.str(reply["msgId"])!!, v.thread.seed)
        assertEquals("Thanks!", opened.valueOrNull()!!.text)
        assertFalse(a.messages.value.isRequest(a.messages.value.conversations.single()))

        // The reply comes back from the mailbox on the owner's other device as the owner's own.
        val b = center(mock, FakeKeyring("alice", umk, root, true, ByteArray(32) { 4 }))
        b.refresh()
        val onB = b.messages.value.conversations.single()
        assertEquals(listOf(false, true), onB.ordered.map { it.mine })

        assertNull(a.accept(c.conv))
        assertTrue("Accept is an unblock order at .com", c.conv in mock.accepted)
        assertTrue(c.pseudonymPub !in a.messages.value.state.blocks)
        assertNull(a.rename(c.pseudonymPub, "Bob"))
        assertNull(a.report(c.conv, VoiciJs.str(sent["msgId"])!!, "spam"))
        assertEquals("spam", VoiciJs.str(mock.reports.single()["reason"]))
        assertNull(a.block(c.conv, true))
        assertTrue(c.pseudonymPub in mock.blocks["alice"]!!)
        assertTrue(a.messages.value.visible.isEmpty())

        b.syncState()
        assertEquals("Bob", b.messages.value.state.nicknames[c.pseudonymPub]!!.name)
        assertEquals(listOf(c.pseudonymPub), b.messages.value.state.blocks)
        val blob = mock.states["alice"]!!
        assertNotNull(VoiciMessages.openMessagesState(VoiciMessages.deriveMessagesStateKey(umk), "alice", blob))
    }

    @Test fun thePhoneEndpointAcksAVisitorsMessageOnceAndForwardsIt() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.edit("accept-messages", accepts = 1)
        assertTrue("the first publish waits for the Publish button", a.page.value.publishedSeq == 0L)
        a.acceptRules()
        assertTrue(a.publish("test"))
        val idx = published(mock).first
        assertEquals(PhoneLiveAnswer("alice", idx.body.ownerSignPub), a.phoneLive())
        val env = mock.visitorMessage("alice", visitorUmk, "Direct hello")
        val (status, body) = a.phoneDeliver(env.toString().toByteArray(), "77".repeat(32))
        assertEquals(body, 200, status)
        val ack = (VoiciJs.parseJson(body) as JsonObject)["ack"]
        assertNotNull(VoiciMessages.verifyVoiciAck(ack, idx.body.ownerSignPub, VoiciJs.str(env["msgId"])!!, VoiciJs.str(env["conv"])))
        assertEquals("direct", a.messages.value.conversations.single().messages.single().status)
        assertTrue(mock.inbox["alice"]!!.single().direct)
        assertEquals(409, a.phoneDeliver(env.toString().toByteArray(), "77".repeat(32)).first)
        // A forged signature is refused without an ack.
        val bad = JsonObject(env + ("sig" to JsonPrimitive("00".repeat(64))))
        assertEquals(403, a.phoneDeliver(bad.toString().toByteArray(), "77".repeat(32)).first)
    }

    @Test fun signInWithFlagshipAnswersWhatTheBrowserChecks() = runBlocking {
        val mock = mock()
        val owner = center(mock, admin())
        owner.refresh()
        owner.edit("accept-messages", accepts = 1)
        assertTrue("the first publish waits for the Publish button", owner.page.value.publishedSeq == 0L)
        owner.acceptRules()
        assertTrue(owner.publish("test"))
        val pageId = published(mock).first.body.pageId
        mock.accounts["bob"] = VoiciAccountKeys("dd".repeat(32), null)
        val visitor = FakeKeyring("bob", visitorUmk, ByteArray(32) { 6 }, true, ByteArray(32) { 7 })
        val vc = center(mock, visitor)
        val browserPriv = ByteArray(32) { 0x31 }
        val delivered = ArrayList<ByteArray>()
        val req = VoiciSignInRequest("https://voi.ci", pageId, "alice", VoiciJs.hex(VoiciJs.p256PublicKey(browserPriv)), "cd".repeat(16))
        val pipe = object : VoiciSignInPipe {
            override suspend fun connect(link: VoiciSignInLink) = "123456"
            override suspend fun deliver(answer: ByteArray) {
                delivered += answer
            }
            override fun close() {}
        }
        val flow = VoiciSignInFlow(vc, visitor, pipe, VoiciIntegrity.NONE)
        val link = VoiciSignInLink.parse(
            "https://flagshipserver.com/voici-sign-in#s=abcdefgh12&k=${com.flagshipserver.app.core.Base64URL.encode(ByteArray(32) { 5 })}" +
                "&p=$pageId&u=alice&d=${req.delegatePub}&n=${req.nonce}",
        )!!
        assertEquals(req, link.request("https://voi.ci"))
        flow.start(link)
        val review = flow.phase.value as VoiciSignInPhase.Review
        // A first page carries the account name (the username) until the owner changes it.
        assertEquals("alice", review.displayName)
        flow.approve("test")
        assertEquals(VoiciSignInPhase.Done, flow.phase.value)
        val checked = VoiciMessages.checkVoiciSignInAnswer(VoiciJs.parseJson(delivered.single().decodeToString()), req, listOf(mock.caPub), System.currentTimeMillis())
        assertTrue(checked.code, checked.ok)
        assertEquals("none", VoiciJs.str((mock.attestRequests.single()["request"] as JsonObject)["deviceCheckRef"]))
        // The owner replies; the visitor's app (no push) finds it on its next open and offers the page.
        vc.checkReplies()
        assertTrue(vc.replyNotices.value.isEmpty())
        val visitorConv = VoiciMessages.voiciConv(pageId, VoiciVisitorKeys.derive(visitorUmk, pageId).pseudonymPub)
        mock.visitorWrites("alice", visitorUmk, "Hello from the web")
        owner.refreshInbox()
        assertNull(owner.reply(visitorConv, "Hi back"))
        vc.checkReplies()
        val notice = vc.replyNotices.value.single()
        assertEquals("alice", notice.username)
        val fetch = mock.threadFetches.last()
        assertEquals(visitorConv, VoiciJs.str(fetch["conv"]))
        val del = WebDelegations.parseWebDelegation((fetch["cred"] as JsonObject)["delegation"])!!
        assertEquals("the reader key is delegated by P, not an account key", VoiciVisitorKeys.derive(visitorUmk, pageId).pseudonymPub, del.principalPub)
        vc.openedReply(notice)
        vc.checkReplies()
        assertTrue(vc.replyNotices.value.isEmpty())

        val site = vc.messages.value.state.signedInSites.single()
        assertEquals(req.delegatePub, site.delegatePub)
        // Any refusal is a failed sign-out (the site stays listed), told in its own sentence; 404 included.
        for (status in listOf(404, 403, 500)) {
            mock.revokeRefusal = status to "unknown-delegate"
            assertEquals("sign-out-failed", vc.signOutSite(site))
            assertEquals(1, vc.messages.value.state.signedInSites.size)
        }
        mock.revokeRefusal = 429 to "rate-limited"
        assertEquals("rate-limited", vc.signOutSite(site))
        assertNull(vc.signOutSite(site))
        assertEquals(pageId, VoiciJs.str(mock.revokeBodies.last()["pageId"]))
        assertTrue(req.delegatePub in mock.revoked)
        assertTrue(vc.messages.value.state.signedInSites.isEmpty())

        // A limit refusal surfaces its code (a device that kept no attestation asks `.com` again).
        mock.attestRefusal = "first-contact-limit"
        val third = VoiciSignInFlow(center(mock, visitor), visitor, pipe, VoiciIntegrity.NONE)
        third.start(link)
        third.approve("test")
        assertEquals(VoiciSignInPhase.Failed("first-contact-limit", 7200), third.phase.value)
    }

    @Test fun jpegMetadataIsCutAndOgFieldsAreRead() {
        fun seg(m: Int, body: Int) = byteArrayOf(0xff.toByte(), m.toByte(), 0, (body + 2).toByte()) + ByteArray(body) { 0x41 }
        val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte()) + seg(0xe0, 14) + seg(0xe1, 8) + seg(0xe2, 4) + seg(0xfe, 3) + seg(0xdb, 5) +
            byteArrayOf(0xff.toByte(), 0xda.toByte(), 0, 4, 1, 2, 9, 9, 0xff.toByte(), 0xd9.toByte())
        assertTrue(VoiciPage.voiciJpegHasMetadata(jpeg))
        val clean = VoiciJpeg.stripMetadata(jpeg)!!
        assertFalse(VoiciPage.voiciJpegHasMetadata(clean))
        assertEquals(jpeg.size - (12 + 8 + 7), clean.size)
        assertTrue(VoiciPage.isVoiciJpeg(clean))

        val og = VoiciLinkCards.parseOg(
            """<html><head><meta property="og:title" content="A &amp; B"><meta name='og:site_name' content='Example'>
               <meta content="Desc&#39;s" property="og:description"><meta property="og:image" content="/i.png"></head></html>""",
        )
        assertEquals(VoiciOgFields("A & B", "Example", "Desc's", "/i.png"), og)
        val card = VoiciLinkCards.card(og.copy(title = "‮Evil\nTitle " + "x".repeat(200)), "example.com", null)!!
        assertNull(VoiciText.checkVoiciText(VoiciTextField.cardTitle, card.title))
        assertTrue(card.title.startsWith("Evil Title"))
        assertNull(VoiciLinkCards.card(VoiciOgFields(null, null, null, null), "example.com", null))
    }

    @Test fun signInLinksAreParsedStrictly() {
        val k = com.flagshipserver.app.core.Base64URL.encode(ByteArray(32) { 5 })
        val p = "ab".repeat(16)
        val d = "04" + "11".repeat(64)
        val n = "cd".repeat(16)
        val base = "https://flagshipserver.com/voici-sign-in"
        assertNotNull(VoiciSignInLink.parse("$base#s=abcdefgh12&k=$k&p=$p&u=alice&d=$d&n=$n"))
        assertNotNull(VoiciSignInLink.parse("$base?s=abcdefgh12&k=$k&p=$p&u=alice&d=$d&n=$n"))
        assertNull("no browser key", VoiciSignInLink.parse("$base#s=abcdefgh12&k=$k&p=$p&u=alice&n=$n"))
        assertNull("compressed key", VoiciSignInLink.parse("$base#s=abcdefgh12&k=$k&p=$p&u=alice&d=03${"11".repeat(32)}&n=$n"))
        assertNull("short nonce", VoiciSignInLink.parse("$base#s=abcdefgh12&k=$k&p=$p&u=alice&d=$d&n=cdcd"))
        assertNull("upper-case name", VoiciSignInLink.parse("$base#s=abcdefgh12&k=$k&p=$p&u=Alice&d=$d&n=$n"))
        assertNull("bad X25519", VoiciSignInLink.parse("$base#s=abcdefgh12&k=AAAA&p=$p&u=alice&d=$d&n=$n"))
        assertNull("other path", VoiciSignInLink.parse("https://flagshipserver.com/remote#s=abcdefgh12&k=$k&p=$p&u=alice&d=$d&n=$n"))
    }

    @Test fun theLocalVaultOpensOnlyUnderItsAccountKey() {
        val store = MemoryVoiciVaultStore()
        val v = VoiciVault(store)
        v.save(umk, "alice", VoiciLocal(pageId = "ab".repeat(16), rulesAccepted = true))
        assertEquals("ab".repeat(16), v.load(umk, "alice").pageId)
        assertEquals(VoiciLocal(), v.load(ByteArray(32) { 7 }, "alice"))
        val sha = v.putImage(umk, "alice", byteArrayOf(1, 2, 3))
        assertEquals(listOf<Byte>(1, 2, 3), v.image(umk, "alice", sha)!!.toList())
        assertNull(v.image(ByteArray(32) { 7 }, "alice", sha))
    }
}
