import Foundation
import Observation
import FlagshipAPI

/// The data behind an app's "Access & permissions" section. A box without the page shows nothing.
@MainActor
@Observable
public final class ServicePermissionsController {
    public private(set) var permissions: ServicePermissions?
    public private(set) var notice: String?
    public private(set) var error: String?
    public private(set) var busy = false

    private let serviceId: String
    private let client: any ScreensClient

    public init(serviceId: String, client: any ScreensClient) {
        self.serviceId = serviceId
        self.client = client
    }

    public var isHidden: Bool { permissions == nil }

    public func load() async {
        do {
            permissions = try await client.servicePermissions(serviceId: serviceId)
        } catch {
            permissions = nil
        }
    }

    /// Ends one grant, or all of this app's grants when `grantId` is nil.
    public func revoke(grantId: String?) async {
        busy = true
        defer { busy = false }
        do {
            let r = try await client.revokeServicePermission(serviceId: serviceId, grantId: grantId)
            notice = PermissionWords.outcome(r)
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }
}
