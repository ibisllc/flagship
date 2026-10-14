import Foundation
import FlagshipAPI

/// Terminal-style view of a vibe-code transcript. The AI writes whole files
/// inline (`=== path ===` … `=== END ===`); rendered verbatim they are
/// thousands of lines that make the session screen crawl, and the code is
/// on the box anyway. Each finished file becomes one "wrote" line, the file
/// still being written shows only its last few lines, and only the newest
/// messages are kept on screen.
public enum VibeTranscript {
    public static let maxMessages = 40
    public static let liveTailLines = 6

    public struct Line: Equatable, Sendable {
        public let role: String
        public let text: String
        /// What the owner attached (user lines).
        public var attachments: [VibeCodeAttachment]? = nil
        /// Flagship Inference credits the reply used (assistant lines).
        public var credits: Double? = nil
    }

    private static func boundary(_ line: Substring) -> String? {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("==="), t.hasSuffix("==="), t.count > 6 else { return nil }
        let name = t.dropFirst(3).dropLast(3).trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : name
    }

    /// Collapse file blocks. `live` keeps the tail of an unfinished block.
    public static func compact(_ text: String, live: Bool = false) -> String {
        var out: [String] = []
        var file: String?
        var body: [Substring] = []
        func closeFile() {
            guard let f = file else { return }
            if f != "QUESTION" {
                out.append("  wrote \(f) (\(body.count) line\(body.count == 1 ? "" : "s"))")
            } else {
                out.append(contentsOf: body.map(String.init))
            }
            file = nil
            body = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if let name = boundary(line) {
                closeFile()
                if name != "END" { file = name }
            } else if file != nil {
                body.append(line)
            } else {
                out.append(String(line))
            }
        }
        if let f = file {
            if live, f != "QUESTION" {
                out.append("  writing \(f)… (\(body.count) lines)")
                out.append(contentsOf: body.suffix(liveTailLines).map { "    " + $0 })
            } else {
                closeFile()
            }
        }
        while out.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeLast() }
        return out.joined(separator: "\n")
    }

    /// The newest messages, compacted, and how many older ones were left out.
    public static func lines(_ messages: [VibeCodeSessionMessage]) -> (hidden: Int, lines: [Line]) {
        let shown = messages.suffix(maxMessages)
        return (messages.count - shown.count,
                shown.map { Line(role: $0.role, text: $0.role == "assistant" ? compact($0.text) : $0.text,
                          attachments: $0.attachments, credits: $0.credits) })
    }
}
