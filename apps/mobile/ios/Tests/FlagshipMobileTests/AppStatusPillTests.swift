import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// docs/app-placement.md §6: an app's status pill.
final class AppStatusPillTests: XCTestCase {

    private func summary(status: String, activity: String? = nil, copying: AppCopying? = nil) -> AppSummary {
        AppSummary(serviceId: "u--notes", creator: "u", slug: "notes", urlLabel: "notes", summary: nil,
                   url: "https://notes.x/", status: status, version: nil, installedAt: 1, copying: copying,
                   activity: activity.map(AppActivity.init(kind:)))
    }

    private func combined(_ answers: [AppServerState?]) -> AppStatusPill { AppStatusPill.combined(answers) }

    // MARK: One server

    func test_serverStateFromStatus() {
        XCTAssertEqual(AppServerState(summary(status: "running")), .running)
        XCTAssertEqual(AppServerState(summary(status: "starting")), .starting)
        XCTAssertEqual(AppServerState(summary(status: "stopped")), .stopped)
        XCTAssertEqual(AppServerState(summary(status: "unknown")), .unknown)
        XCTAssertEqual(AppServerState(summary(status: "exploded")), .unknown)
    }

    func test_activityOutranksStatus() {
        XCTAssertEqual(AppServerState(summary(status: "running", activity: "deploying")), .deploying)
        XCTAssertEqual(AppServerState(summary(status: "stopped", activity: "copying")), .copying)
        XCTAssertEqual(AppServerState(summary(status: "running", activity: "editing")), .editing)
        XCTAssertEqual(AppServerState(summary(status: "running", activity: "tidying")), .running,
                       "a kind this build doesn't know is ignored")
    }

    func test_aCopyStillArrivingIsCopyingOnAnOlderBox() {
        XCTAssertEqual(AppServerState(summary(status: "unknown", copying: AppCopying(state: "copying", progress: 0.4))),
                       .copying)
        XCTAssertEqual(AppServerState(summary(status: "running", copying: AppCopying(state: "done"))), .running)
    }

    func test_oneServersPill() {
        XCTAssertEqual(AppServerState.running.pill, AppStatusPill(label: "Running", kind: .online))
        XCTAssertEqual(AppServerState.starting.pill, AppStatusPill(label: "Starting", kind: .busy))
        XCTAssertEqual(AppServerState.stopped.pill, AppStatusPill(label: "Stopped", kind: .idle))
        XCTAssertEqual(AppServerState.deploying.pill, AppStatusPill(label: "Deploying", kind: .busy))
        XCTAssertEqual(AppServerState.copying.pill, AppStatusPill(label: "Copying", kind: .busy))
        XCTAssertEqual(AppServerState.editing.pill, AppStatusPill(label: "Editing", kind: .busy))
        XCTAssertNil(AppServerState.unknown.pill, "no pill when the box can't say")
    }

    func test_pillKindsMapToTheDesignSystem() {
        XCTAssertEqual(AppStatusPill(label: "", kind: .online).fsKind, .online)
        XCTAssertEqual(AppStatusPill(label: "", kind: .busy).fsKind, .provisioning)
        XCTAssertEqual(AppStatusPill(label: "", kind: .idle).fsKind, .idle)
        XCTAssertEqual(AppStatusPill(label: "", kind: .warning).fsKind, .pending)
    }

    // MARK: Every server combined

    func test_rule1_deployingOrCopyingAnywhereIsDeploying() {
        let deploying = AppStatusPill(label: "Deploying", kind: .busy)
        XCTAssertEqual(combined([.running, .deploying]), deploying)
        XCTAssertEqual(combined([.copying, .running, .running]), deploying)
        XCTAssertEqual(combined([.editing, .copying]), deploying, "deploying outranks editing")
        XCTAssertEqual(combined([nil, .deploying]), deploying)
    }

    func test_rule2_editingAnywhereIsEditing() {
        let editing = AppStatusPill(label: "Editing", kind: .busy)
        XCTAssertEqual(combined([.running, .editing]), editing)
        XCTAssertEqual(combined([.stopped, .editing, nil]), editing)
    }

    func test_rule3_onNServersCountsRunningAndStarting() {
        XCTAssertEqual(combined([.running]), AppStatusPill(label: "On 1 server", kind: .online))
        XCTAssertEqual(combined([.starting]), AppStatusPill(label: "On 1 server", kind: .online))
        XCTAssertEqual(combined([.running, .starting]), AppStatusPill(label: "On 2 servers", kind: .online))
        XCTAssertEqual(combined([.running, .running, .running]), AppStatusPill(label: "On 3 servers", kind: .online))
    }

    func test_rule3_mixedServersCountOnlyTheLiveOnes() {
        XCTAssertEqual(combined([.running, .stopped]).label, "On 1 server")
        XCTAssertEqual(combined([.running, nil, .running]).label, "On 2 servers", "a server that didn't answer isn't counted")
        XCTAssertEqual(combined([.running, .unknown]).label, "On 1 server", "unknown is on that server but not running")
    }

    func test_rule3_unknownEverywhereStillSaysOnNServers() {
        XCTAssertEqual(combined([.unknown]), AppStatusPill(label: "On 1 server", kind: .online))
        XCTAssertEqual(combined([.unknown, .unknown]), AppStatusPill(label: "On 2 servers", kind: .online),
                       "older boxes list the app but can't say: never Stopped")
        XCTAssertEqual(combined([.unknown, .stopped]).label, "On 1 server")
        XCTAssertEqual(combined([.unknown, nil]).label, "On 1 server")
    }

    func test_rule4_everyAnsweringServerStoppedIsStopped() {
        let stopped = AppStatusPill(label: "Stopped", kind: .idle)
        XCTAssertEqual(combined([.stopped]), stopped)
        XCTAssertEqual(combined([.stopped, .stopped]), stopped)
        XCTAssertEqual(combined([.stopped, nil]), stopped, "only the servers that answered count")
    }

    func test_rule5_noAnswerIsCantReach() {
        let cantReach = AppStatusPill(label: "Can't reach", kind: .warning)
        XCTAssertEqual(combined([nil]), cantReach)
        XCTAssertEqual(combined([nil, nil]), cantReach)
        XCTAssertEqual(combined([]), cantReach)
    }

    // MARK: Wire

    func test_activityDecodesOptionally() throws {
        let row = #"{"serviceId":"u--notes","creator":"u","slug":"notes","urlLabel":"notes","url":"https://n/","#
        let old = try JSONDecoder().decode(AppSummary.self, from: Data((row + #""status":"unknown","installedAt":1}"#).utf8))
        XCTAssertNil(old.activity)
        XCTAssertEqual(AppServerState(old), .unknown)
        let busy = try JSONDecoder().decode(AppSummary.self, from: Data(
            (row + #""status":"running","installedAt":1,"activity":{"kind":"deploying"}}"#).utf8))
        XCTAssertEqual(busy.activity, AppActivity(kind: "deploying"))
        XCTAssertEqual(AppServerState(busy), .deploying)
        let odd = try JSONDecoder().decode(AppSummary.self, from: Data(
            (row + #""status":"starting","installedAt":1,"activity":{}}"#).utf8))
        XCTAssertEqual(AppServerState(odd), .starting)
    }
}

/// The services list asks every server and combines what they say.
@MainActor
final class ServicesListStatusTests: XCTestCase {

    private let homeFqdn = "home.bright-maple.flagship.services"
    private let officeFqdn = "office.bright-maple.flagship.services"
    private let cabinFqdn = "cabin.bright-maple.flagship.services"

    private var pods: [PodInfo] {
        [PodInfo(podId: "h", name: "Home", fqdn: homeFqdn, status: .online),
         PodInfo(podId: "o", name: "Office", fqdn: officeFqdn, status: .online),
         PodInfo(podId: "c", name: "Cabin", fqdn: cabinFqdn, status: .online)]
    }

    private func app(_ id: String, _ status: String, activity: String? = nil) -> AppSummary {
        AppSummary(serviceId: id, creator: "u", slug: ServicesSlug.slug(of: id), urlLabel: ServicesSlug.slug(of: id),
                   summary: nil, url: "https://\(ServicesSlug.slug(of: id)).x/", status: status, version: nil,
                   installedAt: 1, activity: activity.map(AppActivity.init(kind:)))
    }

    private func box(_ apps: [AppSummary]) -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.appsListFixture = AppsListResponse(apps: apps)
        return c
    }

    private func model(home: MockScreensClient, office: MockScreensClient, cabin: MockScreensClient) -> ServicesListViewModel {
        let factory = PodScreensClientFactory { fqdn in
            fqdn.hasPrefix("home") ? home : fqdn.hasPrefix("office") ? office : cabin
        }
        let vm = ServicesListViewModel(client: home, clients: factory, homeFqdn: { [homeFqdn] in homeFqdn })
        vm.servers = pods
        return vm
    }

    func test_listsEveryAppOnceAndCombinesItsServers() async {
        let home = box([app("u--notes", "running"), app("u--wiki", "stopped")])
        let office = box([app("u--notes", "running"), app("u--blog", "stopped"), app("u--wiki", "stopped")])
        let cabin = box([app("u--notes", "starting"), app("u--blog", "running", activity: "editing")])
        let vm = model(home: home, office: office, cabin: cabin)
        await vm.load()
        XCTAssertEqual(vm.state.value?.map(\.serviceId), ["u--notes", "u--wiki", "u--blog"])
        XCTAssertEqual(vm.pill(for: "u--notes").label, "On 3 servers")
        XCTAssertEqual(vm.pill(for: "u--wiki").label, "Stopped")
        XCTAssertEqual(vm.pill(for: "u--blog").label, "Editing")
        XCTAssertEqual(vm.fqdns(for: "u--blog"), [officeFqdn, cabinFqdn])
    }

    func test_olderBoxesThatSayUnknownCountAsOnTheServer() async {
        let vm = model(home: box([app("u--notes", "unknown")]), office: box([app("u--notes", "unknown")]),
                       cabin: box([]))
        await vm.load()
        XCTAssertEqual(vm.pill(for: "u--notes"), AppStatusPill(label: "On 2 servers", kind: .online))
    }

    func test_aServerThatStopsAnsweringKeepsItsAppsAsCantReach() async {
        let home = box([app("u--notes", "running")])
        let office = box([app("u--notes", "stopped"), app("u--blog", "running")])
        let vm = model(home: home, office: office, cabin: box([]))
        await vm.load()
        XCTAssertEqual(vm.pill(for: "u--blog").label, "On 1 server")

        office.appsListError = URLError(.timedOut)
        await vm.load()
        XCTAssertEqual(vm.state.value?.map(\.serviceId), ["u--notes", "u--blog"])
        XCTAssertEqual(vm.pill(for: "u--blog"), AppStatusPill(label: "Can't reach", kind: .warning))
        XCTAssertEqual(vm.pill(for: "u--notes").label, "On 1 server")
    }

    func test_everyServerFailingWithNothingKnownFails() async {
        let home = box([]), office = box([]), cabin = box([])
        for b in [home, office, cabin] { b.appsListError = URLError(.notConnectedToInternet) }
        let vm = model(home: home, office: office, cabin: cabin)
        await vm.load()
        XCTAssertNotNil(vm.state.failure)
    }

    func test_anAppOpensOnTheShellServerElseOneThatRunsIt() async {
        let home = box([app("u--notes", "running")])
        let office = box([app("u--notes", "running"), app("u--blog", "stopped")])
        let cabin = box([app("u--blog", "running")])
        let vm = model(home: home, office: office, cabin: cabin)
        await vm.load()
        XCTAssertNil(vm.openFqdn(for: "u--notes"))
        XCTAssertEqual(vm.openFqdn(for: "u--blog"), cabinFqdn)
    }

    func test_serverFilterShowsWhatThatServerLists() async {
        let vm = model(home: box([app("u--notes", "running")]),
                       office: box([app("u--blog", "running")]), cabin: box([app("u--notes", "stopped")]))
        await vm.load()
        vm.serverFilter = "c"
        XCTAssertEqual(vm.filteredApps.map(\.serviceId), ["u--notes"])
        vm.serverFilter = "o"
        XCTAssertEqual(vm.filteredApps.map(\.serviceId), ["u--blog"])
        vm.serverFilter = nil
        XCTAssertEqual(vm.filteredApps.map(\.serviceId), ["u--notes", "u--blog"])
    }

    func test_withoutOtherServersOnlyTheShellServerIsAsked() async {
        let vm = ServicesListViewModel(client: box([app("u--notes", "stopped")]))
        await vm.load()
        XCTAssertEqual(vm.state.value?.map(\.serviceId), ["u--notes"])
        XCTAssertEqual(vm.pill(for: "u--notes").label, "Stopped")
    }

    func test_runsOnRowsCarryEachServersState() async {
        let home = box([app("u--notes", "running")])
        let office = box([app("u--notes", "unknown")])
        let cabin = box([app("u--notes", "stopped", activity: "deploying")])
        let factory = PodScreensClientFactory { fqdn in
            fqdn.hasPrefix("home") ? home : fqdn.hasPrefix("office") ? office : cabin
        }
        let key = Curve25519.Signing.PrivateKey()
        let runsOn = AppRunsOnController(serviceId: "u--notes", appName: "Notes", pods: pods, pageFqdn: homeFqdn,
                                         clients: factory, uninstallClient: MockServiceUninstallClient(),
                                         signer: { _ in key }, irkSigner: { _ in key })
        await runsOn.load()
        XCTAssertEqual(runsOn.row(homeFqdn)?.state?.pill?.label, "Running")
        XCTAssertEqual(runsOn.row(officeFqdn)?.state, .unknown)
        XCTAssertNil(runsOn.row(officeFqdn)?.state?.pill)
        XCTAssertEqual(runsOn.row(cabinFqdn)?.state?.pill?.label, "Deploying")
    }

    func test_serverPageRowsCarryTheirState() async {
        let c = box([app("u--notes", "starting"), app("u--wiki", "unknown")])
        let controller = ServerAppsController(serverFqdn: homeFqdn, clients: .shared(c))
        await controller.load()
        XCTAssertEqual(controller.rows.map(\.state), [.starting, .unknown])
        XCTAssertEqual(controller.rows.first?.running, true)
    }
}
