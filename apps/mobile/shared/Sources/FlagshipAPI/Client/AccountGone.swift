import Foundation

/// "This account was removed" (docs/account-gone.md): the state, no screen.
///
/// After a reset or a wipe an account no longer exists on `.com`, but a device
/// that was already signed in keeps its identity and keeps calling. Every
/// own-account route then answers one stable `404 { code: "account-not-found" }`.
/// Every request the API clients make passes `gatedData` (UpdateLock.swift),
/// which hands each such answer to `note`. When it names THIS device's own
/// account the state flips once, the screen takes over, and from then on every
/// call that names that account is answered here with the same 404, without
/// touching the network, so no poller keeps asking and no error repeats.
public final class AccountGoneRegistry: @unchecked Sendable {
    public static let shared = AccountGoneRegistry()
    public static let code = "account-not-found"

    private let mutex = NSLock()
    private var gone: String?
    private var own: Set<String> = []
    private var listener: (@Sendable (String?) -> Void)?

    public init() {}

    public var goneName: String? {
        mutex.lock()
        defer { mutex.unlock() }
        return gone
    }

    public var isGone: Bool { goneName != nil }

    /// Which names are this device's own account (its account name and the
    /// active profile's). Set whenever the signed-in account changes.
    public func setOwnNames(_ names: [String?]) {
        mutex.lock()
        own = Set(names.compactMap { $0?.lowercased() }.filter { !$0.isEmpty })
        mutex.unlock()
    }

    /// Told on every change: the gone account's name, or nil when cleared.
    public func onChange(_ fn: (@Sendable (String?) -> Void)?) {
        mutex.lock()
        listener = fn
        mutex.unlock()
    }

    private static let notAccountNames: Set<String> = ["check"]

    /// The account a `.com` URL names in its path (`/api/users/<u>/...` or
    /// `/api/accounts/<u>/...`), lowercased, or nil.
    public static func accountName(in url: URL?) -> String? {
        guard let url else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count >= 3, parts[0] == "api", parts[1] == "users" || parts[1] == "accounts" else { return nil }
        let name = parts[2].lowercased()
        return notAccountNames.contains(name) ? nil : name
    }

    /// The `404` body `.com` sends, also used for calls answered locally.
    public static func body() -> Data {
        Data(#"{"error":"account-not-found","code":"account-not-found"}"#.utf8)
    }

    /// A local 404 for a call that names the removed account; nil for any other call.
    public func localAnswer(for request: URLRequest) -> (Data, URLResponse)? {
        guard let name = goneName, Self.accountName(in: request.url) == name, let url = request.url,
              let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil,
                                         headerFields: ["content-type": "application/json", "cache-control": "no-store"])
        else { return nil }
        return (Self.body(), resp)
    }

    /// Look at a `.com` answer. When it is `404 account-not-found` for this
    /// device's own account, the account is gone. Another account's name (a
    /// shared server's owner, an invite author), a 404 without the code and
    /// any other status change nothing. Returns true when the answer was that
    /// 404 for our own account.
    @discardableResult
    public func note(url: URL?, status: Int, body: Data) -> Bool {
        guard status == 404, let name = Self.accountName(in: url) else { return false }
        mutex.lock()
        let isOwn = own.contains(name)
        mutex.unlock()
        guard isOwn,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              (json["code"] as? String) == Self.code else { return false }
        mutex.lock()
        let changed = gone != name
        gone = name
        let fn = listener
        mutex.unlock()
        if changed { fn?(name) }
        return true
    }

    /// The person removed it from this device (or made a new account).
    public func clear() {
        mutex.lock()
        let changed = gone != nil
        gone = nil
        let fn = listener
        mutex.unlock()
        if changed { fn?(nil) }
    }
}
