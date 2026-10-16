import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// The keys the Access control screen signs with. Production leaves this nil
/// (the Keystore asks for Face ID); the gym's smoke fixture injects fixed keys.
public struct ServiceAccessKeys: Sendable {
    public let authorAidKeys: @MainActor @Sendable (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data)
    /// Stands in for the admin root (every admin-only order).
    public let adminSigner: @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    public let isAdminDevice: Bool
    public let deviceId: String?
    /// Stands in for this device's account device key.
    public let deviceKey: Curve25519.Signing.PrivateKey?
    public let deviceNames: [String: String]?

    public init(
        authorAidKeys: @escaping @MainActor @Sendable (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data),
        adminSigner: @escaping @MainActor @Sendable (String) async throws -> Curve25519.Signing.PrivateKey,
        isAdminDevice: Bool = true,
        deviceId: String? = nil,
        deviceKey: Curve25519.Signing.PrivateKey? = nil,
        deviceNames: [String: String]? = nil
    ) {
        self.authorAidKeys = authorAidKeys
        self.adminSigner = adminSigner
        self.isAdminDevice = isAdminDevice
        self.deviceId = deviceId
        self.deviceKey = deviceKey
        self.deviceNames = deviceNames
    }

    public var deviceSigner: AppAccessSigner? {
        guard let deviceKey else { return nil }
        return { _ in deviceKey }
    }

    public var ownDeviceKey: (@MainActor () -> Curve25519.Signing.PrivateKey?)? {
        guard let deviceKey else { return nil }
        return { deviceKey }
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
/// apps, so Access control renders the account's devices, a co-manager,
/// people, a group and their ranks without a keystore or a box.
///
/// Account members: this device (an admin device at Master, or with
/// `nonAdmin` a non-admin one at Manager, or with `memberRank` one an admin
/// set to Member), the admin's iPad (Master), a device the directory doesn't
/// name that an admin refused, and Mum's account co-managing the server.
/// Invited: Sam from this device (member tier), Priya from the iPad, Family
/// from the unnamed device, and Jordan before invites recorded who made them.
public enum ServiceAccessFixture {
    public static let thisDeviceId = String(repeating: "d0", count: 16)
    public static let ipadDeviceId = String(repeating: "1a", count: 16)
    public static let unnamedDeviceId = String(repeating: "2b", count: 16)
    public static let mumShareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

    /// The Pro switch for a separate access list on each server: `free` (off,
    /// locked), `pro` (off, can turn on) or `separate` (on, with the Home and
    /// Office servers in the picker, and the plan screen's warning).
    public static func seedListScope(_ kind: String, screens: MockScreensClient, serviceIds: [String], username: String) {
        let home = "home.\(username).flagship.services"
        let office = "office.\(username).flagship.services"
        let pro = kind != "free"
        let separate = kind == "separate"
        for ref in serviceIds {
            screens.mockListScope[ref] = AppListScopeState(
                serviceRef: ref, scope: separate ? "server" : "account", plan: pro ? "pro" : "free",
                selfFqdn: home, leader: home, servers: [home, office])
        }
        screens.mockAccessListsSummary = AccessListsSummary(
            plan: pro ? "pro" : "free", separateApps: separate ? 1 : 0, leaders: separate ? [home] : [])
    }

    static func key(_ b: UInt8) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }

    static func pub(_ k: Curve25519.Signing.PrivateKey) -> String { HexUtil.encode(k.publicKey.rawRepresentation) }

    public static func seed(access: MockServiceAccessClient, screens: MockScreensClient,
                            serviceIds: [String], nonAdmin: Bool = false, memberRank: Bool = false,
                            listScope: String? = nil, username: String = "bright-maple") -> ServiceAccessKeys {
        if let listScope { seedListScope(listScope, screens: screens, serviceIds: serviceIds, username: username) }
        let aid = key(5)
        let admin = key(9)
        let device = key(0xd0)
        let household = Data(repeating: 0x33, count: 32)
        let sam = String(repeating: "5a", count: 32)
        let priya = String(repeating: "7b", count: 32)
        let guest = String(repeating: "3c", count: 32)
        let isAdmin = !(nonAdmin || memberRank)
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
                accountMembers: [
                    .device(id: thisDeviceId, pub: pub(device), admin: isAdmin,
                            rank: memberRank ? "member" : (isAdmin ? "master" : "manager"), set: memberRank),
                    .device(id: ipadDeviceId, pub: pub(key(0x1a)), admin: true, rank: "master"),
                    .device(id: unnamedDeviceId, pub: pub(key(0x2b)), admin: false, rank: nil, set: true, refused: true),
                    .coManager(shareId: mumShareId, label: "Mum", rank: "manager"),
                ],
                members: [
                    AppMember(aid: sam, role: "manager", grants: [AppMemberGrant(inviteId: id("sam"), role: "manager"),
                                                               AppMemberGrant(inviteId: id("family"), role: "member")]),
                    AppMember(aid: priya, role: "master", grants: [AppMemberGrant(inviteId: id("priya"), role: "master")]),
                    AppMember(aid: guest, role: "member", grants: [AppMemberGrant(inviteId: id("family"), role: "member")]),
                ],
                invites: [
                    AppMemberInviteRole(inviteId: id("sam"), role: "manager", set: false, tier: "member",
                                        creatorPub: pub(device), creatorDeviceId: thisDeviceId),
                    AppMemberInviteRole(inviteId: id("priya"), role: "master", set: true, tier: "admin",
                                        creatorPub: pub(admin), creatorDeviceId: ipadDeviceId),
                    AppMemberInviteRole(inviteId: id("family"), role: "member", set: true, tier: "admin",
                                        creatorPub: pub(admin), creatorDeviceId: unnamedDeviceId),
                    AppMemberInviteRole(inviteId: id("jordan"), role: "member", set: true),
                ])
        }
        access.rows = rows
        access.state = ServiceAccessState(mode: "open", allowCount: 3)
        return ServiceAccessKeys(
            authorAidKeys: { _ in (aid, household) },
            adminSigner: { _ in admin },
            isAdminDevice: isAdmin,
            deviceId: thisDeviceId,
            deviceKey: device,
            deviceNames: [ipadDeviceId: "Harry's iPad", thisDeviceId: "Harry's iPhone"])
    }
}
