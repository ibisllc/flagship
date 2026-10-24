#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The serial the gym's recipe for Home carries.
    static let firstContactSerial = "GYMFIRSTCONTACT1"

    /// Every launch starts with no pins, no kept secrets and no grants; grants go to the mock box.
    static func firstContactReset(_ mocks: GymMocks) {
        ServerKeyPins().clear()
        ServerWildcardGrantKeeper.shared.clear()
        KeychainFirstContactSecrets.gymOverride = InMemoryFirstContactSecrets()
        StudioSeenStore.shared.clear()
        FirstContactUpkeep.install(clients: .shared(mocks.screens))
    }

    /// First contact seams (docs/first-contact.md), on top of `-smoke-approval-pending` (Home asks to
    /// serve, signed by its gym STK):
    /// - `-smoke-fc-recipe`: this device made Home's recipe and the request carries a valid proof.
    /// - `-smoke-fc-bad-proof`: this device made the recipe but the proof is wrong.
    /// - `-smoke-fc-key-changed`: this device pinned another key for Home.
    /// - `-smoke-fc-studio`: Studio reported Home's key from its console (with `-smoke-fc-recipe`).
    static func firstContact(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        guard let pending = mocks.mailbox.pending.first else { return }
        let domain = pending.serverDomain
        let secrets = KeychainFirstContactSecrets()
        if args.contains("-smoke-fc-recipe") || args.contains("-smoke-fc-bad-proof") {
            let secret = Data(repeating: 0x11, count: 32)
            let confirm = Data(repeating: 0x22, count: 32)
            secrets.save(FirstContactSecret(enrollmentKeyHex: HexUtil.encode(secret), authCodeSerial: firstContactSerial,
                                            studioConfirmKeyHex: HexUtil.encode(confirm)), for: domain)
            let proofKey = args.contains("-smoke-fc-bad-proof") ? Data(repeating: 0x33, count: 32) : secret
            let proof = Enrollment.proofHex(secret: proofKey, serverDomain: domain, stkPubHex: pending.stkPub.lowercased(),
                                            authCodeSerial: firstContactSerial)
            let info = pending.deviceInfo
            mocks.mailbox.pending = [PendingSecretRequest(
                serverDomain: pending.serverDomain, requestNonceHex: pending.requestNonceHex, stkPub: pending.stkPub,
                purpose: pending.purpose, issuedAt: pending.issuedAt, requestSignature: pending.requestSignature,
                deviceInfo: DeviceInfoHint(ip: info?.ip, region: info?.region, os: info?.os, hostname: info?.hostname,
                                           enrollmentProof: proof),
                postedAt: pending.postedAt, expiresAt: pending.expiresAt)]
            if args.contains("-smoke-fc-studio"),
               let mac = FirstContact.studioSeenMacHex(key: confirm, serverDomain: domain, stkPubHex: pending.stkPub) {
                StudioSeenStore.shared.record(serverDomain: domain, stkPubHex: pending.stkPub, macHex: mac)
            }
        }
        if args.contains("-smoke-fc-key-changed") {
            ServerKeyPins().pin(Data(repeating: 0x44, count: 32), for: domain)
        }
    }
}
#endif
