import Foundation
import os

/// A calls-log line: the same `\(value, privacy: .public)` interpolation as `Logger`, kept as plain text so a debug
/// (gym) build can also write it to a file. Every call-path field is a state or a code, so nothing private is logged.
public struct CallLogMessage: ExpressibleByStringInterpolation, Sendable {
    public let text: String
    public init(stringLiteral value: String) { text = value }
    public init(stringInterpolation i: Interpolation) { text = i.text }

    public struct Interpolation: StringInterpolationProtocol {
        var text = ""
        public init(literalCapacity: Int, interpolationCount: Int) { text.reserveCapacity(literalCapacity) }
        public mutating func appendLiteral(_ literal: String) { text += literal }
        public mutating func appendInterpolation<T>(_ value: T, privacy: OSLogPrivacy) { text += String(describing: value) }
        public mutating func appendInterpolation<T>(_ value: T) { text += String(describing: value) }
    }
}

/// The calls log (subsystem com.flagshipserver.app, category calls). Debug builds (the gym app) also append each line
/// to Library/Caches/calls.log (about 1 MB, one older file kept), which `xcrun devicectl device copy from
/// --domain-type appDataContainer` fetches without the Mac's admin password.
public struct CallLog: Sendable {
    private let logger = Logger(subsystem: "com.flagshipserver.app", category: "calls")
    public init() {}

    public func notice(_ message: CallLogMessage) {
        logger.notice("\(message.text, privacy: .public)")
        #if DEBUG
        CallLogFile.shared.append(message.text)
        #endif
    }
}

#if DEBUG
final class CallLogFile: @unchecked Sendable {
    static let shared = CallLogFile()
    private static let limit = 1_000_000
    private let queue = DispatchQueue(label: "flagship.calls-log-file")
    private let url: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("calls.log")
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func append(_ line: String) {
        let now = Date()
        queue.async { [self] in
            guard let url else { return }
            let data = Data("\(stamp.string(from: now)) \(line)\n".utf8)
            let fm = FileManager.default
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size + data.count > Self.limit {
                let old = url.deletingLastPathComponent().appendingPathComponent("calls.1.log")
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: url, to: old)
            }
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                _ = try? h.seekToEnd()
                try? h.write(contentsOf: data)
            } else {
                try? data.write(to: url, options: .atomic)
            }
        }
    }
}
#endif
