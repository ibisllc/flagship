import Foundation

/// A button that sits where another view used to be (Add/Restore server under
/// the banner that just went away, or before the list filled in) is hit by a
/// finger already on its way to the old layout. It takes no tap for a short
/// while after the layout moves, so a tap lands where the person meant it.
/// Pure so it can be tested without waiting: the screen passes the clock.
public struct TapSettle: Equatable {
    /// 450 ms covers the snappy reflow animation plus a finger's reaction.
    public nonisolated(unsafe) static var quietPeriod: TimeInterval = 0.45

    private var lastChange: Date

    init(startedAt: Date = Date()) { lastChange = startedAt }

    mutating func layoutChanged(at now: Date = Date()) { lastChange = now }

    func accepts(at now: Date = Date()) -> Bool {
        now.timeIntervalSince(lastChange) >= Self.quietPeriod
    }
}
