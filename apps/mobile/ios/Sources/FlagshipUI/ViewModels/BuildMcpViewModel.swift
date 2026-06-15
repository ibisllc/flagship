import Foundation
import Observation
import FlagshipAPI

/// Backs the MCP build mode. The box hosts an MCP server scoped to one
/// build; the owner pastes the URL + a per-build bearer key into their IDE
/// (Cursor/Cline) and builds with their OWN AI — no model key on the box.
///
/// Surfaces the value-free env-request list the IDE accumulates (the IDE
/// never sees the value; the owner sets it on the box).
///
/// Mirrors the canonical webapp `views/build-mcp.js`.
@MainActor
@Observable
public final class BuildMcpViewModel {
    public private(set) var buildId: String?
    public private(set) var connection: BuildMcpConnection?
    public private(set) var envRequests: [BuildEnvRequest] = []
    public private(set) var isCreating = false
    public private(set) var isRotating = false
    public private(set) var isDeploying = false
    public private(set) var errorMessage: String?
    /// Non-nil once a deploy lands — the live URL.
    public private(set) var deployedUrl: String?

    private let client: any ScreensClient
    /// Stable label the rotate path reuses so the IDE config carries the
    /// same name across regenerations. Matches the webapp ("webapp"); iOS
    /// uses "ios".
    private let label = "ios"

    public init(client: any ScreensClient) {
        self.client = client
    }

    /// Pretty-printed IDE config JSON, ready to paste / copy.
    public var ideConfigJson: String {
        guard let conn = connection else { return "" }
        let obj = conn.ideConfig.mapValues { $0.value }
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let s = String(data: data, encoding: .utf8)
        else { return "" }
        return s
    }

    public func createConnection() async {
        errorMessage = nil
        isCreating = true
        defer { isCreating = false }
        do {
            let r = try await client.buildMcpCreate(BuildMcpRequest(label: label))
            buildId = r.buildId
            connection = r.connection
            await refreshEnvRequests()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    public func rotateKey() async {
        guard let buildId else { return }
        errorMessage = nil
        isRotating = true
        defer { isRotating = false }
        do {
            connection = try await client.buildMcpRotate(buildId: buildId, BuildMcpRequest(label: label))
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    public func refreshEnvRequests() async {
        guard let buildId else { return }
        do {
            envRequests = try await client.buildEnvRequests(buildId: buildId).requests
        } catch {
            // Best-effort: an env-requests fetch failure shouldn't blow up
            // the connection screen. Leave the existing list in place.
        }
    }

    public func deploy() async {
        guard let buildId else { return }
        errorMessage = nil
        isDeploying = true
        defer { isDeploying = false }
        do {
            let r = try await client.buildDeploy(buildId: buildId)
            deployedUrl = r.url
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }
}
