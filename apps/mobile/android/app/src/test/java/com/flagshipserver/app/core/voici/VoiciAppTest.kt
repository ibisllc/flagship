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

    /** A minimal JPEG with no metadata (SOI, APP0, a scan, EOI); [n] makes each one distinct. */
    private fun fakeJpeg(n: Int) = byteArrayOf(
        0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 4, 0, n.toByte(),
        0xff.toByte(), 0xda.toByte(), 0, 2, 1, 2, 3, 0xff.toByte(), 0xd9.toByte(),
    )

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

    /** Capped server copy (§2.7a): the oldest chunks are phone-only; the phone serves them, another device carries them. */
    @Test fun phoneOnlyChunksAreServedByThePhoneAndCarriedByADeviceWithoutThem() {
        val card = fakeJpeg(9)
        val cardSha = WebEnvelopes.sha256Hex(card)
        val chunks = (0 until 12).map { i ->
            val links = if (i == 0) listOf(VoiciPostLink("https://example.com/old", VoiciCard("Old", "example.com", "", cardSha))) else emptyList()
            listOf(post("Post $i", 1_000L + i).copy(links = links))
        }
        val state = VoiciPageState(VoiciOwner.defaultProfile("Alice"), 1, chunks, 0)
        val plan = VoiciOwner.planPieces(state, { if (it == cardSha) card else null })
        val phone = VoiciPage.voiciPhoneChunksFor(state.chunks.size)
        assertEquals(2, phone)
        val keys = VoiciOwnerKeys.derive(umk, "ab".repeat(16), 1)
        val idx = VoiciPage.signVoiciPageIndex(
            VoiciPageIndexBody("alice", "ab".repeat(16), 1, 1_000, 1, 1, keys.inboxPub, keys.signPub, plan.map { it.ref }, "admin-root", phoneChunks = phone.toLong()),
            root,
        )
        assertTrue(VoiciPage.checkVoiciPublish(idx.toJson(), "alice", "admin-root", rootPub, 0, null, 1_000).ok)
        val noPhone = VoiciPage.signVoiciPageIndex(idx.body.copy(phoneChunks = null), root)
        assertEquals("too-many-chunks", VoiciPage.checkVoiciPublish(noPhone.toJson(), "alice", "admin-root", rootPub, 0, null, 1_000).code)

        val byRole = plan.associateBy { it.role }
        val image = { sha: String -> if (sha == cardSha) card else null }
        assertEquals(byRole.getValue("chunk-0").bytes!!.toList(), VoiciOwner.phonePiece(byRole.getValue("chunk-0").sha256, idx, state, image)!!.toList())
        assertEquals(card.toList(), VoiciOwner.phonePiece(cardSha, idx, state, image)!!.toList())
        assertNull(VoiciOwner.phonePiece(byRole.getValue("chunk-5").sha256, idx, state, image))
        assertNull(VoiciOwner.phonePiece(byRole.getValue("profile").sha256, idx, state, image))
        assertNull(VoiciOwner.phonePiece(byRole.getValue("chunk-0").sha256, noPhone, state, image))

        val onCom = plan.filter { !idx.body.isPhoneChunk(it.role) }.associate { it.sha256 to it.bytes!! }
        val second = VoiciOwner.readPublished(idx) { onCom[it.sha256] }!!
        assertEquals(listOf(0, 0), second.chunks.take(2).map { it.size })
        assertEquals(state.chunks.drop(2), second.chunks.drop(2))
        val carried = VoiciOwner.carriedChunks(idx, second)
        assertEquals(listOf("chunk-0", "chunk-1"), carried.map { it.role })
        assertTrue(VoiciOwner.carriedChunks(idx, state).isEmpty())
        val again = VoiciOwner.planPieces(second, { null }, idx.body.pieces, carried)
        assertEquals(plan.map { it.ref }.sortedBy { it.key }, again.map { it.ref }.sortedBy { it.key })
        assertTrue(again.filter { idx.body.isPhoneChunk(it.role) || it.role.startsWith("card-") }.all { it.bytes == null })
        assertNull(VoiciOwner.readPublished(idx) { if (it.role == "chunk-5") null else onCom[it.sha256] })
    }

    @Test fun callsSettingIsPublishedAndEveryLaterPublishKeepsIt() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertTrue("the first publish turns calls on", published(mock).first.body.isV2)
        assertTrue(a.setCalls(true, "anyone", "test"))
        published(mock).first.body.let {
            assertEquals(1, it.acceptsCalls)
            assertEquals("anyone", it.callsFrom)
        }
        assertTrue(a.page.value.callsOn)
        assertEquals("anyone", a.page.value.callsFrom)
        // A post publishes on top: calls stay on.
        a.edit("post-add", post = post("Hello"))
        assertTrue(a.publish("test"))
        published(mock).first.body.let {
            assertEquals(3L, it.seq)
            assertEquals(1, it.acceptsCalls)
            assertEquals("anyone", it.callsFrom)
        }
        // Off is a v1 index again.
        assertTrue(a.setCalls(false, "signed-in", "test"))
        published(mock).first.body.let {
            assertFalse(it.isV2)
            assertNull(it.acceptsCalls)
        }
        assertFalse(a.page.value.callsOn)
        // A device that can't sign the page can't change it.
        val b = center(mock, FakeKeyring("alice", umk, root, false, ByteArray(32) { 5 }))
        b.refresh()
        assertFalse(b.setCalls(true, "accepted", "test"))
    }

    /** Owner decisions 2026-11-16 and 2026-11-20: a page's first publish turns on messages and call-back calls. */
    @Test fun aFirstPublishTurnsOnMessagesAndCallBackCalls() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        assertTrue(a.page.value.firstPublish)
        assertEquals("the editor shows messages on before the first publish", 1, a.page.value.working?.acceptsMessages)
        a.acceptRules()
        a.acknowledgePublicWarning()
        assertEquals("a first publish always shows the warning, which says what starts on", PagePublicStep.Warning, a.publicStep())
        assertTrue(a.goPublic("test"))
        published(mock).first.body.let {
            assertEquals(1, it.acceptsMessages)
            assertEquals(1, it.acceptsCalls)
            assertEquals("callback", it.callsFrom)
        }
        assertTrue(a.page.value.callsOn)
        assertFalse(a.page.value.firstPublish)
        assertEquals(PagePublicStep.Publish, a.publicStep())
    }

    @Test fun aFirstPublishKeepsMessagesOffWhenTheOwnerTurnedThemOffFirst() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.acceptRules()
        a.edit("accept-messages", accepts = 0)
        assertTrue(a.publish("test"))
        published(mock).first.body.let {
            assertEquals(0, it.acceptsMessages)
            assertEquals(1, it.acceptsCalls)
        }
    }

    @Test fun aRepublishKeepsTheOwnersChoices() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertTrue(a.setCalls(false, "signed-in", "test"))
        a.edit("accept-messages", accepts = 0)
        assertTrue(a.publish("test"))
        a.edit("post-add", post = post("Later"))
        assertTrue(a.publish("test"))
        published(mock).first.body.let {
            assertEquals(4L, it.seq)
            assertEquals(0, it.acceptsMessages)
            assertNull(it.acceptsCalls)
        }
        // A second admin device that never saw the page loses the seq race and keeps the page's choices.
        val b = center(mock, admin(4))
        b.edit("post-add", post = post("From B"))
        assertTrue(b.publish("test"))
        published(mock).first.body.let {
            assertEquals(5L, it.seq)
            assertEquals(0, it.acceptsMessages)
            assertNull(it.acceptsCalls)
        }
    }

    /** Owner decision 2026-11-17: hidden from search engines by default; the switch is a publish; every publish keeps it. */
    @Test fun showInSearchIsOffAtFirstAndEveryPublishKeepsIt() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertNull(published(mock).first.body.showInSearch)
        assertFalse(a.page.value.showInSearch)
        assertTrue(a.setShowInSearch(true, "test"))
        assertEquals(1, published(mock).first.body.showInSearch)
        assertTrue(a.page.value.showInSearch)
        // An edit and a calls change keep it.
        a.edit("post-add", post = post("Later"))
        assertTrue(a.publish("test"))
        assertEquals(1, published(mock).first.body.showInSearch)
        assertTrue(a.setCalls(false, "signed-in", "test"))
        assertEquals(1, published(mock).first.body.showInSearch)
        // Another admin device keeps the page's choice too.
        val b = center(mock, admin(4))
        b.edit("post-add", post = post("From B"))
        assertTrue(b.publish("test"))
        assertEquals(1, published(mock).first.body.showInSearch)
        a.refresh()
        assertTrue(a.setShowInSearch(false, "test"))
        assertNull(published(mock).first.body.showInSearch)
    }

    @Test fun showInSearchNeedsAPublicPageAndAnAdminDevice() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        assertFalse(a.setShowInSearch(true, "test"))
        assertEquals(0, mock.publishCount)
        // A device without the admin root can't change it either.
        a.acceptRules()
        assertTrue(a.publish("test"))
        val other = center(mock, FakeKeyring("alice", umk, root, false, ByteArray(32) { 6 }))
        other.refresh()
        assertFalse(other.setShowInSearch(true, "test"))
        assertNull(published(mock).first.body.showInSearch)
    }

    /** docs/voici-and-messages.md §2.10: the share card is drawn on the first publish, carried while the look holds. */
    @Test fun theShareCardIsDrawnThenCarriedThenRedrawn() = runBlocking {
        val mock = mock()
        val drawn = ArrayList<String>()
        val renderer = VoiciShareCardRenderer { profile, username, _ ->
            drawn += "${profile.displayName}|${profile.theme}|$username"
            fakeJpeg(drawn.size)
        }
        val a = VoiciCenter(mock, admin(), VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), shareCard = renderer)
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        val first = published(mock).first.body.pieces.single { it.role == "share" }
        assertEquals(1, drawn.size)
        assertTrue(mock.pieces.containsKey("${published(mock).first.body.pageId}/${first.sha256}"))
        // A post does not change the card: carried, not drawn.
        a.edit("post-add", post = post("Hello"))
        assertTrue(a.publish("test"))
        assertEquals(first, published(mock).first.body.pieces.single { it.role == "share" })
        assertEquals(1, drawn.size)
        // A new name draws a new card.
        a.edit("profile", profile = published(mock).second.profile.copy(displayName = "Alice B"))
        assertTrue(a.publish("test"))
        val second = published(mock).first.body.pieces.single { it.role == "share" }
        assertEquals(2, drawn.size)
        assertTrue(drawn.last().startsWith("Alice B|"))
        assertTrue(second.sha256 != first.sha256)
    }

    @Test fun aCardThatFailsToDrawLeavesThePagePublishable() = runBlocking {
        val mock = mock()
        val bad = VoiciShareCardRenderer { _, _, _ -> byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe1.toByte(), 0, 2, 0xff.toByte(), 0xd9.toByte()) }
        val a = VoiciCenter(mock, admin(), VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), shareCard = bad)
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertTrue(published(mock).first.body.pieces.none { it.role == "share" })
    }

    /** docs/voici-calls.md, owner decisions 2026-11-15: the call key is bound, answers and ends while locked, and is revoked. */
    @Test fun answeringWhileLockedBindsUsesAndRevokesTheCallKey() = runBlocking {
        val mock = mock()
        val vault = com.flagshipserver.app.calls.MemoryCallKeyVault()
        val k = admin()
        val a = VoiciCenter(mock, k, VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), callKeyVault = vault)
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        assertNull(a.setAnswerWhileLocked(true))
        assertTrue(a.page.value.answersWhileLocked)
        val key = vault.load("alice")!!
        val (idx, _) = published(mock)
        assertTrue(VoiciCalls.verifyCallKeyBinding(mock.callKeys["alice|${k.deviceId}"], idx.body.ownerSignPub, "alice"))
        assertEquals(key.pubHex, VoiciJs.str((mock.callKeys["alice|${k.deviceId}"]!!["binding"] as JsonObject)["callKeyPub"]))
        // Locked: no UMK; the call key alone joins, answers and ends.
        val locked = a.lockedCallKeys()!!
        assertNull(locked.ownerSignSeed)
        assertEquals(VoiciCalls.deviceRef(key.pubHex), locked.deviceRef)
        val join = key.joinHeaders("ca".repeat(16), 1_000)
        assertTrue(VoiciCalls.verifyCallJoin("alice", "ca".repeat(16), k.deviceId, key.pubHex, 1_000, join.getValue("x-flagship-call-key-sig"), 1_000))
        val end = locked.signEnd("ca".repeat(16), "hangup", 5)!!
        assertTrue(WebEnvelopes.p256VerifyP1363(VoiciJs.str(end["sig"]), VoiciCalls.canonicalEnd("ca".repeat(16), "owner", "hangup", 5), key.pubHex))
        // Off: an owner-signed revocation, the key is gone.
        assertNull(a.setAnswerWhileLocked(false))
        assertFalse(a.page.value.answersWhileLocked)
        assertNull(vault.load("alice"))
        assertEquals(key.pubHex, VoiciJs.str(mock.callKeyRevokes.single()["callKeyPub"]))
        assertTrue(mock.callKeys.isEmpty())
    }

    @Test fun aDeviceThatCantSignThePageCantTurnOnAnsweringWhileLocked() = runBlocking {
        val mock = mock()
        val owner = center(mock, admin())
        owner.refresh()
        owner.acceptRules()
        assertTrue(owner.publish("test"))
        val vault = com.flagshipserver.app.calls.MemoryCallKeyVault()
        val b = VoiciCenter(mock, FakeKeyring("alice", umk, root, false, ByteArray(32) { 5 }), VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), callKeyVault = vault)
        b.refresh()
        assertEquals("not-admin", b.setAnswerWhileLocked(true))
        assertNull(vault.load("alice"))
    }

    @Test fun callAllowIsSignedByTheOwnerKey() = runBlocking {
        val mock = mock()
        val a = center(mock, admin())
        a.refresh()
        a.acceptRules()
        assertTrue(a.publish("test"))
        val conv = "ab".repeat(32)
        assertNull(a.callAllow(conv, true))
        assertNull(a.callAllow(conv, false))
        assertEquals(listOf("allow", "disallow"), mock.callAllows.map { VoiciJs.str(it["op"]) })
        assertEquals(conv, VoiciJs.str(mock.callAllows.first()["conv"]))
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
        assertEquals(listOf(firstPostText(), "First", "From B"), state.chunks.flatten().map { it.text })
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
        assertEquals(listOf(firstPostText(), "From the tablet"), published(mock).second.chunks.flatten().map { it.text })
        assertEquals(1, mock.consumed.size)
        assertTrue(mock.drafts["alice"]!!.isEmpty())

        m.refresh()
        assertEquals(0, m.page.value.pendingCount)
        assertEquals(listOf(firstPostText(), "From the tablet"), m.page.value.working!!.chunks.flatten().map { it.text })

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
