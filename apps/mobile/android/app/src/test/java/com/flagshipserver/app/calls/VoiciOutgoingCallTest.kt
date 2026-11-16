// Calling from the app (docs/voici-calls.md "Calling from the app") against the in-memory `.com` (MockVoiciClient
// runs the shared request check): the app calls a page as its visitor with a fake media engine (request, answer
// checked under the page's owner key, caller-direction frame keys, a signed caller end), falls back to a voi.ci tab
// over /qr-pipe when the engine is missing, refuses a page that takes no calls, records the device-local history, and
// keeps calling a visitor of the account's own page back as a hook only.

package com.flagshipserver.app.calls

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.voici.CallVisitorOutcome
import com.flagshipserver.app.core.voici.MemoryVoiciVaultStore
import com.flagshipserver.app.core.voici.VoiciCallAnswerBody
import com.flagshipserver.app.core.voici.VoiciCallHandoff
import com.flagshipserver.app.core.voici.VoiciCalls
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciIntegrity
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciKeyring
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciOwnerKeys
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciSignInRequest
import com.flagshipserver.app.core.voici.VoiciVault
import com.flagshipserver.app.core.voici.VoiciVectorsTest
import com.flagshipserver.app.core.voici.WebEnvelopes
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

private class Keys(val user: String, val umkSeed: ByteArray, val rootSeed: ByteArray, val admin: Boolean, val deviceSeed: ByteArray) : VoiciKeyring {
    override fun username() = user
    override fun umk() = umkSeed
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = admin
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = rootSeed to "admin-root"
    override fun device() = VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(VoiciJs.edPub(deviceSeed)), Ed25519Sign(deviceSeed))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = user
}

/** A media engine that offers the vectors' SDP and records what the call hands it. */
private class FakeEngine(private val offerSdp: String) : CallMediaEngine {
    var answered: Pair<String, CallerIceServer>? = null
    var crypto: CallFrameCrypto? = null
    var stopped = false
    override suspend fun answer(offerSdp: String, video: Boolean, turn: CallTurnCredential): String = throw CallMediaUnavailable()
    override fun start(crypto: CallFrameCrypto) {}
    override fun addRemoteIce(candidate: String?) {}
    override var onLocalIce: ((String?) -> Unit)? = null
    override var onConnected: (() -> Unit)? = null
    override var onFailed: (() -> Unit)? = null
    override fun setMuted(muted: Boolean) {}
    override fun setCamera(on: Boolean): Boolean = false
    override fun stop() {
        stopped = true
    }
    override suspend fun offer(video: Boolean): String = offerSdp
    override suspend fun applyAnswer(sdp: String, iceServer: CallerIceServer) {
        answered = sdp to iceServer
    }
    override fun startCaller(crypto: CallFrameCrypto) {
        this.crypto = crypto
    }
}

private class FakeRoom : VoiciCallerRoom {
    var url: String? = null
    var onMessage: ((String) -> Unit)? = null
    val sent = ArrayList<JsonObject>()
    var closed = false
    override fun connect(url: String, onMessage: (String) -> Unit, onClosed: () -> Unit) {
        this.url = url
        this.onMessage = onMessage
    }
    override fun send(text: String) {
        sent += Json.parseToJsonElement(text).jsonObject
    }
    override fun close() {
        closed = true
    }
}

private class FakePipe : VoiciCallHandoffPipe {
    var sid: String? = null
    var sealed: com.flagshipserver.app.core.voici.VoiciCallHandoffSealed? = null
    override suspend fun deliver(sid: String, sealed: com.flagshipserver.app.core.voici.VoiciCallHandoffSealed, openBrowser: () -> Unit) {
        openBrowser()
        this.sid = sid
        this.sealed = sealed
    }
}

class VoiciOutgoingCallTest {
    private val ownerUmk = ByteArray(32) { 1 }
    private val root = ByteArray(32) { 2 }
    private val visitorUmk = ByteArray(32) { 9 }
    private val V: JsonObject by lazy { Json.parseToJsonElement(VoiciVectorsTest.vectorsFile("packages/protocol/test-vectors/voici-calls/vectors.json").readText()).jsonObject }
    private fun sdp(key: String) = VoiciJs.str((V["sdp"] as JsonObject)[key])!!

    private fun center(mock: MockVoiciClient, k: Keys) =
        VoiciCenter(mock, k, VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    /** alice publishes a page (calls on for "anyone signed in" unless [calls] is false); bob is the visitor. */
    private fun world(calls: Boolean = true): Triple<MockVoiciClient, VoiciCenter, String> = runBlocking {
        val mock = MockVoiciClient()
        mock.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), VoiciJs.hex(VoiciJs.edPub(root)))
        mock.accounts["bob"] = VoiciAccountKeys("dd".repeat(32), null)
        val owner = center(mock, Keys("alice", ownerUmk, root, true, ByteArray(32) { 3 }))
        owner.refresh()
        owner.edit("accept-messages", accepts = 1)
        owner.acceptRules()
        assertTrue(owner.publish("test"))
        if (calls) assertTrue(owner.setCalls(true, "signed-in", "test"))
        val pageId = VoiciPage.parseVoiciPageIndex(mock.storedIndex("alice"))!!.body.pageId
        val visitor = center(mock, Keys("bob", visitorUmk, ByteArray(32) { 6 }, true, ByteArray(32) { 7 }))
        visitor.refresh()
        Triple(mock, visitor, pageId)
    }

    @Test fun callsAPageWithTheEngineChecksTheAnswerAndHangsUpSigned() = runBlocking {
        val (mock, bob, pageId) = world()
        val engine = FakeEngine(sdp("offerRaw"))
        val room = FakeRoom()
        val call = bob.outgoingCall(VoiciCallTarget("alice", pageId), false, VoiciIntegrity.NONE, engine, room, FakePipe()) { error("no browser with an engine") }
        call.start()
        assertEquals(VoiciOutgoingState.Ringing, call.state.value)
        val request = mock.placedCalls.single()
        val callId = VoiciJs.str(request["callId"])!!
        assertEquals("wss://${mock.callApex}/api/voici/calls/$callId/caller?t=${"7".repeat(64)}", room.url)
        assertEquals(VoiciCalls.mungeSdp(sdp("offerRaw")), VoiciJs.str(request["offerSdp"]))
        assertTrue("an audio call carries no media field", !request.containsKey("media"))

        // alice's phone answers: X-Wing to the caller's key, signed by the page's owner key.
        val idx = VoiciPage.parseVoiciPageIndex(mock.storedIndex("alice"))!!
        val ownerKeys = VoiciOwnerKeys.derive(ownerUmk, pageId, idx.body.inboxEpoch)
        val (ct, ss) = VoiciCalls.encapsulate(WebEnvelopes.hexToBytes(VoiciJs.str(request["callerXwingPub"])!!))
        val body = VoiciCallAnswerBody(callId, "ab".repeat(32), VoiciCalls.requestHash(request)!!, VoiciJs.hex(ct), VoiciCalls.mungeSdp(sdp("answerRaw")),
            "7e".repeat(16), "5ec7".repeat(16), System.currentTimeMillis())
        val answer = VoiciCalls.signAnswer(body, ownerKeys.sign.seed)
        room.onMessage!!(JsonObject(mapOf("t" to JsonPrimitive("answer"), "answer" to answer)).toString())
        assertEquals(VoiciOutgoingState.Connecting, call.state.value)
        val (appliedSdp, ice) = engine.answered!!
        assertEquals(body.answerSdp, appliedSdp)
        assertEquals("turns:alice.${com.flagshipserver.app.core.Endpoints.dataApex}:443?transport=tcp", ice.url)
        assertEquals(listOf("7e".repeat(16), "5ec7".repeat(16)), listOf(ice.username, ice.credential))

        // The keys the caller holds open what the answering phone seals (p2c), and the phone opens the caller's (c2p).
        val keys = VoiciCalls.frameKeys(ss, VoiciCalls.requestBytes(request)!!, VoiciCalls.canonicalAnswer(body))
        val phone = CallFrameCrypto(callId, keys, null)
        val caller = engine.crypto!!
        val f = ByteArray(60) { it.toByte() }
        assertTrue(f.contentEquals(caller.openAudio(phone.sealAudio(f)!!)))
        assertTrue(f.contentEquals(phone.openAudio(caller.sealAudio(f)!!)))

        engine.onConnected!!.invoke()
        assertTrue(call.state.value is VoiciOutgoingState.Connected)
        call.hangUp()
        val end = room.sent.last { VoiciJs.str(it["t"]) == "end" }["end"]
        val delegatePub = VoiciJs.str((request["cred"] as JsonObject)["delegation"]!!.jsonObject["delegatePub"])!!
        assertEquals("hangup", VoiciCalls.checkEnd(end, callId, delegatePub, idx.body.ownerSignPub))
        assertEquals(VoiciOutgoingState.Ended("hangup"), call.state.value)
        assertTrue(engine.stopped && room.closed)
        val rec = bob.callHistory().single()
        assertEquals(listOf("out", "answered", "alice", pageId), listOf(rec.direction, rec.outcome, rec.peerUsername, rec.peerPageId))
    }

    @Test fun refusesAnAnswerNotSignedByThePageOwner() = runBlocking {
        val (mock, bob, pageId) = world()
        val room = FakeRoom()
        val call = bob.outgoingCall(VoiciCallTarget("alice", pageId), false, VoiciIntegrity.NONE, FakeEngine(sdp("offerRaw")), room, FakePipe()) {}
        call.start()
        val request = mock.placedCalls.single()
        val (ct, _) = VoiciCalls.encapsulate(WebEnvelopes.hexToBytes(VoiciJs.str(request["callerXwingPub"])!!))
        val body = VoiciCallAnswerBody(VoiciJs.str(request["callId"])!!, "ab".repeat(32), VoiciCalls.requestHash(request)!!, VoiciJs.hex(ct),
            VoiciCalls.mungeSdp(sdp("answerRaw")), "7e".repeat(16), "5ec7".repeat(16), System.currentTimeMillis())
        val forged = VoiciCalls.signAnswer(body, ByteArray(32) { 0x44 })
        room.onMessage!!(JsonObject(mapOf("t" to JsonPrimitive("answer"), "answer" to forged)).toString())
        assertEquals(VoiciOutgoingState.Ended("failed"), call.state.value)
        assertEquals("failed", bob.callHistory().single().outcome)
    }

    @Test fun withoutAnEngineTheCallGoesToAVoiciTab() = runBlocking {
        val (mock, bob, pageId) = world()
        val pipe = FakePipe()
        var opened: String? = null
        val call = bob.outgoingCall(VoiciCallTarget("alice", pageId), true, VoiciIntegrity.NONE, StubCallMediaEngine(), FakeRoom(), pipe) { opened = it }
        call.start()
        assertEquals(VoiciOutgoingState.Browser, call.state.value)
        assertTrue("nothing reached .com: the browser places the call", mock.placedCalls.isEmpty())
        val link = opened!!
        val m = Regex("^https://voi\\.ci/alice#call=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{43})$").find(link)!!
        assertEquals(pipe.sid, m.groupValues[1])
        val browserSecret = Base64URL.decode(m.groupValues[2])!!
        val sealed = pipe.sealed!!
        val key = VoiciCallHandoff.pipeKey(browserSecret, Base64URL.decode(sealed.phonePk)!!)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, Base64URL.decode(sealed.nonce)!!))
        val handoff = Json.parseToJsonElement(c.doFinal(Base64URL.decode(sealed.ciphertext)!!).decodeToString()).jsonObject
        assertEquals(setOf("kind", "username", "pageId", "media", "issuedAt", "expiresAt", "delegatePriv", "signIn"), handoff.keys)
        assertEquals(listOf(VoiciCallHandoff.TAG, "alice", pageId, VoiciCalls.MEDIA_VIDEO), listOf("kind", "username", "pageId", "media").map { VoiciJs.str(handoff[it]) })
        val issued = VoiciJs.time(handoff["issuedAt"])!!
        assertTrue(VoiciJs.time(handoff["expiresAt"])!! - issued <= VoiciCallHandoff.TTL_MS)
        val signIn = handoff["signIn"]!!.jsonObject
        val delegation = signIn["delegation"]!!.jsonObject
        val delegatePub = VoiciCallHandoff.delegatePub(WebEnvelopes.hexToBytes(VoiciJs.str(handoff["delegatePriv"])!!))
        val req = VoiciSignInRequest(com.flagshipserver.app.core.Endpoints.voiciOrigin, pageId, "alice", delegatePub, VoiciJs.str(delegation["nonce"])!!)
        val checked = VoiciMessages.checkVoiciSignInAnswer(signIn, req, listOf(mock.caPub), System.currentTimeMillis())
        assertTrue(checked.code, checked.ok)
        assertTrue("the session lasts at most 10 minutes", VoiciJs.time(delegation["expiresAt"])!! - VoiciJs.time(delegation["issuedAt"])!! <= VoiciCallHandoff.SESSION_MS)
        assertEquals("browser", bob.callHistory().single().outcome)
    }

    @Test fun aPageThatTakesNoCallsIsRefusedBeforeAnythingIsSent() = runBlocking {
        val (mock, bob, pageId) = world(calls = false)
        val call = bob.outgoingCall(VoiciCallTarget("alice", pageId), false, VoiciIntegrity.NONE, FakeEngine(sdp("offerRaw")), FakeRoom(), FakePipe()) {}
        call.start()
        assertEquals(VoiciOutgoingState.Failed("calls-off"), call.state.value)
        assertTrue(mock.placedCalls.isEmpty())
    }

    /** Owner decision 2026-11-15: ringing a visitor back goes through the conversation's ring-back channel only. */
    @Test fun ringingAVisitorBackNeedsTheirCallBackChannel() = runBlocking {
        val mock = MockVoiciClient()
        mock.accounts["alice"] = VoiciAccountKeys("ee".repeat(32), VoiciJs.hex(VoiciJs.edPub(root)))
        val alice = center(mock, Keys("alice", ownerUmk, root, true, ByteArray(32) { 3 }))
        alice.refresh()
        alice.edit("accept-messages", accepts = 1)
        alice.acceptRules()
        assertTrue(alice.publish("test"))
        assertTrue(alice.setCalls(true, "signed-in", "test"))
        val pageId = VoiciPage.parseVoiciPageIndex(mock.storedIndex("alice"))!!.body.pageId
        mock.visitorWrites("alice", visitorUmk, "Call me back?")
        alice.refreshInbox()
        val conv = alice.messages.value.conversations.single().conv

        // The caller called anonymously (no channel): Call is refused and disabled for them on this device.
        assertEquals(CallVisitorOutcome.NoCallBack, alice.callVisitor(conv))
        assertTrue(conv in alice.ringBackOff())

        // They call again with "Call and allow call-back": the channel exists, and a new call from them brings Call back.
        mock.ringBacks += conv
        alice.recordCall(VoiciCallRecord("r1", "c1", "in", "missed", conv = conv, pseudonymPub = "pp", at = System.currentTimeMillis() + 1))
        assertTrue(conv !in alice.ringBackOff())
        val r = alice.callVisitor(conv, video = true)
        assertTrue(r is CallVisitorOutcome.Ringing)
        val ring = mock.rings.single()
        assertEquals(listOf(pageId, conv, VoiciCalls.MEDIA_VIDEO), listOf("pageId", "conv", "media").map { VoiciJs.str(ring[it]) })
        // Only the caller's thread key opens the hint, and it names this page so their app dials out to it.
        val t = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(visitorUmk, pageId).thread.seed
        val ringId = VoiciJs.str(ring["ringId"])!!
        val opened = com.flagshipserver.app.core.pq.PqHybrid.hybridOpen(t, com.flagshipserver.app.core.voici.VoiciRings.TAG_RING_HINT,
            listOf(VoiciJs.utf8(conv), VoiciJs.utf8(ringId)), WebEnvelopes.b64Decode(VoiciJs.str(ring["hint"]))!!)
        val hint = Json.parseToJsonElement(opened.plaintext.decodeToString()).jsonObject
        assertEquals(listOf("alice", pageId, ringId), listOf("username", "pageId", "ringId").map { VoiciJs.str(hint[it]) })
    }
}
