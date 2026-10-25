import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// AI02 on iOS: the Local AI screen's actions (each order signed with the sensitive-order key over
/// the shared canonical bytes), the box's own sentences, and the "On this server" menu group.
@MainActor
final class LocalAiViewModelTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()
    private var domain = ""

    private func make() async -> (LocalAiViewModel, MockScreensClient) {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        domain = await mock.boxDomain()!
        let k = key
        let vm = LocalAiViewModel(serverDomain: domain, client: mock, signer: { _ in k }, now: { 1_761_300_000_000 },
                                  newJobId: { "0123456789abcdef" })
        await vm.load()
        return (vm, mock)
    }

    override func setUp() {
        super.setUp()
        DefaultModelStore.defaults = UserDefaults(suiteName: "local-ai-\(UUID().uuidString)")!
    }

    func test_loadShowsWhatIsDownloadedAndThePrivacyLine() async {
        let (vm, _) = await make()
        XCTAssertEqual(vm.view?.privacy, "this-server")
        XCTAssertEqual(vm.view?.cost, "none")
        XCTAssertEqual(vm.installedModels.map(\.id), ["qwen2.5-0.5b-q4"])
        XCTAssertEqual(LocalAiCopy.privacy, "Runs only on this server. Nothing is sent anywhere.")
        XCTAssertEqual(LocalAiCopy.queue(2), "Number 2 in line")
        XCTAssertEqual(LocalAiCopy.queue(1), "Next in line")
    }

    func test_downloadThenARefusalInTheBoxsWords() async {
        let (vm, _) = await make()
        let m = vm.view!.models.first { $0.id == "stories-15m" }!
        await vm.download(m)
        XCTAssertNil(vm.error)
        XCTAssertEqual(vm.notice, "TinyStories 15M is downloading.")
        let installed = vm.view!.models.first { $0.id == "qwen2.5-0.5b-q4" }!
        await vm.download(installed)
        XCTAssertEqual(vm.error, "That model is already on this server.")
    }

    func test_trainingSignsTheSharedCanonicalBytes() async throws {
        let (vm, mock) = await make()
        try await mock.localAiModel(.download, modelId: "stories-260k")
        await vm.load(); await vm.load(); await vm.load()
        vm.prepareTrain()
        XCTAssertEqual(vm.trainApp, "bright-maple--wiki", "only an app with sample data")
        XCTAssertEqual(vm.trainModel, "stories-260k")
        vm.trainEpochs = 2
        let ok = await vm.startTraining()
        XCTAssertTrue(ok, vm.error ?? "")
        let body = try XCTUnwrap(mock.localAiMock.trainBodies.last)
        let order = body["order"] as! [String: Any]
        XCTAssertEqual(Set(order.keys), ["serverDomain", "serviceId", "jobId", "baseModel", "epochs", "issuedAt"])
        let canonical = try LocalAiTrainOrder(serverDomain: domain, serviceId: "bright-maple--wiki", jobId: "0123456789abcdef",
                                              baseModel: "stories-260k", epochs: 2, issuedAt: 1_761_300_000_000).canonicalBytes()
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self),
                       "flagship/local-ai-train/v1|\(domain.lowercased())|bright-maple--wiki|0123456789abcdef|stories-260k|2|1761300000000")
        let sig = HexUtil.decode(body["signature"] as! String) ?? Data()
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: canonical))
    }

    func test_allowThenWithdrawAnApp() async throws {
        let (vm, mock) = await make()
        let app = vm.view!.apps.first!
        await vm.setAppAccess(app, allowed: true)
        XCTAssertNil(vm.error)
        XCTAssertEqual(vm.view?.apps.first?.grant?.requestsPerDay, 500)
        let grant = try XCTUnwrap(mock.localAiMock.grantBodies.last?["order"] as? [String: Any])
        XCTAssertEqual((grant["maxTokensPerRequest"] as? NSNumber)?.intValue, 1024)
        // The fixed clock gives the withdrawal the same issuedAt: the box (and its mock) refuse a not-newer order.
        await vm.setAppAccess(vm.view!.apps.first!, allowed: false)
        XCTAssertEqual(vm.error, "A newer choice is already in place.")
    }

    func test_cancelledFaceIdChangesNothing() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = LocalAiViewModel(serverDomain: await mock.boxDomain()!, client: mock,
                                  signer: { _ in throw BiometricGate.GateError.userCancelled })
        await vm.load()
        await vm.setAppAccess(vm.view!.apps.first!, allowed: true)
        XCTAssertEqual(vm.error, LocalAiCopy.notChanged)
        XCTAssertTrue(mock.localAiMock.grantBodies.isEmpty)
    }

    // MARK: On this server in the model menu

    func test_onThisServerGroupSendsTheLocalCredentialAndIsNeverFlagship() {
        let specs = ModelGroups.specs(entries: [], includeFlagship: true, includeLocal: true)
        XCTAssertEqual(specs.map(\.id), [ModelGroups.flagshipId, "flagship-local"])
        XCTAssertFalse(specs[1].isFlagship)
        XCTAssertEqual(specs[1].title, "On this server")
        XCTAssertEqual(ModelGroups.groupId(forProvider: "flagship-local", in: specs), "flagship-local")
        XCTAssertEqual(ModelGroups.groupId(forCredential: LocalAi.credential, in: specs), "flagship-local")
        XCTAssertEqual(ModelGroups.credential(for: specs[1], picked: true, needsCredential: false), .send(LocalAi.credential))
        XCTAssertEqual(ModelGroups.credential(for: specs[1], picked: false, needsCredential: false), .keep)
        XCTAssertEqual(LocalAi.credential.provider, "flagship-local")
    }

    func test_menuListsOnlyWhatTheBoxDownloaded() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let menu = GroupedModelMenu()
        menu.configure(entries: [], provider: "flagship-local", freeAiSession: false, fallbackCredential: nil,
                       initial: ModelChoice(model: nil, effort: nil), flagshipCatalog: nil,
                       ownModels: { cred in (try? await mock.aiModels(AiModelsRequest(credential: cred))) ?? AiModelsResponse(provider: cred.provider, kind: "own") },
                       flagshipUsable: nil)
        XCTAssertEqual(menu.boxGroupId, "flagship-local")
        await menu.loadAll()
        XCTAssertEqual(menu.group("flagship-local")?.menu.ownOptions.map(\.id), ["qwen2.5-0.5b-q4"])
    }
}
