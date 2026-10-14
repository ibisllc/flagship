import XCTest
@testable import FlagshipCore
import FlagshipAPI

final class AccountReadTokenProviderTests: XCTestCase {
    private final class Minter: AccountReadTokenMinting, @unchecked Sendable {
        var calls: [String] = []
        var refuseDevice = false
        var refuseAll = false
        var serial = 0
        let lifetime: Int64
        let clock: Clock
        init(clock: Clock, lifetime: Int64 = 1_000_000) { self.clock = clock; self.lifetime = lifetime }
        func mintAccountReadToken(username: String, credential: AccountReadTokenCredential) async throws -> AccountReadTokenResponse {
            switch credential {
            case .device: calls.append("device:\(username)")
            case .irk: calls.append("irk:\(username)")
            }
            if refuseAll { throw ScreensClientError.http(status: 403, message: "not authorized") }
            if case .device = credential, refuseDevice { throw ScreensClientError.http(status: 403, message: "not authorized") }
            serial += 1
            return AccountReadTokenResponse(token: "art1.t\(serial)", expiresAt: clock.now + lifetime)
        }
    }

    private final class Clock: @unchecked Sendable { var now: Int64 = 1_000_000 }

    private final class Keys: @unchecked Sendable {
        var available = true
        var asked = 0
        func credentials() -> [AccountReadTokenCredential] {
            asked += 1
            guard available else { return [] }
            let auth = AccountDirectoryAuthorization(deviceId: "d", signerPubHex: "p", requestId: "r", issuedAt: 1, signatureHex: "s")
            let envelope = MailboxAuthEnvelope(
                auth: .init(username: "alice", endpointLabel: "account-read-token", phoneIrkPub: "k", issuedAt: 1, expiresAt: 2, nonce: "n"),
                authSignature: "sig"
            )
            return [.device(auth), .irk(envelope)]
        }
    }

    private final class Paused: @unchecked Sendable { var values: [Bool] = [] }

    private func make(
        keyless: Bool = false
    ) -> (AccountReadTokenProvider, Minter, Keys, InMemoryAccountReadTokenStore, Clock, Paused) {
        let clock = Clock()
        let minter = Minter(clock: clock)
        let keys = Keys()
        let store = InMemoryAccountReadTokenStore()
        let paused = Paused()
        let provider = AccountReadTokenProvider(
            minter: minter,
            store: store,
            credentials: { _ in keys.credentials() },
            isKeyless: { _ in keyless },
            onPausedChanged: { paused.values.append($0) },
            now: { clock.now }
        )
        return (provider, minter, keys, store, clock, paused)
    }

    func testMintsWithTheDeviceKeyAndReusesTheToken() async {
        let (provider, minter, _, store, _, _) = make()
        let first = await provider.token(for: "Alice")
        let second = await provider.token(for: "alice")
        XCTAssertEqual(first, "art1.t1")
        XCTAssertEqual(second, "art1.t1")
        XCTAssertEqual(minter.calls, ["device:alice"])
        XCTAssertEqual(store.load(username: "alice")?.token, "art1.t1")
    }

    func testFallsBackToTheIrkWhenTheDeviceIsRefused() async {
        let (provider, minter, _, _, _, _) = make()
        minter.refuseDevice = true
        let token = await provider.token(for: "alice")
        XCTAssertEqual(token, "art1.t1")
        XCTAssertEqual(minter.calls, ["device:alice", "irk:alice"])
    }

    func testNoKeysAtHandMeansNoTokenAndNoMint() async {
        let (provider, minter, keys, _, _, _) = make()
        keys.available = false
        let token = await provider.token(for: "alice")
        XCTAssertNil(token)
        XCTAssertTrue(minter.calls.isEmpty)
        // Keys turn up (an unlock): the very next read mints.
        keys.available = true
        let next = await provider.token(for: "alice")
        XCTAssertEqual(next, "art1.t1")
    }

    func testDemoAccountsSendNoTokenAndNeverSign() async {
        let (provider, minter, keys, _, _, _) = make(keyless: true)
        let token = await provider.token(for: "alice")
        let rejected = await provider.tokenAfterRejection(for: "alice")
        XCTAssertNil(token)
        XCTAssertNil(rejected)
        XCTAssertEqual(keys.asked, 0)
        XCTAssertTrue(minter.calls.isEmpty)
    }

    func testRejectionMintsAFreshTokenOnce() async {
        let (provider, minter, _, _, _, _) = make()
        _ = await provider.token(for: "alice")
        let fresh = await provider.tokenAfterRejection(for: "alice")
        XCTAssertEqual(fresh, "art1.t2")
        XCTAssertEqual(minter.calls.count, 2)
    }

    func testRejectionWithoutKeysPausesUntilAMintSucceeds() async {
        let (provider, _, keys, store, _, paused) = make()
        _ = await provider.token(for: "alice")
        keys.available = false
        let fresh = await provider.tokenAfterRejection(for: "alice")
        XCTAssertNil(fresh)
        XCTAssertNil(store.load(username: "alice"))
        XCTAssertEqual(paused.values, [true])
        keys.available = true
        _ = await provider.token(for: "alice")
        XCTAssertEqual(paused.values, [true, false])
    }

    func testARefusedMintWaitsBeforeSigningAgain() async {
        let (provider, minter, _, _, clock, _) = make()
        minter.refuseAll = true
        _ = await provider.token(for: "alice")
        _ = await provider.token(for: "alice")
        XCTAssertEqual(minter.calls.count, 2)
        clock.now += 61_000
        minter.refuseAll = false
        let token = await provider.token(for: "alice")
        XCTAssertEqual(token, "art1.t1")
    }

    func testRetryNowSkipsTheBackoffAfterTheOwnerUnlocks() async {
        let (provider, minter, _, _, _, paused) = make()
        minter.refuseAll = true
        _ = await provider.tokenAfterRejection(for: "alice")
        XCTAssertEqual(paused.values, [true])
        minter.refuseAll = false
        // Still inside the refusal's backoff: a background read doesn't sign.
        let callsBefore = minter.calls.count
        let backedOff = await provider.tokenAfterRejection(for: "alice")
        XCTAssertNil(backedOff)
        XCTAssertEqual(minter.calls.count, callsBefore)
        // The owner taps "Show my servers": mint at once and unpause.
        let ok = await provider.retryNow(for: "alice")
        XCTAssertTrue(ok)
        XCTAssertEqual(paused.values, [true, false])
    }

    func testRetryNowNeverSignsForADemoAccount() async {
        let (provider, minter, keys, _, _, _) = make(keyless: true)
        let ok = await provider.retryNow(for: "alice")
        XCTAssertTrue(ok)
        XCTAssertEqual(keys.asked, 0)
        XCTAssertTrue(minter.calls.isEmpty)
    }

    func testRenewsPastHalfLifeAndKeepsTheOldTokenIfItCant() async {
        let (provider, minter, keys, _, clock, _) = make()
        _ = await provider.token(for: "alice")
        clock.now += 600_000
        keys.available = false
        let kept = await provider.token(for: "alice")
        XCTAssertEqual(kept, "art1.t1")
        keys.available = true
        let renewed = await provider.token(for: "alice")
        XCTAssertEqual(renewed, "art1.t2")
        XCTAssertEqual(minter.calls.count, 2)
    }

    func testSignOutWipesEveryToken() async {
        let (provider, _, _, store, _, _) = make()
        _ = await provider.token(for: "alice")
        await provider.clearAll()
        XCTAssertNil(store.load(username: "alice"))
    }

    // MARK: - sendAccountRead

    private final class Sent: @unchecked Sendable { var bearers: [String?] = [] }

    func testSendRetriesOnceWithAFreshTokenAfterA401() async throws {
        let (provider, _, _, _, _, _) = make()
        let sent = Sent()
        let req = URLRequest(url: URL(string: "https://flagshipserver.com/api/users/alice/pods")!)
        let (_, status) = try await sendAccountRead(req, username: "alice", tokens: provider) { r in
            sent.bearers.append(r.value(forHTTPHeaderField: "authorization"))
            let code = sent.bearers.count == 1 ? 401 : 200
            return (Data("{}".utf8), HTTPURLResponse(url: r.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(status, 200)
        XCTAssertEqual(sent.bearers, ["Bearer art1.t1", "Bearer art1.t2"])
    }

    func testSendGivesUpAfterOneRetry() async throws {
        let (provider, _, keys, _, _, _) = make()
        let sent = Sent()
        let req = URLRequest(url: URL(string: "https://flagshipserver.com/api/users/alice/pods")!)
        keys.available = false
        let (_, status) = try await sendAccountRead(req, username: "alice", tokens: provider) { r in
            sent.bearers.append(r.value(forHTTPHeaderField: "authorization"))
            return (Data(), HTTPURLResponse(url: r.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(status, 401)
        XCTAssertEqual(sent.bearers, [nil])
    }
}
