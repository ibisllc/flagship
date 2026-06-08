import XCTest
@testable import FlagshipBurnerCore

/// Locks the semantics the WizardModel keys off.
///
/// The WizardModel itself lives in the FlagshipBurner exe target, which the
/// test target can't import, so its model-level behaviour (default is
/// `.advanced`, `runWrite` runs the remaster step) is exercised via this
/// shared seam: the model asks `mode.requiresRecipe` / `mode.requiresUserISO`
/// to decide which inputs are needed.
final class BurnerModeTests: XCTestCase {

    /// Advanced is the only mode. If we ever add another we have to revisit
    /// the WizardModel `@Published var mode: BurnerMode = .advanced` literal.
    func testAdvancedIsTheOnlyMode() {
        XCTAssertEqual(BurnerMode.advanced.rawValue, "advanced")
        XCTAssertEqual(Set(BurnerMode.allCases), Set([.advanced]))
    }

    /// Advanced = stock distro ISO + recipe → remaster. Both are mandatory.
    func testAdvancedRequiresRecipeAndUserISO() {
        XCTAssertTrue(BurnerMode.advanced.requiresRecipe)
        XCTAssertTrue(BurnerMode.advanced.requiresUserISO)
    }

    func testBakeCtaLabel() {
        XCTAssertEqual(BurnerMode.advanced.bakeCtaLabel, "Assemble and flash")
    }

    func testMenuLabel() {
        XCTAssertEqual(BurnerMode.advanced.menuLabel, "Advanced")
    }
}
