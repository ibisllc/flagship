import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// In-process stand-in for `apps/com/src/buildRelay.ts`: one session per sid
/// with a browser slot and a phone slot, the same frames (accepted, rebind,
/// peer-hello, ack, peer-missing, peer-deliver, delivered, error), and the
/// same single-shot teardown after the phone's first `deliver`.
final class FakeRelayHub: PairingSocketFactory, @unchecked Sendable {
    final class Session {
        var browser: FakeSocket?
        var phone: FakeSocket?
        var consumed = false
    }

    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    /// Mutates a forwarded ciphertext, per sid, to model a hostile relay.
    var tamperDeliver: (@Sendable (_ sid: String, _ ciphertext: String) -> String)?

    func connect(sid: String, role: String) throws -> any PairingSocket {
        let socket = FakeSocket(hub: self, sid: sid, role: role)
        lock.lock()
        defer { lock.unlock() }
        let s = sessions[sid] ?? Session()
        sessions[sid] = s
        if role == "browser" {
            if s.consumed || s.browser != nil {
                socket.push(#"{"kind":"rebind"}"#)
                socket.serverClose()
            } else {
                s.browser = socket
                socket.push(#"{"kind":"accepted"}"#)
            }
        } else {
            if s.consumed || s.phone != nil {
                socket.push(#"{"kind":"error","reason":"session already consumed"}"#)
                socket.serverClose()
            } else {
                s.phone = socket
            }
        }
        return socket
    }

    func hasBrowser(_ sid: String) -> Bool {
        lock.withLock { sessions[sid]?.browser != nil }
    }

    func sids() -> [String] {
        lock.withLock { Array(sessions.keys) }
    }

    fileprivate func detach(_ socket: FakeSocket) {
        lock.lock()
        defer { lock.unlock() }
        guard let s = sessions[socket.sid] else { return }
        if s.browser === socket {
            s.browser = nil
            if let phone = s.phone, !s.consumed { phone.push(#"{"kind":"peer-missing"}"#) }
        }
        if s.phone === socket { s.phone = nil }
    }

    fileprivate func handle(_ socket: FakeSocket, _ text: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let s = sessions[socket.sid] else { return }
        let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        let kind = obj["kind"] as? String

        if socket.role == "browser" {
            socket.push(#"{"kind":"error","reason":"browser sends nothing"}"#)
            return
        }
        switch kind {
        case "hello":
            guard let browser = s.browser else {
                socket.push(#"{"kind":"peer-missing"}"#)
                return
            }
            let pk = obj["phonePk"] as? String ?? ""
            browser.push(#"{"kind":"peer-hello","phonePk":"\#(pk)"}"#)
            socket.push(#"{"kind":"ack"}"#)
        case "deliver":
            guard let browser = s.browser else {
                socket.push(#"{"kind":"error","reason":"browser not connected"}"#)
                return
            }
            var ct = obj["ciphertext"] as? String ?? ""
            let nonce = obj["nonce"] as? String ?? ""
            if let tamper = tamperDeliver { ct = tamper(socket.sid, ct) }
            browser.push(#"{"kind":"peer-deliver","ciphertext":"\#(ct)","nonce":"\#(nonce)"}"#)
            socket.push(#"{"kind":"delivered"}"#)
            s.consumed = true
            browser.serverClose()
            socket.serverClose()
        default:
            socket.push(#"{"kind":"error","reason":"unknown kind"}"#)
        }
    }
}

final class FakeSocket: PairingSocket, @unchecked Sendable {
    fileprivate let sid: String
    fileprivate let role: String
    private weak var hub: FakeRelayHub?
    private let lock = NSLock()
    private var inbox: [String] = []
    private var waiter: CheckedContinuation<String, Error>?
    private var closed = false
    private var local = false

    init(hub: FakeRelayHub, sid: String, role: String) {
        self.hub = hub
        self.sid = sid
        self.role = role
    }

    func send(_ text: String) async throws {
        if lock.withLock({ closed }) { throw URLError(.networkConnectionLost) }
        hub?.handle(self, text)
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if !inbox.isEmpty {
                let m = inbox.removeFirst()
                lock.unlock()
                cont.resume(returning: m)
            } else if closed {
                lock.unlock()
                cont.resume(throwing: URLError(.networkConnectionLost))
            } else {
                waiter = cont
                lock.unlock()
            }
        }
    }

    func close() {
        lock.withLock { local = true }
        serverClose()
        hub?.detach(self)
    }

    var closedLocally: Bool { lock.withLock { local } }

    func push(_ frame: String) {
        lock.lock()
        if let w = waiter {
            waiter = nil
            lock.unlock()
            w.resume(returning: frame)
        } else {
            inbox.append(frame)
            lock.unlock()
        }
    }

    func serverClose() {
        lock.lock()
        closed = true
        let w = inbox.isEmpty ? waiter : nil
        if w != nil { waiter = nil }
        lock.unlock()
        w?.resume(throwing: URLError(.networkConnectionLost))
    }
}

final class LivePairingRelayTests: XCTestCase {
    private let deviceId = "00112233445566778899aabbccddeeff"

    private struct Fixture {
        let adminSk = Curve25519.KeyAgreement.PrivateKey()
        let incomingSk = Curve25519.KeyAgreement.PrivateKey()
        let signingPub = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let deviceIdBytes: Data

        var devicePubRaw: Data {
            incomingSk.publicKey.rawRepresentation + signingPub + deviceIdBytes
        }
        func material() throws -> QrRelay.DerivedMaterial {
            try QrRelay.deriveMaterial(
                phonePrivateKey: incomingSk,
                browserPublicKey: adminSk.publicKey.rawRepresentation
            )
        }
    }

    private func makeFixture() throws -> Fixture {
        Fixture(deviceIdBytes: try XCTUnwrap(HexUtil.decode(deviceId)))
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 2, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out waiting for \(what)") }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    // MARK: - Both roles interoperate

    func test_adminAndIncoming_interoperate_sasEqual_bundleRoundTrips() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let admin = LivePairingRelayClient(factory: hub)
        let incoming = LivePairingRelayClient(factory: hub)
        let sid = "sid-interop"

        let adminTask = Task { try await admin.adminAwaitDevicePubkey(sid: sid, adminPrivateKey: fx.adminSk) }
        try await waitUntil("admin browser slot") { hub.hasBrowser(sid) }

        let mat = try fx.material()
        let incomingTask = Task {
            try await incoming.incomingSendPubkeyAwaitBundle(
                sid: sid,
                handshakePublicKey: fx.incomingSk.publicKey.rawRepresentation,
                aeadKey: mat.aeadKey,
                devicePubRaw: fx.devicePubRaw
            )
        }

        let received = try await adminTask.value
        XCTAssertEqual(received, fx.devicePubRaw, "admin sees handshake || device key || device id")

        let adminMat = try QrRelay.deriveMaterial(
            phonePrivateKey: fx.adminSk,
            browserPublicKey: Data(received.prefix(32))
        )
        XCTAssertEqual(adminMat.matchCode, mat.matchCode, "both screens show the same SAS")
        XCTAssertEqual(adminMat.matchCode.count, 6)

        let bundle = Data(#"{"umkSeedHex":"00","admit":{},"admitSig":"ff"}"#.utf8)
        let sealed = try QrRelay.seal(payload: bundle, with: adminMat.aeadKey)
        try await admin.adminDeliverBundle(
            sid: sid,
            ciphertextBase64Url: sealed.ciphertextBase64Url,
            nonceBase64Url: sealed.nonceBase64Url
        )

        let frame = try await incomingTask.value
        XCTAssertEqual(frame.ciphertextBase64Url, sealed.ciphertextBase64Url)
        XCTAssertEqual(frame.nonceBase64Url, sealed.nonceBase64Url)
        let opened = LivePairingRelayClient.aeadOpen(
            key: mat.aeadKey,
            ciphertextBase64Url: frame.ciphertextBase64Url,
            nonceBase64Url: frame.nonceBase64Url
        )
        XCTAssertEqual(opened, bundle)

        await admin.close()
        await incoming.close()
    }

    func test_incomingHello_isWebShapedJson_withReturnChannel() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let incoming = LivePairingRelayClient(factory: hub)
        let sid = "sid-shape"
        let mat = try fx.material()

        let browser = try hub.connect(sid: sid, role: "browser")
        _ = try await browser.receive()
        let incomingTask = Task {
            try await incoming.incomingSendPubkeyAwaitBundle(
                sid: sid,
                handshakePublicKey: fx.incomingSk.publicKey.rawRepresentation,
                aeadKey: mat.aeadKey,
                devicePubRaw: fx.devicePubRaw
            )
        }

        let helloText = try await browser.receive()
        let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(helloText.utf8)) as? [String: Any])
        XCTAssertEqual(hello["kind"] as? String, "peer-hello")
        XCTAssertEqual(hello["phonePk"] as? String, Base64URL.encode(fx.incomingSk.publicKey.rawRepresentation))

        let deliverText = try await browser.receive()
        let deliver = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(deliverText.utf8)) as? [String: Any])
        XCTAssertEqual(deliver["kind"] as? String, "peer-deliver")
        let plain = try XCTUnwrap(LivePairingRelayClient.aeadOpen(
            key: mat.aeadKey,
            ciphertextBase64Url: try XCTUnwrap(deliver["ciphertext"] as? String),
            nonceBase64Url: try XCTUnwrap(deliver["nonce"] as? String)
        ))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["devicePubHex", "deviceId", "returnSid", "returnPkB64u"])
        XCTAssertEqual(obj["devicePubHex"] as? String, HexUtil.encode(fx.signingPub))
        XCTAssertEqual(obj["deviceId"] as? String, deviceId)
        XCTAssertEqual(Base64URL.decode(try XCTUnwrap(obj["returnSid"] as? String))?.count, 16)
        XCTAssertEqual(Base64URL.decode(try XCTUnwrap(obj["returnPkB64u"] as? String))?.count, 32)

        await incoming.close()
        _ = try? await incomingTask.value
    }

    // MARK: - Failure paths

    func test_tamperedHello_isIgnoredByAdmin_andNeverResolves() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        hub.tamperDeliver = { _, ct in
            var chars = Array(ct)
            chars[0] = chars[0] == "A" ? "B" : "A"
            return String(chars)
        }
        let admin = LivePairingRelayClient(factory: hub)
        let incoming = LivePairingRelayClient(factory: hub)
        let sid = "sid-tamper"
        let adminTask = Task { try await admin.adminAwaitDevicePubkey(sid: sid, adminPrivateKey: fx.adminSk) }
        try await waitUntil("admin browser slot") { hub.hasBrowser(sid) }

        let mat = try fx.material()
        let incomingTask = Task {
            try await incoming.incomingSendPubkeyAwaitBundle(
                sid: sid,
                handshakePublicKey: fx.incomingSk.publicKey.rawRepresentation,
                aeadKey: mat.aeadKey,
                devicePubRaw: fx.devicePubRaw
            )
        }

        do {
            _ = try await adminTask.value
            XCTFail("a tampered hello must not yield a device key")
        } catch PairingRelayError.transport(_) {
            // The relay tore the consumed leg down; the forged frame was dropped.
        } catch {
            XCTFail("unexpected error \(error)")
        }

        await incoming.close()
        do {
            _ = try await incomingTask.value
            XCTFail("incoming should have been cancelled")
        } catch PairingRelayError.sessionInvalidated {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func test_tamperedBundle_failsToOpen() throws {
        let key = SymmetricKey(size: .bits256)
        let sealed = try QrRelay.seal(payload: Data("secret".utf8), with: key)
        XCTAssertNotNil(LivePairingRelayClient.aeadOpen(
            key: key, ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url
        ))
        var chars = Array(sealed.ciphertextBase64Url)
        chars[0] = chars[0] == "A" ? "B" : "A"
        XCTAssertNil(LivePairingRelayClient.aeadOpen(
            key: key, ciphertextBase64Url: String(chars), nonceBase64Url: sealed.nonceBase64Url
        ))
        XCTAssertNil(LivePairingRelayClient.aeadOpen(
            key: SymmetricKey(size: .bits256),
            ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url
        ))
    }

    func test_incomingWithoutAdmin_isPeerMissing() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let incoming = LivePairingRelayClient(factory: hub)
        do {
            _ = try await incoming.incomingSendPubkeyAwaitBundle(
                sid: "sid-nobody",
                handshakePublicKey: fx.incomingSk.publicKey.rawRepresentation,
                aeadKey: try fx.material().aeadKey,
                devicePubRaw: fx.devicePubRaw
            )
            XCTFail("expected peerMissing")
        } catch PairingRelayError.peerMissing {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    /// Plays a hand-rolled incoming device whose hello carries `extra`, then
    /// returns the admin client once its device-key await has resolved.
    private func adminAfterCraftedHello(
        hub: FakeRelayHub, fx: Fixture, sid: String, extra: [String: String]
    ) async throws -> LivePairingRelayClient {
        let admin = LivePairingRelayClient(factory: hub)
        let adminTask = Task { try await admin.adminAwaitDevicePubkey(sid: sid, adminPrivateKey: fx.adminSk) }
        try await waitUntil("admin browser slot") { hub.hasBrowser(sid) }

        let phone = try hub.connect(sid: sid, role: "phone")
        try await phone.send(LivePairingRelayClient.json([
            "kind": "hello", "phonePk": Base64URL.encode(fx.incomingSk.publicKey.rawRepresentation),
        ]))
        let ackFrame = try await phone.receive()
        XCTAssertTrue(ackFrame.contains("ack"))
        var body: [String: String] = [
            "devicePubHex": HexUtil.encode(fx.signingPub), "deviceId": deviceId,
        ]
        body.merge(extra) { _, new in new }
        let sealed = try QrRelay.seal(
            payload: try JSONSerialization.data(withJSONObject: body),
            with: try fx.material().aeadKey
        )
        try await phone.send(LivePairingRelayClient.json([
            "kind": "deliver", "ciphertext": sealed.ciphertextBase64Url, "nonce": sealed.nonceBase64Url,
        ]))
        _ = try await adminTask.value
        return admin
    }

    func test_missingReturnChannel_failsDelivery() async throws {
        let fx = try makeFixture()
        let admin = try await adminAfterCraftedHello(hub: FakeRelayHub(), fx: fx, sid: "sid-noreturn", extra: [:])
        do {
            try await admin.adminDeliverBundle(sid: "sid-noreturn", ciphertextBase64Url: "AA", nonceBase64Url: "AA")
            XCTFail("expected peerMissing")
        } catch PairingRelayError.peerMissing {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func test_returnChannelNobodyListensOn_failsDelivery() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let admin = try await adminAfterCraftedHello(
            hub: hub, fx: fx, sid: "sid-deadreturn",
            extra: ["returnSid": "never-opened", "returnPkB64u": Base64URL.encode(Data(repeating: 4, count: 32))]
        )
        do {
            try await admin.adminDeliverBundle(sid: "sid-deadreturn", ciphertextBase64Url: "AA", nonceBase64Url: "AA")
            XCTFail("expected peerMissing")
        } catch PairingRelayError.peerMissing {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func test_malformedHelloFields_areIgnored() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let admin = LivePairingRelayClient(factory: hub)
        let sid = "sid-badfields"
        let adminTask = Task { try await admin.adminAwaitDevicePubkey(sid: sid, adminPrivateKey: fx.adminSk) }
        try await waitUntil("admin browser slot") { hub.hasBrowser(sid) }

        let phone = try hub.connect(sid: sid, role: "phone")
        try await phone.send(LivePairingRelayClient.json([
            "kind": "hello", "phonePk": Base64URL.encode(fx.incomingSk.publicKey.rawRepresentation),
        ]))
        _ = try await phone.receive()
        let sealed = try QrRelay.seal(
            payload: try JSONSerialization.data(withJSONObject: ["devicePubHex": "abcd", "deviceId": deviceId]),
            with: try fx.material().aeadKey
        )
        try await phone.send(LivePairingRelayClient.json([
            "kind": "deliver", "ciphertext": sealed.ciphertextBase64Url, "nonce": sealed.nonceBase64Url,
        ]))
        do {
            _ = try await adminTask.value
            XCTFail("a short device key must not be accepted")
        } catch PairingRelayError.transport(_) {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func test_closeUnblocksAwaitingAdmin() async throws {
        let fx = try makeFixture()
        let hub = FakeRelayHub()
        let admin = LivePairingRelayClient(factory: hub)
        let adminTask = Task { try await admin.adminAwaitDevicePubkey(sid: "sid-close", adminPrivateKey: fx.adminSk) }
        try await waitUntil("admin browser slot") { hub.hasBrowser("sid-close") }
        await admin.close()
        do {
            _ = try await adminTask.value
            XCTFail("expected sessionInvalidated")
        } catch PairingRelayError.sessionInvalidated {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    // MARK: - View models over the live client

    @MainActor
    func test_addDeviceViewModel_overLiveRelay_deliversASealedBundle() async throws {
        let hub = FakeRelayHub()
        let adminIrk = Curve25519.Signing.PrivateKey()
        let admin = LivePairingRelayClient(factory: hub)
        let vm = AddDeviceViewModel(
            account: "acme",
            relay: admin,
            deriveIRK: { _ in adminIrk },
            currentUMKHex: { _ in HexUtil.encode(Data(repeating: 7, count: 32)) },
            canPromoteToAdmin: false
        )
        let started = Task { await vm.start() }
        try await waitUntil("QR") {
            if case .waitingForDevice = vm.phase { return hub.sids().count == 1 }
            return false
        }
        guard case .waitingForDevice(let qr) = vm.phase else { return XCTFail("phase \(vm.phase)") }
        let session = try PairingQr.parseJoinUrl(qr)

        let handshake = Curve25519.KeyAgreement.PrivateKey()
        let signing = Curve25519.Signing.PrivateKey()
        let mat = try QrRelay.deriveMaterial(phonePrivateKey: handshake, browserPublicKey: session.adminPublicKey)
        let raw = handshake.publicKey.rawRepresentation + signing.publicKey.rawRepresentation
            + (try XCTUnwrap(HexUtil.decode(deviceId)))
        let incoming = LivePairingRelayClient(factory: hub)
        let bundleTask = Task {
            try await incoming.incomingSendPubkeyAwaitBundle(
                sid: session.sid,
                handshakePublicKey: handshake.publicKey.rawRepresentation,
                aeadKey: mat.aeadKey,
                devicePubRaw: raw
            )
        }

        await started.value
        guard case .confirmMatch(_, let code, _) = vm.phase else { return XCTFail("phase \(vm.phase)") }
        XCTAssertEqual(code, mat.matchCode)
        vm._forceGateExpiredForTests()
        await vm.confirmMatch()
        guard case .admitted = vm.phase else { return XCTFail("phase \(vm.phase)") }

        let frame = try await bundleTask.value
        let plain = try XCTUnwrap(LivePairingRelayClient.aeadOpen(
            key: mat.aeadKey,
            ciphertextBase64Url: frame.ciphertextBase64Url,
            nonceBase64Url: frame.nonceBase64Url
        ))
        let bundle = try PairingBundle.decode(plain)
        XCTAssertEqual(bundle.admit.username, "acme")
        XCTAssertEqual(bundle.admit.newDevicePubHex, HexUtil.encode(signing.publicKey.rawRepresentation))
        XCTAssertEqual(bundle.admit.deviceId, deviceId)
    }

    // MARK: - Golden vectors (test-vectors/pairing-relay.json)

    private func loadVectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("test-vectors").appendingPathComponent("pairing-relay.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("could not locate test-vectors/pairing-relay.json from \(#filePath)")
        throw NSError(domain: "fixture", code: 1)
    }

    func test_goldenVectors_matchWebCrypto() throws {
        let v = try loadVectors()
        let adminSk = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: try XCTUnwrap(HexUtil.decode(v["adminSkHex"] as! String))
        )
        let incomingSk = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: try XCTUnwrap(HexUtil.decode(v["incomingSkHex"] as! String))
        )
        XCTAssertEqual(Base64URL.encode(adminSk.publicKey.rawRepresentation), v["adminPkB64u"] as? String)
        XCTAssertEqual(Base64URL.encode(incomingSk.publicKey.rawRepresentation), v["incomingPkB64u"] as? String)

        let fromAdmin = try QrRelay.deriveMaterial(
            phonePrivateKey: adminSk, browserPublicKey: incomingSk.publicKey.rawRepresentation
        )
        let fromIncoming = try QrRelay.deriveMaterial(
            phonePrivateKey: incomingSk, browserPublicKey: adminSk.publicKey.rawRepresentation
        )
        XCTAssertEqual(fromAdmin.matchCode, v["sas"] as? String)
        XCTAssertEqual(fromIncoming.matchCode, v["sas"] as? String)
        let kEnc = fromAdmin.aeadKey.withUnsafeBytes { Data($0) }
        XCTAssertEqual(HexUtil.encode(kEnc), v["kEncHex"] as? String)

        for name in ["incomingHello", "adminBundle"] {
            let entry = try XCTUnwrap(v[name] as? [String: Any])
            let plaintext = Data((entry["plaintext"] as! String).utf8)
            let ct = entry["ciphertext"] as! String
            let nonceB64 = entry["nonce"] as! String

            XCTAssertEqual(
                LivePairingRelayClient.aeadOpen(key: fromIncoming.aeadKey, ciphertextBase64Url: ct, nonceBase64Url: nonceB64),
                plaintext, "\(name) opens"
            )

            let nonce = try AES.GCM.Nonce(data: try XCTUnwrap(Base64URL.decode(nonceB64)))
            let sealed = try AES.GCM.seal(plaintext, using: fromAdmin.aeadKey, nonce: nonce)
            XCTAssertEqual(Base64URL.encode(sealed.ciphertext + sealed.tag), ct, "\(name) seals byte-identically")
        }
    }
}
