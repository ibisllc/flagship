import Foundation

public struct VMInstallObservation: Sendable, Equatable {
    public let phase: String
    public let detail: String?
    public let updatedAt: Date

    public init(phase: String, detail: String?, updatedAt: Date) {
        self.phase = phase
        self.detail = detail
        self.updatedAt = updatedAt
    }

    public var summary: String {
        if let detail, !detail.isEmpty { return detail }
        switch phase {
        case "booting": return "Booting the installer"
        case "partitioning": return "Preparing the encrypted disk"
        case "installing": return "Installing Debian"
        case "downloading": return "Downloading Flagship software"
        case "registering": return "Registering the server"
        case "sealing": return "Sealing the disk key"
        case "installed": return "Installation complete"
        case "pairing": return "Pairing with your phone"
        case "live": return "Server is live"
        case "error": return "Installation reported an error"
        default: return "Waiting for an installer checkpoint"
        }
    }

    public func isStale(at now: Date, threshold: TimeInterval = 3 * 60) -> Bool {
        now.timeIntervalSince(updatedAt) >= threshold
    }

    public func staleMinutes(at now: Date) -> Int {
        max(0, Int(now.timeIntervalSince(updatedAt)) / 60)
    }

    public static func decode(_ data: Data) -> VMInstallObservation? {
        struct Status: Decodable {
            let phase: String
            let detail: String?
            let updatedAt: Int64
        }
        let allowed = Set([
            "booting", "partitioning", "installing", "downloading", "registering",
            "sealing", "installed", "pairing", "live", "error",
        ])
        guard let status = try? JSONDecoder().decode(Status.self, from: data),
              allowed.contains(status.phase) else { return nil }
        let cleanDetail = status.detail.map {
            String($0.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(240))
        }
        return VMInstallObservation(
            phase: status.phase,
            detail: cleanDetail,
            updatedAt: Date(timeIntervalSince1970: Double(status.updatedAt) / 1000))
    }

    public static func statusURL(serial: String) -> URL? {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard (8...64).contains(serial.count),
              serial.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return URL(string: "https://flagshipserver.com/api/order/\(serial)/status")
    }
}
