import XCTest
@testable import FlagshipBurnerCore

final class DiskEnumeratorTests: XCTestCase {

    func testIsWholeDiskID() {
        XCTAssertTrue(DiskEnumerator.isWholeDiskID("disk0"))
        XCTAssertTrue(DiskEnumerator.isWholeDiskID("disk6"))
        XCTAssertTrue(DiskEnumerator.isWholeDiskID("disk42"))
        XCTAssertFalse(DiskEnumerator.isWholeDiskID("disk0s1"))
        XCTAssertFalse(DiskEnumerator.isWholeDiskID("disk3s1s1"))
        XCTAssertFalse(DiskEnumerator.isWholeDiskID("disk"))
        XCTAssertFalse(DiskEnumerator.isWholeDiskID("foo"))
        XCTAssertFalse(DiskEnumerator.isWholeDiskID(""))
    }

    func testParseAllDisksTopLevelKeepsOnlyWholeDisks() throws {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>AllDisks</key>
          <array>
            <string>disk0</string>
            <string>disk0s1</string>
            <string>disk1</string>
            <string>disk3s1s1</string>
            <string>disk6</string>
          </array>
        </dict>
        </plist>
        """.data(using: .utf8)!
        let ids = try DiskEnumerator.parseAllDisksTopLevel(plist: plist)
        XCTAssertEqual(ids, ["disk0", "disk1", "disk6"])
    }

    func testParseDiskInfoMapsAllFields() throws {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>DeviceIdentifier</key><string>disk7</string>
          <key>DeviceNode</key><string>/dev/disk7</string>
          <key>MediaName</key><string>SanDisk Ultra USB</string>
          <key>VolumeName</key><string>FLAGSHIP</string>
          <key>TotalSize</key><integer>32010928128</integer>
          <key>Removable</key><true/>
          <key>Internal</key><false/>
          <key>BusProtocol</key><string>USB</string>
          <key>WholeDisk</key><true/>
        </dict>
        </plist>
        """.data(using: .utf8)!
        let disk = try DiskEnumerator.parseDiskInfo(plist: plist, fallbackId: "disk7")
        XCTAssertEqual(disk.id, "disk7")
        XCTAssertEqual(disk.deviceNode, "/dev/disk7")
        XCTAssertEqual(disk.mediaName, "SanDisk Ultra USB")
        XCTAssertEqual(disk.volumeName, "FLAGSHIP")
        XCTAssertEqual(disk.sizeBytes, 32010928128)
        XCTAssertTrue(disk.isRemovable)
        XCTAssertTrue(disk.isExternal)
        XCTAssertEqual(disk.busProtocol, "USB")
        XCTAssertTrue(disk.isWholeDisk)
    }

    func testAcceptRejectsInternalNonRemovable() {
        let bootDisk = USBDisk(
            id: "disk0", deviceNode: "/dev/disk0",
            mediaName: "APPLE SSD", volumeName: "",
            sizeBytes: 250_000_000_000,
            isRemovable: false, isExternal: false,
            busProtocol: "Apple Fabric", isWholeDisk: true
        )
        XCTAssertFalse(DiskEnumerator.accept(bootDisk).isEmpty)
    }

    func testAcceptAcceptsExternalUSB() {
        let usb = USBDisk(
            id: "disk7", deviceNode: "/dev/disk7",
            mediaName: "Ultra USB", volumeName: "FLAGSHIP",
            sizeBytes: 32_010_928_128,
            isRemovable: true, isExternal: true,
            busProtocol: "USB", isWholeDisk: true
        )
        XCTAssertTrue(DiskEnumerator.accept(usb).isEmpty)
    }

    func testAcceptRejectsPartition() {
        let part = USBDisk(
            id: "disk7s1", deviceNode: "/dev/disk7s1",
            mediaName: "MS-DOS FAT32", volumeName: "FLAGSHIP",
            sizeBytes: 32_000_000_000,
            isRemovable: true, isExternal: true,
            busProtocol: "USB", isWholeDisk: false
        )
        XCTAssertTrue(DiskEnumerator.accept(part).contains(.notWholeDisk))
    }

    func testAcceptRejectsZeroSize() {
        let empty = USBDisk(
            id: "disk7", deviceNode: "/dev/disk7",
            mediaName: "Card Reader (empty)", volumeName: "",
            sizeBytes: 0,
            isRemovable: true, isExternal: true,
            busProtocol: "USB", isWholeDisk: true
        )
        XCTAssertTrue(DiskEnumerator.accept(empty).contains(.zeroSize))
    }

    func testParseAllDisksMissingKeyThrows() {
        let bad = "<plist><dict></dict></plist>".data(using: .utf8)!
        XCTAssertThrowsError(try DiskEnumerator.parseAllDisksTopLevel(plist: bad))
    }

    func testHumanSizeFormatted() {
        let d = USBDisk(
            id: "disk7", deviceNode: "/dev/disk7",
            mediaName: "x", volumeName: "",
            sizeBytes: 16_000_000_000,
            isRemovable: true, isExternal: true,
            busProtocol: "USB", isWholeDisk: true
        )
        // Don't assert exact format (locale-sensitive), only that something
        // non-empty comes back with "GB" in it.
        XCTAssertFalse(d.humanSize.isEmpty)
        XCTAssertTrue(d.humanSize.contains("GB"))
    }
}
