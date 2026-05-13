import XCTest
@testable import FlagshipCore

@MainActor
final class ToastCenterTests: XCTestCase {

    func test_publish_appendsToQueue() {
        let c = ToastCenter()
        c.success("Saved.")
        XCTAssertEqual(c.queue.count, 1)
        XCTAssertEqual(c.queue.first?.kind, .success)
        XCTAssertEqual(c.queue.first?.message, "Saved.")
    }

    func test_dedupes_identicalToasts() {
        let c = ToastCenter()
        c.info("hello")
        c.info("hello")
        c.info("hello")
        XCTAssertEqual(c.queue.count, 1)
    }

    func test_differentKindsCoexist() {
        let c = ToastCenter()
        c.info("x"); c.success("x"); c.error("x"); c.warning("x")
        XCTAssertEqual(c.queue.count, 4)
    }

    func test_dismiss_removesById() {
        let c = ToastCenter()
        c.info("a"); c.info("b")
        guard let firstId = c.queue.first?.id else { return XCTFail() }
        c.dismiss(firstId)
        XCTAssertEqual(c.queue.count, 1)
        XCTAssertEqual(c.queue.first?.message, "b")
    }

    func test_autoDismiss_afterDuration() async throws {
        let c = ToastCenter()
        c.success("flash", duration: 0.05)
        XCTAssertEqual(c.queue.count, 1)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(c.queue.isEmpty)
    }
}
