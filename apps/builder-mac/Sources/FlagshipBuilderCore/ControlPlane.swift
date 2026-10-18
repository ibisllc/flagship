import Foundation

/// The control plane Studio talks to: flagshipserver.com, or the host named by
/// FLAGSHIP_CONTROL_HOST (the gym, a self-hosted plane). The install-status and
/// health polls, the pairing relay and the boot worker baked into a server's
/// seed all follow it, or a Studio pointed elsewhere never sees its guest's
/// checkpoints and seals a disk that asks prod to approve its unlock. Mirrors
/// the Windows (`FLAGSHIP_CONTROL_HOST` in VMManager.cs) and Linux
/// (`vm/control_plane.py`) Studios.
public enum ControlPlane {
    public static let defaultHost = "flagshipserver.com"

    /// The configured host, or production when unset or not a plain host
    /// (letters, digits, dots, dashes, optional port).
    public static func host(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        let raw = (environment["FLAGSHIP_CONTROL_HOST"] ?? "").trimmingCharacters(in: .whitespaces)
        return isPlainHost(raw) ? raw : defaultHost
    }

    /// `https://boot.<host>`: the boot worker a sealed disk asks for its unlock.
    public static func bootHost(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        "https://boot.\(host(environment: environment))"
    }

    public static func orderURL(serial: String, leaf: String,
                                environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        URL(string: "https://\(host(environment: environment))/api/order/\(serial)/\(leaf)")
    }

    static func isPlainHost(_ s: String) -> Bool {
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2, let name = parts.first, !name.isEmpty else { return false }
        if parts.count == 2 {
            let port = parts[1]
            guard (1...5).contains(port.count), port.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        }
        guard let first = name.first, let last = name.last,
              first.isASCII, last.isASCII,
              first.isLetter || first.isNumber, last.isLetter || last.isNumber else { return false }
        return name.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "-" }
    }
}
