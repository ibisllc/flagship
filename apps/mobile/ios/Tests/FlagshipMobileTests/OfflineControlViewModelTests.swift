import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipCore
@testable import FlagshipAPI

/// Offline control's view model against the in-process box (GymRescue): the real hello checks under
/// the pinned key, the signed session and offline orders, and the resumable backup download.
@MainActor
final class OfflineControlViewModelTests: XCTestCase {
    private let user = "bright-maple"
    private var domain: String { "home.\(user).flagship.services" }

    private func env(_ scenario: String, signer seed: Data = GymRescue.ownerSeed, pinned: Bool = true, found: Bool = true,
                     lan: [String] = [], book: RescueServerBook = .volatile()) -> (OfflineControlEnvironment, MockRescueBox) {
        let stk = try! Curve25519.Signing.PrivateKey(rawRepresentation: GymRescue.stkSeed)
        let owner = try! Curve25519.Signing.PrivateKey(rawRepresentation: GymRescue.ownerSeed)
        let signer = try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let box = MockRescueBox(serverDomain: domain, scenario: scenario, ownerPub: owner.publicKey)
        let d = domain
        let stkHex = HexUtil.encode(stk.publicKey.rawRepresentation)
        let id = Rescue.discoveryId(stkPub: stk.publicKey.rawRepresentation, serverDomain: d)!
        let e = OfflineControlEnvironment(
            servers: { [(d, pinned ? stkHex : nil, lan)] },
            pinnedMldsa: { _ in nil }, strict: { _ in false },
            orderKey: { _ in (signer, .adminRoot) }, pqSignature: { _, _, _ in nil },
            accountKek: { _ in Data(repeating: 0x33, count: 32) },
            passcodeSlot: { _, _, _ in ServerBackupSlot(kind: "passcode", kdf: ServerBackupKdf(m: 64, t: 1, p: 1, saltHex: String(repeating: "01", count: 16)),
                                                        nonceHex: String(repeating: "02", count: 12), wrappedHex: String(repeating: "03", count: 48)) },
            connector: MockRescueConnector(box: box),
            discovery: { MockRescueDiscovery(found: found ? [id: RescueEndpoint(host: "192.168.1.20")] : [:]) },
            book: book)
        return (e, box)
    }

    private func vm(_ e: OfflineControlEnvironment) -> OfflineControlViewModel {
        OfflineControlViewModel(username: user, env: e, pollNs: 1_000_000,
                                directory: FileManager.default.temporaryDirectory.appendingPathComponent("rescue-\(UUID().uuidString)"))
    }

    private func waitFound(_ m: OfflineControlViewModel) async {
        for _ in 0..<40 where m.servers.first?.found == nil { try? await Task.sleep(nanoseconds: 50_000_000) }
    }

    func testFindsTheBoxByItsOpaqueIdAndOpensASession() async throws {
        let book = RescueServerBook.volatile()
        let m = vm(env("found", book: book).0)
        m.start()
        await waitFound(m)
        XCTAssertEqual(m.servers.first?.found, RescueEndpoint(host: "192.168.1.20"))
        await m.connect(domain)
        XCTAssertEqual(m.phase, .connected)
        XCTAssertEqual(m.snapshot?.apps.count, 2)
        XCTAssertNil(m.certificateNote)
        XCTAssertEqual(book.entry(domain)?.lan.first, "192.168.1.20:443", "where it answered is remembered")
    }

    func testAnotherKeyIsNotYourServer() async {
        let m = vm(env("wrong-key").0)
        m.start()
        await waitFound(m)
        await m.connect(domain)
        guard case .failed(let msg) = m.phase else { return XCTFail("refused") }
        XCTAssertTrue(msg.contains("This isn't your server"), msg)
    }

    func testTheBoxRefusesAStrangersSessionInItsOwnWords() async {
        let m = vm(env("stranger", signer: GymRescue.strangerSeed).0)
        m.start()
        await waitFound(m)
        await m.connect(domain)
        guard case .failed(let msg) = m.phase else { return XCTFail("refused") }
        XCTAssertTrue(msg.hasPrefix("The rescue session was refused: not signed by this server's owner key"), msg)
    }

    func testAnExpiredCertificateStillWorksByKey() async {
        let m = vm(env("expired-cert").0)
        m.start()
        await waitFound(m)
        await m.connect(domain)
        XCTAssertEqual(m.phase, .connected)
        XCTAssertNotNil(m.certificateNote)
    }

    func testNotFoundAndNothingSeenBeforeSaysSo() async {
        let m = vm(env("not-found", found: false).0)
        m.start()
        await m.connect(domain)
        guard case .failed(let msg) = m.phase else { return XCTFail("failed") }
        XCTAssertTrue(msg.contains("wasn't found on this Wi-Fi"), msg)
        m.manualName = domain
        m.manualAddress = "192.168.1.20"
        XCTAssertTrue(m.canConnectManually)
        await m.connectManually()
        XCTAssertEqual(m.phase, .connected, "the typed address works")
    }

    func testAServerWithNoPinnedKeyIsNotTried() async {
        let m = vm(env("found", pinned: false).0)
        m.start()
        await m.connect(domain)
        guard case .failed(let msg) = m.phase else { return XCTFail("failed") }
        XCTAssertTrue(msg.contains("never confirmed"), msg)
    }

    func testEachControlIsASignedOrderTheBoxChecks() async {
        let (e, box) = env("found")
        let m = vm(e)
        m.start()
        await waitFound(m)
        await m.connect(domain)
        let notes = "\(user)--notes"
        await m.perform(.appStop, serviceId: notes)
        XCTAssertNil(m.actionError)
        XCTAssertEqual(m.snapshot?.apps.first { $0.serviceId == notes }?.state, "stopped")
        await m.perform(.appStart, serviceId: notes)
        XCTAssertEqual(m.snapshot?.apps.first { $0.serviceId == notes }?.state, "running")
        await m.perform(.appRestart, serviceId: notes)
        XCTAssertEqual(m.notice, "Notes was restarted.")
        XCTAssertEqual(box.apps.first { $0.id == notes }?.state, "running")
        await m.perform(.serverShutdown)
        XCTAssertEqual(m.phase, .list, "the session ends with the server")
        XCTAssertEqual(m.notice, "The server is shutting down.")
    }

    func testAnInterruptedDownloadResumesAndFinishes() async throws {
        let m = vm(env("interrupt").0)
        m.start()
        await waitFound(m)
        await m.connect(domain)
        m.askPasscode()
        XCTAssertFalse(m.canStartBackup, "the passcode must be saved first")
        m.passcodeSaved = true
        await m.startBackup()
        guard case .interrupted = m.backup else { return XCTFail("interrupted, got \(m.backup)") }
        await m.download()
        guard case .saved(let url) = m.backup else { return XCTFail("saved, got \(m.backup)") }
        XCTAssertEqual(try Data(contentsOf: url).count, 10 * 1024 * 1024)
    }

    func testAddressParsing() {
        XCTAssertEqual(OfflineControlViewModel.endpoint("192.168.1.20"), RescueEndpoint(host: "192.168.1.20", port: 443))
        XCTAssertEqual(OfflineControlViewModel.endpoint("10.0.0.5:8443"), RescueEndpoint(host: "10.0.0.5", port: 8443))
        XCTAssertEqual(OfflineControlViewModel.endpoint("[fd00::5]:443"), RescueEndpoint(host: "fd00::5", port: 443))
        XCTAssertNil(OfflineControlViewModel.endpoint("  "))
    }
}
