import XCTest

/// GYM iOS button sweep (mock tier), Build: see GymSweepSupport.
final class GymSweepBuildTests: GymSweepCase {

    func openBuildChooser(_ app: XCUIApplication) {
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15), "Services should offer a build affordance.")
        build.tap()
        XCTAssertTrue(app.buttons["build-src-scratch"].waitForExistence(timeout: 15), "The chooser should render.")
    }

    func openBuildSessions(_ app: XCUIApplication) {
        openBuildChooser(app)
        let link = app.buttons["build-source-journal-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))
    }

    /// A restart cut a git build's AI run off (`-smoke-build-interrupted`):
    /// Build sessions → the kept build shows the box's sentence; "Run the AI
    /// again or deploy" reopens it on the git screen with both actions, and
    /// Deploy puts what the AI wrote live.
    func test_interruptedGitBuildOffersRunAgainAndDeploy() throws {
        let app = launch(tab: "apps", ["-smoke-build-interrupted"])
        openBuildSessions(app)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "recipes")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The kept git build is listed as open.")
        row.tap()
        let reason = app.staticTexts["build-journal-failed-reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 15), "The kept build says why its run failed.")
        XCTAssertTrue(reason.label.hasPrefix("The server restarted while the AI was working on this build."),
                      "Got: \(reason.label)")
        shot(app, "build-interrupted-timeline")

        app.buttons["build-journal-open-git"].tap()
        let err = app.staticTexts["build-git-adapt-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15), "The git screen shows the box's reason.")
        XCTAssertTrue(err.label.contains("Its files are kept"), "Got: \(err.label)")
        let again = app.buttons["build-git-adapt"]
        XCTAssertTrue(reveal(app, again))
        XCTAssertEqual(again.label, "Run the AI again")
        let deploy = app.buttons["build-git-deploy-kept"]
        XCTAssertTrue(reveal(app, deploy), "A kept build offers to deploy what it has.")
        shot(app, "build-interrupted-git")
        deploy.tap()
        XCTAssertTrue(app.staticTexts["Installed"].waitForExistence(timeout: 15), "Deploy puts the kept build live.")
        expectProbe(app, "deployed build bld-recipes03")
    }
}
