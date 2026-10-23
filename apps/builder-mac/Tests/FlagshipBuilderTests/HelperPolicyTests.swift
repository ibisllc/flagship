import XCTest
import Security
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

    // MARK: disk assessment

    private func plist(_ over: [String: Any] = [:], drop: [String] = []) -> Data {
        var d: [String: Any] = [
            "DeviceIdentifier": "disk4", "WholeDisk": true, "Internal": false,
            "RemovableMedia": true, "VirtualOrPhysical": "Physical", "BusProtocol": "USB",
            "TotalSize": 16_000_000_000, "MediaName": "Stick", "DiskUUID": "UUID-1",
        ]
        for (k, v) in over { d[k] = v }
        for k in drop { d.removeValue(forKey: k) }
        return try! PropertyListSerialization.data(fromPropertyList: d, format: .xml, options: 0)
    }

    private func assess(_ data: Data, system: Set<String> = ["disk0", "disk3"], image: Int64 = 1_000_000_000) throws -> HelperPolicy.DiskFacts {
        try HelperPolicy.assess(plist: data, wantedID: "disk4", systemDisks: system, imageBytes: image)
    }

    func testAnExternalRemovableWholeDiskIsAccepted() throws {
        let f = try assess(plist())
        XCTAssertEqual(f.id, "disk4")
        XCTAssertEqual(f.totalSize, 16_000_000_000)
    }

    func testRefusals() {
        let cases: [(String, Data, HelperPolicy.Refusal)] = [
            ("another disk answered", plist(["DeviceIdentifier": "disk5"]), .notThatDisk),
            ("a partition", plist(["WholeDisk": false]), .notExternalWholeDisk),
            ("internal", plist(["Internal": true]), .notExternalWholeDisk),
            ("internal flag missing", plist(drop: ["Internal"]), .notExternalWholeDisk),
            ("not removable", plist(["RemovableMedia": false]), .notRemovable),
            ("virtual", plist(["VirtualOrPhysical": "Virtual"]), .virtualDisk),
            ("disk image", plist(["BusProtocol": "Disk Image"]), .virtualDisk),
            ("too small", plist(["TotalSize": 500]), .diskTooSmall),
            ("zero", plist(["TotalSize": 0]), .diskTooSmall),
            ("data drive", plist(["TotalSize": 4 * 1024 * 1024 * 1024 * 1024]), .diskTooLarge),
        ]
        for (name, data, expected) in cases {
            XCTAssertThrowsError(try assess(data), name) { XCTAssertEqual($0 as? HelperPolicy.Refusal, expected, name) }
        }
        XCTAssertThrowsError(try assess(plist(), system: ["disk4"])) {
            XCTAssertEqual($0 as? HelperPolicy.Refusal, .systemDisk)
        }
        XCTAssertThrowsError(try assess(Data("not a plist".utf8)))
    }

    func testSystemDisksIncludeTheAPFSPhysicalStore() throws {
        let rootInfo = try PropertyListSerialization.data(fromPropertyList: [
            "ParentWholeDisk": "disk3",
            "APFSPhysicalStores": [["APFSPhysicalStore": "disk0s2"]],
        ], format: .xml, options: 0)
        let set = try HelperPolicy.systemWholeDisks { _ in rootInfo }
        XCTAssertEqual(set, ["disk3", "disk0"])
    }

    func testSystemDisksFailClosed() {
        XCTAssertThrowsError(try HelperPolicy.systemWholeDisks { _ in throw DiskEnumeratorError.diskutilFailed("x") })
        XCTAssertThrowsError(try HelperPolicy.systemWholeDisks { _ in Data("junk".utf8) })
        let empty = try! PropertyListSerialization.data(fromPropertyList: [String: Any](), format: .xml, options: 0)
        XCTAssertThrowsError(try HelperPolicy.systemWholeDisks { _ in empty })
    }

    func testSliceToWhole() {
        XCTAssertEqual(HelperPolicy.wholeID(ofSlice: "disk0s2"), "disk0")
        XCTAssertEqual(HelperPolicy.wholeID(ofSlice: "disk12s1s1"), "disk12")
    }
}
