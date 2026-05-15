import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// V2 — AppDetailViewModel.renameApp ceremony. Exercises the
/// signing + POST + state-machine paths against MockFlagshipServerClient.
@MainActor
final class AppRenameViewModelTests: XCTestCase {

    override func tearDown() async throws {
        Keystore.wipe()
        try await super.tearDown()
    }

    private func makeUMK() async throws {
        try await Keystore.generateUMK(reason: "test")
    }

    func test_canonicalBytes_matchProtocolFieldOrder() {
        // Pin Worker contract: tag | username | appId | newLabel | issuedAt.
        let bytes = AppRenameClaim.canonicalBytes(
            username: "alice",
            appId: "meta-scratchpad",
            newDisplayLabel: "mynotes",
            issuedAt: 1700000000000,
        )
        let s = String(data: bytes, encoding: .utf8)!
        XCTAssertEqual(s, "flagship/app-rename/v1|alice|meta-scratchpad|mynotes|1700000000000")
    }

    func test_renameApp_happyPath_postsSignedEnvelope_andUpdatesAppLinks() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.appRenameBehavior = .ok
        let vm = AppDetailViewModel(
            appId: "meta-scratchpad",
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            server: server,
            username: { "alice" },
        )

        let ok = await vm.renameApp(to: "MyNotes")  // case-insensitive; lowered by ceremony
        XCTAssertTrue(ok)

        // Phase landed on .completed.
        if case .completed(let label, let shortUrl) = vm.renamePhase {
            XCTAssertEqual(label, "mynotes")
            XCTAssertNotNil(shortUrl)
        } else {
            XCTFail("expected .completed, got \(vm.renamePhase)")
        }

        // The recorded server call carries the lowercased label +
        // the ed25519 signature.
        let last = try XCTUnwrap(server.lastAppRename)
        XCTAssertEqual(last.username, "alice")
        XCTAssertEqual(last.appId, "meta-scratchpad")
        XCTAssertEqual(last.body.request.newDisplayLabel, "mynotes")
        XCTAssertEqual(last.body.signature.count, 128) // 64-byte sig in hex
    }

    func test_renameApp_collision_surfacesFriendlyError() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.appRenameBehavior = .collision
        let vm = AppDetailViewModel(
            appId: "meta-scratchpad",
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            server: server,
            username: { "alice" },
        )

        let ok = await vm.renameApp(to: "taken")
        XCTAssertFalse(ok)
        if case .failed(let msg) = vm.renamePhase {
            XCTAssertTrue(msg.lowercased().contains("name"))
        } else {
            XCTFail("expected .failed, got \(vm.renamePhase)")
        }
    }

    func test_renameApp_emptyDraft_failsImmediately_withoutSigning() async {
        let server = MockFlagshipServerClient()
        let vm = AppDetailViewModel(
            appId: "meta-scratchpad",
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            server: server,
            username: { "alice" },
        )
        let ok = await vm.renameApp(to: "   ")
        XCTAssertFalse(ok)
        if case .failed = vm.renamePhase {} else {
            XCTFail("expected .failed, got \(vm.renamePhase)")
        }
        // No server call was made.
        XCTAssertNil(server.lastAppRename)
    }

    func test_renameApp_noUsername_failsImmediately() async {
        let server = MockFlagshipServerClient()
        let vm = AppDetailViewModel(
            appId: "meta-scratchpad",
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            server: server,
            username: { nil },
        )
        let ok = await vm.renameApp(to: "fine")
        XCTAssertFalse(ok)
    }

    func test_loadAppLinks_storesResponse() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = AppDetailViewModel(
            appId: "meta-scratchpad",
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            server: server,
            username: { "alice" },
        )
        await vm.loadAppLinks()
        // Mock returns a synthetic alias — verify we surfaced it.
        XCTAssertNotNil(vm.appLinks.value)
        XCTAssertEqual(vm.appLinks.value?.appId, "meta-scratchpad")
    }
}
