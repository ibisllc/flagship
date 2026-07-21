import XCTest
@testable import FlagshipBuilderCore

/// The raw-write failure path: Foundation wraps a failed device write in the
/// generic "The file couldn't be saved." — writeFailureReason must recover the
/// POSIX errno (however deep in the underlying-error chain Foundation buries
/// it) and name the real failure mode.
final class DiskWriteTests: XCTestCase {
    private func cocoaError(wrapping posix: Int32, depth: Int = 1) -> Error {
        var err = NSError(domain: NSPOSIXErrorDomain, code: Int(posix))
        for _ in 0..<depth {
            err = NSError(domain: NSCocoaErrorDomain,
                          code: NSFileWriteUnknownError,
                          userInfo: [NSUnderlyingErrorKey: err])
        }
        return err
    }

    func testDeviceDetachReportsDisconnect() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: ENXIO))
        XCTAssertTrue(reason.contains("disconnected mid-write"), reason)
    }

    func testIOErrorReportsFailingStick() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: EIO))
        XCTAssertTrue(reason.contains("I/O error"), reason)
    }

    func testWriteProtectReportsSwitch() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: EROFS))
        XCTAssertTrue(reason.contains("write-protect"), reason)
    }

    func testAlignmentReportsEinval() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: EINVAL))
        XCTAssertTrue(reason.contains("EINVAL"), reason)
    }

    func testErrnoFoundThroughNestedUnderlyingErrors() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: ENODEV, depth: 3))
        XCTAssertTrue(reason.contains("disconnected mid-write"), reason)
    }

    func testUnmappedErrnoFallsBackToStrerror() {
        let reason = DiskWrite.writeFailureReason(cocoaError(wrapping: ENOSPC))
        XCTAssertTrue(reason.contains("errno \(ENOSPC)"), reason)
    }

    func testNonPosixErrorFallsBackToLocalizedDescription() {
        let err = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError)
        let reason = DiskWrite.writeFailureReason(err)
        XCTAssertEqual(reason, err.localizedDescription)
    }

    func testWriteFailedDescriptionIncludesProgressAndReason() {
        let desc = DiskWriteError.writeFailed(bytesWritten: 180 * 1024 * 1024,
                                              reason: "x").errorDescription
        XCTAssertEqual(desc, "Write failed 180 MB in: x")
    }

    func testRawOpenPermissionFailureNamesFullDiskAccessSetting() {
        let reason = DiskWrite.openFailureReason(EPERM)
        XCTAssertTrue(reason.contains("Full Disk Access"), reason)
        XCTAssertTrue(reason.contains("click +"), reason)
        XCTAssertFalse(reason.contains("busy"), reason)
    }

    func testRawOpenBusyFailureIsDistinctFromPermissionFailure() {
        let reason = DiskWrite.openFailureReason(EBUSY)
        XCTAssertTrue(reason.contains("device is busy"), reason)
        XCTAssertFalse(reason.contains("Full Disk Access"), reason)
    }
}
