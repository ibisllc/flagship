import Foundation

/// Argument vector builders for the Node CLI's subcommands. Pure
/// functions, fully unit-testable — kept separate from the spawn step.
public enum CLIArgs {
    public static func verify(entryPath: String, recipePath: String) -> [String] {
        return [entryPath, "verify", recipePath]
    }

    public static func userData(entryPath: String, recipePath: String, outPath: String, keepRecipe: Bool) -> [String] {
        var a = [entryPath, "user-data", recipePath, outPath]
        if keepRecipe { a.append("--keep-recipe") }
        return a
    }

    public static func prepare(entryPath: String,
                               recipePath: String,
                               isoPath: String,
                               outIsoPath: String,
                               keepRecipe: Bool) -> [String] {
        var a = [entryPath, "prepare", recipePath, isoPath, outIsoPath]
        if keepRecipe { a.append("--keep-recipe") }
        return a
    }

    /// `write` needs root. The caller is responsible for spawning the
    /// command with admin privileges (e.g. via NSAppleScript's
    /// `do shell script ... with administrator privileges`).
    public static func write(entryPath: String,
                             recipePath: String,
                             isoPath: String,
                             devicePath: String,
                             keepRecipe: Bool) -> [String] {
        var a = [entryPath, "write", recipePath, isoPath, "--device", devicePath, "--yes"]
        if keepRecipe { a.append("--keep-recipe") }
        return a
    }
}

/// One line of subprocess output, tagged with its stream of origin.
public struct CLILogLine: Equatable, Sendable {
    public enum Stream: Sendable { case stdout, stderr }
    public let stream: Stream
    public let text: String
    public init(stream: Stream, text: String) {
        self.stream = stream
        self.text = text
    }
}

/// Spawned-CLI controller — owns the Process and exposes an AsyncStream
/// of log lines. Stream completes when both pipes hit EOF; subscribers
/// can read `terminationStatus` afterwards.
///
/// We chose AsyncStream over Combine because the SwiftUI view consumer
/// is in a `Task { for await ... }` loop, which is the cleanest local
/// idiom for "tail this subprocess until it exits".
public final class CLIRunner {

    public let nodePath: String
    public let arguments: [String]
    public let workingDirectory: URL?

    private let process = Process()
    private let outPipe = Pipe()
    private let errPipe = Pipe()

    public init(nodePath: String, arguments: [String], workingDirectory: URL? = nil) {
        self.nodePath = nodePath
        self.arguments = arguments
        self.workingDirectory = workingDirectory
    }

    /// Launch the subprocess and stream both pipes' lines as they arrive.
    /// The returned stream finishes when both pipes hit EOF. Throws on
    /// spawn failure only — runtime errors (non-zero exit) surface as a
    /// stderr line + `terminationStatus != 0`.
    public func start() throws -> AsyncStream<CLILogLine> {
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = arguments
        process.standardOutput = outPipe
        process.standardError = errPipe
        if let cwd = workingDirectory { process.currentDirectoryURL = cwd }
        try process.run()

        return AsyncStream { continuation in
            let group = DispatchGroup()
            group.enter()
            group.enter()

            Self.tail(handle: outPipe.fileHandleForReading, stream: .stdout, into: continuation, leaving: group)
            Self.tail(handle: errPipe.fileHandleForReading, stream: .stderr, into: continuation, leaving: group)

            group.notify(queue: .global()) { [weak self] in
                self?.process.waitUntilExit()
                continuation.finish()
            }

            continuation.onTermination = { @Sendable [weak self] _ in
                guard let s = self else { return }
                if s.process.isRunning {
                    s.process.terminate()
                }
            }
        }
    }

    public var isRunning: Bool { process.isRunning }
    public var terminationStatus: Int32 { process.terminationStatus }

    public func cancel() {
        if process.isRunning { process.terminate() }
    }

    private static func tail(handle: FileHandle,
                             stream: CLILogLine.Stream,
                             into continuation: AsyncStream<CLILogLine>.Continuation,
                             leaving group: DispatchGroup) {
        var buffer = Data()
        handle.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty {
                if !buffer.isEmpty {
                    if let s = String(data: buffer, encoding: .utf8) {
                        continuation.yield(CLILogLine(stream: stream, text: s))
                    }
                    buffer.removeAll()
                }
                fh.readabilityHandler = nil
                group.leave()
                return
            }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0a) {
                let lineData = buffer.subdata(in: 0..<nl)
                if let s = String(data: lineData, encoding: .utf8) {
                    continuation.yield(CLILogLine(stream: stream, text: s))
                }
                buffer.removeSubrange(0...nl)
            }
        }
    }
}
