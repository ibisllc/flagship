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
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        await vm.adapt()
        XCTAssertEqual(client.buildAdaptStartCalls.first?.req.background, true)
        guard case .adapted(let n) = vm.phase else {
            return XCTFail("expected adapted, got \(vm.phase)")
        }
        XCTAssertEqual(n, 16)
        XCTAssertFalse(vm.shouldFallBackToScratch)
    }

    func test_gitVM_sendsTheTypedNameAsALabel() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/random"
        vm.name = "My App"
        await vm.checkRepo()
        XCTAssertEqual(client.buildGitCalls.last?.name, "myapp")
        XCTAssertEqual(vm.assignedName, "myapp")

        vm.name = ""
        client.buildGitFixture = BuildGitResponse(buildId: "b", fit: false, reason: "no flagship.app.json", fileCount: 3, name: "random-dev")
        await vm.checkRepo()
        XCTAssertNil(client.buildGitCalls.last?.name)
        XCTAssertEqual(vm.assignedName, "random-dev")
    }

    func test_gitVM_takenName_raisesTheConflict() async {
        let client = makeClient()
        client.buildGitError = ScreensClientError.http(
            status: 409, message: #"{"error":"A build session already uses the name \"notes\".","ok":false,"kind":"session","sessionId":"s1","message":"x"}"#)
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/notes"
        vm.name = "notes"
        await vm.checkRepo()
        XCTAssertEqual(vm.conflict?.kind, "session")
        XCTAssertEqual(vm.conflict?.sessionId, "s1")
        XCTAssertNil(vm.buildId)
        guard case .idle = vm.phase else { return XCTFail("expected idle, got \(vm.phase)") }
    }

    func test_gitVM_cloneFailure_showsTheBoxReason() async {
        let client = makeClient()
        client.buildGitError = ScreensClientError.http(
            status: 422, message: #"{"error":"Couldn't clone this repo. Check the address, and that the repo is public."}"#)
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/missing"
        await vm.checkRepo()
        XCTAssertEqual(vm.errorMessage, "Couldn't clone this repo. Check the address, and that the repo is public.")
    }

    func test_gitVM_adaptThatDeployed_showsItInstalled() async {
        let client = makeClient()
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "done", fileCount: 8, deployed: true, deployedUrl: "https://hello.home.me.flagship.services")
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/hello"
        await vm.checkRepo()
        await vm.adapt()
        XCTAssertEqual(vm.phase, .installed(url: "https://hello.home.me.flagship.services"))
    }

    func test_gitVM_failedAdapt_restoresTheVerdictWithTheReason() async {
        let client = makeClient()
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "failed", reason: "adapt model call failed: bad key")
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/hello"
        await vm.checkRepo()
        await vm.adapt()
        XCTAssertEqual(vm.errorMessage, "adapt model call failed: bad key")
        guard case .verdict = vm.phase else { return XCTFail("expected verdict, got \(vm.phase)") }
    }

    func test_gitVM_exportAdapter_savesTheFileToShare() async throws {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        await vm.exportAdapter()
        let url = try XCTUnwrap(vm.adapterFileURL)
        XCTAssertEqual(url.lastPathComponent, "flagship.app.json")
        XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains("\"adapter\""))
    }

    func test_gitVM_shareTravelsWithTheAdapt_notTheCheck() async throws {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        XCTAssertTrue(vm.share)
        await vm.adapt()
        XCTAssertEqual(client.buildAdaptStartCalls.last?.req.share, true)

        await vm.checkRepo()
        vm.share = false
        await vm.adapt()
        XCTAssertEqual(client.buildAdaptStartCalls.last?.req.share, false)

        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(XCTUnwrap(client.buildGitCalls.last))) as? [String: Any]
        XCTAssertNil(body?["share"])
    }

    func test_gitVM_shareChoice_survivesAFailedAdapt_andResetsOnANewCheck() async {
        let client = makeClient()
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "failed", reason: "adapt model call failed: bad key")
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        vm.share = false
        await vm.adapt()
        guard case .verdict = vm.phase else { return XCTFail("expected verdict, got \(vm.phase)") }
        XCTAssertFalse(vm.share)
        await vm.adapt()
        XCTAssertEqual(client.buildAdaptStartCalls.last?.req.share, false)
        await vm.checkRepo()
        XCTAssertTrue(vm.share)
    }

    func test_gitVM_checkRepo_isHiddenWhileAVerdictShows() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/flagship-ready"
        XCTAssertFalse(vm.showsVerdict)
        await vm.checkRepo()
        XCTAssertTrue(vm.showsVerdict)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        XCTAssertTrue(vm.showsVerdict)
        client.buildGitError = ScreensClientError.http(status: 422, message: #"{"error":"git clone failed"}"#)
        await vm.checkRepo()
        XCTAssertFalse(vm.showsVerdict)
    }

    func test_gitVM_aSharedAdaptationThatCrashes_offersTheOwnersAI() async {
        let client = makeClient()
        client.buildDeployError = ScreensClientError.http(
            status: 502, message: #"{"error":"docker build failed: exit 1. The shared adaptation of this repo didn't work on this server, so it has been reported. Use AI to prepare the repo for Flagship instead.","needsAdapt":true}"#)
        let vm = BuildGitViewModel(client: client)
        vm.gitUrl = "https://github.com/me/flagship-ready"
        await vm.checkRepo()
        await vm.deploy()
        guard case .verdict(let v) = vm.phase else { return XCTFail("expected the not-ready card, got \(vm.phase)") }
        XCTAssertFalse(v.fit)
        XCTAssertTrue(BuildGitScreen.notReadyText(v).contains("didn't work on this server"))
        XCTAssertNil(vm.errorMessage)
    }

    func test_gitVM_adaptTheBoxAlreadyStarted_isFollowed() async {
        let client = makeClient()
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        client.buildAdaptStartError = ScreensClientError.http(status: 409, message: #"{"error":"the AI is already adapting this repo"}"#)
        await vm.adapt()
        guard case .adapted(let n) = vm.phase else { return XCTFail("expected adapted, got \(vm.phase)") }
        XCTAssertEqual(n, 16)
    }

    func test_notReadyCard_saysItPlainly() {
        let missing = BuildGitResponse(buildId: "b", fit: false, reason: "no flagship.app.json — repo isn't a Flagship app yet; the AI can adapt it", fileCount: 3)
        XCTAssertEqual(BuildGitScreen.notReadyText(missing), "This repo is not yet adapted for Flagship.")
        let broken = BuildGitResponse(buildId: "b", fit: false, reason: "flagship.app.json present but invalid: name", fileCount: 3)
        XCTAssertEqual(BuildGitScreen.notReadyText(broken), broken.reason)
    }

    func test_notReadyCard_copy() {
        XCTAssertEqual(BuildGitScreen.adaptButton, "Use AI to adapt and deploy")
        XCTAssertEqual(BuildGitScreen.shareToggle, "Anonymously share your adaptation")
        XCTAssertEqual(BuildGitScreen.shareNote, "Others can then install this repo without AI. Nothing about you or your server is included.")
        XCTAssertEqual(BuildGitScreen.checkAgain, "Check again")
    }

    func test_journalVM_openBuilds_areSeparateAndDiscardable() async {
        let client = makeClient()
        client.buildSessionsFixture = BuildSessionsResponse(builds: [
            BuildSummary(buildId: "g1", mode: "git", name: "notes", startedAt: 1, lastAt: 2, entryCount: 3, lastKind: "fitness-check", open: true),
            BuildSummary(buildId: "g0", mode: "git", name: "old", startedAt: 1, lastAt: 2, entryCount: 5, lastKind: "deployed"),
        ])
        let vm = BuildJournalViewModel(client: client)
        await vm.loadList()
        guard case .loaded(let builds) = vm.list else { return XCTFail("not loaded") }
        XCTAssertEqual(vm.openBuilds(builds).map(\.buildId), ["g1"])
        XCTAssertEqual(vm.endedBuilds(builds).map(\.buildId), ["g0"])
        await vm.discard(build: builds[0])
        XCTAssertEqual(client.buildDiscardCalls, ["g1"])
        XCTAssertNil(vm.discardError)
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

    // MARK: - Build sessions across the account's servers

    private func serverClient(_ builds: [BuildSummary], sessions: [VibeCodeSessionMeta]) -> MockScreensClient {
        let c = makeClient()
        c.buildSessionsFixture = BuildSessionsResponse(builds: builds)
        c.vibeCodeSessionsFixture = sessions
        return c
    }

    func test_journalVM_listsEveryServersBuilds_eachNamingItsServer() async {
        let home = serverClient([BuildSummary(buildId: "g1", mode: "git", name: "notes", startedAt: 1, lastAt: 2,
                                              entryCount: 1, lastKind: "fitness-check", open: true)],
                                sessions: [VibeCodeSessionMeta(sessionId: "s-home", startedAt: 5, status: "failed")])
        let office = serverClient([BuildSummary(buildId: "g2", mode: "git", name: "wiki", startedAt: 3, lastAt: 4,
                                                entryCount: 1, lastKind: "fitness-check", open: true)],
                                  sessions: [VibeCodeSessionMeta(sessionId: "s-office", startedAt: 9, status: "awaiting-tool-response")])
        let vm = BuildJournalViewModel(client: home, servers: [
            .init(fqdn: "Home.x", name: "Home", client: home),
            .init(fqdn: "office.x", name: "Office", client: office),
        ])
        await vm.loadList()
        guard case .loaded(let builds) = vm.list else { return XCTFail("not loaded: \(vm.list)") }
        XCTAssertEqual(Set(builds.map(\.buildId)), ["g1", "g2"])
        XCTAssertEqual(vm.liveSessions.map(\.sessionId), ["s-office", "s-home"], "newest activity first")
        XCTAssertEqual(vm.sessionServer["s-office"], "office.x")
        XCTAssertEqual(vm.serverName(forSession: "s-home"), "Home")
        XCTAssertEqual(vm.serverName(forBuild: "g2"), "Office")
        XCTAssertEqual(BuildJournalScreen.subtitle("Started now", on: vm.serverName(forBuild: "g2")), "Started now · on Office")

        await vm.discard(build: builds.first { $0.buildId == "g2" }!)
        XCTAssertEqual(office.buildDiscardCalls, ["g2"], "the discard goes to the build's own server")
        XCTAssertTrue(home.buildDiscardCalls.isEmpty)
    }

    func test_journalVM_anUnreachableServerIsNamed_notFatal() async {
        let home = serverClient([], sessions: [VibeCodeSessionMeta(sessionId: "s-home", startedAt: 5, status: "failed")])
        let office = makeClient()
        office.shouldFail = true
        let vm = BuildJournalViewModel(client: home, servers: [
            .init(fqdn: "home.x", name: "Home", client: home),
            .init(fqdn: "office.x", name: "Office", client: office),
        ])
        await vm.loadList()
        XCTAssertNil(vm.list.failure)
        XCTAssertEqual(vm.liveSessions.map(\.sessionId), ["s-home"])
        XCTAssertEqual(vm.unreachableServers, ["Office"])
        XCTAssertEqual(BuildJournalScreen.unreachableNote(["Office"]), "Couldn't reach Office, so its builds aren't listed.")
    }

    func test_journalVM_oneServer_namesNoServer() async {
        let home = serverClient([], sessions: [VibeCodeSessionMeta(sessionId: "s-home", startedAt: 5, status: "failed")])
        let vm = BuildJournalViewModel(client: home, servers: [.init(fqdn: "home.x", name: "Home", client: home)])
        await vm.loadList()
        XCTAssertFalse(vm.spansServers)
        XCTAssertNil(vm.serverName(forSession: "s-home"))
    }
}
