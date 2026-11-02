import XCTest
@testable import FlagshipUI
import FlagshipAPI

/// The relay mesh's box events (docs/architecture-v2/relay-mesh.md §9.3, §9.4) in Activity: a title of our own,
/// the box's sentence under it, and a refused move shown as a warning.
final class RelayMeshActivityTests: XCTestCase {
    func test_relayMovesAreNamed() {
        let moved = BoxActivityEntry(ts: 1, action: "server.relay.moved", kind: "server.relay.moved", ok: true)
        XCTAssertEqual(BoxEventLabels.title(moved), "Moved to another Flagship relay")
        XCTAssertEqual(BoxEventLabels.symbol(moved), "antenna.radiowaves.left.and.right")
        let refused = BoxActivityEntry(ts: 2, action: "server.relay.move-refused", kind: "server.relay.move-refused", ok: false)
        XCTAssertEqual(BoxEventLabels.title(refused), "Stayed on its current relay")
        XCTAssertEqual(BoxEventLabels.symbol(refused), "exclamationmark.triangle.fill")
    }
}
