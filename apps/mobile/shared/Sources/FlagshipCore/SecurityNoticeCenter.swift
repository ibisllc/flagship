import Foundation
import Observation
import FlagshipAPI

/// What is remembered about notices, per install (not per account, so it
/// survives sign-out and a second account): the highest `seq` ever verified,
/// the last accepted document (notice and mandate log), the newest authority
/// mandate time seen (`tip`), and what the person dismissed.
public struct SecurityNoticeStoreState: Equatable, Sendable {
    public struct Dismissal: Equatable, Sendable {
        public var seq: Int64
        public var at: Int64
    }
    public var highestSeq: Int64 = 0
    /// `{"version":1,"notice":{...},"mandates":[...]}`, as accepted.
    public var doc: Data?
    public var tip: Int64 = 0
    public var dismissed: Dismissal?
    public init() {}
}

public final class SecurityNoticeStorage: @unchecked Sendable {
    public static let key = "flagship.securityNotice.v1"
    private let defaults: UserDefaults
    private let mutex = NSLock()

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// A corrupt store reads as empty.
    public func load() -> SecurityNoticeStoreState {
        mutex.lock()
        defer { mutex.unlock() }
        var out = SecurityNoticeStoreState()
        guard let data = defaults.data(forKey: Self.key),
              let v = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return out }
        func uint(_ x: Any?) -> Int64? {
            guard let n = x as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
            let i = n.int64Value
            return i >= 0 && Double(i) == n.doubleValue ? i : nil
        }
        out.highestSeq = uint(v["highestSeq"]) ?? 0
        out.tip = uint(v["tip"]) ?? 0
        if let docObject = v["doc"], JSONSerialization.isValidJSONObject(docObject) {
            out.doc = try? JSONSerialization.data(withJSONObject: docObject, options: [.sortedKeys])
        }
        if let d = v["dismissed"] as? [String: Any], let seq = uint(d["seq"]), let at = uint(d["at"]) {
            out.dismissed = .init(seq: seq, at: at)
        }
        return out
    }

    public func save(_ s: SecurityNoticeStoreState) {
        mutex.lock()
        defer { mutex.unlock() }
        var v: [String: Any] = ["highestSeq": s.highestSeq, "tip": s.tip]
        if let doc = s.doc, let object = try? JSONSerialization.jsonObject(with: doc) { v["doc"] = object }
        if let d = s.dismissed { v["dismissed"] = ["seq": d.seq, "at": d.at] }
        guard let data = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return }
        defaults.set(data, forKey: Self.key)
    }

    public func clear() {
        mutex.lock()
        defer { mutex.unlock() }
        defaults.removeObject(forKey: Self.key)
    }
}

/// One fetch of the notice document. Never throws: any failure is `.failed`.
public enum NoticeFetchResult: Equatable, Sendable {
    /// 204: nothing in force on this deploy.
    case none
    /// 200: the document bytes.
    case document(Data)
    case failed
}

public protocol NoticeFetching: Sendable {
    func fetch() async -> NoticeFetchResult
}

/// `GET <control apex>/api/notices`, anonymous: no cookies, no credentials, no
/// custom header, no query, no referrer, and no redirect followed (a redirect
/// is a failure). It uses its own ephemeral session, never the authenticated
/// API clients, so it is also the one request that still leaves while the app
/// is locked. docs/security-notices.md section 3 and 6.2.
public struct AnonymousNoticeFetcher: NoticeFetching {
    public static let path = "/api/notices"
    static let maxBytes = 1_000_000

    private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private let base: @Sendable () -> URL
    private let configuration: URLSessionConfiguration

    public init(base: @escaping @Sendable () -> URL = { Endpoints.controlBaseUrl },
                configuration: URLSessionConfiguration? = nil) {
        self.base = base
        self.configuration = configuration ?? Self.anonymousConfiguration()
    }

    /// Nothing is stored, kept or sent beyond what URLSession itself adds (its
    /// user agent and the connection).
    public static func anonymousConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.httpCookieStorage = nil
        c.urlCredentialStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 30
        c.waitsForConnectivity = false
        c.httpAdditionalHeaders = nil
        return c
    }

    /// The request exactly as it is sent.
    public func request() -> URLRequest {
        var comps = URLComponents(url: base(), resolvingAgainstBaseURL: false) ?? URLComponents()
        comps.path = Self.path
        comps.query = nil
        comps.fragment = nil
        var req = URLRequest(url: comps.url ?? base().appendingPathComponent(Self.path))
        req.httpMethod = "GET"
        req.httpShouldHandleCookies = false
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    public func fetch() async -> NoticeFetchResult {
        let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, resp) = try await session.data(for: request())
            guard let http = resp as? HTTPURLResponse else { return .failed }
            if http.statusCode == 204 { return .none }
            guard http.statusCode == 200, data.count <= Self.maxBytes else { return .failed }
            return .document(data)
        } catch {
            return .failed
        }
    }
}

/// The notice state of this install: fetch, store, decide, poll.
///
/// Fail open everywhere: every failure leaves what the person already sees as
/// it was. The decision is re-made from the stored notice, re-verified against
/// the authority, at the device's clock every time the app starts, comes back
/// to the foreground, and at the next boundary (validFrom, lockFrom,
/// validUntil, at most 6 hours ahead).
@MainActor
@Observable
public final class SecurityNoticeCenter {
    public private(set) var outcome: SecurityNoticeOutcome = .none(why: "kind-none")
    /// Bumped on every fetch attempt that finished, so a test or the gym can wait for one.
    public private(set) var fetchCount = 0
    /// Bumped when a banner is dismissed, so views re-read `bannerVisible`.
    public private(set) var dismissals = 0

    @ObservationIgnored private let storage: SecurityNoticeStorage
    @ObservationIgnored private let fetcher: any NoticeFetching
    @ObservationIgnored private let lock: UpdateLock
    @ObservationIgnored private let client: SecurityNoticeClient
    @ObservationIgnored private let pin: String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let minInterval: TimeInterval
    @ObservationIgnored private let maxJitter: TimeInterval
    @ObservationIgnored private var inFlight = false
    @ObservationIgnored private var lastAttempt: Date?
    @ObservationIgnored private var boundary: Task<Void, Never>?
    @ObservationIgnored private var kick: Task<Void, Never>?
    @ObservationIgnored private var sessionDismissed = false
    @ObservationIgnored private var started = false

    public init(
        storage: SecurityNoticeStorage = SecurityNoticeStorage(),
        fetcher: any NoticeFetching = AnonymousNoticeFetcher(),
        lock: UpdateLock = .shared,
        client: SecurityNoticeClient = .current(),
        pin: String = MaintainersTrust.bakedPin,
        minInterval: TimeInterval = 15 * 60,
        maxJitter: TimeInterval = 10,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.storage = storage
        self.fetcher = fetcher
        self.lock = lock
        self.client = client
        self.pin = pin
        self.minInterval = minInterval
        self.maxJitter = maxJitter
        self.now = now
    }

    public var isLocked: Bool { outcome.isLock }

    // MARK: Decide

    /// Re-decide from the stored notice at the clock. Never throws.
    @discardableResult
    public func evaluate() -> SecurityNoticeOutcome {
        let state = storage.load()
        var decided: SecurityNoticeOutcome = .none(why: "kind-none")
        var parsed: SecurityNotice?
        if let doc = state.doc, let root = try? JSONSerialization.jsonObject(with: doc) as? [String: Any],
           let n = SecurityNotice.parse(root["notice"]) {
            parsed = n
            let mandates = SecurityNoticeAuthority.decodeMandates(root["mandates"]) ?? []
            let authority = SecurityNoticeAuthority.resolve(mandates: mandates, now: now(), pin: pin, minTip: state.tip)
            decided = SecurityNoticeVerifier.storedOutcome(
                .init(highestSeq: state.highestSeq, notice: n), authorityKeys: authority.keys, client: client,
                nowMs: Self.ms(now())
            )
        }
        publish(decided)
        scheduleNextBoundary(parsed)
        return decided
    }

    private func publish(_ next: SecurityNoticeOutcome) {
        if next != outcome { outcome = next }
        lock.set(next.isLock)
    }

    private func scheduleNextBoundary(_ n: SecurityNotice?) {
        boundary?.cancel()
        boundary = nil
        guard let n else { return }
        let nowMs = Self.ms(now())
        guard let next = [n.validFrom, n.lockFrom, n.validUntil].filter({ $0 > nowMs }).min() else { return }
        let wait = min(Double(next - nowMs) / 1000 + 0.25, 6 * 3600)
        boundary = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.evaluate()
        }
    }

    // MARK: Fetch

    /// One anonymous GET, then fold the answer in. Never throws and never
    /// runs twice at once; any failure leaves the cached notice as it was.
    @discardableResult
    public func refresh() async -> String? {
        guard !inFlight else { return nil }
        inFlight = true
        lastAttempt = now()
        defer {
            inFlight = false
            fetchCount += 1
        }
        guard case let .document(data) = await fetcher.fetch(),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? NSNumber)?.intValue == 1,
              let candidate = root["notice"], !(candidate is NSNull),
              let rawMandates = root["mandates"] as? [Any] else { return nil }
        var state = storage.load()
        let mandates = SecurityNoticeAuthority.decodeMandates(rawMandates) ?? []
        let authority = SecurityNoticeAuthority.resolve(mandates: mandates, now: now(), pin: pin, minTip: state.tip)
        let folded = SecurityNoticeVerifier.accept(.init(highestSeq: state.highestSeq, notice: nil),
                                                   candidate: candidate, authorityKeys: authority.keys)
        if folded.refused == nil, let n = folded.store.notice {
            let accepted: [String: Any] = ["version": 1, "notice": n.json(), "mandates": rawMandates]
            state.highestSeq = folded.store.highestSeq
            state.doc = try? JSONSerialization.data(withJSONObject: accepted, options: [.sortedKeys])
            state.tip = authority.tip
            storage.save(state)
            evaluate()
        } else if authority.tip > state.tip {
            state.tip = authority.tip
            storage.save(state)
        }
        // Nothing new (a refusal, a repeat): the screen stays as it is until
        // the next boundary or foreground.
        return folded.refused?.rawValue
    }

    // MARK: Poll

    /// Once shortly after launch (0 to `maxJitter` seconds), and see `foreground()`.
    public func start() {
        guard !started else { return }
        started = true
        evaluate()
        scheduleFetch()
    }

    /// The app came back to the foreground: re-decide now, and poll when the
    /// last attempt is `minInterval` old.
    public func foreground() {
        evaluate()
        if let last = lastAttempt, now().timeIntervalSince(last) < minInterval { return }
        scheduleFetch()
    }

    private func scheduleFetch() {
        guard kick == nil, !inFlight else { return }
        let delay = maxJitter > 0 ? Double.random(in: 0...maxJitter) : 0
        kick = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled, let self else { return }
            self.kick = nil
            await self.refresh()
        }
    }

    // MARK: Banner

    public static let advisoryReappear: TimeInterval = 24 * 3600

    /// Should the banner for this outcome show? A maintenance banner stays
    /// dismissed for its seq. An update banner returns after a day. The grace
    /// window of an update-required comes back on every launch (dismissal lasts
    /// the launch). A new seq shows again.
    public var bannerVisible: Bool {
        _ = dismissals
        guard case let .banner(style, n) = outcome else { return false }
        if sessionDismissed { return false }
        if n.kind == "update-required" { return true }
        guard let d = storage.load().dismissed, d.seq == n.seq else { return true }
        if style == .maintenance { return false }
        return Self.ms(now()) - d.at >= Int64(Self.advisoryReappear * 1000)
    }

    public func dismissBanner() {
        guard case let .banner(_, n) = outcome else { return }
        if n.kind == "update-required" {
            sessionDismissed = true
        } else {
            var state = storage.load()
            state.dismissed = .init(seq: n.seq, at: Self.ms(now()))
            storage.save(state)
        }
        dismissals += 1
    }

    static func ms(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1000).rounded()) }
}
