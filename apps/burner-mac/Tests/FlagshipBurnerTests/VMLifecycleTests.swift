import XCTest
@testable import FlagshipBurnerCore

/// Every transition of the pure VM state machine, including the
/// install→first-boot ISO-detach seam and the sealed
/// "waiting for you to unlock" state.
final class VMLifecycleTests: XCTestCase {

    private func sealed(_ state: VMState = .created,
                        clock: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 0) }) -> VMLifecycle {
        VMLifecycle(state: state, sealedAtBoot: true, clock: clock)
    }

    private func unsealed(_ state: VMState = .created) -> VMLifecycle {
        VMLifecycle(state: state, sealedAtBoot: false, clock: { Date(timeIntervalSince1970: 0) })
    }

    // MARK: - Install phase

    func testStartInstallAttachesISOAndStarts() throws {
        var lc = sealed()
        let effects = try lc.handle(.startInstall)
        XCTAssertEqual(lc.state, .installing)
        XCTAssertEqual(effects, [.attachInstallerISO, .startVirtualMachine])
    }

    func testInstallSucceededDetachesTheISO() throws {
        // The seam the spec calls out: after the unattended install the ISO
        // comes OFF, so every later boot is from the guest's own disk.
        var lc = sealed(.installing)
        let effects = try lc.handle(.installSucceeded)
        XCTAssertEqual(lc.state, .installed)
        XCTAssertEqual(effects, [.detachInstallerISO])
    }

    func testInstallFailureStopsAndDetaches() throws {
        var lc = sealed(.installing)
        let effects = try lc.handle(.installFailed("guest error"))
        XCTAssertEqual(lc.state, .failed(VMFailure(phase: .install, reason: "guest error")))
        XCTAssertEqual(effects, [.stopVirtualMachine, .detachInstallerISO])
    }

    func testFailedInstallIsRetryable() throws {
        var lc = sealed(.failed(VMFailure(phase: .install, reason: "x")))
        let effects = try lc.handle(.startInstall)
        XCTAssertEqual(lc.state, .installing)
        XCTAssertEqual(effects, [.attachInstallerISO, .startVirtualMachine])
    }

    // MARK: - Boot: the sealed state

    func testEncryptedGuestBootsIntoAwaitingPhoneUnlock() throws {
        var lc = sealed(.installed)
        let effects = try lc.handle(.powerOn)
        XCTAssertEqual(lc.state, .awaitingPhoneUnlock)
        XCTAssertEqual(effects, [.startVirtualMachine])
    }

    func testUnencryptedGuestBootsStraightToRunning() throws {
        var lc = unsealed(.installed)
        let effects = try lc.handle(.powerOn)
        XCTAssertEqual(lc.state, .running)
        XCTAssertEqual(effects, [.startVirtualMachine])
    }

    func testPhoneUnlockCompletesTheBoot() throws {
        var lc = sealed(.awaitingPhoneUnlock)
        let effects = try lc.handle(.guestUnlocked)
        XCTAssertEqual(lc.state, .running)
        XCTAssertEqual(effects, [])
    }

    func testSealedGuestCanBePoweredOffWhileWaiting() throws {
        // The VM boots with the host but stays sealed — the owner may still
        // shut it down without ever unlocking.
        var lc = sealed(.awaitingPhoneUnlock)
        let effects = try lc.handle(.powerOff)
        XCTAssertEqual(lc.state, .stopped)
        XCTAssertEqual(effects, [.stopVirtualMachine])
    }

    // MARK: - Run / stop / restart

    func testRunningPowersOffToStopped() throws {
        var lc = sealed(.running)
        let effects = try lc.handle(.powerOff)
        XCTAssertEqual(lc.state, .stopped)
        XCTAssertEqual(effects, [.stopVirtualMachine])
    }

    func testStoppedRebootsThroughTheSealedState() throws {
        var lc = sealed(.stopped)
        let effects = try lc.handle(.powerOn)
        XCTAssertEqual(lc.state, .awaitingPhoneUnlock)
        XCTAssertEqual(effects, [.startVirtualMachine])
    }

    func testRuntimeFailureFromRunning() throws {
        var lc = sealed(.running)
        _ = try lc.handle(.runtimeFailed("crashed"))
        XCTAssertEqual(lc.state, .failed(VMFailure(phase: .run, reason: "crashed")))
    }

    func testRuntimeFailureWhileAwaitingUnlock() throws {
        var lc = sealed(.awaitingPhoneUnlock)
        _ = try lc.handle(.runtimeFailed("died"))
        XCTAssertEqual(lc.state, .failed(VMFailure(phase: .run, reason: "died")))
    }

    func testRunFailureIsRestartable() throws {
        var lc = sealed(.failed(VMFailure(phase: .run, reason: "x")))
        let effects = try lc.handle(.powerOn)
        XCTAssertEqual(lc.state, .awaitingPhoneUnlock)
        XCTAssertEqual(effects, [.startVirtualMachine])
    }

    // MARK: - Invalid transitions are loud, not swallowed

    func testInvalidTransitionsThrow() {
        let cases: [(VMState, VMEvent)] = [
            (.created, .powerOn),               // nothing installed yet
            (.created, .installSucceeded),
            (.installing, .powerOn),            // mid-install
            (.installing, .guestUnlocked),
            (.installed, .startInstall),        // already installed
            (.installed, .guestUnlocked),       // not booted
            (.running, .powerOn),               // already up
            (.running, .guestUnlocked),
            (.running, .startInstall),
            (.stopped, .guestUnlocked),
            (.awaitingPhoneUnlock, .powerOn),
            (.failed(VMFailure(phase: .install, reason: "x")), .powerOn), // must retry install
            (.failed(VMFailure(phase: .run, reason: "x")), .startInstall),
        ]
        for (state, event) in cases {
            var lc = sealed(state)
            XCTAssertThrowsError(try lc.handle(event), "\(state) + \(event) should throw") { err in
                XCTAssertEqual(err as? VMLifecycleError,
                               .invalidTransition(from: state, on: event))
            }
            XCTAssertEqual(lc.state, state, "state must not change on a rejected event")
        }
    }

    // MARK: - Injectable clock

    func testStateTimestampsComeFromTheInjectedClock() throws {
        let times: [Date] = [Date(timeIntervalSince1970: 100),
                             Date(timeIntervalSince1970: 200),
                             Date(timeIntervalSince1970: 300)]
        let box = ClockBox(times: times)
        var lc = VMLifecycle(sealedAtBoot: true, clock: { box.next() })
        XCTAssertEqual(lc.stateChangedAt, times[0])
        try lc.handle(.startInstall)
        XCTAssertEqual(lc.stateChangedAt, times[1])
        try lc.handle(.installSucceeded)
        XCTAssertEqual(lc.stateChangedAt, times[2])
    }

    private final class ClockBox: @unchecked Sendable {
        private var times: [Date]
        private let lock = NSLock()
        init(times: [Date]) { self.times = times }
        func next() -> Date {
            lock.lock(); defer { lock.unlock() }
            return times.isEmpty ? Date.distantFuture : times.removeFirst()
        }
    }
}
