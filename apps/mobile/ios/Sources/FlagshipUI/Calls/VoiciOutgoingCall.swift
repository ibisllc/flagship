import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// A page this app calls: one it signed in to as a visitor (docs/voici-calls.md "Calling from the app").
public struct VoiciCallee: Equatable, Sendable, Identifiable {
    public var id: String { pageId }
    public let username: String
    public let pageId: String
    public init(username: String, pageId: String) { self.username = username; self.pageId = pageId }
}

/// The caller's room WebSocket (`wss://<apex>/api/voici/calls/<id>/caller?t=`), behind a seam for tests.
@MainActor
protocol VoiciCallRoomSocket: AnyObject {
    func open(url: URL, headers: [String: String], onText: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void)
    func send(_ text: String)
    func close()
}

/// The live room socket, through the calls' pinned session.
@MainActor
final class LiveVoiciCallRoomSocket: VoiciCallRoomSocket {
    private var task: URLSessionWebSocketTask?

    func open(url: URL, headers: [String: String], onText: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void) {
        var req = URLRequest(url: url, timeoutInterval: 20)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // Behind the update lock, like every other request (UpdateLockGateTests).
        guard let t = try? VoiciCallNetwork.session.gatedWebSocketTask(with: req) else {
            onClose()
            return
        }
        task = t
        t.resume()
        receive(t, onText, onClose)
    }

    private func receive(_ t: URLSessionWebSocketTask, _ onText: @escaping @MainActor (String) -> Void, _ onClose: @escaping @MainActor () -> Void) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(.string(let text)):
                    onText(text)
                    self.receive(t, onText, onClose)
                case .success:
                    self.receive(t, onText, onClose)
                case .failure:
                    onClose()
                }
            }
        }
    }

    func send(_ text: String) { task?.send(.string(text)) { _ in } }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}

/// One call this app places to a page it knows: the caller's half of the voi.ci protocol (docs/voici-calls.md §1-§3)
/// played by the app. It signs a visitor session for the page (its own pseudonym there, `.com`'s attestation, a
/// delegation to a fresh P-256 key), asks the media engine for an offer, signs the request, opens the room, checks the
/// answer under the page's owner key (or a locked phone's bound call key), derives the frame keys and hands them to the
/// engine. When the engine can't place calls (none bundled, or it fails to start), the call goes to the browser: a
/// one-use handoff over `/qr-pipe` to `https://voi.ci/<callee>#call=…`, where the page places it with its own WebRTC.
@MainActor
@Observable
final class VoiciOutgoingCall: Identifiable {
    enum Phase: Equatable {
        case preparing, ringing, connecting, connected
        /// The browser has the call (the app's media engine is missing).
        case handedToBrowser
        /// A room reason (hangup, cancel, no-answer, decline, busy, limit) or "failed".
        case ended(String)
        /// `.com` refused or something broke before ringing: a refusal code.
        case failed(String)
    }

    struct Deps {
        var client: any VoiciComClient
        var media: CallMediaEngine
        var socket: VoiciCallRoomSocket
        /// A sign-in answer for this account on the page, naming `delegatePub` (VoiciVisitorSession on device).
        var session: (_ pageId: String, _ delegatePub: String, _ nonce: String, _ ttlMs: Int64) async throws -> VoiciSignInAnswer
        /// Attaches this conversation's ring-back channel (a "callback accounts only" page takes a call only then).
        var attachRingBack: (_ pageId: String) async throws -> Void = { _ in }
        var relay: () -> any QrRelayClient
        var openURL: (URL) async -> Bool
        /// Keeps the app alive in the background while the handoff is delivered.
        var background: (_ work: @escaping @MainActor () async -> Void) async -> Void
        var history: VoiciCallHistory?
        var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
        var sleep: (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }
        var handoffDeadlineMs: Int64 = 60_000
    }

    let id = UUID()
    let callee: VoiciCallee
    let video: Bool
    /// The pop-up's choice before the call: attach this conversation's ring-back channel ("Call and allow call-back").
    let allowCallBack: Bool
    private(set) var phase: Phase = .preparing
    private(set) var muted = false
    private(set) var cameraOn = false
    private(set) var cameraFront = true
    /// The other side's camera: "on", "off" or "paused".
    private(set) var remoteCamera = "off"
    private(set) var callId = ""
    /// The signed request, once made (the answer is checked against it).
    private(set) var request: JSONValue?

    @ObservationIgnored private var deps: Deps
    @ObservationIgnored private var delegate: P256.Signing.PrivateKey?
    @ObservationIgnored private var callerSeed: [UInt8] = []
    @ObservationIgnored private var ownerSignPub = ""
    @ObservationIgnored private var connectedAt: Int64?
    /// When the call connected, for the call screen's timer (set with the phase change that redraws it).
    var connectedSince: Date? { connectedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }
    @ObservationIgnored private var startedAt: Int64 = 0
    @ObservationIgnored private var over = false

    init(callee: VoiciCallee, video: Bool, allowCallBack: Bool = false, deps: Deps) {
        self.callee = callee
        self.video = video
        self.allowCallBack = allowCallBack
        self.deps = deps
    }

    private static func rand(_ n: Int) -> [UInt8] { (0..<n).map { _ in UInt8.random(in: 0...255) } }

    func start() async {
        startedAt = deps.now()
        do {
            let keys = try await deps.client.accountKeys(username: callee.username)
            guard let raw = try await deps.client.page(username: callee.username),
                  case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: callee.username, sensitiveKind: keys.sensitive.kind,
                                                                    sensitivePub: keys.sensitive.pub, pageId: callee.pageId)
            else { return fail("not-found") }
            guard idx.takesCalls else { return fail("calls-off") }
            ownerSignPub = idx.ownerSignPub
            // On a "callback accounts only" page, calling is consent to being rung back in this conversation: without
            // the choice, the page refuses the call, so it isn't placed.
            if idx.callsFrom == "callback" && !allowCallBack { return fail("callback-only") }
            if allowCallBack { try await deps.attachRingBack(callee.pageId) }
        } catch {
            return fail(Self.code(error))
        }
        let offer: String
        do {
            offer = VoiciCalls.mungeSdp(try await deps.media.offer(video: video))
            guard VoiciCalls.checkSdp(offer, media: video ? VoiciCalls.mediaVideo : VoiciCalls.mediaAudio) == nil else { throw CallMediaUnavailable() }
        } catch {
            // No engine in this build, or it couldn't start: the browser places the call.
            deps.media.stop()
            return await handOff()
        }
        do {
            try await place(offer: offer)
        } catch {
            fail(Self.code(error))
        }
    }

    private func place(offer: String) async throws {
        let key = P256.Signing.PrivateKey()
        delegate = key
        let delegatePub = CanonicalJson.hex(Array(key.publicKey.x963Representation))
        let answer = try await deps.session(callee.pageId, delegatePub, CanonicalJson.hex(Self.rand(16)), VoiciCallHandoffs.sessionMs)
        let conv = try VoiciMessages.voiciConv(pageId: callee.pageId, pseudonymPub: answer.pseudonymPub)
        let x = try PqHybrid.hybridSealKeygen(seed: Self.rand(32))
        callerSeed = x.secretKey
        callId = CanonicalJson.hex(Self.rand(16))
        let r = try VoiciCallHandoffs.signedRequest(pageId: callee.pageId, conv: conv, callId: callId, from: answer.pseudonymPub,
                                                    callerXwingPub: CanonicalJson.hex(x.publicKey), offerSdp: offer, issuedAt: deps.now(),
                                                    cred: .object(answer.cred.json), media: video ? VoiciCalls.mediaVideo : nil) {
            Array(try key.signature(for: $0).rawRepresentation)
        }
        request = r
        let placed = try await deps.client.placeCall(request: r)
        guard placed.callId == callId, placed.room == "wss://\(Endpoints.controlHost)/api/voici/calls/\(callId)/caller",
              let url = URL(string: "\(placed.room)?t=\(placed.token)") else { throw VoiciComError(status: 200, code: "unavailable") }
        guard !over else { return }
        phase = .ringing
        deps.media.onLocalIce = { [weak self] c in Task { @MainActor in self?.send(["t": "ice", "candidate": c.map { .string($0) } ?? .null]) } }
        deps.media.onConnected = { [weak self] in
            Task { @MainActor in
                guard let self, !self.over else { return }
                self.connectedAt = self.deps.now()
                self.phase = .connected
            }
        }
        deps.media.onFailed = { [weak self] in Task { @MainActor in self?.finish("failed") } }
        deps.socket.open(url: url, headers: ["origin": Endpoints.voiciOrigin], onText: { [weak self] t in self?.onRoom(t) },
                         onClose: { [weak self] in
                             guard let self, !self.over else { return }
                             self.finish(self.phase == .ringing || self.phase == .preparing ? "failed" : "hangup")
                         })
    }

    private func send(_ o: [String: JSONValue]) {
        guard let text = try? CanonicalJson.canonicalJson(.object(o)) else { return }
        deps.socket.send(text)
    }

    func onRoom(_ text: String) {
        guard !over, let m = JSONValue.parse(text)?.object, let t = m["t"]?.string else { return }
        switch t {
        case "ringing": if phase == .preparing { phase = .ringing }
        case "answer": Task { await onAnswer(m["answer"]) }
        case "ice": if phase == .connecting || phase == .connected { deps.media.addRemoteIce(m["candidate"]?.string) }
        case "camera": if let s = m["state"]?.string, VoiciCalls.cameraStates.contains(s) { remoteCamera = s }
        case "ended": finish(m["reason"]?.string.flatMap { VoiciCalls.endReasons.contains($0) ? $0 : nil } ?? "hangup")
        default: break
        }
    }

    private func onAnswer(_ raw: JSONValue?) async {
        guard phase == .ringing, let raw, let r = request,
              case .ok(let a) = VoiciCallHandoffs.checkAnswer(raw, request: r, ownerSignPub: ownerSignPub, username: callee.username, now: deps.now()),
              let reqBytes = VoiciCalls.requestBytes(r), let ansBytes = try? VoiciCalls.canonicalAnswer(a),
              let ct = try? CanonicalJson.hexToBytes(a.xwingCiphertext), var ss = try? VoiciCalls.decapsulate(ciphertext: ct, callerSeed: callerSeed)
        else { return hangUp(reason: "failed") }
        phase = .connecting
        let withVideo = video && a.media == VoiciCalls.mediaVideo
        let audio = VoiciCalls.frameKeys(sharedSecret: ss, requestBytes: reqBytes, answerBytes: ansBytes)
        let vk = withVideo ? VoiciCalls.videoFrameKeys(sharedSecret: ss, requestBytes: reqBytes, answerBytes: ansBytes) : nil
        for i in ss.indices { ss[i] = 0 }
        for i in callerSeed.indices { callerSeed[i] = 0 }
        let ice = CallerIceServer(url: "turns:\(callee.username).\(Endpoints.dataApex):443?transport=tcp", username: a.turnUser, credential: a.turnSecret)
        do {
            try await deps.media.applyAnswer(sdp: a.answerSdp, iceServer: ice)
        } catch {
            return hangUp(reason: "failed")
        }
        guard !over else { return }
        deps.media.startCaller(CallFrameCrypto.caller(callId: callId, audio: audio, video: vk))
    }

    /// Hang up (connected) or cancel (still ringing): the end order is signed by this call's delegate key.
    func hangUp() {
        hangUp(reason: phase == .connecting || phase == .connected ? "hangup" : "cancel")
    }

    private func hangUp(reason: String) {
        guard !over else { return }
        if let key = delegate, !callId.isEmpty,
           let end = try? VoiciCallHandoffs.signedEnd(callId: callId, reason: reason, issuedAt: deps.now(), sign: { Array(try key.signature(for: $0).rawRepresentation) }) {
            send(["t": "end", "end": end])
        }
        finish(reason)
    }

    func setMuted(_ m: Bool) {
        deps.media.setMuted(m)
        muted = m
    }

    /// Front or back camera while ours runs.
    func flipCamera() {
        guard cameraOn, deps.media.flipCamera() else { return }
        cameraFront.toggle()
    }

    /// The call's media engine, for the call screen's video views.
    var media: CallMediaEngine { deps.media }

    /// The Camera tap; false when it can't (the call has no video, or no camera).
    func setCamera(_ on: Bool) -> Bool {
        guard video, phase == .connecting || phase == .connected, deps.media.setCamera(on) else { return false }
        if on && !cameraOn { cameraFront = true }
        cameraOn = on
        send(["t": "camera", "state": .string(on ? "on" : "off")])
        return true
    }

    private func fail(_ code: String) {
        guard !over else { return }
        over = true
        deps.socket.close()
        deps.media.stop()
        phase = .failed(code)
    }

    private func finish(_ reason: String) {
        guard !over else { return }
        over = true
        deps.socket.close()
        deps.media.stop()
        let end = deps.now()
        let outcome = Self.outcome(reason: reason, wasConnected: connectedAt != nil)
        if !callId.isEmpty { record(outcome, duration: connectedAt.map { end - $0 } ?? 0) }
        phase = .ended(reason)
    }

    static func outcome(reason: String, wasConnected: Bool) -> VoiciCallRecord.Outcome {
        if wasConnected { return .answered }
        switch reason {
        case "decline", "busy": return .declined
        case "no-answer", "cancel": return .noAnswer
        default: return .failed
        }
    }

    private func record(_ outcome: VoiciCallRecord.Outcome, duration: Int64) {
        deps.history?.record(VoiciCallRecord(callId: callId, direction: .outgoing, outcome: outcome,
                                             peer: .page(username: callee.username, pageId: callee.pageId), video: video, at: startedAt,
                                             durationMs: duration))
    }

    // MARK: the browser fallback

    /// Hands the call to `https://voi.ci/<callee>#call=<sid>.<k>`: a visitor session for the page with a delegate key
    /// made for this one call (10 minutes), sealed to the tab's secret and delivered once over `/qr-pipe`.
    private func handOff() async {
        let key = P256.Signing.PrivateKey()
        let delegatePub = CanonicalJson.hex(Array(key.publicKey.x963Representation))
        let browserSecret = Self.rand(32), appSecret = Self.rand(32)
        let sid = Base64URL.encode(Data(Self.rand(16)))
        let t = deps.now()
        let sealed: (phonePk: String, nonce: String, ciphertext: String)
        let link: URL
        do {
            let answer = try await deps.session(callee.pageId, delegatePub, CanonicalJson.hex(Self.rand(16)), VoiciCallHandoffs.sessionMs)
            let h = try VoiciCallHandoffs.handoff(username: callee.username, pageId: callee.pageId, media: video ? VoiciCalls.mediaVideo : VoiciCalls.mediaAudio,
                                                  issuedAt: t, expiresAt: t + VoiciCallHandoffs.ttlMs, delegatePriv: CanonicalJson.hex(Array(key.rawRepresentation)),
                                                  signIn: answer.json)
            sealed = try VoiciCallHandoffs.seal(h, appSecret: appSecret, browserSecret: browserSecret, nonce: Self.rand(12))
            guard let u = URL(string: try VoiciCallHandoffs.link(host: Endpoints.voiciHost, username: callee.username, sid: sid, browserSecret: browserSecret))
            else { return fail("unavailable") }
            link = u
        } catch {
            return fail(Self.code(error))
        }
        callId = ""
        var delivered = false
        await deps.background { [self] in
            guard await deps.openURL(link) else { return }
            let deadline = deps.now() + deps.handoffDeadlineMs
            while deps.now() < deadline {
                let relay = deps.relay()
                do {
                    try await relay.openAndHello(sid: sid, phonePkBase64Url: sealed.phonePk)
                    try await relay.deliver(ciphertextBase64Url: sealed.ciphertext, nonceBase64Url: sealed.nonce)
                    await relay.close()
                    delivered = true
                    return
                } catch QrRelayError.peerMissing {
                    // The tab hasn't joined the pipe yet: try again shortly.
                    await relay.close()
                    await deps.sleep(500_000_000)
                } catch {
                    await relay.close()
                    return
                }
            }
        }
        guard !over else { return }
        if delivered {
            over = true
            deps.history?.record(VoiciCallRecord(callId: "browser-\(sid)", direction: .outgoing, outcome: .browser,
                                                 peer: .page(username: callee.username, pageId: callee.pageId), video: video, at: startedAt))
            phase = .handedToBrowser
        } else {
            fail("browser")
        }
    }

    static func code(_ error: Error) -> String {
        if let e = error as? VoiciComError { return e.code }
        return "unavailable"
    }
}

extension VoiciOutgoingCall {
    /// The sentence for a call that couldn't be placed (never shown raw).
    static func sentence(_ code: String) -> String {
        switch code {
        case "calls-off": return String(localized: "They aren't taking calls right now.")
        case "not-allowed": return String(localized: "They take calls only from people whose messages they accepted.")
        case "busy": return String(localized: "They're on another call. Try again later.")
        case "rate-limited": return String(localized: "Too many calls. Try again later.")
        case "not-found": return String(localized: "This page isn't on voi.ci.")
        case "locked": return String(localized: "Unlock Flagship and try again.")
        case "browser": return String(localized: "Couldn't hand the call to your browser. Try again.")
        case "callback-only": return String(localized: "This page takes calls only from people who let it call them back.")
        default: return String(localized: "The call couldn't connect. Check your connection and try again.")
        }
    }

    /// The line under the callee's name.
    var statusLine: String {
        switch phase {
        case .preparing: return String(localized: "Calling…")
        case .ringing: return String(localized: "Ringing…")
        case .connecting: return String(localized: "Connecting…")
        case .connected: return String(localized: "Quantum-safe call")
        case .handedToBrowser: return String(localized: "The call continues in your browser.")
        case .ended(let r):
            switch r {
            case "no-answer": return String(localized: "No answer.")
            case "decline", "busy": return String(localized: "They can't take your call right now.")
            case "limit": return String(localized: "Calls end after 60 minutes.")
            case "failed": return Self.sentence("unavailable")
            default: return String(localized: "Call ended")
            }
        case .failed(let c): return Self.sentence(c)
        }
    }

    var isOver: Bool {
        switch phase {
        case .ended, .failed, .handedToBrowser: return true
        default: return false
        }
    }
}
