#if DEBUG
import Foundation
import FlagshipAPI

/// The mock gym's removed account (Debug builds only; Release carries none of
/// this, `scripts/ios-release-clean.mjs`). The mock clients have no `.com`, so
/// the gym feeds the REAL detector the answer `.com` would send:
///
///   `-gym-account-gone <seconds>`   after this long, `.com` answers a read of
///        this device's own account with `404 account-not-found`
///   `-gym-account-gone-mode own|other|nocode`   `own` (default); `other`: the
///        404 names another account (a shared server's owner); `nocode`: a
///        plain 404 for this account
public enum AccountGoneGym {
    @MainActor
    public static func start(args: [String], ownName: @escaping @MainActor () -> String?) {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count, !args[i + 1].hasPrefix("-") else { return nil }
            return args[i + 1]
        }
        guard let after = value("-gym-account-gone").flatMap({ Double($0) }) else { return }
        let mode = value("-gym-account-gone-mode") ?? "own"
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(after * 1_000_000_000))
            let name = mode == "other" ? "someone-else" : (ownName() ?? "smoketest")
            let url = URL(string: "https://\(Endpoints.controlHost)/api/users/\(name)/pods")
            let body = mode == "nocode" ? Data(#"{"error":"not found"}"#.utf8) : AccountGoneRegistry.body()
            AccountGoneRegistry.shared.note(url: url, status: 404, body: body)
        }
    }
}
#endif
