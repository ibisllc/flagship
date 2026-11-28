#if DEBUG
import Foundation
import FlagshipCore

/// Gym-only: `.com`'s name-change routes for the choose-name screen under the mock gym. The precheck holds the names
/// `-smoke-held-names name=domain[,name=domain…]` lists (until 15 October 2027), `-smoke-held-unchecked name[,…]` with
/// a failed lookup, and finds every other name free. Nothing is renamed: the rename refuses.
struct GymHeldNameClient: AccountNameChangeClient {
    let held: [String: String]
    let unchecked: Set<String>
    static let heldUntil: Int64 = 1_823_558_400_000

    init(args: [String]) {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        var held: [String: String] = [:]
        for pair in (value("-smoke-held-names") ?? "").split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2 { held[parts[0].lowercased()] = parts[1].lowercased() }
        }
        self.held = held
        self.unchecked = Set((value("-smoke-held-unchecked") ?? "").split(separator: ",").map { $0.lowercased() })
    }

    private func answer(_ name: String) -> NameChangeQuote {
        let n = name.lowercased()
        if unchecked.contains(n) {
            return NameChangeQuote(available: false, code: "dibs-held", heldUntil: Self.heldUntil, domain: "\(n).com", checked: false)
        }
        if let domain = held[n] {
            return NameChangeQuote(available: false, code: "dibs-held", heldUntil: Self.heldUntil, domain: domain)
        }
        return NameChangeQuote(available: true, kind: "name-change", units: 10)
    }

    func precheck(newUsername: String, grant: NameGrant?) async -> NameChangeQuote? { answer(newUsername) }
    func quote(username: String, newUsername: String, grant: NameGrant?) async throws -> NameChangeQuote { answer(newUsername) }
    func rename(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Int64, signatureHex: String,
                payment: NameChangePayment, grant: NameGrant?) async throws -> NameChangeOutcome {
        throw NameChangeRefusal(status: 503, code: "gym-no-rename")
    }
    func mintDeviceGrant(_ grant: DeviceCapabilityGrantEnvelope, signatureHex: String) async throws {}
    func revokeDeviceGrant(username: String, grantId: String, reason: String, issuedAt: Int64, signatureHex: String) async throws {}
    func accountIrk(username: String) async throws -> String? { nil }
}
#endif
