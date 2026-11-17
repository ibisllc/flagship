import Foundation

/// When to open the next pairing session after one ended before the relay accepted it (journal F15).
///
/// A session that dies at the transport (no network yet, the relay's rate limit, a relay restart) used to be
/// replaced at once by a fresh one, so a Studio could ask the relay dozens of times a minute until the rate limit
/// refused it, and then keep going. The next session now waits 5, 10, 20, 40 and then 60 seconds, as the Windows and
/// Linux Studios do (`PairingWatch`); a session the relay accepted starts the count again.
public struct PairingRetry: Equatable {
    public static let delays: [TimeInterval] = [5, 10, 20, 40, 60]

    public private(set) var failures = 0

    public init() {}

    /// The wait before the next session, counting this failure.
    public mutating func nextDelay() -> TimeInterval {
        let d = Self.delays[min(failures, Self.delays.count - 1)]
        failures += 1
        return d
    }

    /// The relay accepted a session.
    public mutating func reset() { failures = 0 }
}
