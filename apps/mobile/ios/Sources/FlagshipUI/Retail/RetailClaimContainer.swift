import SwiftUI
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Builds the retail claim's live dependencies from the create flow: the recipe it mints, the
/// admin root for the key registration, `.com`'s directory and the pinned TLS session.
struct RetailClaimContainer: View {
    let minter: CreateServerViewModel
    let username: String
    let isDemoAccount: Bool
    let onClaimed: (_ serverDomain: String, _ serial: String) -> Void
    let onClose: () -> Void
    let onOpenServer: (String) -> Void
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    @State private var vm: RetailClaimViewModel?

    var body: some View {
        Group {
            if let vm {
                RetailClaimScreen(vm: vm, onClose: onClose, onOpenServer: onOpenServer)
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil { vm = RetailClaimViewModel(deps: deps()) }
        }
    }

    private func deps() -> RetailClaimDeps {
        let server = self.server, mailbox = self.mailbox, username = self.username, minter = self.minter
        let isDemo = isDemoAccount
        #if DEBUG
        let radio: any BoxClaimRadio = GymSweepSeams.retailRadio ?? CoreBluetoothClaimRadio()
        let gym = GymSweepSeams.retailRadio != nil
        #else
        let radio: any BoxClaimRadio = CoreBluetoothClaimRadio()
        let gym = false
        #endif
        var deps = RetailClaimDeps(
            username: username,
            radio: radio,
            mailboxLink: { MailboxClaimLink(client: server, mailboxId: $0) },
            mintRecipe: {
                do {
                    return try await minter.mintRecipeJSON()
                } catch is AddServerRefused {
                    throw RetailClaimKeyError.notAdmin
                }
            },
            registerKey: { key in
                let signer: Curve25519.Signing.PrivateKey
                if Keystore.hasAdminRoot {
                    signer = try await Keystore.adminRootKey(reason: String(localized: "Register your new box"))
                } else if isDemo {
                    signer = try await Keystore.deriveIRK(reason: String(localized: "Register your new box"))
                } else {
                    throw RetailClaimKeyError.notAdmin
                }
                let sig = try key.sign(with: signer)
                do {
                    try await server.registerBoxClaimKey(BoxClaimKeyRequest(
                        key: .init(username: key.username, serial: key.serial, serverDomain: key.serverDomain,
                                   stkPubHex: key.stkPubHex, issuedAt: key.issuedAt),
                        signature: HexUtil.encode(Data(sig))))
                } catch ScreensClientError.http(let status, let body) {
                    if status == 409 { throw RetailClaimKeyError.taken }
                    if status == 403, body.contains(AddServerRefusal.code) { throw RetailClaimKeyError.notAdmin }
                    throw ScreensClientError.http(status: status, message: body)
                }
            },
            pinStk: { domain, stk in BoxKeyPins.shared.repin(username: username, serverDomain: domain, stkHex: stk) },
            registeredStk: { domain in
                #if DEBUG
                if gym { return GymSweepSeams.retailComStk }
                #endif
                guard let r = try? await mailbox.fetchPods(username: username) else { return nil }
                CertPinRegistry.shared.update(pods: r.pods)
                return r.pods.first { $0.serverDomain.lowercased() == domain.lowercased() && $0.revokedAt == nil }?.identityPubKey.lowercased()
            },
            tlsCheck: { domain in
                if gym { return true }
                return await Self.pinnedTlsCheck(domain)
            },
            onClaimed: onClaimed,
            region: Locale.current.region?.identifier.count == 2 ? (Locale.current.region?.identifier ?? "") : ""
        )
        if gym {
            deps.pauseMs = { 2_000 }
            deps.pollMs = 500
        }
        return deps
    }

    /// Opens the box over the relay with the certificate pin its signed status gave: true when the
    /// handshake holds, false when the pin refused it, nil before the box has reported one.
    static func pinnedTlsCheck(_ domain: String) async -> Bool? {
        guard CertPinRegistry.shared.pinFor(host: domain) != nil, let url = URL(string: "https://\(domain)/") else { return nil }
        let session = BoxPinnedURLSession.make(pinFor: { CertPinRegistry.shared.pinFor(host: $0) })
        defer { session.finishTasksAndInvalidate() }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        do {
            _ = try await session.gatedData(for: req)
            return true
        } catch let e as URLError where e.code == .cancelled || e.code == .serverCertificateUntrusted {
            return false
        } catch {
            return nil
        }
    }
}
