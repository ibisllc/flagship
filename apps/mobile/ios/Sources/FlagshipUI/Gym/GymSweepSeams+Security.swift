#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The chat requests `-smoke-chat-requests` seeds on the mock box: one incoming from another owner's
    /// app, and one of this account's apps asking to reach another owner's.
    public static let chatIncoming = ChatRequest(
        requestId: "gym-chat-in", kind: "incoming",
        claimedSender: ChatAppIdentity(author: "ana", slug: "chess"),
        receiverApp: ChatAppIdentity(author: "bright-maple", slug: "plants"),
        phrase: "Weekly game?", count: 2, at: 1)
    public static let chatOutgoing = ChatRequest(
        requestId: "gym-chat-out", kind: "outgoing",
        claimedSender: ChatAppIdentity(author: "bright-maple", slug: "wiki"),
        receiverApp: ChatAppIdentity(author: "ana", slug: "notes"),
        count: 1, at: 2)

    /// Release 0.3's client screens: app chat approvals, AI-run consent, the watch's boot key.
    static func security(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        if args.contains("-smoke-chat-requests") {
            mocks.screens.mockChatRequests = [chatIncoming, chatOutgoing]
        }
        if args.contains("-smoke-chat-always") {
            mocks.screens.mockChatAlways = [ChatAlwaysAllow(receiverApp: ChatAppIdentity(author: "bright-maple", slug: "board"),
                                                            claimedSender: ChatAppIdentity(author: "ana", slug: "chess"))]
        }
        if args.contains("-smoke-ai-consent") {
            mocks.screens.buildAdaptConsentEstimate = AiCostEstimate(
                provider: "openai", source: "byok", operation: "adapt", lowTokens: 12_000, highTokens: 72_000)
        }
        // The watch's boot key: every launch starts with no copies and no delegate on this device.
        WatchBootKeyStore().clear()
        Keystore.clearWatchDelegate()
        if args.contains("-smoke-watch-delegate") {
            _ = try? Keystore.loadOrCreateWatchDelegateKey()
            _ = try? Keystore.loadOrCreateWatchBootKey()
            WatchBootKeyStore().delegateExpiresAt = Int64(Date().timeIntervalSince1970 * 1000) + WatchBootDelegate.maxMs
            // The server's disk key, sealed for the account key as the installer leaves it.
            if let irk = Keystore.gymIRK(),
               let sealed = try? SecretSeal.sealForEd25519Recipient(plaintext: Data(repeating: 0x5a, count: 32),
                                                                    recipientEd25519Pub: irk.publicKey.rawRepresentation) {
                mocks.mailbox.sealedLuksKeyHex = HexUtil.encode(sealed)
            }
        }
    }
}
#endif
