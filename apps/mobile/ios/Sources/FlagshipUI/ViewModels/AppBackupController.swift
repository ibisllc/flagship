import Foundation
import Observation
import FlagshipAPI

/// "Back up now" on an app's page, as the webapp's Backup card does: the box
/// packs the app's source and, if asked, its data (encrypted when a password
/// is given), then hands the archive to this phone once and deletes it. The
/// bytes go box → phone only; the phone saves them where the owner picks.
@Observable
@MainActor
public final class AppBackupController {
    public enum Phase: Equatable {
        case idle
        case creating
        case downloading
        /// The archive is on this phone at `file`, ready to save or share.
        case ready(file: URL, bytes: Int, encrypted: Bool)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public var includeData = false
    public var password = ""

    public var isBusy: Bool { phase == .creating || phase == .downloading }

    private let serviceId: String
    private let client: any ScreensClient
    private let directory: URL
    private let now: () -> Date

    public init(
        serviceId: String,
        client: any ScreensClient,
        directory: URL = FileManager.default.temporaryDirectory,
        now: @escaping () -> Date = Date.init
    ) {
        self.serviceId = serviceId
        self.client = client
        self.directory = directory
        self.now = now
    }

    public func backUp() async {
        guard !isBusy else { return }
        phase = .creating
        do {
            let started = try await client.appBackupStart(AppBackupStartRequest(
                serviceId: serviceId,
                password: password.isEmpty ? nil : password,
                includeUserData: includeData
            ))
            phase = .downloading
            let data = try await client.appBackupFetch(fetchPath: started.fetchPath)
            let file = directory.appendingPathComponent(
                Self.fileName(serviceId: serviceId, encrypted: started.encrypted, at: now())
            )
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            password = ""
            phase = .ready(file: file, bytes: data.count, encrypted: started.encrypted)
        } catch {
            phase = .failed(ScreensClientError.userFacing(error))
        }
    }

    /// `<slug>-backup-<yyyy-MM-dd-HHmm>.tar.gz`, `.enc` added when encrypted
    /// (the box's own naming).
    nonisolated static func fileName(serviceId: String, encrypted: Bool, at date: Date) -> String {
        let slug = serviceId.components(separatedBy: "--").last ?? serviceId
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd-HHmm"
        return "\(slug)-backup-\(f.string(from: date)).tar.gz\(encrypted ? ".enc" : "")"
    }
}
