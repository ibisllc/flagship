import XCTest
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// Restore a backup into a running server against the mock box (docs/restore-into-server.md §7).
@MainActor
final class RestoreMergeViewModelTests: XCTestCase {
    private let fqdn = "home.demo.flagship.services"
    private let admin = Curve25519.Signing.PrivateKey()

    private struct Missing: Error {}

    private func need<T>(_ v: T?) throws -> T {
        guard let v else { throw Missing() }
        return v
    }

    private func run(_ body: () async throws -> Void) async {
        do { try await body() } catch { XCTFail("\(error)") }
    }

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-backup/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try need(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing()
    }

    private struct World {
        let c: MockScreensClient
        let m: RestoreMergeViewModel
        let saved: SavedBackup
    }

    private func world(admin isAdmin: Bool = true) throws -> World {
        let v = try vectors()
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let archiveId = v["archiveId"] as! String
        let saved = c.makeSavedBackup(createdAt: 1_793_700_000_000, id: archiveId)
        c.savedBackupsList = [saved]
        c.restoreMergeSavedFiles[archiveId] = Data(try need(v["file"] as? String).utf8)
        let kek = try need(HexUtil.decode(v["accountKekHex"] as! String))
        let key = admin
        let m = RestoreMergeViewModel(serverFqdn: fqdn, isAdminDevice: isAdmin, clients: .shared(c),
                                      signer: { _ in key }, accountKek: { _ in kek }, now: { 1_794_000_000_000 }, pollNs: 1_000_000)
        return World(c: c, m: m, saved: saved)
    }

    func testOpensASavedBackupUnderASignedStageAndPreselectsTheSafeDefaults() async {
        await run {
        let w = try world(); let c = w.c, m = w.m, saved = w.saved
        await m.start(.saved(saved))
        XCTAssertEqual(m.phase, .choosing)
        let stage = try need(c.restoreMergeStages.first)
        XCTAssertEqual(stage.order.source, "saved")
        XCTAssertEqual(stage.order.serverDomain, fqdn)
        let bytes = try ServerRestoreMerge.stageBytes(.init(serverDomain: stage.order.serverDomain, archiveId: stage.order.archiveId, bytes: stage.order.bytes,
                                                            sha256: stage.order.sha256, source: stage.order.source, issuedAt: stage.order.issuedAt))
        XCTAssertTrue(admin.publicKey.isValidSignature(try need(HexUtil.decode(stage.signatureHex)), for: bytes))
        XCTAssertEqual(c.restoreMergeCommits.count, 1)
        XCTAssertEqual(m.choices["demo--notes"]?.action, "keep")
        XCTAssertEqual(m.choices["demo--todo"]?.action, "install")
        XCTAssertEqual(m.choices["demo--chess"]?.action, "skip")
        XCTAssertEqual(m.choices["sam--blog"]?.action, "copy")
        XCTAssertEqual(m.apps(in: .different).map(\.name), ["blog"])
        }
    }

    func testTheSignedPlanIsExactlyTheChoicesWithTheGuards() async {
        await run {
        let w = try world(); let c = w.c, m = w.m, saved = w.saved
        await m.start(.saved(saved))
        let notes = try need(m.preview?.apps.first { $0.archivedServiceId == "demo--notes" })
        m.choose(notes, action: "replace")
        m.choose(notes, action: "install")
        XCTAssertEqual(m.choices["demo--notes"]?.action, "replace", "an action the box refused is never chosen")
        await m.restore()
        XCTAssertEqual(m.phase, .done)
        let plan = try need(c.restoreMergePlans.first)
        let lines = try need(plan.lines)
        let replace = try need(lines.first { $0.archivedServiceId == "demo--notes" })
        XCTAssertEqual(replace.guardCode, notes.guards?.guardCode)
        XCTAssertEqual(replace.guardGen, 0)
        XCTAssertEqual(lines.first { $0.archivedServiceId == "sam--blog" }?.targetServiceId, "demo--blog-restored")
        let sha = try ServerRestoreMerge.planSha256(lines.map { .init(archivedServiceId: $0.archivedServiceId, action: $0.action, targetServiceId: $0.targetServiceId, sameApp: $0.sameApp, guardCode: $0.guardCode, guardSchema: $0.guardSchema, guardGen: $0.guardGen) })
        XCTAssertEqual(plan.order.planSha256, sha)
        let bytes = try ServerRestoreMerge.mergeBytes(.init(serverDomain: plan.order.serverDomain, restoreId: plan.order.restoreId, archiveId: plan.order.archiveId, sha256: plan.order.sha256, planSha256: plan.order.planSha256, issuedAt: plan.order.issuedAt, expiresAt: plan.order.expiresAt))
        XCTAssertTrue(admin.publicKey.isValidSignature(try need(HexUtil.decode(plan.signatureHex)), for: bytes))
        XCTAssertEqual(m.undoPoints.map(\.serviceId), ["demo--notes"])
        }
    }

    func testRestoreStaysOffWithOnlyKeepAndSkipOrABadCopyName() async {
        await run {
        let w = try world(); let m = w.m, saved = w.saved
        await m.start(.saved(saved))
        for a in m.preview?.apps ?? [] { m.choose(a, action: a.allowed.contains("keep") ? "keep" : "skip") }
        XCTAssertFalse(m.canRestore)
        let blog = try need(m.preview?.apps.first { $0.name == "blog" })
        m.choose(blog, action: "copy")
        m.setCopyName(blog, "Bad Name")
        XCTAssertFalse(m.canRestore)
        m.setCopyName(blog, "blog-2")
        XCTAssertTrue(m.canRestore)
        }
    }

    func testTheBoxRefusalIsShownAndUndoIsSigned() async {
        await run {
        let w = try world(); let c = w.c, m = w.m, saved = w.saved
        await m.start(.saved(saved))
        c.restoreMergeNextRefusal = ("plan-guard-mismatch", "An app changed since you chose. Look at the choices again.")
        await m.restore()
        XCTAssertEqual(m.actionError, "An app changed since you chose. Look at the choices again.")
        let notes = try need(m.preview?.apps.first { $0.archivedServiceId == "demo--notes" })
        m.choose(notes, action: "replace")
        await m.restore()
        let p = try need(m.undoPoints.first)
        await m.undo(p, discard: false)
        let u = try need(c.restoreMergeUndos.first)
        XCTAssertEqual(u.order.action, "undo")
        XCTAssertTrue(admin.publicKey.isValidSignature(try need(HexUtil.decode(u.signatureHex)),
                                                       for: try ServerRestoreMerge.undoBytes(.init(serverDomain: u.order.serverDomain, restoreId: u.order.restoreId, serviceId: u.order.serviceId, action: u.order.action, issuedAt: u.order.issuedAt))))
        XCTAssertTrue(m.undoPoints.isEmpty)
        }
    }

    func testTheWordsForEachAction() {
        let a = MockScreensClient.restoreMergeDemoApps()[0]
        XCTAssertFalse(RestoreMergeViewModel.consequence("replace", a).isEmpty)
        XCTAssertEqual(RestoreMergeViewModel.refusal("busy"), String(localized: "It is being changed right now. Try again when that is done."))
    }

    func testANonAdminDeviceCannotStart() async {
        await run {
        let w = try world(admin: false); let c = w.c, m = w.m, saved = w.saved
        await m.start(.saved(saved))
        XCTAssertEqual(m.phase, .failed(RestoreMergeViewModel.adminOnly))
        XCTAssertTrue(c.restoreMergeStages.isEmpty)
        }
    }
}
