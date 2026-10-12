import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// docs/app-apis.md §3 on iOS: the "API keys" section of an app's page, the
/// signed create (for the box the client talks to), the key shown once, and
/// revoke.
@MainActor
final class AppApiKeysClientTests: XCTestCase {

    private func makeClient(pod: String = "home") -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = pod
        return c
    }

    private func controller(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                            serviceId: String = "bright-maple--plants", canChange: Bool = true,
                            fallback: String? = "home.bright-maple.flagship.services") -> AppApiKeysController {
        AppApiKeysController(serviceId: serviceId, appName: "Plants", client: client, serverDomain: fallback,
                             canChange: canChange, signer: { _ in key })
    }

    func test_load_listsKeysNewestFirst() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        XCTAssertFalse(c.isHidden)
        XCTAssertEqual(c.keys.map(\.label), ["Dashboard", "Garden sensor"])
        XCTAssertEqual(c.keys.first?.scope, .read)
        XCTAssertNil(c.keys.first?.lastUsedAt)
    }

    func test_load_aBoxWithoutApiKeys_hidesTheSection() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey(), serviceId: "trent--scratchpad")
        await c.load()
        XCTAssertTrue(c.isHidden)

        let failing = makeClient()
        failing.simulatedFailureStatus = 503
        let c2 = controller(failing, key: Curve25519.Signing.PrivateKey())
        await c2.load()
        XCTAssertFalse(c2.isHidden)
        XCTAssertNotNil(c2.state.failure)
    }

    func test_create_signsForTheBoxTheClientTalksTo_andShowsTheKeyOnce() async throws {
        let client = makeClient(pod: "home2")
        let key = Curve25519.Signing.PrivateKey()
        client.mockApiKeyVerifyKey = key.publicKey.rawRepresentation
        // The fallback names the leader; the grant must name home2.
        let c = controller(client, key: key, fallback: "home.bright-maple.flagship.services")
        await c.load()
        let before = Int64(Date().timeIntervalSince1970 * 1000)
        let ok = await c.create(label: "  Weather station  ", scope: .write)
        XCTAssertTrue(ok, c.createError ?? "")
        let call = try XCTUnwrap(client.serviceApiKeyCreateCalls.last)
        let g = call.req.grant
        XCTAssertEqual(call.serviceId, "bright-maple--plants")
        XCTAssertEqual(g.serverDomain, "home2.bright-maple.flagship.services")
        XCTAssertEqual(g.serviceId, "bright-maple--plants")
        XCTAssertTrue(AppApiKeyId.isValid(g.keyId))
        XCTAssertEqual(g.scope, .write)
        XCTAssertGreaterThanOrEqual(g.issuedAt, before)
        XCTAssertEqual(g.expiresAt, 0)
        XCTAssertEqual(call.req.label, "Weather station")
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(call.req.signature)!, for: g.canonicalBytes()))

        let created = try XCTUnwrap(c.createdKey)
        XCTAssertTrue(created.key.hasPrefix("fsk_\(g.keyId)_"))
        XCTAssertEqual(created.usage, "Authorization: Bearer \(created.key)")
        XCTAssertEqual(c.keys.first?.keyId, g.keyId)
        XCTAssertEqual(c.keys.first?.label, "Weather station")
        // The list never carries the secret; closing the sheet forgets it.
        c.dismissCreatedKey()
        XCTAssertNil(c.createdKey)
    }

    func test_create_onAnAppWithNoKeys() async throws {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey(), serviceId: "bright-maple--wiki")
        await c.load()
        XCTAssertEqual(c.keys, [])
        let ok = await c.create(label: "Backup script", scope: .read)
        XCTAssertTrue(ok, c.createError ?? "")
        XCTAssertEqual(client.serviceApiKeyCreateCalls.last?.req.grant.expiresAt, 0)
        XCTAssertNil(c.keys.first?.expiresAt)
    }

    func test_create_aTakenKeyId409_retriesOnceWithAFreshOne() async throws {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        client.serviceApiKeyCreateError = ScreensClientError.http(status: 409, message: #"{"error":"keyId exists"}"#)
        let ok = await c.create(label: "Sensor", scope: .read)
        XCTAssertTrue(ok, c.createError ?? "")
        XCTAssertEqual(client.serviceApiKeyCreateCalls.count, 2)
        let ids = client.serviceApiKeyCreateCalls.map(\.req.grant.keyId)
        XCTAssertNotEqual(ids[0], ids[1])
    }

    func test_create_twice409_givesUp() async throws {
        final class Counter: @unchecked Sendable { var n = 0 }
        let client = makeClient()
        let ids = ["0123456789abcdef", "0123456789abcdef", "0123456789abcdef"]
        let counter = Counter()
        // Same keyId every time: the seeded mock list doesn't hold it, so make
        // the first create succeed, then two more both collide.
        _ = try await AppApiKeyOrder.create(
            label: "A", scope: .read, serviceId: "bright-maple--plants", appName: "Plants",
            client: client, fallbackServerDomain: nil, signer: { _ in Curve25519.Signing.PrivateKey() },
            keyId: { defer { counter.n += 1 }; return ids[counter.n] })
        do {
            _ = try await AppApiKeyOrder.create(
                label: "B", scope: .read, serviceId: "bright-maple--plants", appName: "Plants",
                client: client, fallbackServerDomain: nil, signer: { _ in Curve25519.Signing.PrivateKey() },
                keyId: { defer { counter.n += 1 }; return ids[counter.n] })
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(AppApiKeysCopy.message(for: error), "A key with that id already exists. Try again.")
        }
        XCTAssertEqual(client.serviceApiKeyCreateCalls.count, 3)
    }

    func test_create_labelRules() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        let empty = await c.create(label: "   ", scope: .read)
        XCTAssertFalse(empty)
        XCTAssertEqual(c.createError, "Give the key a name, so you know what uses it.")
        let long = await c.create(label: String(repeating: "x", count: 65), scope: .read)
        XCTAssertFalse(long)
        XCTAssertEqual(c.createError, "Keep the name under 65 characters.")
        XCTAssertTrue(client.serviceApiKeyCreateCalls.isEmpty)
        let max = await c.create(label: String(repeating: "x", count: 64), scope: .read)
        XCTAssertTrue(max, c.createError ?? "")
    }

    func test_onlyAnFskKeyForThisKeyIdCounts() {
        XCTAssertEqual(AppApiKeysCopy.noKeyReturned, "Your server didn't return the new key.")
        XCTAssertFalse(AppApiKeyOrder.isKey("", keyId: "0123456789abcdef"))
        XCTAssertFalse(AppApiKeyOrder.isKey("fsk_0123456789abcdef_", keyId: "0123456789abcdef"))
        XCTAssertFalse(AppApiKeyOrder.isKey("fsk_fedcba9876543210_abc", keyId: "0123456789abcdef"))
        XCTAssertFalse(AppApiKeyOrder.isKey("fsk_0123456789abcdef_a b", keyId: "0123456789abcdef"))
        XCTAssertTrue(AppApiKeyOrder.isKey("fsk_0123456789abcdef_Ab-_9", keyId: "0123456789abcdef"))
    }

    func test_create_refusalsArePlain_andSignerRefusalSendsNothing() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        client.serviceApiKeyCreateError = ScreensClientError.http(status: 403, message: #"{"error":"stale grant"}"#)
        let r1 = await c.create(label: "A", scope: .read)
        XCTAssertFalse(r1)
        XCTAssertEqual(c.createError, "Your phone's clock is more than 10 minutes off. Check the date and time, then try again.")
        XCTAssertNil(c.createdKey)
        XCTAssertEqual(AppApiKeysCopy.message(for: ScreensClientError.http(status: 403, message: #"{"error":"grant is for a different server"}"#)),
                       "This key was signed for a different server. Reload the page and try again.")
        XCTAssertEqual(AppApiKeysCopy.message(for: ScreensClientError.http(status: 403, message: #"{"error":"companion sessions are read-only"}"#)),
                       AppApiKeysCopy.readOnlyNote)
        XCTAssertEqual(AppApiKeysCopy.message(for: ScreensClientError.http(status: 403, message: #"{"error":"bad signature"}"#)),
                       "Your server didn't accept this key's signature.")

        let refused = AppApiKeysController(serviceId: "bright-maple--plants", appName: "Plants", client: client,
                                           serverDomain: nil,
                                           signer: { _ in throw Keystore.KeystoreError.unwrapFailed("cancelled") })
        let calls = client.serviceApiKeyCreateCalls.count
        let r2 = await refused.create(label: "A", scope: .read)
        XCTAssertFalse(r2)
        XCTAssertEqual(client.serviceApiKeyCreateCalls.count, calls)
        XCTAssertTrue(refused.createError?.hasPrefix("Couldn't access your account key") == true)
    }

    func test_revoke_removesTheKey_and404CountsAsRevoked() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        let ok = await c.revoke(keyId: "3f9a0c2e7b1d4a68")
        XCTAssertTrue(ok)
        XCTAssertEqual(client.serviceApiKeyRevokeCalls.map(\.keyId), ["3f9a0c2e7b1d4a68"])
        XCTAssertEqual(c.keys.map(\.keyId), ["a1b2c3d4e5f60718"])
        let again = await c.revoke(keyId: "3f9a0c2e7b1d4a68")
        XCTAssertTrue(again)
        XCTAssertNil(c.errorMessage)
    }

    func test_restricted_isReadOnly() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey(), canChange: false)
        await c.load()
        XCTAssertEqual(c.keys.count, 2)
        let created = await c.create(label: "A", scope: .read)
        let revoked = await c.revoke(keyId: "3f9a0c2e7b1d4a68")
        XCTAssertFalse(created)
        XCTAssertFalse(revoked)
        XCTAssertTrue(client.serviceApiKeyCreateCalls.isEmpty)
        XCTAssertTrue(client.serviceApiKeyRevokeCalls.isEmpty)
    }

    func test_details() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let fresh = AppApiKey(keyId: "0123456789abcdef", label: "A", scope: .write, createdAt: 1_760_000_000_000 - 120_000)
        XCTAssertEqual(AppApiKeysCopy.details(fresh, now: now), "Read & write · Created 2m ago · Never used")
        // A future expiry (keys made elsewhere) isn't shown; only a past one is.
        let future = AppApiKey(keyId: "0123456789abcdef", label: "A", scope: .read, createdAt: 1_760_000_000_000 - 120_000,
                               expiresAt: 1_800_000_000_000)
        XCTAssertEqual(AppApiKeysCopy.details(future, now: now), "Read · Created 2m ago · Never used")
        let expired = AppApiKey(keyId: "0123456789abcdef", label: "A", scope: .read, createdAt: 1_759_999_000_000,
                                lastUsedAt: 1_759_999_990_000, expiresAt: 1_759_999_999_000)
        XCTAssertTrue(AppApiKeysCopy.details(expired, now: now).hasPrefix("Read · Created 16m ago · Last used just now · Expired "))
    }

    // MARK: - Service page

    func test_detail_showsTheSection_unlessTheBox404s() async {
        let client = makeClient()
        let vm = ServiceDetailViewModel(serviceId: "bright-maple--plants", client: client, allPods: [],
                                        serverDomain: "home.bright-maple.flagship.services",
                                        egressSigner: { _ in Curve25519.Signing.PrivateKey() })
        await vm.load()
        XCTAssertTrue(vm.showsApiKeys)
        XCTAssertEqual(vm.apiKeys?.keys.count, 2)
        XCTAssertEqual(vm.apiKeys?.canChange, true)

        let older = makeClient()
        older.mockApiKeys = [:]
        let vm2 = ServiceDetailViewModel(serviceId: "bright-maple--plants", client: older, allPods: [],
                                         accessCanChange: false)
        await vm2.load()
        XCTAssertFalse(vm2.showsApiKeys)
        XCTAssertEqual(vm2.apiKeys?.canChange, false)
    }
}
