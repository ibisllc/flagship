import XCTest
@testable import FlagshipBurnerCore

/// Locks the Quick-vs-Advanced semantics the WizardModel keys off.
///
/// The WizardModel itself lives in the FlagshipBurner exe target, which the
/// test target can't import, so its model-level behaviour (default is
/// `.quick`, `canFlash` ignores recipe in Quick, `runWrite` skips the
/// remaster branch in Quick) is exercised via this shared seam: the model
/// asks `mode.requiresRecipe` to decide whether recipe input is needed, and
/// branches on `mode == .advanced` to run the remaster step.
final class BurnerModeTests: XCTestCase {

    /// Quick is the locked default. If we ever flip this we have to update
    /// the WizardModel `@Published var mode: BurnerMode = .quick` literal
    /// too — keep them in sync via this test.
    func testQuickIsTheDefaultByConvention() {
        // No "default" on the enum itself; the model defaults to Quick.
        // This test pins the *name + shape* so a typo elsewhere fails here.
        XCTAssertEqual(BurnerMode.quick.rawValue, "quick")
        XCTAssertEqual(BurnerMode.advanced.rawValue, "advanced")
        XCTAssertEqual(Set(BurnerMode.allCases), Set([.quick, .advanced]))
    }

    /// Quick = flash the ISO bytes the server already personalized. No JSON
    /// recipe needed — the recipe lives in the ISO trailer.
    func testQuickDoesNotRequireRecipe() {
        XCTAssertFalse(BurnerMode.quick.requiresRecipe)
    }

    /// Advanced = stock distro ISO + recipe → remaster. Recipe is mandatory.
    func testAdvancedRequiresRecipe() {
        XCTAssertTrue(BurnerMode.advanced.requiresRecipe)
    }

    /// The bake CTA reads differently per mode so the user knows whether a
    /// remaster step is about to happen.
    func testBakeCtaLabelsDistinguishTheTwoFlows() {
        XCTAssertEqual(BurnerMode.quick.bakeCtaLabel, "Flash to USB")
        XCTAssertEqual(BurnerMode.advanced.bakeCtaLabel, "Assemble and flash")
        XCTAssertNotEqual(BurnerMode.quick.bakeCtaLabel, BurnerMode.advanced.bakeCtaLabel)
    }

    func testMenuLabels() {
        XCTAssertEqual(BurnerMode.quick.menuLabel, "Quick")
        XCTAssertEqual(BurnerMode.advanced.menuLabel, "Advanced")
    }
}
