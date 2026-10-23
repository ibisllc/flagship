import XCTest
import Security
import DiskArbitration
@testable import FlagshipBuilderCore

/// SEC-MAC-001: the root helper accepts only Flagship's own client and only
/// objects it validated itself.
final class HelperPolicyTests: XCTestCase {
    private var dir: URL!
    private let me = getuid()

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("helper-policy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: client requirement

    func testRequirementIsValidAndNamesOurTeam() {
        let req = HelperPolicy.clientRequirement()
        var ref: SecRequirement?
        XCTAssertEqual(SecRequirementCreateWithString(req as CFString, [], &ref), errSecSuccess, req)
        XCTAssertTrue(req.contains("certificate leaf[subject.OU] = \"8G8RHBU9BN\""))
        XCTAssertTrue(req.contains("identifier \"com.flagshipserver.Builder\""))
        XCTAssertTrue(req.hasPrefix("anchor apple generic"))
    }

    func testBundleIdAloneIsNotEnough() {
        XCTAssertNotEqual(HelperPolicy.clientRequirement(),
                          "identifier \"com.flagshipserver.Builder\" and anchor apple generic")
    }

    // MARK: device node

    func testOnlyWholeDiskNodesAreAccepted() throws {
        XCTAssertEqual(try HelperPolicy.wholeDiskID(fromNode: "/dev/disk4"), "disk4")
        for bad in ["/dev/disk4s1", "/dev/rdisk4", "/dev/disk", "/dev/disk4/../disk0", "disk4",
                    "/dev/disk4\0", "/etc/passwd", "/dev/../dev/disk4", "/dev/disk-1", ""] {
            XCTAssertThrowsError(try HelperPolicy.wholeDiskID(fromNode: bad), bad)
        }
    }

    // MARK: disk assessment (Disk Arbitration + I/O Registry)

    private func stick(_ change: (inout DiskDescription) -> Void = { _ in }) -> DiskDescription {
        var d = DiskDescription(bsdName: "disk4", whole: true, internalDevice: false, removable: true, ejectable: true,
                                size: 16_000_000_000, mediaName: "Stick", busProtocol: "USB", mediaUUID: "",
                                deviceModel: "Flash Disk", registryEntryID: 0x1000_0042)
        change(&d)
        return d
    }

    private func assess(_ d: DiskDescription, system: Set<String> = ["disk0", "disk3"], image: Int64 = 1_000_000_000) throws -> HelperPolicy.DiskFacts {
        try HelperPolicy.assess(d, wantedID: "disk4", systemDisks: system, imageBytes: image)
    }

    func testAnExternalRemovableWholeDiskIsAccepted() throws {
        let f = try assess(stick())
        XCTAssertEqual(f.id, "disk4")
        XCTAssertEqual(f.totalSize, 16_000_000_000)
        XCTAssertEqual(f.registryEntryID, 0x1000_0042)
        // Ejectable but not "removable media" (most USB sticks report this way) is still a stick.
        XCTAssertNoThrow(try assess(stick { $0.removable = false }))
    }

    func testRefusals() {
        let cases: [(String, DiskDescription, HelperPolicy.Refusal)] = [
            ("another disk answered", stick { $0.bsdName = "disk5" }, .notThatDisk),
            ("a partition", stick { $0.whole = false }, .notExternalWholeDisk),
            ("internal", stick { $0.internalDevice = true }, .notExternalWholeDisk),
            ("internal not said", stick { $0.internalDevice = nil }, .notExternalWholeDisk),
            ("neither removable nor ejectable", stick { $0.removable = false; $0.ejectable = false }, .notRemovable),
            ("a disk image", stick { $0.busProtocol = "Disk Image" }, .virtualDisk),
            ("a virtual interface", stick { $0.busProtocol = "Virtual Interface" }, .virtualDisk),
            ("a disk image by model", stick { $0.deviceModel = "Disk Image" }, .virtualDisk),
            ("too small", stick { $0.size = 500 }, .diskTooSmall),
            ("zero", stick { $0.size = 0 }, .diskTooSmall),
            ("data drive", stick { $0.size = 4 * 1024 * 1024 * 1024 * 1024 }, .diskTooLarge),
            ("no registry entry", stick { $0.registryEntryID = 0 }, .diskInfoUnavailable("I/O Registry")),
        ]
        for (name, d, expected) in cases {
            XCTAssertThrowsError(try assess(d), name) { XCTAssertEqual($0 as? HelperPolicy.Refusal, expected, name) }
        }
        XCTAssertThrowsError(try assess(stick(), system: ["disk4"])) {
            XCTAssertEqual($0 as? HelperPolicy.Refusal, .systemDisk)
        }
    }

    /// The write refuses when the facts read at write time differ from the ones
    /// registered: the same diskN now backed by another IOMedia object (unplugged
    /// and plugged back, or another stick that took the number) is not the disk
    /// the owner chose.
    func testAReconnectOrAnotherStickUnderTheSameNumberIsADifferentDisk() throws {
        let registered = try assess(stick())
        XCTAssertEqual(try assess(stick()), registered)
        XCTAssertNotEqual(try assess(stick { $0.registryEntryID = 0x1000_0099 }), registered)
        XCTAssertNotEqual(try assess(stick { $0.mediaName = "Other Stick" }), registered)
        XCTAssertNotEqual(try assess(stick { $0.size = 32_000_000_000 }), registered)
    }

    func testDiskArbitrationDescriptionMapping() {
        let uuid = CFUUIDCreateFromString(kCFAllocatorDefault, "0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0" as CFString)!
        let raw: [String: Any] = [
            kDADiskDescriptionMediaBSDNameKey as String: "disk4",
            kDADiskDescriptionMediaWholeKey as String: true,
            kDADiskDescriptionDeviceInternalKey as String: false,
            kDADiskDescriptionMediaRemovableKey as String: true,
            kDADiskDescriptionMediaEjectableKey as String: true,
            kDADiskDescriptionMediaSizeKey as String: NSNumber(value: 16_000_000_000 as Int64),
            kDADiskDescriptionMediaNameKey as String: "SanDisk Media",
            kDADiskDescriptionDeviceProtocolKey as String: "USB",
            kDADiskDescriptionMediaUUIDKey as String: uuid,
            kDADiskDescriptionDeviceModelKey as String: "Ultra",
        ]
        let d = DiskArbitrationProbe.description(from: raw, registryEntryID: 7)
        XCTAssertEqual(d, DiskDescription(bsdName: "disk4", whole: true, internalDevice: false, removable: true, ejectable: true,
                                          size: 16_000_000_000, mediaName: "SanDisk Media", busProtocol: "USB",
                                          mediaUUID: "0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", deviceModel: "Ultra",
                                          registryEntryID: 7))
        // Missing flags read as "not", never as "yes".
        let bare = DiskArbitrationProbe.description(from: [kDADiskDescriptionMediaBSDNameKey as String: "disk9"], registryEntryID: 0)
        XCTAssertFalse(bare.whole)
        XCTAssertNil(bare.internalDevice)
        XCTAssertFalse(bare.removable || bare.ejectable)
    }

    /// On this Mac (no root needed): the disks under the running system are
    /// found, and the startup disk is refused as Disk Arbitration describes it.
    func testThisMacsStartupDiskIsRefused() throws {
        let system = try DiskArbitrationProbe.systemWholeDisks()
        XCTAssertFalse(system.isEmpty)
        for name in system {
            XCTAssertTrue(DiskEnumerator.isWholeDiskID(name), name)
            let d = try DiskArbitrationProbe.describe(bsdName: name)
            XCTAssertEqual(d.bsdName, name)
            XCTAssertThrowsError(try HelperPolicy.assess(d, wantedID: name, systemDisks: system, imageBytes: 1), name)
        }
        XCTAssertThrowsError(try DiskArbitrationProbe.describe(bsdName: "disk987"))
    }

    func testSliceToWhole() {
        XCTAssertEqual(HelperPolicy.wholeID(ofSlice: "disk0s2"), "disk0")
        XCTAssertEqual(HelperPolicy.wholeID(ofSlice: "disk12s1s1"), "disk12")
    }
}
