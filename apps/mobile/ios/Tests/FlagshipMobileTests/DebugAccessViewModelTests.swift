import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// The server page's "Debug access" (docs/recipe-delivery-and-remote-install.md).
@MainActor
final class DebugAccessViewModelTests: XCTestCase {
    private let domain = "home.bright-maple.flagship.services"
    private let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3"
    private let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x5a, count: 32))
    private var clock: Int64 = 1_760_000_000_000
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "debug-access-\(UUID().uuidString)")
    }

    private func mock() -> MockScreensClient {
        let m = MockScreensClient()
        m.simulatedLatency = 0
        return m
    }

    private func vm(_ client: MockScreensClient, canManage: Bool = true, cancel: Bool = false) -> DebugAccessViewModel {
        DebugAccessViewModel(
            serverDomain: domain,
            view: nil,
            client: client,
            canManage: canManage,
            signer: { [admin] _ in
                if cancel { throw CancellationError() }
                return admin
            },
            now: { [unowned self] in self.clock },
            defaults: defaults
        )
    }

    func test_turnOnSignsAVerifiableGrantAndShowsTheBanner() async throws {
        let client = mock()
        let m = vm(client)
        m.keyText = "\(key) harry@laptop"
        m.duration = .oneHour
        await m.turnOn()
        XCTAssertNil(m.error)
        XCTAssertTrue(m.isOn)
        XCTAssertEqual(m.view.expiresAt, clock + DebugAccess.hourMs)
        XCTAssertEqual(m.view.keyFingerprint, DebugAccess.fingerprint(key))
        XCTAssertEqual(m.bannerText, DebugAccessViewModel.banner(expiresAt: clock + DebugAccess.hourMs))
        XCTAssertTrue(m.bannerText!.hasPrefix("Debug access is on until "))

        let body = try XCTUnwrap(client.debugAccessBodies.last)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        let g = try XCTUnwrap(obj["grant"] as? [String: Any])
        let grant = DebugAccess.Grant(
            serverDomain: g["serverDomain"] as! String,
            sshPublicKey: g["sshPublicKey"] as! String,
            issuedAt: (g["issuedAt"] as! NSNumber).int64Value,
            expiresAt: (g["expiresAt"] as! NSNumber).int64Value
        )
        XCTAssertEqual(grant.sshPublicKey, key)
        XCTAssertTrue(DebugAccess.verify(grant, signatureHex: obj["signatureHex"] as! String, pub: admin.publicKey.rawRepresentation))
        // The key is remembered for Renew on this device.
        XCTAssertEqual(vm(client).keyText, key)
    }

    func test_renewThenTurnOff() async throws {
        let client = mock()
        let m = vm(client)
        m.keyText = key
        await m.turnOn()
        clock += 60_000
        m.duration = .sevenDays
        await m.turnOn()
        XCTAssertEqual(m.view.expiresAt, clock + DebugAccess.maxMs)
        await m.turnOff()
        XCTAssertNil(m.error)
        XCTAssertFalse(m.isOn)
        XCTAssertNil(m.bannerText)
        XCTAssertEqual(m.notice, "Debug access is off.")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(client.debugAccessBodies.last!.utf8)) as? [String: Any])
        let r = try XCTUnwrap(obj["revoke"] as? [String: Any])
        let revoke = DebugAccess.Revoke(serverDomain: r["serverDomain"] as! String, issuedAt: (r["issuedAt"] as! NSNumber).int64Value)
        XCTAssertTrue(DebugAccess.verify(revoke, signatureHex: obj["signatureHex"] as! String, pub: admin.publicKey.rawRepresentation))
    }

    func test_refusesWithoutAKeyBeforeSigning() async {
        let client = mock()
        let m = vm(client)
        await m.turnOn()
        XCTAssertEqual(m.error, "Debug access needs an SSH public key.")
        m.keyText = "not a key"
        await m.turnOn()
        XCTAssertEqual(m.error, "That isn't an SSH public key this server can use.")
        XCTAssertTrue(client.debugAccessBodies.isEmpty)
    }

    func test_showsTheBoxSentence() async {
        let client = mock()
        client.simulatedFailureStatus = nil
        let m = DebugAccessViewModel(
            serverDomain: "other.bright-maple.flagship.services", view: nil, client: client, canManage: true,
            signer: { [admin] _ in admin }, now: { [unowned self] in self.clock }, defaults: defaults
        )
        m.keyText = key
        await m.turnOn()
        XCTAssertEqual(m.error, "That debug access grant is for another server.")
    }

    func test_nonAdminDeviceCantChangeIt() async {
        let client = mock()
        let m = vm(client, canManage: false)
        m.keyText = key
        await m.turnOn()
        await m.turnOff()
        XCTAssertTrue(client.debugAccessBodies.isEmpty)
        XCTAssertEqual(DebugAccessViewModel.adminOnly, "Only an admin device can turn debug access on or off.")
    }

    func test_anEndedGrantIsOff() {
        let m = DebugAccessViewModel(
            serverDomain: domain,
            view: DebugAccessView(on: true, expiresAt: clock - 1, keyFingerprint: "SHA256:x", grantedBy: "admin"),
            client: mock(), canManage: true, signer: { [admin] _ in admin }, now: { [unowned self] in self.clock },
            defaults: defaults
        )
        XCTAssertFalse(m.isOn)
        XCTAssertNil(m.bannerText)
    }

    func test_activityLabels() {
        let title = { (kind: String) in BoxEventLabels.title(BoxActivityEntry(ts: 1, action: kind, kind: kind, ok: true)) }
        XCTAssertEqual(title("server.debug-access.granted"), "Debug access turned on")
        XCTAssertEqual(title("server.debug-access.renewed"), "Debug access renewed")
        XCTAssertEqual(title("server.debug-access.expired"), "Debug access ended")
        XCTAssertEqual(title("server.debug-access.revoked"), "Debug access turned off")
    }
}
