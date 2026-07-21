import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// Build-a-service view models + the Mock's wire fixtures.
@MainActor
final class BuildModesViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    // MARK: - Mock fixtures match the documented wire shapes

    func test_mockGit_fitVerdict_forFlagshipReadyUrl() async throws {
        let client = makeClient()
        let r = try await client.buildGit(BuildGitRequest(gitUrl: "https://github.com/me/flagship-app"))
        XCTAssertTrue(r.fit)
        XCTAssertNotNil(r.manifestName)
        XCTAssertEqual(client.buildGitCalls.count, 1)
    }

    func test_mockGit_notFitVerdict_forArbitraryUrl() async throws {
        let client = makeClient()
        let r = try await client.buildGit(BuildGitRequest(gitUrl: "https://github.com/me/random"))
        XCTAssertFalse(r.fit)
        XCTAssertNil(r.manifestName)
    }

    func test_mockEnvRequests_isValueFree() async throws {
        let client = makeClient()
        let r = try await client.buildEnvRequests(buildId: "b1")
        let q = try XCTUnwrap(r.requests.first)
        XCTAssertEqual(q.name, "STRIPE_SECRET_KEY")
        XCTAssertEqual(q.secret, true)
        XCTAssertFalse(q.currentlySet)
    }

    func test_mockMcp_create_returnsConnectionWithBuildScopedKey() async throws {
        let client = makeClient()
        let r = try await client.buildMcpCreate(BuildMcpRequest(label: "ios"))
        XCTAssertTrue(r.connection.url.contains("/mcp/build/\(r.buildId)"))
        XCTAssertFalse(r.connection.key.isEmpty)
        XCTAssertNotNil(r.connection.ideConfig["mcpServers"])
    }

    // MARK: - BuildGitViewModel

    func test_gitVM_check_fit_setsVerdictPhase() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/flagship-app"
        await vm.checkRepo()
        guard case .verdict(let r) = vm.phase else {
            return XCTFail("expected verdict, got \(vm.phase)")
        }
        XCTAssertTrue(r.fit)
        XCTAssertNotNil(vm.buildId)
    }

    func test_gitVM_canCheck_requiresUrl() {
        let vm = BuildGitViewModel(client: makeClient())
        XCTAssertFalse(vm.canCheck)
        vm.gitUrl = "  "
        XCTAssertFalse(vm.canCheck)
        vm.gitUrl = "https://x/y"
        XCTAssertTrue(vm.canCheck)
    }

    func test_gitVM_deploy_installsAndShowsUrl() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/flagship-app"
        await vm.checkRepo()
        await vm.deploy()
        guard case .installed(let url) = vm.phase else {
            return XCTFail("expected installed, got \(vm.phase)")
        }
        XCTAssertTrue(url.hasPrefix("https://"))
        XCTAssertEqual(client.buildDeployCalls.count, 1)
    }

    func test_gitVM_adapt_success_setsAdaptedPhase() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        await vm.adapt()
        guard case .adapted(let n) = vm.phase else {
            return XCTFail("expected adapted, got \(vm.phase)")
        }
        XCTAssertEqual(n, 16)
        XCTAssertFalse(vm.shouldFallBackToScratch)
    }

    func test_gitVM_adapt_503_flagsScratchFallback() async {
        let client = makeClient()
        client.buildAdaptUnavailable = true
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        await vm.adapt()
        XCTAssertTrue(vm.shouldFallBackToScratch)
    }

    func test_gitVM_check_failure_setsErrorAndStaysIdle() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://x/y"
        await vm.checkRepo()
        guard case .idle = vm.phase else {
            return XCTFail("expected idle after failure, got \(vm.phase)")
        }
        XCTAssertNotNil(vm.errorMessage)
    }

    /// A 404 on "Check repo" means the box has no service/build platform — the
    /// user should see the platform-absent copy, not the generic "couldn't find
    /// that / may have moved" 404 string.
    func test_gitVM_check_404_showsPlatformAbsentMessage() async {
        let client = makeClient()
        client.simulatedFailureStatus = 404
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://x/y"
        await vm.checkRepo()
        let msg = vm.errorMessage ?? ""
        XCTAssertTrue(msg.contains("isn't set up to build services"),
                      "expected platform-absent copy, got: \(msg)")
        XCTAssertFalse(msg.contains("moved or been removed"))
    }

    func test_mcpVM_create_404_showsPlatformAbsentMessage() async {
        let client = makeClient()
        client.simulatedFailureStatus = 404
        let vm = BuildMcpViewModel(client: client)
        await vm.createConnection()
        let msg = vm.errorMessage ?? ""
        XCTAssertTrue(msg.contains("isn't set up to build services"),
                      "expected platform-absent copy, got: \(msg)")
    }

    func test_journalVM_loadList_404_showsPlatformAbsentMessage() async {
        let client = makeClient()
        client.simulatedFailureStatus = 404
        let vm = BuildJournalViewModel(client: client)
        await vm.loadList()
        let msg = vm.list.failure ?? ""
        XCTAssertTrue(msg.contains("isn't set up to build services"),
                      "expected platform-absent copy, got: \(msg)")
    }

    // MARK: - BuildMcpViewModel

    func test_mcpVM_create_populatesConnectionAndEnvRequests() async {
        let client = makeClient()
        let vm = BuildMcpViewModel(client: client)
        await vm.createConnection()
        XCTAssertNotNil(vm.connection)
        XCTAssertNotNil(vm.buildId)
        // env-requests are pulled as part of create.
        XCTAssertFalse(vm.envRequests.isEmpty)
    }

    func test_mcpVM_ideConfigJson_isPrettyPrinted() async {
        let client = makeClient()
        let vm = BuildMcpViewModel(client: client)
        await vm.createConnection()
        let json = vm.ideConfigJson
        XCTAssertTrue(json.contains("mcpServers"))
        XCTAssertTrue(json.contains("\n"), "expected pretty-printed multi-line JSON")
    }

    func test_mcpVM_rotate_swapsKey() async {
        let client = makeClient()
        let vm = BuildMcpViewModel(client: client)
        await vm.createConnection()
        let oldKey = vm.connection?.key
        await vm.rotateKey()
        XCTAssertNotNil(vm.connection?.key)
        XCTAssertNotEqual(vm.connection?.key, oldKey)
        XCTAssertEqual(client.buildMcpRotateCalls.count, 1)
    }

    func test_mcpVM_deploy_setsDeployedUrl() async {
        let client = makeClient()
        let vm = BuildMcpViewModel(client: client)
        await vm.createConnection()
        await vm.deploy()
        XCTAssertNotNil(vm.deployedUrl)
        XCTAssertEqual(client.buildDeployCalls.count, 1)
    }

    // MARK: - BuildJournalViewModel

    func test_journalVM_loadList_loadsPastBuilds() async {
        let client = makeClient()
        let vm = BuildJournalViewModel(client: client)
        await vm.loadList()
        guard case .loaded(let builds) = vm.list else {
            return XCTFail("expected loaded, got \(vm.list)")
        }
        XCTAssertEqual(builds.count, 2)
        XCTAssertNil(vm.openedBuildId)
    }

    func test_journalVM_loadDetail_opensTimeline() async {
        let client = makeClient()
        let vm = BuildJournalViewModel(client: client)
        await vm.loadDetail(buildId: "bld-plants01")
        XCTAssertEqual(vm.openedBuildId, "bld-plants01")
        guard case .loaded(let entries) = vm.detail else {
            return XCTFail("expected loaded, got \(vm.detail)")
        }
        XCTAssertFalse(entries.isEmpty)
        XCTAssertEqual(entries.first?.seq, 1)
    }

    func test_journalVM_closeDetail_returnsToList() async {
        let client = makeClient()
        let vm = BuildJournalViewModel(client: client)
        await vm.loadDetail(buildId: "b1")
        vm.closeDetail()
        XCTAssertNil(vm.openedBuildId)
        XCTAssertNil(vm.detail.value)
    }

    func test_journalVM_loadList_failure_setsFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = BuildJournalViewModel(client: client)
        await vm.loadList()
        XCTAssertNotNil(vm.list.failure)
    }
}
