import Foundation
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The open git build `-smoke-build-interrupted` seeds: a restart cut
    /// its AI run off, so the box kept its files and says so.
    public static let interruptedBuildId = "bld-recipes03"
    public static let interruptedReason =
        "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy."

    /// Build seams for GymSweepBuildTests.
    static func build(_ args: [String], _ app: AppState, _ operations: ActiveOperationsCenter, _ mocks: GymMocks) {
        if args.contains("-smoke-build-interrupted") {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            mocks.screens.buildSessionsFixture = BuildSessionsResponse(builds: [
                BuildSummary(buildId: interruptedBuildId, mode: "git", name: "recipes",
                             startedAt: now - 60_000 * 20, lastAt: now - 60_000 * 15, entryCount: 4,
                             lastKind: "adapt-started", open: true),
                BuildSummary(buildId: "bld-plants01", mode: "scratch", serviceId: "bright-maple--plants",
                             startedAt: now - 60_000 * 60, lastAt: now - 60_000 * 58, entryCount: 9, lastKind: "deployed"),
            ])
            mocks.screens.buildStateFixtures[interruptedBuildId] = BuildStateResponse(
                state: .init(buildId: interruptedBuildId, mode: "git", name: "recipes",
                             adapt: BuildAdaptStatus(status: "failed", reason: interruptedReason)),
                files: ["package.json", "server.js", "flagship.app.json"])
        }
    }
}
