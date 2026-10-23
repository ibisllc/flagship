import CryptoKit
import Foundation

/// First contact, Studio's half (docs/first-contact.md). A server Studio hosts prints its six-digit
/// code and its key on a dedicated output-only virtio port; Studio, which got a per-server
/// `studioConfirmKey` from the phone beside the recipe (never inside it), reports what it saw to
/// `.com` as an HMAC the phone checks, so the phone can show "Confirmed by Studio" in place of
/// asking the owner to compare the code. Mirrors `serverSeenMacHex` in
/// packages/protocol/src/enrollment.ts and the Windows and Linux Studios.
public enum ServerCodeSeen {
    /// The guest sees it as /dev/virtio-ports/<portName>. Output only: the host never writes to it.
    public static let portName = "org.flagshipserver.server-code"
    public static let seenTag = "flagship/server-code-seen/v1"

    public struct Sighting: Equatable, Sendable {
        public let code: String
        public let stkPubHex: String
    }

    private static func isHex64(_ s: Substring) -> Bool {
        s.count == 64 && s.allSatisfy { "0123456789abcdef".contains($0) }
    }

    /// `flagship-server-code <domain> <6 digits> <64 lowercase hex>`, for this server only.
    public static func parse(_ line: String, serverDomain: String) -> Sighting? {
        let parts = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
        guard parts.count == 4, parts[0] == "flagship-server-code",
              parts[1].lowercased() == serverDomain.lowercased(),
              parts[2].count == 6, parts[2].allSatisfy({ $0.isASCII && $0.isNumber }),
              isHex64(parts[3]) else { return nil }
        return Sighting(code: String(parts[2]), stkPubHex: String(parts[3]))
    }

    public static func macHex(studioConfirmKey: Data, serverDomain: String, stkPubHex: String) -> String? {
        guard studioConfirmKey.count == 32, isHex64(Substring(stkPubHex)), !serverDomain.contains("|") else { return nil }
        let msg = Data("\(seenTag)|\(serverDomain.lowercased())|\(stkPubHex)".utf8)
        return Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: studioConfirmKey)))
            .map { String(format: "%02x", $0) }.joined()
    }

    /// The JSON body of `POST /api/order/<serial>/server-seen`.
    public static func body(stkPubHex: String, macHex: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["stkPubHex": stkPubHex, "macHex": macHex], options: [.sortedKeys])) ?? Data()
    }

    /// "482 913", the way the box shows it.
    public static func pretty(_ code: String) -> String {
        code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    }
}

/// Splits the port's bytes into lines; a line longer than any real one is dropped, not buffered forever.
public struct ConsoleLineSplitter: Sendable {
    private var buffer = Data()
    private let maxLine: Int

    public init(maxLine: Int = 4096) { self.maxLine = maxLine }

    public mutating func feed(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: 0x0a) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = String(data: line, encoding: .utf8) { lines.append(s) }
        }
        if buffer.count > maxLine { buffer.removeAll() }
        return lines
    }
}

/// The per-server key, beside the VM bundle (0600) until Studio has reported what it saw.
public enum StudioConfirmKeyFile {
    public static func url(layout: VMBundleLayout, name: String) -> URL {
        layout.bundleDir(name).appendingPathComponent("studio-confirm.key")
    }

    public static func write(_ key: Data, layout: VMBundleLayout, name: String) throws {
        guard key.count == 32 else { return }
        let u = url(layout: layout, name: name)
        try key.write(to: u, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: u.path)
    }

    public static func read(layout: VMBundleLayout, name: String) -> Data? {
        guard let d = try? Data(contentsOf: url(layout: layout, name: name)), d.count == 32 else { return nil }
        return d
    }

    public static func delete(layout: VMBundleLayout, name: String) {
        try? FileManager.default.removeItem(at: url(layout: layout, name: name))
    }
}
