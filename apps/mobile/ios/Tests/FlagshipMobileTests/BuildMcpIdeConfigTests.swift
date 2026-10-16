import XCTest
@testable import FlagshipUI
import FlagshipAPI

/// Connect your IDE: each IDE's own config from the box, the generic one
/// from an older box, and URLs that copy unescaped.
@MainActor
final class BuildMcpIdeConfigTests: XCTestCase {
    func test_perIdeConfigs_andTheCommand() async throws {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = BuildMcpViewModel(client: mock)
        await vm.createConnection()
        XCTAssertEqual(vm.ideChoices.map(\.id), ["claude-code", "cursor", "vscode", "cline"])
        XCTAssertEqual(vm.currentIde?.id, "claude-code")
        XCTAssertTrue(vm.ideCommand?.hasPrefix("claude mcp add --scope user --transport http flagship-") == true)
        XCTAssertTrue(vm.ideConfigJson.contains("https://"), vm.ideConfigJson)
        XCTAssertFalse(vm.ideConfigJson.contains("\\/"), vm.ideConfigJson)
        vm.selectedIde = "vscode"
        XCTAssertTrue(vm.ideConfigJson.contains("\"servers\""))
        XCTAssertNil(vm.ideCommand)
        vm.selectedIde = "cline"
        XCTAssertTrue(vm.ideConfigJson.contains("streamableHttp"))
        XCTAssertEqual(vm.currentIde?.where, "Cline → MCP Servers → Configure MCP Servers")
    }

    func test_olderBox_getsTheGenericConfig() async throws {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        mock.mockMcpLegacyConfig = true
        let vm = BuildMcpViewModel(client: mock)
        await vm.createConnection()
        XCTAssertEqual(vm.ideChoices.map(\.id), ["generic"])
        XCTAssertTrue(vm.ideConfigJson.contains("mcpServers"))
        XCTAssertNil(vm.ideCommand)
    }

    func test_decodesTheBoxWire() throws {
        let body = #"{"url":"https://a/mcp/build/b","key":"k","ideConfig":{"mcpServers":{}},"ideConfigs":[{"id":"cursor","name":"Cursor","where":"~/.cursor/mcp.json","config":{"mcpServers":{}}}]}"#
        let c = try JSONDecoder().decode(BuildMcpConnection.self, from: Data(body.utf8))
        XCTAssertEqual(c.ideConfigs?.first?.name, "Cursor")
        XCTAssertNil(c.ideConfigs?.first?.command)
        let old = try JSONDecoder().decode(BuildMcpConnection.self, from: Data(#"{"url":"u","key":"k","ideConfig":{}}"#.utf8))
        XCTAssertNil(old.ideConfigs)
    }
}
