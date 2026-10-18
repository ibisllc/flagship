#if DEBUG
import Foundation
import CryptoKit
import FlagshipAPI

/// The mock gym's security notices (Debug builds only; Release carries none of
/// this, `scripts/ios-release-clean.mjs`). The notices are the signed ones in
/// `packages/protocol/test-vectors/security-notice/vectors.json` (a unit test
/// compares them), judged against a THROWAWAY authority: the vectors'
/// authority seed signs a one-mandate chain here, and its hash replaces the
/// baked pin for this launch only. The app's own poller keeps the baked pin in
/// every other launch, so a forged lock never works.
///
/// Launch arguments (with `-smoke-mode`):
///   `-gym-notice <name>[,<name>...]`  what the mocked `.com` serves, one
///        answer per poll: `maintenance`, `lock` (update-required with a
///        grace window), `clear` (a signed all clear, seq 5), `forged` (a lock
///        signed by another key), `failed` (a 500), `junk`, `empty` (204).
///   `-gym-notice-now <ms>`           the clock starts here and runs
///   `-gym-notice-build <n>`          this build's number (default: the real one)
///   `-gym-notice-protocol <n>`       this build's protocol level (default: the real one)
///   `-gym-notice-every <seconds>`    the poll interval (default 2)
public enum SecurityNoticeGym {
    public static let authoritySeedHex = "7777777777777777777777777777777777777777777777777777777777777777"

    public static let notices: [String: String] = [
        "maintenance": #"""
        {"advisoryId":"","deprecatesProtocol":0,"eventAt":1792604800000,"kind":"maintenance","lockFrom":0,"message":"We will update on {date}. Flagship may be briefly unavailable.","platforms":{},"reason":"","seq":1,"signature":"053e8101986411f8d992a2e02b1821eb87a706ea37eb6f3aa1e0054c1d006e6391d95de613d95891341ca064147dcaa2eb0e002b42343d7440643f42c4c42e01","signedBy":"c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7","type":"SecurityNotice","validFrom":1792000000000,"validUntil":1792691200000,"version":1}
        """#,
        "lock": #"""
        {"advisoryId":"FSA-2026-001","deprecatesProtocol":1,"eventAt":1793209600000,"kind":"update-required","lockFrom":1793209600000,"message":"You must update Flagship by {date}. Older versions will stop working.","platforms":{"android":{"minBuild":40,"minProtocol":2},"ios":{"minBuild":12,"minProtocol":2},"web":{"minBuild":150,"minProtocol":2}},"reason":"A flaw in how a signed message is checked lets an attacker act as you.","seq":3,"signature":"a9366cca5ef616731c025836cd8ef77fc0fad6b24f5cba192d9cfba9f2e52a046c1c537d53cc2bc815838db08491bdaa5b09b8669d03b0702dc14a1a5276da03","signedBy":"c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7","type":"SecurityNotice","validFrom":1792000000000,"validUntil":1794592000000,"version":1}
        """#,
        "clear": #"""
        {"advisoryId":"","deprecatesProtocol":0,"eventAt":0,"kind":"none","lockFrom":0,"message":"","platforms":{},"reason":"","seq":5,"signature":"304f617d94b2a8dcc4ac7af2162f8ed2387867b306f82676fc552be52787781225d936df5c61978b090e736bf47477fb789ab7f7e4034d413de151c1e2fb6803","signedBy":"c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7","type":"SecurityNotice","validFrom":1792000000000,"validUntil":1792691200000,"version":1}
        """#,
        "forged": #"""
        {"advisoryId":"FSA-2026-001","deprecatesProtocol":1,"eventAt":1793209600000,"kind":"update-required","lockFrom":1793209600000,"message":"You must update Flagship by {date}. Older versions will stop working.","platforms":{"android":{"minBuild":40,"minProtocol":2},"ios":{"minBuild":12,"minProtocol":2},"web":{"minBuild":150,"minProtocol":2}},"reason":"A flaw in how a signed message is checked lets an attacker act as you.","seq":3,"signature":"51f122a95d6a5088e124fd17dc74586c8eaff03033cbbda5bcbf778e7d7b21e01441e226afe2a969dab05de6c1d23926d4e5d92b5138599996c10344bce6b502","signedBy":"ee31f83c88a71219a6fcf9bee0da9bc22620588f5a15a6145553504df9649e5c","type":"SecurityNotice","validFrom":1792000000000,"validUntil":1794592000000,"version":1}
        """#,
    ]

    /// A one-mandate ca-track chain whose holder is the vectors' authority:
    /// `pin` is its hash, `mandates` the JSON a server would send.
    public static func throwawayChain() -> (pin: String, mandates: [[String: Any]]) {
        let seed = MaintainersHex.toBytes(authoritySeedHex)!
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let pub = key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        let unsigned = Mandate(
            kind: "Mandate", version: 1, mandateId: "gym-notice-root-0000-4000-8000-000000000000", track: "ca",
            holder: pub, issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2031-01-01T00:00:00.000Z",
            successors: [pub], approvalRule: MaintainersApprovalRule(kind: "threshold", threshold: 1),
            minSuccessors: 1, maxDurationSeconds: 157_680_000, defaultDurationSeconds: 157_680_000,
            project: nil, signedBy: pub, signatures: []
        )
        let bytes = try! MaintainersCanonical.canonicalMandate(unsigned)
        let sig = try! key.signature(for: bytes).map { String(format: "%02x", $0) }.joined()
        let pin = try! MaintainersCanonical.mandatePinHash(unsigned)
        let json: [String: Any] = [
            "kind": "Mandate", "version": 1, "mandateId": unsigned.mandateId, "track": "ca", "holder": pub,
            "issuedAt": unsigned.issuedAt, "expiresAt": unsigned.expiresAt, "successors": [pub],
            "approvalRule": ["kind": "threshold", "threshold": 1], "minSuccessors": 1,
            "maxDurationSeconds": 157_680_000, "defaultDurationSeconds": 157_680_000,
            "signedBy": pub, "signatures": [["pubkey": pub, "sig": sig]],
        ]
        return (pin, [json])
    }

    /// The mocked `.com`: one answer per fetch, then 204.
    public final class Feed: NoticeFetching, @unchecked Sendable {
        private let mutex = NSLock()
        private var rest: [NoticeFetchResult]
        public init(_ answers: [NoticeFetchResult]) { rest = answers }

        public var isEmpty: Bool {
            mutex.lock()
            defer { mutex.unlock() }
            return rest.isEmpty
        }

        public func fetch() async -> NoticeFetchResult {
            mutex.lock()
            defer { mutex.unlock() }
            return rest.isEmpty ? .none : rest.removeFirst()
        }
    }

    public static func answers(_ names: [String], mandates: [[String: Any]]) -> [NoticeFetchResult] {
        names.map { name in
            switch name {
            case "failed": return .failed
            case "junk": return .document(Data("<html>not json</html>".utf8))
            case "empty": return .none
            default:
                guard let text = notices[name], let notice = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
                      let doc = try? JSONSerialization.data(withJSONObject: ["version": 1, "notice": notice, "mandates": mandates]) else {
                    return .failed
                }
                return .document(doc)
            }
        }
    }

    /// The gym's `SecurityNoticeCenter` for these launch arguments, or nil when
    /// the launch asks for no notice. It starts from an empty store, so a run
    /// never sees an earlier run's notice.
    @MainActor
    public static func center(args: [String]) -> (center: SecurityNoticeCenter, feed: Feed, every: TimeInterval)? {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count, !args[i + 1].hasPrefix("-") else { return nil }
            return args[i + 1]
        }
        guard let list = value("-gym-notice") else { return nil }
        let chain = throwawayChain()
        let feed = Feed(answers(list.split(separator: ",").map(String.init), mandates: chain.mandates))
        let storage = SecurityNoticeStorage()
        storage.clear()
        var client = SecurityNoticeClient.current()
        if let b = value("-gym-notice-build").flatMap({ Int64($0) }) { client.build = b }
        if let p = value("-gym-notice-protocol").flatMap({ Int64($0) }) { client.protocolLevel = p }
        let started = Date()
        let base = value("-gym-notice-now").flatMap { Double($0) }.map { Date(timeIntervalSince1970: $0 / 1000) }
        let clock: @Sendable () -> Date = {
            guard let base else { return Date() }
            return base.addingTimeInterval(Date().timeIntervalSince(started))
        }
        let center = SecurityNoticeCenter(storage: storage, fetcher: feed, client: client, pin: chain.pin, now: clock)
        return (center, feed, value("-gym-notice-every").flatMap { Double($0) } ?? 2)
    }

    /// Poll the feed every `every` seconds until it is spent.
    @MainActor
    public static func poll(_ center: SecurityNoticeCenter, feed: Feed, every: TimeInterval) {
        center.evaluate()
        Task { @MainActor in
            while !feed.isEmpty {
                await center.refresh()
                try? await Task.sleep(nanoseconds: UInt64(every * 1_000_000_000))
            }
        }
    }
}
#endif
