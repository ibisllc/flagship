import XCTest
@testable import FlagshipBuilderCore

/// Locks the semantics the WizardModel keys off.
///
/// The WizardModel itself lives in the FlagshipBuilder exe target, which the
/// test target can't import, so its model-level behaviour (default is
/// `.simple`, `runWrite` runs the remaster step) is exercised via this shared
/// seam: the model asks `mode.requiresRecipe` / `mode.requiresUserISO` to
/// decide which inputs are needed.
final class BuilderModeTests: XCTestCase {

    /// Two modes: Simple (default) + Advanced. If we change this we have to
    /// revisit the WizardModel `@Published var mode: BuilderMode = .simple`.
    func testModesAreSimpleAndAdvanced() {
        XCTAssertEqual(BuilderMode.simple.rawValue, "simple")
        XCTAssertEqual(BuilderMode.advanced.rawValue, "advanced")
        XCTAssertEqual(Set(BuilderMode.allCases), Set([.simple, .advanced]))
    }

    /// allCases is ordered Simple-first so the segmented picker leads with the
    /// default.
    func testSimpleIsFirst() {
        XCTAssertEqual(BuilderMode.allCases.first, .simple)
    }

    /// Simple = server-named Debian base + recipe → remaster. No user ISO.
    func testSimpleRequiresRecipeButNotUserISO() {
        XCTAssertTrue(BuilderMode.simple.requiresRecipe)
        XCTAssertFalse(BuilderMode.simple.requiresUserISO)
    }

    /// Advanced = stock distro ISO + recipe → remaster. Both are mandatory.
    func testAdvancedRequiresRecipeAndUserISO() {
        XCTAssertTrue(BuilderMode.advanced.requiresRecipe)
        XCTAssertTrue(BuilderMode.advanced.requiresUserISO)
    }

    func testBakeCtaLabel() {
        XCTAssertEqual(BuilderMode.simple.bakeCtaLabel, "Flash to USB")
        XCTAssertEqual(BuilderMode.advanced.bakeCtaLabel, "Assemble and flash")
    }

    func testMenuLabel() {
        XCTAssertEqual(BuilderMode.simple.menuLabel, "Simple")
        XCTAssertEqual(BuilderMode.advanced.menuLabel, "Advanced")
    }
}
