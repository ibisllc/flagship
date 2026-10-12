import Foundation

/// A session store fixed to ONE box: its base URL and its own paired-session
/// token. Lets a `LiveScreensClient` talk to a box other than the one the
/// shell is showing (e.g. asking every managed box for waiting access
/// requests) without repointing the shared store. Writes are ignored.
public actor PodScopedSessionStore: SessionStoring {
    public let podBaseUrl: String?
    public let sessionToken: String?

    /// A nil token makes every call fail with `noSessionToken` (this device
    /// isn't paired with that box), never borrowing another box's token.
    public init(baseUrl: String, token: String?) {
        self.podBaseUrl = baseUrl
        self.sessionToken = token
    }

    public func setPodBaseUrl(_ url: String?) async {}
    public func setSessionToken(_ token: String?) async {}
    public func clear() async {}
    public func sessionToken(forPodId podId: String) async -> String? { sessionToken }
    public func setSessionToken(_ token: String?, forPodId podId: String) async {}
    public func podTokenIds() async -> [String] { [] }
    public func migrateSingleTokenToPod(_ anchorPodId: String) async {}
    public var demoSession: DemoSessionRecord? { nil }
    public func setDemoSession(_ session: DemoSessionRecord?) async {}
}
