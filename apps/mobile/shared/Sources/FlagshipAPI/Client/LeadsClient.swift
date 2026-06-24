import Foundation

/// Direct (box-read) per-service leadership.
///
/// Today the phone learns which box LEADS which service from the `.com` `/pods`
/// `leadsServices` relay (Phase 6) — fresh to ~5 min and `.com`-dependent. When
/// a box is reachable the phone can instead read leadership STRAIGHT from a box,
/// over the same pinned canonical pipe as `GET /api/services`:
///
///   GET https://<podFqdn>/api/leads  (unauthenticated)
///     → { asOf, self, gossipActive, leads: { <slug>: { leaderFqdn, leaderStkHex, live } } }
///
/// This is GLOBAL (every slug the box's gossip view knows a leader for, keyed by
/// slug → the leading fqdn), so the caller INVERTS it into the per-pod
/// "fqdn → slugs it leads" shape the UI already renders (see
/// `DirectLeadsInversion`). The read is best-effort and on-demand: a pre-`/api/leads`
/// box 404s, a box with gossip off reports `gossipActive:false`, and either yields
/// `nil` so the caller falls back to the `.com` relay — it must never regress the
/// existing badge.
public struct LeadEntry: Equatable, Sendable {
    /// The fqdn of the box currently leading this service.
    public let leaderFqdn: String
    /// The leader's STK pubkey (hex) — carried for parity with the box's own
    /// view; the client matches by fqdn, so this is informational here.
    public let leaderStkHex: String
    /// Whether the leader is a live runner (vs a stale/elected-but-down view).
    public let live: Bool
    public init(leaderFqdn: String, leaderStkHex: String, live: Bool) {
        self.leaderFqdn = leaderFqdn
        self.leaderStkHex = leaderStkHex
        self.live = live
    }
}

/// The decoded `/api/leads` body. `leads` is keyed by service slug.
public struct LeadsMap: Equatable, Sendable {
    /// Box clock (ms) when this view was taken — informational.
    public let asOf: Int64
    /// The responding box's own fqdn.
    public let selfFqdn: String
    /// Whether gossip is active on the box. A `false` here is treated by the
    /// live client as "no fresher source" (returns nil), since the box's
    /// leadership view is meaningless without an active gossip loop.
    public let gossipActive: Bool
    /// slug → who leads it.
    public let leads: [String: LeadEntry]
    public init(asOf: Int64, selfFqdn: String, gossipActive: Bool, leads: [String: LeadEntry]) {
        self.asOf = asOf
        self.selfFqdn = selfFqdn
        self.gossipActive = gossipActive
        self.leads = leads
    }
}

public protocol LeadsClient: Sendable {
    /// Fetch `/api/leads` from one box. Returns the decoded map, or `nil` on any
    /// error / non-2xx (incl. a pre-`/api/leads` 404) / `gossipActive == false`.
    /// NEVER throws — leadership is a best-effort optimization over the relay.
    func fetchLeads(podFqdn: String) async -> LeadsMap?
}

/// URLSession-backed reader. Rides the BOX-pinned session (hard-fail cert
/// pinning) exactly like `LiveFrontPageClient`.
public final class LiveLeadsClient: LeadsClient, @unchecked Sendable {
    private let urlSession: URLSession

    public init(urlSession: URLSession) {
        self.urlSession = urlSession
    }

    private static func baseUrl(_ podFqdn: String) -> String {
        let host = podFqdn.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return "https://\(host)"
    }

    public func fetchLeads(podFqdn: String) async -> LeadsMap? {
        guard let url = URL(string: Self.baseUrl(podFqdn) + "/api/leads") else { return nil }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.data(for: URLRequest(url: url))
        } catch {
            // Cert-pin mismatch / network error / DNS — best-effort, no throw.
            return nil
        }
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            // A pre-`/api/leads` box 404s (or any non-2xx) → fall back to relay.
            return nil
        }
        return Self.decode(data)
    }

    /// Lenient decode. Tolerates missing/garbled fields (a per-entry default
    /// keeps one bad slug from dropping the whole map) and returns nil when the
    /// body isn't a leads object or gossip is off.
    static func decode(_ data: Data) -> LeadsMap? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        let gossipActive = (obj["gossipActive"] as? Bool) ?? false
        // Gossip off ⇒ the box's leadership view is not authoritative; defer to
        // the `.com` relay rather than render a possibly-empty/stale direct view.
        guard gossipActive else { return nil }
        let asOf = (obj["asOf"] as? NSNumber)?.int64Value ?? 0
        let selfFqdn = (obj["self"] as? String) ?? ""
        var leads: [String: LeadEntry] = [:]
        if let raw = obj["leads"] as? [String: Any] {
            for (slug, v) in raw {
                guard let e = v as? [String: Any] else { continue }
                let leaderFqdn = (e["leaderFqdn"] as? String) ?? ""
                guard !leaderFqdn.isEmpty else { continue }
                leads[slug] = LeadEntry(
                    leaderFqdn: leaderFqdn,
                    leaderStkHex: (e["leaderStkHex"] as? String) ?? "",
                    live: (e["live"] as? Bool) ?? false
                )
            }
        }
        return LeadsMap(asOf: asOf, selfFqdn: selfFqdn, gossipActive: gossipActive, leads: leads)
    }
}

/// Inverts the GLOBAL box view (slug → leaderFqdn) into the per-pod model the UI
/// reads (lowercased fqdn → the slugs that box leads). Only slugs whose
/// `leaderFqdn` matches a KNOWN pod fqdn are kept (an unknown leader is a box
/// this account doesn't show, so it can't render a badge for it). Slug lists are
/// sorted for a stable, churn-free badge.
public enum DirectLeadsInversion {
    public static func invert(leads: [String: LeadEntry], knownFqdns: [String]) -> [String: [String]] {
        let known = Set(knownFqdns.map { $0.lowercased() })
        var out: [String: [String]] = [:]
        for (slug, entry) in leads {
            let target = entry.leaderFqdn.lowercased()
            guard known.contains(target) else { continue }
            out[target, default: []].append(slug)
        }
        for k in out.keys { out[k]?.sort() }
        return out
    }
}

/// In-memory mock: returns a configurable map (default nil = "no fresher source").
public final class MockLeadsClient: LeadsClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _result: LeadsMap?
    private var _requested: [String] = []

    public var result: LeadsMap? {
        get { lock.withLock { _result } }
        set { lock.withLock { _result = newValue } }
    }
    public var requested: [String] { lock.withLock { _requested } }

    public init(result: LeadsMap? = nil) {
        self._result = result
    }

    public func fetchLeads(podFqdn: String) async -> LeadsMap? {
        lock.withLock { _requested.append(podFqdn) }
        return result
    }
}
