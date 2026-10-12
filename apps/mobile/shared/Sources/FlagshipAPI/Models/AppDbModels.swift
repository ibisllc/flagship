import Foundation
import CryptoKit

// The owner's Database section: an app's LIVE data over the owner's paired
// session. Reads need no signature (the box runs them READ ONLY); a write
// carries a `flagship/app-db-write/v1` order signed by the sensitive-order key.
//
// MIRRORS: docs/app-apis.md §6
//          packages/server-daemon/src/dataLayer/ownerDb.ts
//          packages/protocol/test-vectors/app-db-write/vectors.json (every case
//          runs in AppDbWriteVectorTests)

/// One table or view. `name` is `table` in the public schema, else
/// `schema.table`; `rows` is the planner's estimate (nil when unknown).
public struct AppDbTable: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let kind: String
    public let rows: Int64?
    public let bytes: Int64
    public var id: String { name }
    public var isView: Bool { kind == "view" }

    public init(name: String, kind: String = "table", rows: Int64?, bytes: Int64) {
        self.name = name
        self.kind = kind
        self.rows = rows
        self.bytes = bytes
    }

    private enum CodingKeys: String, CodingKey { case name, kind, rows, bytes }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "table"
        rows = AppDbNumber.int64(c, .rows)
        bytes = AppDbNumber.int64(c, .bytes) ?? 0
    }
}

/// One of the app's Postgres stores (`default` for a single-store app).
public struct AppDbStore: Codable, Equatable, Sendable, Identifiable {
    public let store: String
    public let tables: [AppDbTable]
    public var id: String { store }

    public init(store: String, tables: [AppDbTable]) {
        self.store = store
        self.tables = tables
    }
}

/// `GET /api/screens/services/:id/db`.
public struct AppDbStoresResponse: Codable, Equatable, Sendable {
    public let stores: [AppDbStore]
    public init(stores: [AppDbStore]) { self.stores = stores }
}

public struct AppDbColumn: Codable, Equatable, Sendable {
    public let name: String
    public let type: String

    public init(name: String, type: String) {
        self.name = name
        self.type = type
    }

    private enum CodingKeys: String, CodingKey { case name, type }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
    }
}

/// A cell as the box sends it: Postgres's text for most types, a JSON
/// boolean or small number for those, null for NULL.
public enum AppDbValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    /// Anything else (an array or object), as compact JSON.
    case json(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        let any = try c.decode(AnyCodable.self)
        let data = (try? JSONEncoder().encode(any)) ?? Data()
        self = .json(String(decoding: data, as: UTF8.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .json(let j): try c.encode(j)
        }
    }

    /// What a cell shows. NULL reads as `NULL`.
    public var display: String {
        switch self {
        case .null: return "NULL"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .double(let d): return d.rounded() == d && abs(d) < 1e15 ? String(Int64(d)) : String(d)
        case .string(let s): return s
        case .json(let j): return j
        }
    }

    public var isNull: Bool { self == .null }
}

/// `GET …/db/:store/tables/:table?offset&limit`.
public struct AppDbTableRows: Codable, Equatable, Sendable {
    public let columns: [AppDbColumn]
    public let rows: [[AppDbValue]]
    public let total: Int64

    public init(columns: [AppDbColumn], rows: [[AppDbValue]], total: Int64) {
        self.columns = columns
        self.rows = rows
        self.total = total
    }

    private enum CodingKeys: String, CodingKey { case columns, rows, total }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        columns = try c.decodeIfPresent([AppDbColumn].self, forKey: .columns) ?? []
        rows = try c.decodeIfPresent([[AppDbValue]].self, forKey: .rows) ?? []
        total = AppDbNumber.int64(c, .total) ?? Int64(rows.count)
    }
}

/// `POST …/db/:store/query`'s answer.
public struct AppDbQueryResult: Codable, Equatable, Sendable {
    /// The first word of the statement's tag (`SELECT`, `UPDATE`, …).
    public let command: String
    public let columns: [AppDbColumn]
    public let rows: [[AppDbValue]]
    /// Rows returned or changed, as Postgres reported it.
    public let rowCount: Int64?
    /// More rows existed than came back.
    public let truncated: Bool

    public init(command: String, columns: [AppDbColumn] = [], rows: [[AppDbValue]] = [],
                rowCount: Int64? = nil, truncated: Bool = false) {
        self.command = command
        self.columns = columns
        self.rows = rows
        self.rowCount = rowCount
        self.truncated = truncated
    }

    private enum CodingKeys: String, CodingKey { case command, columns, rows, rowCount, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        columns = try c.decodeIfPresent([AppDbColumn].self, forKey: .columns) ?? []
        rows = try c.decodeIfPresent([[AppDbValue]].self, forKey: .rows) ?? []
        rowCount = AppDbNumber.int64(c, .rowCount)
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) == true
    }
}

/// `flagship/app-db-write/v1|<serverDomain>|<serviceId>|<store>|<sqlSha256>|<issuedAt>`:
/// the owner's order to run one exact SQL text that may change data. Good
/// for one use and 10 minutes.
public struct AppDbWriteGrant: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-db-write/v1"

    /// The box the request goes to (its FQDN), never the leader.
    public let serverDomain: String
    public let serviceId: String
    public let store: String
    public let sqlSha256: String
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, store: String, sqlSha256: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.store = store
        self.sqlSha256 = sqlSha256
        self.issuedAt = issuedAt
    }

    /// The grant for `sql` (hashed exactly as sent: no normalizing).
    public init(serverDomain: String, serviceId: String, store: String, sql: String, issuedAt: Int64) {
        self.init(serverDomain: serverDomain, serviceId: serviceId, store: store,
                  sqlSha256: Self.sqlSha256(sql), issuedAt: issuedAt)
    }

    /// Lowercase hex SHA-256 of the SQL's UTF-8 bytes.
    public static func sqlSha256(_ sql: String) -> String {
        SHA256.hash(data: Data(sql.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func canonicalBytes() -> Data {
        Data([Self.canonicalTag, serverDomain, serviceId, store, sqlSha256, String(issuedAt)]
            .joined(separator: "|").utf8)
    }
}

/// `POST …/db/:store/query` body: `{sql}` reads; `{sql, grant, signature}`
/// writes.
public struct AppDbQueryRequest: Codable, Equatable, Sendable {
    public let sql: String
    public let grant: AppDbWriteGrant?
    /// Ed25519 over `grant.canonicalBytes()`, 128 lowercase hex.
    public let signature: String?

    public init(sql: String, grant: AppDbWriteGrant? = nil, signature: String? = nil) {
        self.sql = sql
        self.grant = grant
        self.signature = signature
    }

    public var isSigned: Bool { grant != nil }
}

/// The box's refusal: `{error, sqlState?, position?, needsGrant?}`.
public struct AppDbRefusal: Codable, Equatable, Sendable {
    public let error: String?
    public let sqlState: String?
    public let position: Int?
    public let needsGrant: Bool?

    public static func decode(_ body: String) -> AppDbRefusal? {
        try? JSONDecoder().decode(AppDbRefusal.self, from: Data(body.utf8))
    }
}

/// Counts arrive as JSON numbers, but tolerate a string or a float.
enum AppDbNumber {
    static func int64<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Int64? {
        if let i = try? c.decodeIfPresent(Int64.self, forKey: key) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return Int64(d) }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Int64(s) }
        return nil
    }
}
