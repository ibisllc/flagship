import XCTest
@testable import FlagshipBuilderCore

/// Downloads and expands the real published appliance. Opt-in:
/// FLAGSHIP_LIVE_APPLIANCE_ARCH=amd64|arm64 swift test --filter ApplianceCacheLiveTests
final class ApplianceCacheLiveTests: XCTestCase {
    func testPublishedApplianceExpandsToItsDeclaredDisk() async throws {
        guard let raw = ProcessInfo.processInfo.environment["FLAGSHIP_LIVE_APPLIANCE_ARCH"],
              let arch = IsoArch(rawValue: raw) else {
            throw XCTSkip("set FLAGSHIP_LIVE_APPLIANCE_ARCH to run")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("live-appliance-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let started = Date()
        let cache = try ApplianceCache(arch: arch, cacheRoot: root, log: { print($0) })
        let base = try await cache.ensure(installerGitRef: "main") { phase in print("phase", phase) }
        let provisioner = try ApplianceProvisioner.load(baseURL: base, expectedArch: arch, installerGitRef: "main")
        let allocated = try base.resourceValues(forKeys: [.totalFileAllocatedSizeKey]).totalFileAllocatedSize ?? 0
        print("live appliance ok: \(provisioner.manifest.sha256) allocated=\(allocated) seconds=\(Int(Date().timeIntervalSince(started)))")
    }
}
