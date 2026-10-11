import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

final class EditServiceTests: XCTestCase {
    func testTheBoxsRefusalsBecomeTheRightPrompt() {
        let open = ScreensClientError.http(status: 409, message: #"{"ok":false,"kind":"session","sessionId":"s1","error":"x"}"#)
        XCTAssertEqual(EditStartRefusal.from(open), .sessionOpen)
        let big = ScreensClientError.http(status: 413, message: #"{"error":"\"notes\" is too big to change in the AI chat. Connect your IDE to change it instead."}"#)
        XCTAssertEqual(EditStartRefusal.from(big), .tooBig("\"notes\" is too big to change in the AI chat. Connect your IDE to change it instead."))
        let gone = ScreensClientError.http(status: 404, message: #"{"error":"That service isn't installed."}"#)
        XCTAssertEqual(EditStartRefusal.from(gone), .other("That service isn't installed."))
        XCTAssertTrue(EditStartRefusal.sessionOpen.message(name: "notes").contains("discard it there"))
    }

    @MainActor
    func testAnIDEEditAsksTheBoxToStartFromTheService() async {
        let mock = MockScreensClient()
        let vm = BuildMcpViewModel(client: mock, editServiceId: "alice--notes")
        XCTAssertEqual(vm.editingName, "notes")
        await vm.createConnection()
        XCTAssertEqual(mock.buildMcpCreateCalls.last?.editServiceId, "alice--notes")
        XCTAssertNil(BuildMcpViewModel(client: mock).editingName)
    }

    func testAppDetailSaysWhetherItCanBeEdited() throws {
        let body = #"{"app":{"serviceId":"alice--notes","creator":"alice","slug":"notes","urlLabel":"notes","version":"0.1.0","status":"running","url":"https://notes","installedAt":0},"manifest":{},"dataLayerInstances":[],"members":[],"browserTabs":[],"recentLogs":[],"editable":true}"#
        let d = try JSONDecoder().decode(AppDetailResponse.self, from: Data(body.utf8))
        XCTAssertEqual(d.editable, true)
        let old = try JSONDecoder().decode(AppDetailResponse.self, from: Data(body.replacingOccurrences(of: #","editable":true"#, with: "").utf8))
        XCTAssertNil(old.editable)
    }
}
