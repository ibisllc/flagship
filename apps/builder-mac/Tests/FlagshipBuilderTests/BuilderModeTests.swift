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

    /// Three modes: Simple (default) + the parked Alpine Quick + Advanced. If we
    /// change this we have to revisit the WizardModel
    /// `@Published var mode: BuilderMode = .simple`.
    func testModesAreSimpleQuickAndAdvanced() {
        XCTAssertEqual(BuilderMode.simple.rawValue, "simple")
        XCTAssertEqual(BuilderMode.quick.rawValue, "quick")
        XCTAssertEqual(BuilderMode.advanced.rawValue, "advanced")
        XCTAssertEqual(Set(BuilderMode.allCases), Set([.simple, .quick, .advanced]))
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

    /// Quick bakes the recipe into the builder's cached Alpine base as a
    /// trailer; it needs the recipe but NOT a user-supplied ISO.
    func testQuickRequiresRecipeButNotUserISO() {
        XCTAssertTrue(BuilderMode.quick.requiresRecipe)
        XCTAssertFalse(BuilderMode.quick.requiresUserISO)
    }

    /// Advanced = stock distro ISO + recipe → remaster. Both are mandatory.
    func testAdvancedRequiresRecipeAndUserISO() {
        XCTAssertTrue(BuilderMode.advanced.requiresRecipe)
        XCTAssertTrue(BuilderMode.advanced.requiresUserISO)
    }

    func testBakeCtaLabel() {
        XCTAssertEqual(BuilderMode.simple.bakeCtaLabel, "Flash to USB")
        XCTAssertEqual(BuilderMode.quick.bakeCtaLabel, "Flash to USB")
        XCTAssertEqual(BuilderMode.advanced.bakeCtaLabel, "Assemble and flash")
    }

    func testMenuLabel() {
        XCTAssertEqual(BuilderMode.simple.menuLabel, "Simple")
        XCTAssertEqual(BuilderMode.quick.menuLabel, "Quick")
        XCTAssertEqual(BuilderMode.advanced.menuLabel, "Advanced")
    }
}
