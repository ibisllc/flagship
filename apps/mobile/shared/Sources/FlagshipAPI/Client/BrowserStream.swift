import Foundation

// P8 — browser-viewer bidirectional stream.
//
// `BrowserStream` wraps a single WebSocket session against
// `/api/screens/browser-tabs/:tabId/stream`. The viewer consumes
// `incoming` for `frame` / `error` events and calls `send(_:)` for each
// pointer / scroll / key event the user makes. `close()` ends the
// session; the producer task also ends if the underlying task fails.

public protocol BrowserStream: AnyObject, Sendable {
    var incoming: AsyncStream<BrowserFrame> { get }
    func send(_ input: BrowserInput) async
    func close()
}

/// In-memory stream for tests + previews. `incoming` finishes the
/// moment `close()` is called or `finish()` is invoked. `send` is a
/// no-op that just records the most recent input for assertions.
public final class MockBrowserStream: BrowserStream, @unchecked Sendable {
    public let incoming: AsyncStream<BrowserFrame>
    private let continuation: AsyncStream<BrowserFrame>.Continuation
    public private(set) var sent: [BrowserInput] = []

    public init() {
        var c: AsyncStream<BrowserFrame>.Continuation!
        self.incoming = AsyncStream { c = $0 }
        self.continuation = c
    }

    public func yield(_ frame: BrowserFrame) {
        continuation.yield(frame)
    }

    public func finish() {
        continuation.finish()
    }

    public func send(_ input: BrowserInput) async {
        sent.append(input)
    }

    public func close() {
        continuation.finish()
    }
}
