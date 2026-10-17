#if DEBUG
import Foundation
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// Share seams for GymSweepShareTests.
    ///
    /// `-smoke-shares`: the second account's member keys are pinned, so a
    /// co-manager's orders on a shared server verify as the box checks them.
    /// `-smoke-share-flows`: the share screens run their real flows over
    /// GymShareTransport (signed orders, state that changes), instead of
    /// the screenshot fixtures.
    static func share(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        guard args.contains("-smoke-shares") else {
            ServerShareDemo.gymTransport = nil
            return
        }
        let shareIds = ServerShareDemo.entries().map(\.shareId) + [ServerShareDemo.invitation.shareId]
        // Start-up notices start off: a previous run's registration persists.
        for id in shareIds { SharePushRegistry().forget(id) }
        if let seed = GymSeams.accountRootSeed {
            for id in shareIds {
                if let k = try? ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: id) {
                    MockOrderSigners.shared.pinShareKey(k.publicKey, shareId: id)
                }
            }
        }
        ServerShareDemo.gymTransport = args.contains("-smoke-share-flows")
            ? GymShareTransport(ownerDomains: app.pods.map(\.fqdn))
            : nil
    }
}
#endif
