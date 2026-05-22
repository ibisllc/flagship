import Foundation

/// One line of output shown in the wizard's log drawer, tagged with its
/// stream of origin (stdout = normal, stderr = error/red).
public struct CLILogLine: Equatable, Sendable {
    public enum Stream: Sendable { case stdout, stderr }
    public let stream: Stream
    public let text: String
    public init(stream: Stream, text: String) {
        self.stream = stream
        self.text = text
    }
}
