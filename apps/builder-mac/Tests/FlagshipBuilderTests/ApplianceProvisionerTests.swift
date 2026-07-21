import CryptoKit
import XCTest
@testable import FlagshipBuilderCore

final class ApplianceProvisionerTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("appliance-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    func testVerifiesClonesExpandsAndWritesSeed() throws {
        let base = root.appendingPathComponent("base.raw")
        let baseData = Data("generalized-disk".utf8)
        try baseData.write(to: base)
        let manifest = ApplianceBaseManifest(
            arch: .arm64,
            installerGitRef: "main",
            sha256: SHA256.hash(data: baseData).map { String(format: "%02x", $0) }.joined(),
            sizeBytes: UInt64(baseData.count),
            virtualSizeBytes: UInt64(baseData.count))
        try JSONEncoder().encode(manifest).write(
            to: URL(fileURLWithPath: base.path + ".json"))

        let provisioner = try ApplianceProvisioner.load(
            baseURL: base, expectedArch: .arm64, installerGitRef: "main")
        let layout = VMBundleLayout(root: root.appendingPathComponent("vms"))
        let name = "home.test.flagship.services"
        try FileManager.default.createDirectory(
            at: layout.bundleDir(name), withIntermediateDirectories: true)
        let config = VMConfig(
            name: name, serverDomain: name, username: "test", serverName: "home",
            cpuCount: 2, memoryBytes: 2 * VMResourcePlan.gib, mainDiskSizeBytes: 4096,
            networkMode: .nat, serialConsoleEnabled: false, bootUnlockMode: "auto",
            diskEncrypted: true, provisioningMode: .prebuiltAppliance)
        let recipe = Data("{\"recipe\":true}".utf8)
        try provisioner.provision(
            config: config, layout: layout, recipe: recipe, bootstrap: "#!/bin/bash\ntrue\n")

        XCTAssertEqual(try Data(contentsOf: layout.diskImageURL(name)).prefix(baseData.count), baseData)
        XCTAssertEqual((try FileManager.default.attributesOfItem(
            atPath: layout.diskImageURL(name).path)[.size] as! NSNumber).uint64Value, 4096)
        let seed = try Data(contentsOf: layout.applianceSeedURL(name))
        XCTAssertEqual(seed.count, ApplianceSeed.sizeBytes)
        XCTAssertEqual(String(data: seed.prefix(8), encoding: .ascii), ApplianceSeed.magic)
    }

    func testRejectsWrongRefBeforeCloning() throws {
        let base = root.appendingPathComponent("base.raw")
        let data = Data([1, 2, 3])
        try data.write(to: base)
        let manifest = ApplianceBaseManifest(
            arch: .arm64, installerGitRef: "old",
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            sizeBytes: 3, virtualSizeBytes: 3)
        try JSONEncoder().encode(manifest).write(to: URL(fileURLWithPath: base.path + ".json"))
        XCTAssertThrowsError(try ApplianceProvisioner.load(
            baseURL: base, expectedArch: .arm64, installerGitRef: "main")) { error in
            XCTAssertEqual(error as? ApplianceProvisionError,
                           .gitRefMismatch(expected: "main", got: "old"))
        }
    }
}
