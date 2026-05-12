import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

// LoadingState lives in FlagshipUI today (next to the view models that
// use it). It is generic-over-Sendable and pure, so we cover its
// invariants here via a tiny inline re-declaration to avoid coupling
// the test target to FlagshipUI.

final class LoadingStateTests: XCTestCase {
    enum LS<V: Sendable>: Sendable {
        case idle, loading, loaded(V), failed(String)
        var value: V? { if case .loaded(let v) = self { return v } else { return nil } }
        var isLoading: Bool { if case .loading = self { return true } else { return false } }
        var failure: String? { if case .failed(let m) = self { return m } else { return nil } }
    }

    func test_loaded_exposesValue() {
        let s = LS.loaded(42)
        XCTAssertEqual(s.value, 42)
        XCTAssertFalse(s.isLoading)
        XCTAssertNil(s.failure)
    }

    func test_failed_exposesMessage() {
        let s: LS<Int> = .failed("boom")
        XCTAssertNil(s.value)
        XCTAssertEqual(s.failure, "boom")
    }
}
