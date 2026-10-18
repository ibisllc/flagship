import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Add/Restore server sat where a card had been, so a tap just after the layout
/// moved landed on it; it now takes no tap for a quiet period after the layout
/// changes.
final class TapSettleTests: XCTestCase {
    func test_takesNoTapJustAfterTheLayoutMoves() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var s = TapSettle(startedAt: t0)
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(1)), "settled")
        s.layoutChanged(at: t0.addingTimeInterval(10))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(10.1)))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(10.44)))
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(10.45)))
    }

    func test_aSecondMoveRestartsTheQuietPeriod() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var s = TapSettle(startedAt: t0)
        s.layoutChanged(at: t0.addingTimeInterval(1))
        s.layoutChanged(at: t0.addingTimeInterval(1.3))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(1.6)))
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(1.8)))
    }

    func test_theQuietPeriodIsFourHundredFiftyMilliseconds() {
        XCTAssertEqual(TapSettle.quietPeriod, 0.45)
    }
}
