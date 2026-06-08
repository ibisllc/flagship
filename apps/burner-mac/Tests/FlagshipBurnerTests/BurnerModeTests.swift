import XCTest
@testable import FlagshipBurnerCore

/// Locks the semantics the WizardModel keys off.
///
/// The WizardModel itself lives in the FlagshipBurner exe target, which the
/// test target can't import, so its model-level behaviour (default is
/// `.simple`, `runWrite` runs the remaster step) is exercised via this shared
/// seam: the model asks `mode.requiresRecipe` / `mode.requiresUserISO` to
/// decide which inputs are needed.
final class BurnerModeTests: XCTestCase {

    /// Two modes: Simple (default) + Advanced. If we change this we have to
    /// revisit the WizardModel `@Published var mode: BurnerMode = .simple`.
    func testModesAreSimpleAndAdvanced() {
        XCTAssertEqual(BurnerMode.simple.rawValue, "simple")
        XCTAssertEqual(BurnerMode.advanced.rawValue, "advanced")
        XCTAssertEqual(Set(BurnerMode.allCases), Set([.simple, .advanced]))
    }

    /// allCases is ordered Simple-first so the segmented picker leads with the
    /// default.
    func testSimpleIsFirst() {
        XCTAssertEqual(BurnerMode.allCases.first, .simple)
    }

    /// Simple = server-named Debian base + recipe → remaster. No user ISO.
    func testSimpleRequiresRecipeButNotUserISO() {
        XCTAssertTrue(BurnerMode.simple.requiresRecipe)
        XCTAssertFalse(BurnerMode.simple.requiresUserISO)
    }

    /// Advanced = stock distro ISO + recipe → remaster. Both are mandatory.
    func testAdvancedRequiresRecipeAndUserISO() {
        XCTAssertTrue(BurnerMode.advanced.requiresRecipe)
        XCTAssertTrue(BurnerMode.advanced.requiresUserISO)
    }

    func testBakeCtaLabel() {
        XCTAssertEqual(BurnerMode.simple.bakeCtaLabel, "Flash to USB")
        XCTAssertEqual(BurnerMode.advanced.bakeCtaLabel, "Assemble and flash")
    }

    func testMenuLabel() {
        XCTAssertEqual(BurnerMode.simple.menuLabel, "Simple")
        XCTAssertEqual(BurnerMode.advanced.menuLabel, "Advanced")
    }
}
