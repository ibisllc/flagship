import XCTest
@testable import FlagshipBurnerCore

/// Drives the pure Swift VM core against the SHARED golden vectors
/// (apps/desktop-shared/golden/vm-core-vectors.json) — the cross-language
/// contract that keeps this Swift core and the C# core in apps/burner-windows
/// identical, the same role engine/golden/preseed-vectors.json plays for the
/// preseed engine. Mirrors apps/burner-windows/tests/VMCoreVectorTests.cs one
/// for one. If a vector fails here the fix is byte-parity with the vectors,
/// never editing the vectors to match the code (unless BOTH platforms change
/// together).
///
/// The file is read straight from the shared location via `#filePath` (not a
/// copied test resource), exactly as the Windows csproj *links* the same file
/// into its Resources — so there is nothing to drift.
final class VMCoreVectorTests: XCTestCase {

    // MARK: - Vector loading

    private static func vectorsURL() -> URL {
        // .../apps/burner-mac/Tests/FlagshipBurnerTests/VMCoreVectorTests.swift
        //   → .../FlagshipBurnerTests → .../Tests → .../burner-mac → .../apps
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // FlagshipBurnerTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // burner-mac
            .deletingLastPathComponent() // apps
        dir.appendPathComponent("desktop-shared/golden/vm-core-vectors.json")
        return dir
    }

    private func loadVectors() throws -> [String: Any] {
        let url = Self.vectorsURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("shared vm-core-vectors.json not found at \(url.path)")
        }
        let data = try Data(contentsOf: url)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw XCTSkip("vm-core-vectors.json is not a JSON object")
        }
        return obj
    }

    // MARK: - Token codecs (mirror the C# ParseState/ParseEvent/ParseEffect)

    private func parseState(_ token: String) throws -> VMState {
        switch token {
        case "created": return .created
        case "installing": return .installing
        case "installed": return .installed
        case "awaitingPhoneUnlock": return .awaitingPhoneUnlock
        case "running": return .running
        case "stopped": return .stopped
        case "failed:install": return .failed(VMFailure(phase: .install, reason: "x"))
        case "failed:run": return .failed(VMFailure(phase: .run, reason: "x"))
        default: throw XCTSkip("unknown state token '\(token)'")
        }
    }

    private func parseEvent(_ token: String, reason: String?) throws -> VMEvent {
        switch token {
        case "startInstall": return .startInstall
        case "installSucceeded": return .installSucceeded
        case "installFailed": return .installFailed(reason ?? "")
        case "powerOn": return .powerOn
        case "guestUnlocked": return .guestUnlocked
        case "powerOff": return .powerOff
        case "runtimeFailed": return .runtimeFailed(reason ?? "")
        default: throw XCTSkip("unknown event token '\(token)'")
        }
    }

    private func parseEffect(_ token: String) throws -> VMEffect {
        switch token {
        case "attachInstallerISO": return .attachInstallerISO
        case "detachInstallerISO": return .detachInstallerISO
        case "startVirtualMachine": return .startVirtualMachine
        case "stopVirtualMachine": return .stopVirtualMachine
        default: throw XCTSkip("unknown effect token '\(token)'")
        }
    }

    /// Compare ignoring the placeholder failure reason baked into start-state
    /// tokens; a transition INTO failed pins the real reason.
    private func assertStateMatches(_ expectedToken: String, reason expectedReason: String?,
                                    _ actual: VMState, _ msg: String) throws {
        let expected = try parseState(expectedToken)
        switch (expected, actual) {
        case (.failed(let e), .failed(let a)):
            XCTAssertEqual(e.phase, a.phase, msg)
            if let expectedReason { XCTAssertEqual(expectedReason, a.reason, msg) }
        default:
            XCTAssertEqual(expected, actual, msg)
        }
    }

    private let epoch: @Sendable () -> Date = { Date(timeIntervalSince1970: 0) }

    // MARK: - Lifecycle

    func testAllVectorTransitionsHold() throws {
        let vectors = try loadVectors()
        let lifecycle = vectors["lifecycle"] as? [String: Any]
        let transitions = lifecycle?["transitions"] as? [[String: Any]] ?? []
        var count = 0
        for t in transitions {
            let start = t["start"] as! String
            let ev = t["event"] as! String
            let reason = t["reason"] as? String
            let next = t["next"] as! String
            let effects = try (t["effects"] as! [String]).map { try parseEffect($0) }
            // No "sealed" key ⇒ the transition must hold for BOTH values.
            let sealedValues: [Bool] = (t["sealed"] as? Bool).map { [$0] } ?? [true, false]
            for sealedAtBoot in sealedValues {
                var lc = VMLifecycle(state: try parseState(start),
                                     sealedAtBoot: sealedAtBoot, clock: epoch)
                let got = try lc.handle(try parseEvent(ev, reason: reason))
                let label = "\(start) --\(ev)--> \(next) (sealed=\(sealedAtBoot))"
                try assertStateMatches(next, reason: reason, lc.state, label)
                XCTAssertEqual(effects, got, "effects for \(label)")
                count += 1
            }
        }
        XCTAssertGreaterThanOrEqual(count, 15, "vector file must actually contain transitions")
    }

    func testAllVectorInvalidTransitionsThrowAndLeaveStateUntouched() throws {
        let vectors = try loadVectors()
        let lifecycle = vectors["lifecycle"] as? [String: Any]
        let invalid = lifecycle?["invalid"] as? [[String: Any]] ?? []
        var count = 0
        for t in invalid {
            let start = t["start"] as! String
            let ev = t["event"] as! String
            for sealedAtBoot in [true, false] {
                let startState = try parseState(start)
                var lc = VMLifecycle(state: startState, sealedAtBoot: sealedAtBoot, clock: epoch)
                XCTAssertThrowsError(try lc.handle(try parseEvent(ev, reason: "r")),
                                     "\(start) --\(ev)--> must be rejected")
                // State must not change on a rejected event.
                XCTAssertEqual(lc.state, startState, "\(start) unchanged after rejected \(ev)")
                count += 1
            }
        }
        XCTAssertGreaterThanOrEqual(count, 20, "vector file must actually contain invalid cases")
    }

    // MARK: - Duration-gated install verdict

    func testInstallVerdictMatchesVectors() throws {
        let vectors = try loadVectors()
        let section = vectors["installVerdict"] as! [String: Any]
        XCTAssertEqual((section["minPlausibleInstallSeconds"] as! NSNumber).doubleValue,
                       VMLifecycle.minPlausibleInstallDuration)
        let start = Date(timeIntervalSince1970: 0)
        for c in section["cases"] as! [[String: Any]] {
            let elapsed = (c["elapsedSeconds"] as! NSNumber).doubleValue
            let expected = c["verdict"] as! String
            let verdict = VMLifecycle.verdictForCleanInstallStop(
                installStartedAt: start, now: start.addingTimeInterval(elapsed))
            switch verdict {
            case .installed:
                XCTAssertEqual(expected, "installSucceeded", "elapsed=\(elapsed)")
            case .failedTooFast:
                XCTAssertEqual(expected, "installFailed", "elapsed=\(elapsed)")
            }
        }
    }

    // MARK: - Resource plan

    func testResourcePlanMatchesVectors() throws {
        let vectors = try loadVectors()
        let section = vectors["resourcePlan"] as! [String: Any]
        for c in section["cases"] as! [[String: Any]] {
            let hostCpus = (c["hostCpus"] as! NSNumber).intValue
            let hostRamGiB = (c["hostRamGiB"] as! NSNumber).uint64Value
            let host = HostResources(cpuCount: hostCpus,
                                     memoryBytes: hostRamGiB * VMResourcePlan.gib)
            let label = "cpus=\(hostCpus) ramGiB=\(hostRamGiB)"
            XCTAssertEqual((c["vmCpus"] as! NSNumber).intValue,
                           VMResourcePlan.vmCPUCount(host: host), "vmCpus \(label)")
            XCTAssertEqual((c["vmMemGiB"] as! NSNumber).uint64Value * VMResourcePlan.gib,
                           VMResourcePlan.vmMemoryBytes(host: host), "vmMemGiB \(label)")
            XCTAssertEqual((c["maxVMs"] as! NSNumber).intValue,
                           VMResourcePlan.maxVMCount(host: host), "maxVMs \(label)")
        }
    }

    // MARK: - Bundle-name validation

    func testNameValidationMatchesVectors() throws {
        let vectors = try loadVectors()
        let section = vectors["nameValidation"] as! [String: Any]
        for n in section["valid"] as! [String] {
            XCTAssertTrue(VMInventoryStore.isValidName(n), "'\(n)' should be valid")
        }
        for n in section["invalid"] as! [String] {
            XCTAssertFalse(VMInventoryStore.isValidName(n), "'\(n)' should be invalid")
        }
    }
}
