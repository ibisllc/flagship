#if canImport(BackgroundTasks) && os(iOS)
import Foundation
import BackgroundTasks
import Network
import FlagshipAPI
import FlagshipCore

/// Keeps a copy of each phone-side server's newest backup on this phone
/// (docs/server-backup-and-clone.md, "Backup policy"): a BGProcessingTask
/// that runs only on external power with a network, skips metered or
/// constrained networks (Wi-Fi only), and is rescheduled after every run.
/// Downloading is a session read; nothing is opened, so no key is needed.
public enum PhoneBackupTask {
    public static let identifier = "com.flagshipserver.app.backup-fetch"
    /// iOS decides when; this is only the earliest.
    static let interval: TimeInterval = 6 * 3600

    nonisolated(unsafe) private static var clients: PodScreensClientFactory?

    /// Register the handler. Must run before the app finishes launching.
    public static func register(clients: PodScreensClientFactory) {
        guard self.clients == nil else { return }
        self.clients = clients
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
    }

    /// Ask for the next run (idempotent: a pending request is replaced).
    public static func schedule() {
        guard clients != nil else { return }
        let r = BGProcessingTaskRequest(identifier: identifier)
        r.requiresExternalPower = true
        r.requiresNetworkConnectivity = true
        r.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        try? BGTaskScheduler.shared.submit(r)
    }

    private static func handle(_ task: BGProcessingTask) {
        schedule()
        guard let clients else {
            task.setTaskCompleted(success: false)
            return
        }
        let work = Task {
            guard await isUnmetered() else {
                task.setTaskCompleted(success: true)
                return
            }
            _ = await PhoneBackupFetcher.runOnce(clients: clients, freeBytes: DeviceStorage.freeBytes)
            task.setTaskCompleted(success: !Task.isCancelled)
        }
        // Stop cleanly: the parts already in stay, and the next run resumes.
        task.expirationHandler = { work.cancel() }
    }

    /// Wi-Fi (or wired), not a hotspot or Low Data Mode.
    private static func isUnmetered() async -> Bool {
        await withCheckedContinuation { cont in
            let monitor = NWPathMonitor()
            let once = Once()
            monitor.pathUpdateHandler = { path in
                guard once.claim() else { return }
                monitor.cancel()
                cont.resume(returning: path.status == .satisfied && !path.isExpensive && !path.isConstrained)
            }
            monitor.start(queue: DispatchQueue(label: "flagship.backup-fetch.path"))
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
    }
}
#endif
