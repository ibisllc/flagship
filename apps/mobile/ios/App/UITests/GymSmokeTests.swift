import XCTest

/// GYM iOS smoke (§12-G3 / §10 Phase-1) — the deterministic Tier-1 smoke the
/// gym harness drives on the iOS surface: cold-launch in `-smoke-mode` (seeded
/// `DemoFixtures`, no backend) → the paired Home shell renders its expected
/// element. This is the iOS leg of `gym:every-merge`.
///
/// The verdict is the assertion (Layer 1). Screenshots are captured at the
/// scenario's screenshot points and attached to the `.xcresult` (kept always)
/// so the gym adapter can pull them out for the advisory judge — they never
/// decide pass/fail.
///
/// Building this target also builds the FlagshipApp + UITest target, which
/// exercises the smoke-mode launch-arg wiring (G2's `-smoke-mode` / `-smoke-tab`
/// seam) end-to-end.
final class GymSmokeTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Capture a screenshot and attach it under the gym's stable name so the
    /// adapter can map it to a screenshot point. `keepAlways` so the frame is
    /// present in the .xcresult on success too (the D7 capture, §7-B).
    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Cold launch in smoke mode lands on Home with sample pods seeded; the
    /// "Add a server" affordance (`home-add-server`) only renders once at least
    /// one server exists, so its presence proves the seeded paired shell drew.
    func test_gymColdLaunchRendersHome() throws {
        let app = XCUIApplication()
        // The smoke-mode seam: skip onboarding, seed DemoFixtures, land on Home.
        app.launchArguments = ["-smoke-mode", "-smoke-tab", "home"]
        app.launch()

        gymShot(app, "cold-launch")

        // Assertion (the deterministic goal): the seeded Home shell is shown.
        // `home-add-server` is present only when pods exist (DemoFixtures seeds
        // sample pods), so this asserts both "Home rendered" and "fixtures
        // applied" in one stable handle.
        let addServer = app.buttons["home-add-server"]
        XCTAssertTrue(
            addServer.waitForExistence(timeout: 15),
            "Smoke-mode Home should render the seeded paired shell with the add-server affordance."
        )
        gymShot(app, "home-ready")
    }
}
