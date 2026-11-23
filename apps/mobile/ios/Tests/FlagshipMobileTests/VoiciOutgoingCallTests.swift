import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Calling from the app (docs/voici-calls.md "Calling from the app"): the outgoing call against a mock `.com`, a mock
/// engine and a scripted room; the browser fallback over a scripted pipe; the device-local call list; the hook for the
/// owner-calls-a-visitor path that waits on the owner's decision.
@MainActor
final class VoiciOutgoingCallTests: XCTestCase {
    private func load(_ rel: String) throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../" + rel).standardized
        return try XCTUnwrap(JSONValue.parse(utf8: Array(try Data(contentsOf: url))))
    }

    final class Engine: CallMediaEngine {
        var offerSdp: String?
        var applied: (sdp: String, ice: CallerIceServer)?
        var started: CallFrameCrypto?
        var stopped = false
        func answer(offerSdp: String, video: Bool, turn: CallTurnCredential) async throws -> String { throw CallMediaUnavailable() }
        func start(_ crypto: CallFrameCrypto) {}
        func addRemoteIce(_ candidate: String?) {}
        var onLocalIce: ((String?) -> Void)?
        var onConnected: (() -> Void)?
        var onFailed: (() -> Void)?
        func setMuted(_ muted: Bool) {}
        func setCamera(_ on: Bool) -> Bool { true }
        func stop() { stopped = true }
        func offer(video: Bool) async throws -> String {
            guard let offerSdp else { throw CallMediaUnavailable() }
            return offerSdp
        }
        func applyAnswer(sdp: String, iceServer: CallerIceServer) async throws { applied = (sdp, iceServer) }
        func startCaller(_ crypto: CallFrameCrypto) { started = crypto }
    }

    final class Socket: VoiciCallRoomSocket {
        var url: URL?
        var headers: [String: String] = [:]
        var sent: [JSONValue] = []
        var closed = false
        func open(url: URL, headers: [String: String], onText: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void) {
            self.url = url
            self.headers = headers
        }
        func send(_ text: String) { if let v = JSONValue.parse(text) { sent.append(v) } }
        func close() { closed = true }
    }

    final class Relay: QrRelayClient, @unchecked Sendable {
        var missing: Int
        var hellos: [(sid: String, pk: String)] = []
        var delivered: (ciphertext: String, nonce: String)?
        init(missing: Int) { self.missing = missing }
        func openAndHello(sid: String, phonePkBase64Url: String) async throws {
            hellos.append((sid, phonePkBase64Url))
            if missing > 0 { missing -= 1; throw QrRelayError.peerMissing }
        }
        func deliver(ciphertextBase64Url: String, nonceBase64Url: String) async throws { delivered = (ciphertextBase64Url, nonceBase64Url) }
        func close() async {}
    }

    private var calls: JSONValue!
    private var messages: JSONValue!
    private var now: Int64 = 0
    private let client = MockVoiciComClient()

    override func setUp() async throws {
        calls = try load("packages/protocol/test-vectors/voici-calls/vectors.json")
        messages = try load("packages/protocol/test-vectors/messages/vectors.json")
        now = calls["now"]!.safeInt!
        let ctx = calls["pageV2"]!["ctx"]!
        client.keys["alice"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: ctx["sensitivePub"]!.string!)
        client.pages["alice"] = calls["pageV2"]!["signed"]!
    }

    /// This account's visitor session for the vectors' page: the pseudonym, attestation and thread key of the shared
    /// messages vectors, a delegation to the call's own key.
    private func session(pageId: String, delegatePub: String, nonce: String, ttl: Int64) throws -> VoiciSignInAnswer {
        let d = messages["derivations"]!
        let secret = try CanonicalJson.hexToBytes(d["messagesSecret"]!.string!)
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
        let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
        let pPub = CanonicalJson.hex(p.publicKey)
        let att = try XCTUnwrap(MessagesAttestations.parseMessagesKeyAttestation(messages["signIn"]!["answer"]!["attestation"]))
        let del = WebDelegation(scope: "voici-messages", origin: "https://voi.ci", audience: pageId, principalPub: pPub, delegatePub: delegatePub,
                                issuedAt: now, expiresAt: min(att.expiresAt, now + ttl), nonce: nonce)
        let ts = VoiciThreadStatement(pageId: pageId, pseudonymPub: pPub, threadPub: CanonicalJson.hex(t.publicKey), issuedAt: now)
        let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: p.seed),
                                    threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: p.seed))
        return VoiciSignInAnswer(pageId: pageId, pseudonymPub: pPub, cred: cred, threadSeed: CanonicalJson.hex(t.seed))
    }

    private func call(video: Bool = false, engine: Engine, socket: Socket, relay: Relay = Relay(missing: 0), history: VoiciCallHistory? = nil,
                      opened: @escaping (URL) -> Void = { _ in }) -> VoiciOutgoingCall {
        let deps = VoiciOutgoingCall.Deps(
            client: client, media: engine, socket: socket,
            session: { [unowned self] p, d, n, ttl in try self.session(pageId: p, delegatePub: d, nonce: n, ttl: ttl) },
            relay: { relay }, openURL: { opened($0); return true }, background: { await $0() }, history: history,
            now: { [unowned self] in self.now }, sleep: { _ in })
        return VoiciOutgoingCall(callee: VoiciCallee(username: "alice", pageId: calls["keys"]!["pageId"]!.string!), video: video, deps: deps)
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<200 where !until() { await Task.yield() }
    }

    func test_placesASignedRequestTheCalleeAcceptsAndTakesTheAnswer() async throws {
        let engine = Engine(), socket = Socket(), history = VoiciCallHistory(defaults: UserDefaults(suiteName: "voici-out-\(UUID())")!)
        history.configure(username: "me")
        engine.offerSdp = calls["sdp"]!["offerRaw"]!.string!
        // An "accepted" page and "Call without call-back": nothing attached, the call is placed.
        let c = call(engine: engine, socket: socket, history: history)
        await c.start()
        XCTAssertEqual(c.phase, .ringing)
        let request = try XCTUnwrap(client.placedCalls.first)
        let k = calls["keys"]!
        let ctx = VoiciCallRequestCheckContext(pageId: k["pageId"]!.string!, acceptsCalls: true, origin: "https://voi.ci", caKeys: [k["caPub"]!.string!], now: now)
        XCTAssertEqual(VoiciCalls.checkRequest(request, ctx).code, "ok")
        XCTAssertEqual(socket.url?.absoluteString, "wss://\(Endpoints.controlHost)/api/voici/calls/\(c.callId)/caller?t=\(String(repeating: "7a", count: 32))")
        XCTAssertEqual(socket.headers["origin"], Endpoints.voiciOrigin)

        // The callee's phone answers, signed by the page's owner messages key.
        let e = try VoiciCalls.encapsulate(callerXwingPub: try CanonicalJson.hexToBytes(request["callerXwingPub"]!.string!))
        let body = VoiciCallAnswerBody(callId: c.callId, deviceRef: k["deviceRef"]!.string!, requestHash: VoiciCalls.requestHash(request)!,
                                       xwingCiphertext: CanonicalJson.hex(e.ciphertext), answerSdp: calls["sdp"]!["answer"]!.string!,
                                       turnUser: String(repeating: "7e", count: 16), turnSecret: String(repeating: "5e", count: 32), issuedAt: now)
        let answer = try VoiciCalls.signAnswer(body, ownerSignSeed: try CanonicalJson.hexToBytes(k["ownerSignSeed"]!.string!))
        c.onRoom(try CanonicalJson.canonicalJson(.object(["t": "answer", "answer": answer])))
        await settle { engine.started != nil }
        XCTAssertEqual(c.phase, .connecting)
        XCTAssertEqual(engine.applied?.ice, CallerIceServer(url: "turns:alice.\(Endpoints.dataApex):443?transport=tcp", username: body.turnUser, credential: body.turnSecret))
        XCTAssertEqual(engine.started?.sendsDir, .c2p)
        // Frames the caller seals open under the phone's c2p key from the same transcript.
        let keys = VoiciCalls.frameKeys(sharedSecret: e.sharedSecret, requestBytes: VoiciCalls.requestBytes(request)!, answerBytes: try VoiciCalls.canonicalAnswer(body))
        let sealed = try XCTUnwrap(engine.started?.sealAudio([1, 2, 3]))
        XCTAssertEqual(VoiciCalls.openFrame(key: keys.c2p, callId: c.callId, dir: .c2p, sealed: sealed)?.frame, [1, 2, 3])

        engine.onConnected?()
        await settle { c.phase == .connected }
        now += 5_000
        c.hangUp()
        XCTAssertEqual(c.phase, .ended("hangup"))
        let end = try XCTUnwrap(socket.sent.last?["end"])
        XCTAssertEqual(VoiciCalls.checkEnd(end, callId: c.callId, callerPub: request["cred"]!["delegation"]!["delegatePub"]!.string!, ownerSignPub: ""), "hangup")
        XCTAssertEqual(history.records.first?.outcome, .answered)
        XCTAssertEqual(history.records.first?.direction, .outgoing)
        XCTAssertEqual(history.records.first?.durationMs, 5_000)
    }

    func test_refusesAnAnswerNotSignedByThePage() async throws {
        let engine = Engine(), socket = Socket()
        engine.offerSdp = calls["sdp"]!["offerRaw"]!.string!
        let c = call(engine: engine, socket: socket)
        await c.start()
        let request = try XCTUnwrap(client.placedCalls.first)
        let e = try VoiciCalls.encapsulate(callerXwingPub: try CanonicalJson.hexToBytes(request["callerXwingPub"]!.string!))
        let body = VoiciCallAnswerBody(callId: c.callId, deviceRef: calls["keys"]!["deviceRef"]!.string!, requestHash: VoiciCalls.requestHash(request)!,
                                       xwingCiphertext: CanonicalJson.hex(e.ciphertext), answerSdp: calls["sdp"]!["answer"]!.string!,
                                       turnUser: String(repeating: "7e", count: 16), turnSecret: String(repeating: "5e", count: 32), issuedAt: now)
        let forged = try VoiciCalls.signAnswer(body, ownerSignSeed: Array(repeating: 9, count: 32))
        c.onRoom(try CanonicalJson.canonicalJson(.object(["t": "answer", "answer": forged])))
        await settle { c.isOver }
        XCTAssertEqual(c.phase, .ended("failed"))
        XCTAssertNil(engine.started)
        XCTAssertEqual(socket.sent.last?["end"]?["reason"]?.string, "failed")
    }

    func test_comRefusalAndAPageWithoutCalls() async throws {
        let engine = Engine()
        engine.offerSdp = calls["sdp"]!["offerRaw"]!.string!
        client.placeRefusal = (403, "not-allowed")
        let history = VoiciCallHistory(defaults: UserDefaults(suiteName: "voici-out-\(UUID())")!)
        history.configure(username: "me")
        let c = call(engine: engine, socket: Socket(), history: history)
        await c.start()
        XCTAssertEqual(c.phase, .failed("not-allowed"))
        XCTAssertEqual(c.statusLine, VoiciOutgoingCall.sentence("not-allowed"))
        client.pages["alice"] = nil
        let gone = call(engine: Engine(), socket: Socket(), history: history)
        await gone.start()
        XCTAssertEqual(gone.phase, .failed("not-found"))
        // Both tries show in Calls as failed, the one refused before it had a call id too.
        XCTAssertEqual(history.records.count, 2)
        XCTAssertEqual(history.records.map(\.outcome), [.failed, .failed])
        XCTAssertEqual(history.records.map(\.direction), [.outgoing, .outgoing])
    }

    /// No media engine: the call goes to the browser, once the tab joins the pipe; the delivery opens with the tab's
    /// secret from the link and names this page.
    func test_withoutAnEngineTheCallGoesToTheBrowser() async throws {
        let relay = Relay(missing: 2), history = VoiciCallHistory(defaults: UserDefaults(suiteName: "voici-out-\(UUID())")!)
        history.configure(username: "me")
        var opened: URL?
        let c = call(video: true, engine: Engine(), socket: Socket(), relay: relay, history: history) { opened = $0 }
        await c.start()
        XCTAssertEqual(c.phase, .handedToBrowser)
        XCTAssertEqual(relay.hellos.count, 3)
        let url = try XCTUnwrap(opened?.absoluteString)
        XCTAssertTrue(url.hasPrefix("https://\(Endpoints.voiciHost)/alice#call="))
        let frag = String(url.split(separator: "#")[1].dropFirst("call=".count))
        let parts = frag.split(separator: ".").map(String.init)
        XCTAssertEqual(parts[0], relay.hellos[0].sid)
        let browserSecret = Array(try XCTUnwrap(Base64URL.decode(parts[1])))
        let appPub = Array(try XCTUnwrap(Base64URL.decode(relay.hellos[0].pk)))
        let key = try VoiciCallHandoffs.key(mySecret: browserSecret, peerPub: appPub)
        let d = try XCTUnwrap(relay.delivered)
        let ct = try XCTUnwrap(Base64URL.decode(d.ciphertext)), nonce = try XCTUnwrap(Base64URL.decode(d.nonce))
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        let h = try XCTUnwrap(JSONValue.parse(utf8: Array(try AES.GCM.open(box, using: SymmetricKey(data: key)))))
        XCTAssertEqual(h["kind"]?.string, VoiciCallHandoffs.tag)
        XCTAssertEqual(h["username"]?.string, "alice")
        XCTAssertEqual(h["media"]?.string, VoiciCalls.mediaVideo)
        XCTAssertEqual(h["signIn"]?["delegation"]?["delegatePub"]?.string, VoiciCallHandoffs.delegatePub(h["delegatePriv"]!.string!))
        XCTAssertLessThanOrEqual(h["expiresAt"]!.safeInt! - h["issuedAt"]!.safeInt!, VoiciCallHandoffs.ttlMs)
        XCTAssertEqual(history.records.first?.outcome, .browser)
    }

    func test_aTabThatNeverJoinsFailsWithASentence() async throws {
        let relay = Relay(missing: .max)
        var t: Int64 = 0
        let deps = VoiciOutgoingCall.Deps(
            client: client, media: Engine(), socket: Socket(),
            session: { [unowned self] p, d, n, ttl in try self.session(pageId: p, delegatePub: d, nonce: n, ttl: ttl) },
            relay: { relay }, openURL: { _ in true }, background: { await $0() }, history: nil,
            now: { [unowned self] in t += 1_000; return self.now + t }, sleep: { _ in })
        let c = VoiciOutgoingCall(callee: VoiciCallee(username: "alice", pageId: calls["keys"]!["pageId"]!.string!), video: false, deps: deps)
        await c.start()
        XCTAssertEqual(c.phase, .failed("browser"))
        XCTAssertEqual(c.statusLine, VoiciOutgoingCall.sentence("browser"))
    }

    // MARK: the call list

    func test_historyMergesMissedCallsNewestFirstAndOnce() {
        let h = VoiciCallHistory(defaults: UserDefaults(suiteName: "voici-hist-\(UUID())")!)
        h.configure(username: "me")
        h.record(VoiciCallRecord(callId: "a", direction: .outgoing, outcome: .answered, peer: .page(username: "bob", pageId: String(repeating: "b", count: 32)), video: false, at: 30))
        h.record(VoiciCallRecord(callId: "m1", direction: .incoming, outcome: .declined, peer: .visitor(conv: "c1", pseudonymPub: "p1"), video: false, at: 20))
        let missed = [
            VoiciMissedCallRow(callId: "m1", conv: "c1", pseudonymPub: "p1", reason: "decline", ringingAt: 20, video: false),
            VoiciMissedCallRow(callId: "m2", conv: "c2", pseudonymPub: "p2", reason: "no-answer", ringingAt: 40, video: true),
        ]
        let list = h.entries(missed: missed)
        XCTAssertEqual(list.map(\.callId), ["m2", "a", "m1"])
        XCTAssertEqual(list[0].outcome, .missed)
        XCTAssertNil(list[0].callablePage)
        XCTAssertEqual(list[1].callablePage?.username, "bob")
        // Kept per account on this device, and forgotten with it.
        let defaults = UserDefaults(suiteName: "voici-hist-keep")!
        let a = VoiciCallHistory(defaults: defaults)
        a.configure(username: "me")
        a.record(VoiciCallRecord(callId: "x", direction: .outgoing, outcome: .browser, peer: .page(username: "bob", pageId: "p"), video: false, at: 1))
        let b = VoiciCallHistory(defaults: defaults)
        b.configure(username: "me")
        XCTAssertEqual(b.records.map(\.callId), ["x"])
        VoiciCallHistory.forget(username: "me", allProfiles: false, defaults: defaults)
        let c = VoiciCallHistory(defaults: defaults)
        c.configure(username: "me")
        XCTAssertTrue(c.records.isEmpty)
    }

    func test_historyIsCapped() {
        let h = VoiciCallHistory(defaults: UserDefaults(suiteName: "voici-cap-\(UUID())")!)
        h.configure(username: "me")
        for i in 0..<(VoiciCallHistory.maxRecords + 5) {
            h.record(VoiciCallRecord(callId: "c\(i)", direction: .outgoing, outcome: .noAnswer, peer: .page(username: "bob", pageId: "p"), video: false, at: Int64(i)))
        }
        XCTAssertEqual(h.records.count, VoiciCallHistory.maxRecords)
        XCTAssertEqual(h.records.first?.callId, "c\(VoiciCallHistory.maxRecords + 4)")
    }

    #if os(iOS)
    func test_incomingOutcomes() {
        XCTAssertEqual(VoiciCallCenter.incomingOutcome(code: "hangup", wasConnected: true), .answered)
        XCTAssertEqual(VoiciCallCenter.incomingOutcome(code: "decline", wasConnected: false), .declined)
        XCTAssertEqual(VoiciCallCenter.incomingOutcome(code: "no-answer", wasConnected: false), .missed)
        XCTAssertNil(VoiciCallCenter.incomingOutcome(code: "answered-elsewhere", wasConnected: false))
        XCTAssertEqual(VoiciCallCenter.incomingOutcome(code: "media-unavailable", wasConnected: false), .failed)
    }
    #endif

    /// A "callback accounts only" page: the app attaches the conversation's ring-back channel before it rings.
    func test_aCallbackPageAttachesTheRingBackChannelFirst() async throws {
        var idx = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(calls["pageV2"]!["signed"]!))
        idx.callsFrom = "callback"
        client.pages["alice"] = try VoiciPage.signVoiciPageIndex(idx, signerSeed: [UInt8](repeating: 0x33, count: 32)).json
        let engine = Engine()
        engine.offerSdp = calls["sdp"]!["offerRaw"]!.string!
        var attached: [String] = []
        let deps = VoiciOutgoingCall.Deps(
            client: client, media: engine, socket: Socket(),
            session: { [unowned self] p, d, n, ttl in try self.session(pageId: p, delegatePub: d, nonce: n, ttl: ttl) },
            attachRingBack: { attached.append($0) },
            relay: { Relay(missing: 0) }, openURL: { _ in true }, background: { await $0() }, history: nil,
            now: { [unowned self] in self.now }, sleep: { _ in })
        let c = VoiciOutgoingCall(callee: VoiciCallee(username: "alice", pageId: idx.pageId), video: false, allowCallBack: true, deps: deps)
        await c.start()
        XCTAssertEqual(attached, [idx.pageId])
        XCTAssertEqual(c.phase, .ringing)
        // "Call without call-back" on a callback-only page: not placed, and nothing attached.
        let without = VoiciOutgoingCall(callee: VoiciCallee(username: "alice", pageId: idx.pageId), video: false, deps: deps)
        await without.start()
        XCTAssertEqual(without.phase, .failed("callback-only"))
        XCTAssertEqual(attached, [idx.pageId])
    }

    /// The owner's ring back: refused until the visitor attached the conversation's channel; the hint opens only under
    /// the visitor's thread key and names the page, so the visitor's app dials out to it.
    func test_theOwnersRingNeedsTheVisitorsChannelAndOnlyTheVisitorOpensItsHint() async throws {
        let k = calls["keys"]!, pageId = k["pageId"]!.string!
        let d = messages["derivations"]!
        let secret = try CanonicalJson.hexToBytes(d["messagesSecret"]!.string!)
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
        let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
        let conv = try VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: CanonicalJson.hex(p.publicKey))
        let ringId = String(repeating: "ab", count: 16)
        let hint = try VoiciRings.sealHint(threadPub: t.publicKey, VoiciRingHint(pageId: pageId, username: "alice", conv: conv, ringId: ringId,
                                                                                    media: VoiciCalls.mediaAudio, issuedAt: now))
        let ring = try VoiciRings.signedRing(pageId: pageId, conv: conv, ringId: ringId, hint: CanonicalJson.b64Encode(hint), media: VoiciCalls.mediaAudio,
                                             issuedAt: now, ownerSignSeed: try CanonicalJson.hexToBytes(k["ownerSignSeed"]!.string!))
        do {
            try await client.ring(username: "alice", ring: ring.ring, signature: ring.signature)
            XCTFail("rang without a channel")
        } catch let e as VoiciComError {
            XCTAssertEqual(e.code, "no-ring-back")
        }
        let order = try VoiciRings.signedRingBack(pageId: pageId, conv: conv, op: "attach", issuedAt: now, pseudonymSeed: p.seed)
        try await client.ringBack(order: order, account: "visitor", device: { _, _ in nil })
        try await client.ring(username: "alice", ring: ring.ring, signature: ring.signature)
        XCTAssertEqual(client.rings.count, 1)
        let push = try XCTUnwrap(PushNotifications.voiciRing(["flagship-call": ["kind": "voici-ring", "ringId": ringId, "hint": CanonicalJson.b64Encode(hint), "room": "x"]]))
        let opened = try XCTUnwrap(VoiciRings.openHint(threadSeed: t.seed, conv: conv, ringId: push.ringId, sealed: CanonicalJson.b64Decode(push.hint)!))
        XCTAssertEqual([opened.username, opened.pageId], ["alice", pageId])
        XCTAssertNil(VoiciRings.openHint(threadSeed: [UInt8](repeating: 5, count: 32), conv: conv, ringId: ringId, sealed: hint))
        XCTAssertNil(PushNotifications.voiciRing(["kind": "voici-call", "ringId": ringId, "hint": "AA=="]))
        let stop = try VoiciRings.signedRingBack(pageId: pageId, conv: conv, op: "stop", issuedAt: now + 1, pseudonymSeed: p.seed)
        try await client.ringBack(order: stop, account: "visitor", device: { _, _ in nil })
        do {
            try await client.ring(username: "alice", ring: ring.ring, signature: ring.signature)
            XCTFail("rang after Stop call-backs")
        } catch let e as VoiciComError {
            XCTAssertEqual(e.code, "no-ring-back")
        }
    }

}

/// The Calls page's "Who to call" field and the Social page's missed-call count (docs/social-tabs.md).
final class SocialTabsLogicTests: XCTestCase {
    func test_callTargetTakesAUsernameOrAPageLink() {
        for input in ["alex", " Alex ", "@alex", "voi.ci/alex", "https://voi.ci/alex", "https://voi.ci/alex/", "voi.ci/alex#call=x", "http://www.voi.ci/alex?x=1"] {
            XCTAssertEqual(VoiciCallTarget.username(from: input), "alex", input)
        }
        XCTAssertEqual(VoiciCallTarget.username(from: "gym.voi.ci/bo-1", voiciHost: "gym.voi.ci"), "bo-1")
        for input in ["", "   ", "-alex", "al ex", "voi.ci/", "https://example.com/alex", "+1 555 0100", String(repeating: "a", count: 64)] {
            XCTAssertNil(VoiciCallTarget.username(from: input), input)
        }
    }

    func test_missedCallsCountUntilSeen() {
        func r(_ id: String, _ dir: VoiciCallRecord.Direction, _ out: VoiciCallRecord.Outcome, _ at: Int64) -> VoiciCallRecord {
            VoiciCallRecord(callId: id, direction: dir, outcome: out, peer: .visitor(conv: "c", pseudonymPub: "p"), video: false, at: at)
        }
        let entries = [r("1", .incoming, .missed, 100), r("2", .incoming, .missed, 300), r("3", .incoming, .declined, 400),
                       r("4", .outgoing, .noAnswer, 500), r("5", .incoming, .answered, 600)]
        XCTAssertEqual(SocialBadges.unseenMissed(entries, seenAt: 0), 2)
        XCTAssertEqual(SocialBadges.unseenMissed(entries, seenAt: 200), 1)
        XCTAssertEqual(SocialBadges.unseenMissed(entries, seenAt: 300), 0)
    }
}
