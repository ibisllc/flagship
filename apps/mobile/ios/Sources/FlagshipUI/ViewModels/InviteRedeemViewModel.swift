import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Friend-side redeem orchestrator (docs/service-access-gating.md).
///
/// The owner shares `https://<server>.<user>/invite#<secret>`. The friend opens
/// it (deep-link → InviteRedeem screen); this VM:
///   1. AID-signs the redeem over { secretHash, visitorAID, redeemedAt } with
///      the friend's STABLE AID (UMK-derived, survives the friend's IRK
///      rotations), and POSTs the raw secret to the BOX's redeem endpoint,
///   2. the box re-verifies the AID sig, delegates the first-bind to `.com`,
///      then adds the friend's AID to the service's allow-list,
///   3. confirms — the friend now has access. The box also hands back a
///      `Flagship-App-Session` cookie so a later plain-browser visit works.
@Observable
@MainActor
public final class InviteRedeemViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case redeeming
        case done(serviceRef: String, firstBind: Bool)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let secretHex: String
    /// Friend's AID keypair provider (one biometric).
    private let aid: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        secretHex: String,
        aid: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.secretHex = secretHex.lowercased()
        self.now = now
        self.aid = aid ?? { reason in try await Keystore.deriveAccountId(reason: reason) }
    }

    public var serverHost: String { serverDomain }

    public func redeem() async {
        if case .redeeming = phase { return }
        guard secretHex.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            phase = .failed("This invite link is missing or malformed.")
            return
        }
        phase = .redeeming
        do {
            let key = try await aid("Accept this invite")
            let aidPub = key.publicKey.rawRepresentation
            guard let secret = HexUtil.decode(secretHex) else {
                phase = .failed("This invite link is malformed."); return
            }
            let secretHash = ServiceInvite.secretHash(secret: secret)
            let ts = now()
            let bytes = try ServiceInvite.canonicalRedeem(secretHash: secretHash, visitorAID: aidPub, redeemedAt: ts)
            let sig = try ServiceInvite.sign(bytes, with: key)
            let result = try await client.redeemInvite(
                serverDomain: serverDomain,
                secretHex: secretHex,
                visitorAidHex: HexUtil.encode(aidPub),
                aidSigHex: HexUtil.encode(sig),
                redeemedAt: ts)
            phase = .done(serviceRef: result.serviceRef, firstBind: result.firstBind)
        } catch ServiceAccessError.inviteUnknown {
            phase = .failed("This invite link is unknown or was withdrawn.")
        } catch ServiceAccessError.inviteAlreadyBound {
            phase = .failed("This invite is already linked to another account.")
        } catch ServiceAccessError.inviteRevoked {
            phase = .failed("This invite has been revoked.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
