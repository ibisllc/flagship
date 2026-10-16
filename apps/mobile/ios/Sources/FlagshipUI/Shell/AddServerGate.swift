import SwiftUI
import Flagship
import FlagshipCore
import FlagshipAPI

/// Adding a server to the account (create one, co-manage someone's running
/// server, take over a box, import a backup) is for the account's admin
/// devices only (owner rule 2026-10-15; docs/service-access-gating.md
/// "Account members"): the device that holds the account's admin root. Every
/// account is opened with one, so an account never lacks an admin device. A
/// demo account's device stands in for its owner (it holds no keys; the
/// operator runs the account). Home's button, every link into those flows and
/// recipe minting all ask this one rule. Mirrors the webapp's
/// lib/addServerGate.js and Android's AddServerGate.
public enum AddServerGate {
    public static let adminOnlyMessage = AddServerRefusal.message

    public static func allows(holdsAdminRoot: Bool, isDemoAccount: Bool) -> Bool {
        holdsAdminRoot || isDemoAccount
    }

    @MainActor
    public static func allows(_ app: AppState) -> Bool {
        allows(holdsAdminRoot: Keystore.hasAdminRoot || GymSeams.forceAdminRoot, isDemoAccount: app.isDemoAccount)
    }

    /// The admin root a new server's recipe pins. Only opening the account
    /// mints one: a device without it is refused, never handed a fresh root
    /// the account's admins don't hold. A demo account pins none.
    public static func recipeAdminRootPin(adminRootPubHex: String?, isDemoAccount: Bool) throws -> String? {
        if let adminRootPubHex { return adminRootPubHex }
        if isDemoAccount { return nil }
        throw AddServerRefused()
    }
}

public struct AddServerRefused: LocalizedError, Equatable {
    public init() {}
    public var errorDescription: String? { AddServerGate.adminOnlyMessage }
}

/// Where a link or button into one of those flows lands on a device that
/// isn't an admin device of the account.
struct AddServerAdminOnlyScreen: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            VStack(spacing: FS.space.s3) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 36))
                    .foregroundColor(c.textMuted)
                Text("Admin devices only")
                    .font(FS.font.h3())
                    .foregroundColor(c.text)
                Text(AddServerGate.adminOnlyMessage)
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(FS.space.s6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("add-server-admin-only")
        }
    }
}
