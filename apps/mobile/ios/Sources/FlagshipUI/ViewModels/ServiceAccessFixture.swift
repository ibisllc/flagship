import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// The keys the Access control screen signs with. Production leaves this nil
/// (the Keystore asks for Face ID); the gym's smoke fixture injects fixed keys.
public struct ServiceAccessKeys: Sendable {
    public let authorAidKeys: @MainActor @Sendable (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data)
    public let irkSigner: @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    public let roleSigner: @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    public let isAdminDevice: Bool
    public let deviceId: String?
    public let deviceNames: [String: String]?

    public init(
        authorAidKeys: @escaping @MainActor @Sendable (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data),
        irkSigner: @escaping @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey,
        roleSigner: @escaping @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey,
        isAdminDevice: Bool = true,
        deviceId: String? = nil,
        deviceNames: [String: String]? = nil
    ) {
        self.authorAidKeys = authorAidKeys
        self.irkSigner = irkSigner
        self.roleSigner = roleSigner
        self.isAdminDevice = isAdminDevice
        self.deviceId = deviceId
        self.deviceNames = deviceNames
    }
}

private struct ServiceAccessKeysKey: EnvironmentKey {
    static let defaultValue: ServiceAccessKeys? = nil
}

public extension EnvironmentValues {
    var serviceAccessKeys: ServiceAccessKeys? {
        get { self[ServiceAccessKeysKey.self] }
        set { self[ServiceAccessKeysKey.self] = newValue }
    }
}

/// Gym-only (`-smoke-mode -smoke-access-fixture`): a members list for the demo
/// apps, so Access control renders people, a group and their ranks without a
/// keystore or a box. Sam was invited from this device (member tier), Priya
/// from the admin's iPad, Family from a device the directory doesn't name,
/// and Jordan before invites recorded who made them. `nonAdmin` plays a
/// device without the admin root (`-smoke-non-admin-device`).
public enum ServiceAccessFixture {
    public static let thisDeviceId = String(repeating: "d0", count: 16)
    public static let ipadDeviceId = String(repeating: "1a", count: 16)
    public static let unnamedDeviceId = String(repeating: "2b", count: 16)

    public static func seed(access: MockServiceAccessClient, screens: MockScreensClient,
                            serviceIds: [String], nonAdmin: Bool = false) -> ServiceAccessKeys {
        let aid = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
        let irk = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
        let household = Data(repeating: 0x33, count: 32)
        let sam = String(repeating: "5a", count: 32)
        let priya = String(repeating: "7b", count: 32)
        let guest = String(repeating: "3c", count: 32)
        var rows: [ServiceInviteRow] = []
        for ref in serviceIds {
            func row(_ id: String, _ name: String, bound: String?, group: [String] = [], max: Int? = nil,
                     manual: Bool = false, by: (tier: String, device: String)? = nil) -> ServiceInviteRow {
                let inviteId = "\(id)-\(ref)"
                let sealed = (try? ServiceInvite.sealBundle(ServiceInvite.Bundle(name: name, photo: nil),
                                                           householdKey: household, inviteId: inviteId)) ?? ""
                return ServiceInviteRow(inviteId: inviteId, serviceRef: ref, encryptedBundleHex: sealed,
                                        boundAidHex: bound, boundAt: bound == nil ? nil : 1, createdAt: 1, revokedAt: nil,
                                        boundAidsHex: group, maxRedemptions: max, redemptions: max == nil ? nil : group.count,
                                        approvalMode: manual ? "manual" : nil,
                                        creatorTier: by?.tier, creatorDeviceId: by?.device)
            }
            rows += [
                row("sam", "Sam", bound: sam, by: ("member", thisDeviceId)),
                row("priya", "Priya", bound: priya, manual: true, by: ("admin", ipadDeviceId)),
                row("family", "Family", bound: nil, group: [sam, guest], max: 5, by: ("admin", unnamedDeviceId)),
                row("jordan", "Jordan", bound: nil),
            ]
            let id = { (s: String) in "\(s)-\(ref)" }
            screens.mockMembers[ref] = AppMembersResponse(
                serviceId: ref, mode: "open", defaultRole: "member",
                descriptions: ["member": "Adds and edits their own plants",
                               "manager": "Also waters and edits anyone's plants",
                               "master": "Also changes the garden's settings"],
                members: [
                    AppMember(aid: sam, role: "manager", grants: [AppMemberGrant(inviteId: id("sam"), role: "manager"),
                                                               AppMemberGrant(inviteId: id("family"), role: "member")]),
                    AppMember(aid: priya, role: "master", grants: [AppMemberGrant(inviteId: id("priya"), role: "master")]),
                    AppMember(aid: guest, role: "member", grants: [AppMemberGrant(inviteId: id("family"), role: "member")]),
                ],
                invites: [
                    AppMemberInviteRole(inviteId: id("sam"), role: "manager", set: false),
                    AppMemberInviteRole(inviteId: id("priya"), role: "master", set: true),
                    AppMemberInviteRole(inviteId: id("family"), role: "member", set: true),
                    AppMemberInviteRole(inviteId: id("jordan"), role: "member", set: true),
                ])
        }
        access.rows = rows
        access.state = ServiceAccessState(mode: "open", allowCount: 3)
        return ServiceAccessKeys(
            authorAidKeys: { _ in (aid, household) },
            irkSigner: { _ in irk },
            roleSigner: { _ in irk },
            isAdminDevice: !nonAdmin,
            deviceId: thisDeviceId,
            deviceNames: [ipadDeviceId: "Harry's iPad", thisDeviceId: "Harry's iPhone"])
    }
}
