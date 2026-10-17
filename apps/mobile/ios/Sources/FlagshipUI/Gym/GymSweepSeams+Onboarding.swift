#if DEBUG
import Foundation
import CryptoKit
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// A friend's box and app the smoke account was invited to.
    public static let gymFriendServer = "home.trent.flagship.services"
    public static let gymFriendApp = "trent--scratchpad"

    nonisolated(unsafe) private static var visitorOwnersCleared = false

    /// Deep-link seams for GymSweepOnboardingTests (`-smoke-mode`).
    ///
    /// `-smoke-visitor`: the mock box names the keys a visitor may sign
    /// with (the per-app ids, the account id, this device's account key) and
    /// checks each redeem / acceptance / knock signature, so the probe says
    /// which key signed. Clears remembered invite owners first, so a knock
    /// on the friend's box knows its owner only from this run's redeem.
    /// `-smoke-invite-manual`: the redeem needs the owner's approval.
    static func onboarding(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        guard args.contains("-smoke-visitor"), let seed = GymSeams.accountRootSeed else { return }
        // Once per launch: the shell's onAppear runs this again when a cover
        // closes, which would forget the owner the redeem just remembered.
        if !visitorOwnersCleared {
            UserDefaults.standard.removeObject(forKey: "flagship.inviteOwners.v1")
            visitorOwnersCleared = true
        }
        var labels: [String: String] = [:]
        for ref in [gymFriendApp, "bright-maple--plants"] {
            if let pub = ServiceInvite.deriveAppAccountIdPub(umkSeed: seed, appRef: ref) {
                labels[HexUtil.encode(pub)] = "the per-app id for \(ref)"
            }
        }
        if let aid = ServiceInvite.deriveAccountIdPub(umkSeed: seed) {
            labels[HexUtil.encode(aid)] = "the account id"
        }
        if let user = app.currentUser?.lowercased(), let deviceId = app.activeProfile?.deviceId,
           let key = try? AccountMetadata.deriveAccountDeviceKey(umk: seed, accountId: user, deviceId: deviceId) {
            labels[HexUtil.encode(key.publicKey.rawRepresentation)] = "this device's account key"
        }
        mocks.access.visitorLabels = labels
        mocks.access.verifyVisitorSignature = { kind, f, sigHex in
            guard let sig = HexUtil.decode(sigHex) else { return false }
            func bytes(_ k: String) -> Data? { (f[k] as? String).flatMap(HexUtil.decode) }
            func int(_ k: String) -> Int64? {
                switch f[k] {
                case let i as Int64: return i
                case let i as Int: return Int64(i)
                case let n as NSNumber: return n.int64Value
                default: return nil
                }
            }
            let keyField = kind == "accept" ? "contactAID" : "visitorAID"
            guard let pubRaw = bytes(keyField), let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: pubRaw)
            else { return false }
            let msg: Data?
            switch kind {
            case "redeem":
                guard let secret = bytes("secretHex"), let at = int("redeemedAt") else { return false }
                msg = try? ServiceInvite.canonicalRedeem(secretHash: ServiceInvite.secretHash(secret: secret),
                                                         visitorAID: pubRaw, redeemedAt: at)
            case "accept":
                guard let iid = f["inviteId"] as? String, let ref = f["serviceRef"] as? String,
                      let at = int("acceptedAt") else { return false }
                msg = try? ServiceInvite.canonicalAccept(inviteId: iid, serviceRef: ref, contactAID: pubRaw, acceptedAt: at)
            case "knock":
                guard let server = f["serverId"] as? String, let ref = f["serviceRef"] as? String,
                      let page = f["pageId"] as? String, let at = int("issuedAt") else { return false }
                msg = try? ServiceInvite.canonicalKnock(serverId: server, serviceRef: ref, pageId: page,
                                                        visitorAID: pubRaw, issuedAt: at)
            default:
                msg = nil
            }
            guard let msg else { return false }
            return pub.isValidSignature(sig, for: msg)
        }
        mocks.access.redeemResult = RedeemResult(serviceRef: gymFriendApp, boundAidHex: "00", firstBind: true,
                                                 pending: args.contains("-smoke-invite-manual"))
        mocks.access.acceptResult = AcceptResult(bound: true, serviceRef: gymFriendApp, boundAidHex: "00")
    }

    /// Accounts the mock `.com` already holds, for Join → sign in.
    public static let gymRecoverableAccount = "sole-maple"
    public static let gymMultiDeviceAccount = "many-maple"
    public static let gymNoBackupAccount = "bare-maple"

    /// `-smoke-onboarding` seams (no `-smoke-mode`: the app starts unpaired).
    /// Always: three existing accounts on the mock `.com` (one device with a
    /// cloud backup, several devices with one, none). `-smoke-join-bundle`:
    /// the pairing relay holds an admin bundle this device can't open (a
    /// mismatched pairing), so Join reaches the code and fails after it.
    public static func applyOnboarding(args: [String], mocks: GymMocks) {
        guard args.contains("-smoke-onboarding"), let server = mocks.server else { return }
        let irk = String(repeating: "11", count: 32)
        server.seedClaimedUsername(gymRecoverableAccount, irkPubHex: irk)
        server.cloudRecoveryByUser[gymRecoverableAccount] = true
        server.seedClaimedUsername(gymMultiDeviceAccount, irkPubHex: irk)
        server.accountTypeByUser[gymMultiDeviceAccount] = "multi"
        server.cloudRecoveryByUser[gymMultiDeviceAccount] = true
        server.seedClaimedUsername(gymNoBackupAccount, irkPubHex: irk)
        if args.contains("-smoke-join-bundle"), let relay = mocks.pairingRelay {
            Task {
                try? await relay.adminDeliverBundle(sid: "gym", ciphertextBase64Url: "AAAAAAAAAAAAAAAAAAAAAA",
                                                    nonceBase64Url: "AAAAAAAAAAAAAAAA")
            }
        }
    }
}
#endif
