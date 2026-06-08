import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Provisioning observability on iOS.
///
/// Pins:
///   1. DemoServerBlock decodes the Worker wire shape (canonical
///      `phase` / phaseAt / lastError) — byte-identical to
///      packages/control-plane/src/demoUsers.ts `DemoServerBlock`.
///   2. ProvisionPhaseBridge.parse maps a canonical `provision-status`
///      push payload (design §2.3) into a typed event reading
///      `meta.phase` as a `ProvisionStatusPhase`, and ignores other
///      categories. (Cross-language contract point 3 — the same payload
///      Android `ProvisionPhasePush.parse` + the webapp SW parse.)
@MainActor
final class ProvisionPhaseTests: XCTestCase {

    // MARK: - DemoServerBlock wire shape (canonical phase)

    func test_demoServerBlock_decodesPhaseFields_fromWorkerWire() throws {
        // Mirror of demoServerBlockFromRow's output — canonical phase.
        let json = #"""
        {
          "fqdn": "home.demoalice.flagship.services",
          "status": "provisioning",
          "ttlIdleMinutes": 30,
          "phase": "sealing",
          "phaseAt": 1700000000000,
          "lastError": null
        }
        """#
        let block = try JSONDecoder().decode(DemoServerBlock.self, from: Data(json.utf8))
        XCTAssertEqual(block.phase, "sealing")
        XCTAssertEqual(block.phaseAt, 1_700_000_000_000)
        XCTAssertNil(block.lastError)
        XCTAssertEqual(block.lifecycle, .provisioning)
    }

    func test_demoServerBlock_decodesErrorPhaseWithError() throws {
        let json = #"""
        {
          "fqdn": "home.demoalice.flagship.services",
          "status": "provisioning",
          "ttlIdleMinutes": 30,
          "phase": "error",
          "phaseAt": 1700000000000,
          "lastError": "acme dns-01 timeout"
        }
        """#
        let block = try JSONDecoder().decode(DemoServerBlock.self, from: Data(json.utf8))
        XCTAssertEqual(block.phase, "error")
        XCTAssertEqual(block.lastError, "acme dns-01 timeout")
    }

    func test_demoServerBlock_oldWireWithoutPhase_decodesToNil() throws {
        // Backward-compat: a row without the phase fields. The synthesized
        // decoder must treat them as nil, not throw.
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

    // MARK: - ProvisionPhaseBridge.parse (canonical provision-status payload)

    /// The canonical payload (design §2.3) with a nested `meta` block —
    /// the Web-Push (RFC 8291) shape the SW unwraps. Byte-shape-identical
    /// to what the webapp SW + Android ProvisionPhasePush parse.
    private func canonicalPush(phase: String, serial: String = "01CAFE", detail: String? = nil) -> [AnyHashable: Any] {
        var meta: [AnyHashable: Any] = [
            "kind": "provision-status",
            "serial": serial,
            "phase": phase,
        ]
        if let detail { meta["detail"] = detail }
        return [
            "category": "provision-status",
            "title": "title",
            "body": "body",
            "deepLink": "flagship://install-progress",
            "meta": meta,
        ]
    }

    func test_parse_canonicalProvisionStatusPush_nestedMeta() {
        let e = ProvisionPhaseBridge.parse(canonicalPush(phase: "registering", serial: "01CAFE"))
        XCTAssertEqual(e?.phase, .registering)
        XCTAssertEqual(e?.serial, "01CAFE")
        XCTAssertNil(e?.detail)
    }

    func test_parse_flattenedSealedShape() {
        // APNs/FCM sealed-payload pushes surface the discrete fields at the
        // top level of userInfo (no nested `meta`).
        let info: [AnyHashable: Any] = [
            "kind": "provision-status",
            "serial": "AC-DEAD",
            "phase": "sealing",
        ]
        let e = ProvisionPhaseBridge.parse(info)
        XCTAssertEqual(e?.phase, .sealing)
        XCTAssertEqual(e?.serial, "AC-DEAD")
    }

    func test_parse_errorPhaseCarriesDetail() {
        let e = ProvisionPhaseBridge.parse(canonicalPush(phase: "error", detail: "tunnel never came online"))
        XCTAssertEqual(e?.phase, .error)
        XCTAssertEqual(e?.detail, "tunnel never came online")
    }

    func test_parse_emptyDetailBecomesNil() {
        let e = ProvisionPhaseBridge.parse(canonicalPush(phase: "live", detail: ""))
        XCTAssertEqual(e?.phase, .live)
        XCTAssertNil(e?.detail)
    }

    func test_parse_ignoresOtherCategories() {
        XCTAssertNil(ProvisionPhaseBridge.parse(["kind": "unlock-approve", "requestId": "x"]))
        XCTAssertNil(ProvisionPhaseBridge.parse(["category": "provision-status"]))  // missing phase
        XCTAssertNil(ProvisionPhaseBridge.parse([:]))
    }

    func test_parse_unknownPhaseStringIsRejected() {
        // A phase the binary doesn't know about decodes via ProvisionStatusPhase
        // initializer; an entirely unparseable string yields nil here.
        XCTAssertNil(ProvisionPhaseBridge.parse(canonicalPush(phase: "")))
    }

    func test_bridge_onPhaseFires() {
        var received: ProvisionPhaseEvent?
        ProvisionPhaseBridge.shared.onPhase = { received = $0 }
        defer { ProvisionPhaseBridge.shared.onPhase = nil }
        let e = ProvisionPhaseBridge.parse(canonicalPush(phase: "live", serial: "01CAFE"))!
        ProvisionPhaseBridge.shared.onPhase?(e)
        XCTAssertEqual(received?.phase, .live)
        XCTAssertEqual(received?.serial, "01CAFE")
    }
}
