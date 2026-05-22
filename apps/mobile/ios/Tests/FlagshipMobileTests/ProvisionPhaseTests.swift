import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Provisioning observability on iOS.
///
/// Pins:
///   1. DemoServerBlock decodes the enriched Worker wire shape
///      (phase / phaseAt / lastError) — byte-identical to
///      packages/control-plane/src/demoUsers.ts `DemoServerBlock`.
///   2. ProvisionPhaseBridge.parse maps a `provision-phase` push
///      userInfo into a typed event, and ignores other categories.
@MainActor
final class ProvisionPhaseTests: XCTestCase {

    // MARK: - DemoServerBlock wire shape (enriched)

    func test_demoServerBlock_decodesPhaseFields_fromWorkerWire() throws {
        // Mirror of demoServerBlockFromRow's enriched output. Keep
        // byte-identical with the Worker.
        let json = #"""
        {
          "fqdn": "home.demoalice.flagship.services",
          "status": "provisioning",
          "ttlIdleMinutes": 30,
          "phase": "cert-issued",
          "phaseAt": 1700000000000,
          "lastError": null
        }
        """#
        let block = try JSONDecoder().decode(DemoServerBlock.self, from: Data(json.utf8))
        XCTAssertEqual(block.phase, "cert-issued")
        XCTAssertEqual(block.phaseAt, 1_700_000_000_000)
        XCTAssertNil(block.lastError)
        XCTAssertEqual(block.lifecycle, .provisioning)
    }

    func test_demoServerBlock_decodesFailedPhaseWithError() throws {
        let json = #"""
        {
          "fqdn": "home.demoalice.flagship.services",
          "status": "provisioning",
          "ttlIdleMinutes": 30,
          "phase": "failed",
          "phaseAt": 1700000000000,
          "lastError": "acme dns-01 timeout"
        }
        """#
        let block = try JSONDecoder().decode(DemoServerBlock.self, from: Data(json.utf8))
        XCTAssertEqual(block.phase, "failed")
        XCTAssertEqual(block.lastError, "acme dns-01 timeout")
    }

    func test_demoServerBlock_oldWireWithoutPhase_decodesToNil() throws {
        // Backward-compat: a pre-0035 Worker omits the phase fields. The
        // synthesized decoder must treat them as nil, not throw.
        let json = #"""
        {
          "fqdn": "home.demoalice.flagship.services",
          "status": "up",
          "ttlIdleMinutes": 30
        }
        """#
        let block = try JSONDecoder().decode(DemoServerBlock.self, from: Data(json.utf8))
        XCTAssertNil(block.phase)
        XCTAssertNil(block.phaseAt)
        XCTAssertNil(block.lastError)
        XCTAssertEqual(block.lifecycle, .up)
    }

    // MARK: - ProvisionPhaseBridge.parse

    func test_parse_provisionPhasePush() {
        let info: [AnyHashable: Any] = [
            "kind": "provision-phase",
            "username": "demoalice",
            "fqdn": "home.demoalice.flagship.services",
            "phase": "deps",
        ]
        let e = ProvisionPhaseBridge.parse(info)
        XCTAssertEqual(e?.phase, "deps")
        XCTAssertEqual(e?.username, "demoalice")
        XCTAssertEqual(e?.fqdn, "home.demoalice.flagship.services")
        XCTAssertNil(e?.error)
    }

    func test_parse_failedPhaseCarriesError() {
        let info: [AnyHashable: Any] = [
            "kind": "provision-phase",
            "username": "demoalice",
            "fqdn": "home.demoalice.flagship.services",
            "phase": "failed",
            "error": "tunnel never came online",
        ]
        let e = ProvisionPhaseBridge.parse(info)
        XCTAssertEqual(e?.phase, "failed")
        XCTAssertEqual(e?.error, "tunnel never came online")
    }

    func test_parse_emptyErrorBecomesNil() {
        let info: [AnyHashable: Any] = [
            "kind": "provision-phase",
            "phase": "ready",
            "error": "",
        ]
        XCTAssertNil(ProvisionPhaseBridge.parse(info)?.error)
    }

    func test_parse_ignoresOtherCategories() {
        XCTAssertNil(ProvisionPhaseBridge.parse(["kind": "unlock-approve", "requestId": "x"]))
        XCTAssertNil(ProvisionPhaseBridge.parse(["kind": "provision-phase"]))  // missing phase
        XCTAssertNil(ProvisionPhaseBridge.parse([:]))
    }

    func test_bridge_onPhaseFires() {
        var received: ProvisionPhaseEvent?
        ProvisionPhaseBridge.shared.onPhase = { received = $0 }
        defer { ProvisionPhaseBridge.shared.onPhase = nil }
        let e = ProvisionPhaseBridge.parse([
            "kind": "provision-phase",
            "username": "demoalice",
            "fqdn": "home.demoalice.flagship.services",
            "phase": "ready",
        ])!
        ProvisionPhaseBridge.shared.onPhase?(e)
        XCTAssertEqual(received?.phase, "ready")
    }
}
