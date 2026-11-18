import Foundation
import CryptoKit
import OSLog
import Flagship
import FlagshipAPI
import FlagshipCore

/// What a voi.ci call needs from this device's keys (MessagesStore.callKeys).
/// Unlocked, it signs with the account device key and the owner messages key; locked (the setting "Answer calls while
/// Flagship is locked"), only `callKey` signs, and nothing else of the account is at hand: no inbox key (the caller is
/// "Someone on voi.ci"), no local block list (`.com` refuses blocked callers before it rings).
struct VoiciCallKeys: @unchecked Sendable {
    let username: String
    let deviceId: String
    let deviceKey: Curve25519.Signing.PrivateKey?
    let pageId: String
    let acceptsCalls: Bool
    let ownerSignSeed: [UInt8]?
    let ownerSignPub: String
    /// The page's inbox seeds, newest epoch first (a push sealed before a rotation still opens).
    let inboxSeeds: [[UInt8]]
    let caKeys: [String]
    let origin: String
    let blocked: Set<String>
    let revoked: Set<String>
    let nicknames: [String: String]
    /// The page's call mode ("anyone" takes anonymous calls, docs/voici-calls.md "Who may call a page"), from this
    /// device's copy of the index (none while locked).
    var callsFrom: String = "accepted"
    var callKey: VoiciCallKey? = nil
    /// Reads the page's live call mode from its signed index on `.com`, for an anonymous call the copy above refuses
    /// (the mode was changed on another device, or the device is locked and keeps no copy).
    var liveMode: (@Sendable () async -> VoiciCallModes.CallMode?)? = nil

    /// What a locked device has: its call key and the public facts kept with it.
    static func locked(_ k: VoiciCallKey, caKeys: [String], origin: String) -> VoiciCallKeys {
        VoiciCallKeys(username: k.username, deviceId: k.deviceId, deviceKey: nil, pageId: k.pageId, acceptsCalls: true, ownerSignSeed: nil,
                      ownerSignPub: k.ownerSignPub, inboxSeeds: [], caKeys: caKeys, origin: origin, blocked: [], revoked: [], nicknames: [:], callKey: k)
    }

    var devicePubHex: String? { deviceKey.map { HexUtil.encode($0.publicKey.rawRepresentation) } }
    var deviceRef: String? {
        if let callKey { return callKey.deviceRef }
        return devicePubHex.flatMap { try? VoiciCalls.deviceRef(devicePubHex: $0) }
    }

    /// The room WebSocket's auth: the call key's join while locked, else device headers.
    func roomHeaders(callId: String, path: String) -> [String: String]? {
        if let callKey { return callKey.joinHeaders(callId: callId, now: Int64(Date().timeIntervalSince1970 * 1000)) }
        return deviceHeaders(method: "GET", path: path)
    }

    func signAnswer(_ body: VoiciCallAnswerBody) throws -> JSONValue {
        if let callKey { return try VoiciCalls.signAnswerWithCallKey(body, proof: callKey.proof, sign: callKey.sign) }
        guard let ownerSignSeed else { throw CanonicalJsonError("locked") }
        return try VoiciCalls.signAnswer(body, ownerSignSeed: ownerSignSeed)
    }

    func signEnd(callId: String, reason: String, issuedAt: Int64) -> JSONValue? {
        if let callKey { return try? VoiciCalls.signEndOwnerWithCallKey(callId: callId, reason: reason, issuedAt: issuedAt, sign: callKey.sign) }
        guard let ownerSignSeed else { return nil }
        return try? VoiciCalls.signEndOwner(callId: callId, reason: reason, issuedAt: issuedAt, ownerSignSeed: ownerSignSeed)
    }

    /// The caller in a push, opened under the inbox keys.
    func openPush(_ push: VoiciCallPush) -> (pageId: String, conv: String, from: String)? {
        guard let sealed = CanonicalJson.b64Decode(push.sealed) else { return nil }
        for seed in inboxSeeds { if let p = VoiciCalls.openPush(inboxSeed: seed, callId: push.callId, sealed: sealed) { return p } }
        return nil
    }

    /// Device headers for one `.com` request (the `/profile` scheme), signed by this device's account key.
    func deviceHeaders(method: String, path: String) -> [String: String]? {
        guard let deviceKey, let pub = devicePubHex else { return nil }
        guard let requestId = try? AccountMetadata.generateDeviceId() else { return nil }
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        guard let bytes = try? AccountMetadata.canonicalDirectoryRequest(accountId: username, deviceId: deviceId, signerPubHex: pub, method: method,
                                                                         path: path, requestId: requestId, issuedAt: at),
              let sig = try? deviceKey.signature(for: bytes) else { return nil }
        return ["x-flagship-device-id": deviceId, "x-flagship-device-pub": pub, "x-flagship-request-id": requestId,
                "x-flagship-issued-at": String(at), "x-flagship-signature": HexUtil.encode(Data(sig))]
    }
}

/// One ringing voi.ci call on this admin device (docs/voici-calls.md §1, §2, §6): the room WebSocket to `.com`, the
/// caller's signed request checked here, the signed answer (X-Wing encapsulation, the one-time TURN credential, the
/// munged answer SDP, `media` when the caller offered video), the CA receipt that says this device won, and the frame
/// keys handed to the media engine. Every check and signature is the shared VoiciCalls port.
@MainActor
final class VoiciCallSession {
    enum Event {
        case request(VoiciCallRequest)
        case won
        case connected
        /// ICE connected through the caller's TURN stream; DTLS and the first media follow.
        case pathOpen
        /// A room reason (hangup, cancel, no-answer, limit, ...), "answered-elsewhere", "decline", "left" or "failed".
        case ended(String)
        case remoteCamera(String)
    }

    let push: VoiciCallPush
    private let keys: VoiciCallKeys
    private let media: CallMediaEngine
    private let onEvent: (Event) -> Void
    private var task: URLSessionWebSocketTask?
    private(set) var request: VoiciCallRequest?
    private var pending: (ss: [UInt8], req: [UInt8], ans: [UInt8])?
    private var over = false

    init(push: VoiciCallPush, keys: VoiciCallKeys, media: CallMediaEngine, onEvent: @escaping (Event) -> Void) {
        self.push = push; self.keys = keys; self.media = media; self.onEvent = onEvent
    }

    private static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func randHex(_ n: Int) -> String { CanonicalJson.hex((0..<n).map { _ in UInt8.random(in: 0...255) }) }

    private var joinKind = "device-key"

    /// The device's room socket. It names only the call: `.com` finds the account from the live call (privacy §2.12).
    nonisolated static func roomURL(room: String, callId: String) -> URL? {
        URL(string: "wss://\(room)/api/voici/calls/\(callId)/device")
    }

    func connect() {
        let path = "/api/voici/calls/\(push.callId)/device"
        guard let url = Self.roomURL(room: push.room, callId: push.callId), let headers = keys.roomHeaders(callId: push.callId, path: path) else {
            return end("failed", why: "no-room-auth")
        }
        var req = URLRequest(url: url, timeoutInterval: 20)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // Which join this is (the call key while Flagship is locked, else the device key), so a refused join says which.
        joinKind = keys.callKey == nil ? "device-key" : "call-key"
        voiciCallLog.notice("room join: \(self.joinKind, privacy: .public)")
        media.onLocalIce = { [weak self] c in Task { @MainActor in self?.send(["t": "ice", "candidate": c.map { .string($0) } ?? .null]) } }
        media.onConnected = { [weak self] in Task { @MainActor in self?.onEvent(.connected) } }
        media.setOnPathOpen { [weak self] in Task { @MainActor in self?.onEvent(.pathOpen) } }
        media.onFailed = { [weak self] in Task { @MainActor in self?.end("failed", why: "media-failed") } }
        // Behind the update lock, like every other request (UpdateLockGateTests).
        guard let t = try? VoiciCallNetwork.session.gatedWebSocketTask(with: req) else {
            return end("failed", why: "update-required")
        }
        task = t
        t.resume()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(.string(let text)):
                    self.onRoom(text)
                    self.receive()
                case .success:
                    self.receive()
                case .failure:
                    // A refused upgrade (403: the server didn't accept this device's join) reads differently from a drop.
                    let status = (self.task?.response as? HTTPURLResponse)?.statusCode
                    if let status, status != 101 {
                        self.end("failed", why: "room-join-refused-\(status)-\(self.joinKind)")
                    } else {
                        self.end("failed", why: "room-socket-closed")
                    }
                }
            }
        }
    }

    private func send(_ o: [String: JSONValue]) {
        guard let text = try? CanonicalJson.canonicalJson(.object(o)) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func onRoom(_ text: String) {
        guard let m = JSONValue.parse(text)?.object, let t = m["t"]?.string else { return }
        switch t {
        case "request": onRequest(m["request"])
        case "won": onWon(m["receipt"])
        case "answered-elsewhere": end("answered-elsewhere", why: "room")
        case "ice": media.addRemoteIce(m["candidate"]?.string)
        case "camera": if let s = m["state"]?.string, VoiciCalls.cameraStates.contains(s) { onEvent(.remoteCamera(s)) }
        case "ended": end(m["reason"]?.string ?? "hangup", why: "room-ended")
        case "error": end("failed", why: "room-error")
        default: break
        }
    }

    private func onRequest(_ raw: JSONValue?) {
        guard let raw else { return end("failed", why: "request-missing") }
        if raw["kind"]?.string == VoiciCallModes.anonKind {
            // A browser with no account calling a page open to anyone (`.com` checked its proof of work). This device's
            // copy of the call mode may be older than the page `.com` rang for: then the live signed index decides.
            let keys = keys, live = keys.liveMode
            Task { @MainActor [weak self] in
                let v = await VoiciCallModes.checkRequestAnon(raw, pageId: keys.pageId, mode: (keys.acceptsCalls, keys.callsFrom), now: Self.now(),
                                                              blocked: keys.blocked, live: { await live?() })
                guard let self, !self.over else { return }
                guard case .ok(let r) = v else { return self.end("failed", why: "anon-request-\(v.code)") }
                guard r.callId == self.push.callId else { return self.end("failed", why: "anon-request-wrong-call") }
                self.request = r
                self.onEvent(.request(r))
            }
            return
        }
        let ctx = VoiciCallRequestCheckContext(pageId: keys.pageId, acceptsCalls: keys.acceptsCalls, origin: keys.origin, caKeys: keys.caKeys,
                                               now: Self.now(), blocked: keys.blocked, revoked: keys.revoked)
        let v = VoiciCalls.checkRequest(raw, ctx)
        guard case .ok(let r) = v else { return end("failed", why: "request-\(v.code)") }
        guard r.callId == push.callId else { return end("failed", why: "request-wrong-call") }
        request = r
        onEvent(.request(r))
    }

    /// Answers. `cameraAble`: this device can send video (the call itself starts as audio). Nil once the signed answer
    /// is sent, else a code: "not-ready", "media-unavailable", "failed".
    func answer(cameraAble: Bool) async -> String? {
        guard let r = request, let deviceRef = keys.deviceRef, let reqBytes = VoiciCalls.requestBytes(r.json),
              let requestHash = VoiciCalls.requestHash(r.json), let xpub = try? CanonicalJson.hexToBytes(r.callerXwingPub),
              let encap = try? VoiciCalls.encapsulate(callerXwingPub: xpub) else { return request == nil ? "not-ready" : "failed" }
        let ct = encap.ciphertext
        var ss = encap.sharedSecret
        let turn = CallTurnCredential(user: Self.randHex(16), secret: Self.randHex(32))
        let sdp: String
        do {
            sdp = VoiciCalls.mungeSdp(try await media.answer(offerSdp: r.offerSdp, video: r.hasVideo, turn: turn))
        } catch {
            wipe(&ss)
            return error is CallMediaUnavailable ? "media-unavailable" : "failed"
        }
        guard VoiciCalls.checkSdp(sdp, media: r.media) == nil else { wipe(&ss); return "failed" }
        let body = VoiciCallAnswerBody(callId: r.callId, deviceRef: deviceRef, requestHash: requestHash, xwingCiphertext: CanonicalJson.hex(ct),
                                       answerSdp: sdp, turnUser: turn.user, turnSecret: turn.secret, issuedAt: Self.now(),
                                       media: r.hasVideo ? (cameraAble ? VoiciCalls.mediaVideo : VoiciCalls.mediaAudio) : nil)
        guard let signed = try? keys.signAnswer(body), let ansBytes = try? VoiciCalls.canonicalAnswer(body) else {
            wipe(&ss)
            return "failed"
        }
        pending = (ss, reqBytes, ansBytes)
        // The caller's TURN stream may reach this device's bare name only for this answer's one-time credential.
        CallTurnGate.shared.arm(.init(user: turn.user, secret: turn.secret))
        send(["t": "answer", "answer": signed])
        return nil
    }

    private func onWon(_ receipt: JSONValue?) {
        guard var p = pending, let deviceRef = keys.deviceRef,
              case .ok = VoiciCalls.checkReceipt(receipt, caKeys: keys.caKeys, now: Self.now(), account: keys.username, deviceRef: deviceRef)
        else { return end("failed", why: "receipt") }
        let audio = VoiciCalls.frameKeys(sharedSecret: p.ss, requestBytes: p.req, answerBytes: p.ans)
        let video = request?.hasVideo == true ? VoiciCalls.videoFrameKeys(sharedSecret: p.ss, requestBytes: p.req, answerBytes: p.ans) : nil
        wipe(&p.ss)
        pending = nil
        media.start(CallFrameCrypto(callId: push.callId, audio: audio, video: video))
        onEvent(.won)
    }

    /// Decline while ringing: the room ends the call for every device and records a missed call.
    func decline() {
        send(["t": "decline"])
        end("decline", why: "declined-here")
    }

    /// Hang up an answered call: the end order is signed by the owner messages key.
    func hangUp() {
        if let order = keys.signEnd(callId: push.callId, reason: "hangup", issuedAt: Self.now()) {
            send(["t": "end", "end": order])
        }
        end("hangup", why: "hung-up-here")
    }

    /// Leaves the room without ending the call for the other devices (this device couldn't answer).
    func leave() { end("left", why: "left-here") }

    func sendCamera(_ state: String) {
        if VoiciCalls.cameraStates.contains(state) { send(["t": "camera", "state": .string(state)]) }
    }

    /// `why` names the cause for the device log (a code, never a key or a name), so a device test shows why a call ended.
    private func end(_ reason: String, why: String) {
        guard !over else { return }
        over = true
        voiciCallLog.notice("call session ended: \(reason, privacy: .public) (\(why, privacy: .public))")
        CallTurnGate.shared.disarm()
        if var p = pending { wipe(&p.ss) }
        pending = nil
        media.stop()
        task?.cancel(with: .normalClosure, reason: nil)
        onEvent(.ended(reason))
    }
}

let voiciCallLog = CallLog()

private func wipe(_ b: inout [UInt8]) {
    for i in b.indices { b[i] = 0 }
}
