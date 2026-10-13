import XCTest
import LocalAuthentication
@testable import Flagship
@testable import FlagshipUI

/// The lock screen showed "Couldn't authenticate: The operation couldn't be
/// completed. (Flagship.BiometricGate.GateError error 0.)" on launch: the
/// auto-prompt ran before the app was in front, LocalAuthentication refused,
/// and the refusal was wrapped in a payload case with no description.
final class BiometricGateErrorTests: XCTestCase {

    private func la(_ code: LAError.Code) -> Error {
        NSError(domain: LAErrorDomain, code: code.rawValue)
    }

    func test_mapsLocalAuthenticationCodes() {
        typealias E = BiometricGate.GateError
        XCTAssertEqual(E.from(la(.userCancel)), .userCancelled)
        XCTAssertEqual(E.from(la(.userFallback)), .userCancelled)
        XCTAssertEqual(E.from(la(.appCancel)), .interrupted)
        XCTAssertEqual(E.from(la(.systemCancel)), .interrupted)
        XCTAssertEqual(E.from(la(.notInteractive)), .interrupted)
        XCTAssertEqual(E.from(la(.passcodeNotSet)), .notAvailable)
        XCTAssertEqual(E.from(la(.biometryNotAvailable)), .notAvailable)
        XCTAssertEqual(E.from(la(.biometryNotEnrolled)), .notAvailable)
        XCTAssertEqual(E.from(la(.biometryLockout)), .lockedOut)
        XCTAssertEqual(E.from(la(.authenticationFailed)), .failed)
        XCTAssertEqual(E.from(la(.invalidContext)), .other(code: LAError.Code.invalidContext.rawValue))
        XCTAssertEqual(E.from(LAError(.systemCancel)), .interrupted)
        XCTAssertEqual(E.from(E.lockedOut), .lockedOut)
        XCTAssertEqual(E.from(NSError(domain: "x", code: 7)), .other(code: 7))
    }

    func test_everyCaseReadsAsASentence() {
        let all: [BiometricGate.GateError] = [
            .notAvailable, .userCancelled, .interrupted, .lockedOut, .failed, .other(code: -99),
        ]
        for e in all {
            let text = e.localizedDescription
            XCTAssertFalse(text.contains("GateError"), text)
            XCTAssertFalse(text.contains("error 0"), text)
            XCTAssertFalse(text.contains("operation couldn"), text)
            XCTAssertTrue(text.hasSuffix("."), text)
        }
    }

    func test_onlyCancelAndInterruptionAreSilent() {
        XCTAssertTrue(BiometricGate.GateError.userCancelled.isSilent)
        XCTAssertTrue(BiometricGate.GateError.interrupted.isSilent)
        XCTAssertFalse(BiometricGate.GateError.failed.isSilent)
        XCTAssertFalse(BiometricGate.GateError.notAvailable.isSilent)
        XCTAssertFalse(BiometricGate.GateError.lockedOut.isSilent)
    }

    func test_lockScreenSaysNothingForCancelOrANotYetShownPrompt() {
        XCTAssertNil(BiometricLockScreen.message(for: la(.userCancel)))
        XCTAssertNil(BiometricLockScreen.message(for: la(.systemCancel)))
        XCTAssertNil(BiometricLockScreen.message(for: la(.appCancel)))
        XCTAssertNil(BiometricLockScreen.message(for: la(.notInteractive)))
        XCTAssertNil(BiometricLockScreen.message(for: BiometricGate.GateError.userCancelled))
    }

    func test_lockScreenExplainsRealFailures() {
        XCTAssertEqual(
            BiometricLockScreen.message(for: la(.authenticationFailed)),
            "That didn't match. Try again."
        )
        XCTAssertEqual(
            BiometricLockScreen.message(for: la(.biometryLockout)),
            "Too many failed attempts. Unlock your device with its passcode, then try again."
        )
        XCTAssertTrue(BiometricLockScreen.message(for: BiometricGate.GateError.notAvailable)?
            .hasPrefix("No device screen lock is set up.") ?? false)
        XCTAssertEqual(
            BiometricLockScreen.message(for: NSError(domain: "x", code: 0)),
            "Unlock didn't work. Try again."
        )
    }
}
