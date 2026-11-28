import SwiftUI
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// What the app knows about an account key change (docs/account-key-rotation.md): a new key waiting for this
/// device, the rotator's progress, the cloud recovery the change turned off.
@Observable
@MainActor
public final class AccountKeyRotationCenter {
    public static let shared = AccountKeyRotationCenter()

    public enum Receive: Equatable, Sendable { case idle, waiting, installing, done, failed(String) }

    public private(set) var receive: Receive = .idle
    public private(set) var progress: AccountKeyRotationFlow.Progress?
    public private(set) var recoveryOff = false
    private var running = false

    public static let waitingLine = String(localized: "Your account key was changed. Unlock to continue.")
    public static let doneLine = String(localized: "This device has the new account key.")
    public static let recoveryOffLine = String(localized: "Cloud recovery is off since the account key changed. Set it up again.")
    public static let progressTitle = String(localized: "Account key change")
    public static func devicesLine(_ done: Int, _ total: Int) -> String { String(localized: "Devices updated: \(done) of \(total)") }
    public static func serversLine(_ done: Int, _ total: Int) -> String { String(localized: "Servers on the new key: \(done) of \(total)") }
    public static func waitingForLine(_ name: String) -> String { String(localized: "Waiting for \(name)") }

    /// Resume a rotation this device sent, then look for a key waiting for it. `interactive` may ask for the unlock.
    public func check(server: any FlagshipServerClient, app: AppState, interactive: Bool) async {
        guard !running, !app.isDemoAccount, let user = app.currentUser?.lowercased(), !user.isEmpty,
              let deviceId = app.activeProfile?.deviceId, AccountMetadata.isDeviceId(deviceId) else { return }
        running = true
        defer { running = false }
        let name = app.activeProfile?.deviceDisplayName
        await AccountKeyRotationService.resumePending(server: server, username: user, deviceId: deviceId, selfName: name)
        if interactive { receive = .installing }
        switch await AccountKeyRotationService.receive(server: server, username: user, deviceId: deviceId, interactive: interactive, selfName: name) {
        case .upToDate: if receive != .done { receive = .idle }
        case .waiting: receive = .waiting
        case .installed: receive = .done
        case .failed(let line): receive = .failed(line)
        }
        if Keystore.accountKeyRecoveryOff, (try? await server.hasCloudRecovery(username: user)) == true {
            Keystore.accountKeyRecoveryOff = false
        }
        recoveryOff = Keystore.accountKeyRecoveryOff
    }

    /// The rotator's progress card: kept devices back in the directory, servers that verified the new epoch.
    public func refreshProgress(server: any FlagshipServerClient, app: AppState, status: (PodInfo) async -> AccountKeyBoxStatus?) async {
        guard let record = Keystore.accountKeyProgress, let user = app.currentUser?.lowercased(),
              let deviceId = app.activeProfile?.deviceId, let key = AccountKeyRotationService.deviceKey(username: user, deviceId: deviceId),
              let dir = try? await AccountKeyRotationService.directory(server: server, username: user, deviceId: deviceId, key: key)
        else { progress = nil; return }
        var servers: [(name: String, trustedEpoch: Int64?)] = []
        for pod in app.placementPods { servers.append((pod.name, await status(pod)?.trustedEpoch)) }
        let p = AccountKeyRotationFlow.progress(kept: record.keptDeviceIds, selfProfileDeviceIds: Set(dir.selfProfiles.map(\.deviceId)),
                                                servers: servers, keyEpoch: record.toEpoch)
        if p.isComplete {
            Keystore.accountKeyProgress = nil
            progress = nil
        } else {
            progress = p
        }
    }

    public func dismissDone() { if receive == .done { receive = .idle } }

    /// Called by the rotator once it promoted.
    public func didRotate() {
        recoveryOff = Keystore.accountKeyRecoveryOff
    }
}

/// The calm line under the top of the shell while a new account key waits for this device, the rotator's
/// progress card and the cloud-recovery reminder.
public struct AccountKeyRotationBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.podScreensClients) private var podClients
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    private let center = AccountKeyRotationCenter.shared

    public init() {}

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(spacing: 0) {
            if app.isUnlocked, app.isPaired {
                switch center.receive {
                case .waiting, .installing:
                    line(c, text: AccountKeyRotationCenter.waitingLine, tint: c.accent,
                         button: center.receive == .installing ? nil : String(localized: "Unlock"), id: "account-key-waiting") {
                        Task { await center.check(server: server, app: app, interactive: true) }
                    }
                case .done:
                    line(c, text: AccountKeyRotationCenter.doneLine, tint: c.accent, button: String(localized: "OK"), id: "account-key-done") {
                        center.dismissDone()
                    }
                case .failed(let text):
                    line(c, text: text, tint: c.warning, button: nil, id: "account-key-failed") {}
                case .idle:
                    EmptyView()
                }
                if let p = center.progress {
                    progressCard(c, p)
                }
                if center.recoveryOff {
                    line(c, text: AccountKeyRotationCenter.recoveryOffLine, tint: c.warning, button: String(localized: "Set up"),
                         id: "account-key-recovery-off") { linker.enqueue(.recoverySetup) }
                }
            }
        }
        .task(id: "\(app.isUnlocked)|\(app.currentUser ?? "")|\(scenePhase == .active)") {
            guard app.isUnlocked, scenePhase == .active else { return }
            await center.check(server: server, app: app, interactive: false)
            await refresh()
        }
    }

    private func refresh() async {
        await center.refreshProgress(server: server, app: app) { pod in
            let client = await podClients.client(forFqdn: pod.fqdn)
            return try? await client.accountKeyStatus().status
        }
    }

    private func progressCard(_ c: FSColors, _ p: AccountKeyRotationFlow.Progress) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(c.accent).frame(width: 4)
            VStack(alignment: .leading, spacing: FS.space.s1) {
                Text(AccountKeyRotationCenter.progressTitle).font(FS.font.bodySm().weight(.semibold))
                Text(AccountKeyRotationCenter.devicesLine(p.devicesUpdated, p.devicesTotal)).font(FS.font.bodySm())
                Text(AccountKeyRotationCenter.serversLine(p.serversOnNewKey, p.serversTotal)).font(FS.font.bodySm())
                ForEach(p.waitingFor, id: \.self) { name in
                    Text(AccountKeyRotationCenter.waitingForLine(name)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
                FSSecondaryButton(String(localized: "Retry")) { Task { await refresh() } }
                    .accessibilityIdentifier("account-key-progress-retry")
            }
            .padding(FS.space.s3)
            Spacer(minLength: 0)
        }
        .background(c.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("account-key-progress")
    }

    private func line(_ c: FSColors, text: String, tint: Color, button: String?, id: String, action: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: FS.space.s2) {
            Rectangle().fill(tint).frame(width: 4)
            Text(text).font(FS.font.bodySm()).fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, FS.space.s3)
            Spacer(minLength: 0)
            if let button {
                FSSecondaryButton(button, action: action).padding(.trailing, FS.space.s3)
            }
        }
        .background(c.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}
