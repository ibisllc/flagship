import Foundation
import FlagshipAPI

/// How the phone reaches a retail box (docs/retail-box-setup.md §7.1, §11.2, §15.1). The claim flow
/// only sees these: Core Bluetooth on iOS, BluetoothLeScanner on Android, the blind `.com` mailbox
/// for the sharing method, and a scripted box for the mock gym.

/// One unclaimed box the radio hears. `advertId` is the box's random per-boot id (scan response);
/// `peripheral` is the radio's own handle for connecting.
public struct BoxClaimAdvert: Equatable, Hashable, Sendable {
    public let peripheral: String
    public let advertId: String
    public let state: BoxClaim.AdvertState
    public init(peripheral: String, advertId: String, state: BoxClaim.AdvertState) {
        self.peripheral = peripheral; self.advertId = advertId; self.state = state
    }
}

public enum BoxClaimRadioError: Error, Equatable, Sendable {
    case bluetoothOff
    case notAllowed
    case unsupported
    case connectFailed
    case linkClosed
}

/// A link carries whole claim messages (`BoxClaim.encodeMessage`) in order.
public protocol BoxClaimLink: AnyObject, Sendable {
    func send(_ message: [UInt8]) async throws
    /// The next whole message from the box; throws `linkClosed` when the link ends.
    func receive() async throws -> [UInt8]
    func close()
}

public protocol BoxClaimRadio: AnyObject, Sendable {
    /// Starts scanning; `onAdverts` gets every claim advert heard in the last few seconds, again on
    /// each change. Throws when Bluetooth is off or not allowed.
    func startScan(onAdverts: @escaping @Sendable ([BoxClaimAdvert]) -> Void) async throws
    func stopScan()
    func connect(_ advert: BoxClaimAdvert) async throws -> any BoxClaimLink
}

/// The presence rule (§7.1): no unclaimed box before power-on, then exactly one new one, and the
/// same one until the claim completes.
public struct BoxClaimPresence: Sendable {
    public enum Verdict: Equatable, Sendable {
        case waiting
        case one(BoxClaimAdvert)
        case anotherBoxNearby
        case twoBoxes
    }

    public private(set) var baselineDone = false
    public private(set) var chosen: BoxClaimAdvert?
    private var stopped: Verdict?

    public init() {}

    /// Adverts heard before the buyer plugged the box in. Any at all stops the setup.
    public mutating func baseline(_ adverts: [BoxClaimAdvert]) -> Verdict {
        if let stopped { return stopped }
        if !adverts.isEmpty { stopped = .anotherBoxNearby; return .anotherBoxNearby }
        return .waiting
    }

    public mutating func endBaseline() { baselineDone = true }

    /// Adverts heard after. A second id, or the first replaced by another, stops the setup for good.
    public mutating func observe(_ adverts: [BoxClaimAdvert]) -> Verdict {
        if let stopped { return stopped }
        guard baselineDone else { return baseline(adverts) }
        let ids = Set(adverts.map(\.advertId))
        if ids.count > 1 { stopped = .twoBoxes; return .twoBoxes }
        if let chosen {
            if let id = ids.first, id != chosen.advertId { stopped = .twoBoxes; return .twoBoxes }
            return .one(chosen)
        }
        guard let first = adverts.first else { return .waiting }
        chosen = first
        return .one(first)
    }
}

/// A `BoxClaimLink` over the `.com` mailbox named by a hash of the setup code (§15.1). `.com` sees
/// only that some bytes passed through a mailbox with an opaque name.
public final class MailboxClaimLink: BoxClaimLink, @unchecked Sendable {
    private let client: any FlagshipServerClient
    private let mailboxId: String
    private let pollEvery: UInt64
    private let lock = NSLock()
    private var after = 0
    private var queued: [[UInt8]] = []
    private var closed = false

    public init(client: any FlagshipServerClient, mailboxId: String, pollEveryMs: UInt64 = 1_000) {
        self.client = client
        self.mailboxId = mailboxId
        self.pollEvery = pollEveryMs
    }

    public func send(_ message: [UInt8]) async throws {
        if isClosed { throw BoxClaimRadioError.linkClosed }
        try await client.postBoxClaimMailbox(mailboxId: mailboxId, dir: "to-box", body: Data(message).base64EncodedString())
    }

    private var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    public func receive() async throws -> [UInt8] {
        while true {
            if isClosed { throw BoxClaimRadioError.linkClosed }
            lock.lock()
            if !queued.isEmpty { let m = queued.removeFirst(); lock.unlock(); return m }
            let cursor = after
            lock.unlock()
            let msgs = (try? await client.readBoxClaimMailbox(mailboxId: mailboxId, dir: "to-phone", after: cursor)) ?? []
            lock.lock()
            for m in msgs where m.seq > after {
                after = m.seq
                if let d = Data(base64Encoded: m.body) { queued.append(Array(d)) }
            }
            let empty = queued.isEmpty
            lock.unlock()
            if empty { try await Task.sleep(nanoseconds: pollEvery * 1_000_000) }
        }
    }

    public func close() { lock.lock(); closed = true; lock.unlock() }
}
