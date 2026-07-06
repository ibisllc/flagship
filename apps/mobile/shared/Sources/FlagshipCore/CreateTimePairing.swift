import Foundation
import CryptoKit
import FlagshipAPI

/// Builds the CREATE-TIME pairing ORDER — the phone's half of pairing the
/// creating device with a server, in the SECRET-FREE recipe.
///
/// The first recipe carries ZERO pairing secrets: no pairing keypair, no
/// `pairingKeyPrivHex`. At create time the phone (which already holds the owner
/// IRK from the single create-server biometric) signs an `add-paired-session`
/// order and serializes it to the plaintext `pairingOrder` envelope JSON. The
/// `token` is the box's accepted paired-session token — persist it locally. The
/// caller then routes the JSON by mode:
///   - OFFLINE (embed-secrets ON):  EMBED it as the recipe's unsigned
///     `pairingOrder` sibling; the box verifies the owner-IRK order at boot and
///     adds the session LOCALLY with no `.com` call.
///   - DEFAULT (online):  STASH it; once the box registers (carrying its identity
///     pub in `/pods`), `SwkDepositCoordinator` SEALS it to that identity and
///     deposits it on `.com`'s blind pairing-deposit lane — sealing is a
///     public-key op, no second biometric.
///
/// The order's canonical bytes + the envelope JSON are byte-identical to the
/// pinned cross-platform vector (`packages/protocol/tests/pairingOrder.test.ts`).
public enum CreateTimePairing {
    public struct Built: Sendable {
        /// The plaintext `{request, signature}` JSON (PairingOrderEnvelope shape)
        /// to embed (offline) or stash + seal-deposit (default online).
        public let pairingOrderJson: String
        /// The paired-session token the box will accept — persist it locally so
        /// the BFF authenticates the moment the box claims the order.
        public let token: String
    }

    /// Build the order JSON + token. Randomness is injectable so tests are
    /// deterministic; production calls pass nothing.
    public static func build(
        username: String,
        serverDomain: String,
        label: String,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        token: String = AddPairedSessionOrder.freshToken()
    ) throws -> Built {
        // The label is committed to the order's canonical bytes, which the
        // daemon re-derives under a fieldGuard that rejects '|' + control chars.
        // Strip them so any UIDevice name pairs cleanly; fall back to "iPhone".
        let cleaned = label
            .components(separatedBy: CharacterSet(charactersIn: "|").union(.controlCharacters))
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let safeLabel = cleaned.isEmpty ? "iPhone" : cleaned

        let order = AddPairedSessionOrder(serverId: serverDomain, token: token, label: safeLabel, issuedAt: now)
        let orderSig = try order.sign(with: irk)
        let json = PairingOrderEnvelope.toJson(order: order, signatureHex: HexUtil.encode(orderSig))
        return Built(pairingOrderJson: json, token: token)
    }
}
