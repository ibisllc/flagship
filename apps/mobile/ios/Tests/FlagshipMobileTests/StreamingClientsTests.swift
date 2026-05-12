import XCTest
@testable import FlagshipAPI

final class StreamingClientsTests: XCTestCase {

    func test_installEvents_emitsFullProvisioningSequence() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        var events: [InstallEvent] = []
        for await event in c.installEvents(serial: "TESTSERIAL") {
            events.append(event)
        }
        XCTAssertEqual(events.count, 5)
        if case .registered(let s, _) = events.first {
            XCTAssertEqual(s, "TESTSERIAL")
        } else { XCTFail("first event should be .registered") }
        guard case .ready(let fqdn, _) = events.last else {
            XCTFail("last event should be .ready"); return
        }
        XCTAssertEqual(fqdn, "newbox.harry.flagship.services")
    }

    func test_installEvents_stopsOnTaskCancel() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let stream = c.installEvents(serial: "X")
        let collector = Task {
            var got: [InstallEvent] = []
            for await e in stream {
                got.append(e)
                if got.count >= 2 { break }   // simulate consumer-side cancel
            }
            return got
        }
        let got = await collector.value
        XCTAssertEqual(got.count, 2)
    }

    func test_vibeCodeStream_emitsTokensBuildAndDeploy() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        var sawDeploy = false
        var sawDone = false
        var sawBuildStart = false
        for await frame in c.vibeCodeStream(sessionId: "vc-abc") {
            switch frame {
            case .buildStart:  sawBuildStart = true
            case .deploy:       sawDeploy = true
            case .done:          sawDone = true
            default: break
            }
        }
        XCTAssertTrue(sawBuildStart)
        XCTAssertTrue(sawDeploy)
        XCTAssertTrue(sawDone)
    }
}
