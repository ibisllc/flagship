import Foundation

/// The "update required" lock's network side (docs/security-notices.md 6.3).
///
/// While a verified, in-window `update-required` notice applies to this build
/// the app refuses to act: no signed order and no call to a server leaves the
/// phone. Reads from the control apex stay open (sign-out and the key backup
/// need them, and a GET changes nothing). The notice fetch itself uses its own
/// session and never passes through here. Nothing is deleted.
///
/// Every request the API clients make goes through `gatedData` / `gatedBytes`
/// / `gatedWebSocketTask` below: that is the one gate. A test scans the
/// sources so a new client cannot skip it.
public struct UpdateRequiredError: Error, LocalizedError, Equatable, Sendable {
    public static let sentence = "Update required. Flagship is paused on this device until you update."
    public init() {}
    public var errorDescription: String? { Self.sentence }
}

public final class UpdateLock: @unchecked Sendable {
    public static let shared = UpdateLock()

    private let mutex = NSLock()
    private var locked = false

    public init() {}

    public var isLocked: Bool {
        mutex.lock()
        defer { mutex.unlock() }
        return locked
    }

    public func set(_ value: Bool) {
        mutex.lock()
        locked = value
        mutex.unlock()
    }

    /// May this request go out while locked? Only a GET or HEAD to the control
    /// apex: nothing it answers changes anything. Boxes, the data plane and
    /// every write are refused.
    public static func permits(method: String?, host: String?, controlHost: String) -> Bool {
        let m = (method ?? "GET").uppercased()
        guard m == "GET" || m == "HEAD" else { return false }
        guard let host else { return false }
        return host.lowercased() == controlHost.lowercased()
    }

    /// Throws `UpdateRequiredError` when locked and the request is not one of
    /// the reads above.
    public func check(_ request: URLRequest) throws {
        guard isLocked else { return }
        let ok = request.httpBody == nil && request.httpBodyStream == nil
            && Self.permits(method: request.httpMethod, host: request.url?.host, controlHost: Endpoints.controlHost)
        if !ok { throw UpdateRequiredError() }
    }

    /// A WebSocket is never a plain read.
    public func checkSocket() throws {
        if isLocked { throw UpdateRequiredError() }
    }
}

extension URLSession {
    /// `data(for:)` behind the update lock.
    public func gatedData(for request: URLRequest) async throws -> (Data, URLResponse) {
        try UpdateLock.shared.check(request)
        return try await data(for: request)
    }

    /// `bytes(for:)` behind the update lock.
    public func gatedBytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        try UpdateLock.shared.check(request)
        return try await bytes(for: request)
    }

    /// `webSocketTask(with:)` behind the update lock.
    public func gatedWebSocketTask(with url: URL) throws -> URLSessionWebSocketTask {
        try UpdateLock.shared.checkSocket()
        return webSocketTask(with: url)
    }

    /// `webSocketTask(with:)` behind the update lock.
    public func gatedWebSocketTask(with request: URLRequest) throws -> URLSessionWebSocketTask {
        try UpdateLock.shared.checkSocket()
        return webSocketTask(with: request)
    }
}
