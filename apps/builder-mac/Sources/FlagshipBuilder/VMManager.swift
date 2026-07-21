import Foundation
import SwiftUI
import FlagshipBuilderCore

/// Runtime orchestrator for hosted VMs: owns the inventory, one pure
/// `VMLifecycle` per VM (the decision-maker), and one `VZHost` per live VM
/// (the dumb executor). Every state change is persisted, so the sidebar
/// survives relaunches.
@MainActor
final class VMManager: ObservableObject {

    struct HostedServer: Identifiable, Equatable {
        var record: VMRecord
        var id: String { record.config.name }
    }

    @Published private(set) var servers: [HostedServer] = []
    @Published private(set) var installObservations: [String: VMInstallObservation] = [:]

    let store: VMInventoryStore
    /// Log sink — the wizard routes this into its log pane.
    var log: (String) -> Void = { _ in }

    private var lifecycles: [String: VMLifecycle] = [:]
    private var hosts: [String: VZHost] = [:]
    /// The lifecycle's attach/detach effect, remembered for the next start.
    private var attachISO: [String: Bool] = [:]
    private var unlockPolls: [String: Task<Void, Never>] = [:]
    private var installPolls: [String: Task<Void, Never>] = [:]
    private var installStallLogged: Set<String> = []

    init(layout: VMBundleLayout = VMBundleLayout(root: VMBundleLayout.defaultRoot())) {
        store = VMInventoryStore(layout: layout)
        loadAndNormalize()
    }

    /// How many VMs this host allows at once (pure cap math).
    var maxVMCount: Int { VMResourcePlan.maxVMCount(host: .current()) }
    var atCapacity: Bool { servers.count >= maxVMCount }

    func server(named name: String) -> HostedServer? {
        servers.first { $0.id == name }
    }

    /// The live VZ adapter for a VM (console access etc.), if it's running.
    func host(named name: String) -> VZHost? { hosts[name] }
    func installObservation(named name: String) -> VMInstallObservation? {
        installObservations[name]
    }

    // MARK: - Launch normalization

    /// VMs die with the app, so any persisted "live" state found at launch is
    /// stale: a mid-install VM becomes a retryable install failure; a booted
    /// one is simply stopped.
    private func loadAndNormalize() {
        var records = store.list()
        for i in records.indices {
            switch records[i].state {
            case .installing:
                records[i].state = .failed(VMFailure(
                    phase: .install, reason: "The app quit while the install was running."))
                records[i].stateChangedAt = Date()
                try? store.save(records[i])
            case .awaitingPhoneUnlock, .running:
                records[i].state = .stopped
                records[i].stateChangedAt = Date()
                try? store.save(records[i])
            default:
                break
            }
        }
        servers = records.map { HostedServer(record: $0) }
    }

    // MARK: - Creation

    /// Create the persistent bundle for a planned VM. The caller (wizard)
    /// then writes either the remastered installer ISO or cloned appliance +
    /// seed into the bundle and calls `beginInstall`.
    func createServer(config: VMConfig) throws {
        let record = VMRecord(config: config, state: .created,
                              createdAt: Date(), tier: .hostedVM)
        try store.create(record)
        servers.append(HostedServer(record: record))
        servers.sort { $0.id < $1.id }
        lifecycles[config.name] = VMLifecycle(state: .created,
                                              sealedAtBoot: config.awaitsPhoneUnlockAtBoot)
    }

    func installerISOPath(for name: String) -> URL { store.layout.installerISOURL(name) }
    func provisioningMediaExists(for server: HostedServer) -> Bool {
        let url = server.record.config.effectiveProvisioningMode == .prebuiltAppliance
            ? store.layout.applianceSeedURL(server.id)
            : store.layout.installerISOURL(server.id)
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Drop a hosted server entirely (its disk image included). Stops it
    /// first if live.
    func deleteServer(named name: String) async {
        if let host = hosts[name] { try? await host.forceStop() }
        hosts[name] = nil
        lifecycles[name] = nil
        unlockPolls[name]?.cancel()
        unlockPolls[name] = nil
        installPolls[name]?.cancel()
        installPolls[name] = nil
        installObservations[name] = nil
        installStallLogged.remove(name)
        try? store.delete(name: name)
        servers.removeAll { $0.id == name }
    }

    // MARK: - Lifecycle driving

    func beginInstall(named name: String) async { await apply(.startInstall, to: name) }
    func cancelInstall(named name: String) async {
        await apply(.installFailed("Installation stopped by you."), to: name)
    }
    func powerOn(named name: String) async { await apply(.powerOn, to: name) }
    func powerOff(named name: String) async { await apply(.powerOff, to: name) }

    /// Feed one event through the pure state machine, persist the new state,
    /// and execute the effects it ordered.
    private func apply(_ event: VMEvent, to name: String) async {
        guard var server = server(named: name) else { return }
        var lc = lifecycles[name] ?? VMLifecycle(
            state: server.record.state,
            sealedAtBoot: server.record.config.awaitsPhoneUnlockAtBoot)
        let effects: [VMEffect]
        do {
            effects = try lc.handle(event)
        } catch {
            log("VM \(name): ignored \(event) in state \(server.record.state.label)")
            return
        }
        lifecycles[name] = lc
        server.record.state = lc.state
        server.record.stateChangedAt = lc.stateChangedAt
        if case .installed = lc.state {
            server.record.config = server.record.config.clearingProvisionStatusSerial()
        }
        if case .running = lc.state {
            server.record.lastConnectedAt = lc.stateChangedAt
        }
        upsert(server)
        try? store.save(server.record)
        await run(effects: effects, on: server.record.config)
        syncUnlockPoll(for: server.record.config)
        syncInstallPoll(for: server.record.config)
    }

    private func run(effects: [VMEffect], on config: VMConfig) async {
        let name = config.name
        for effect in effects {
            switch effect {
            case .attachInstallerISO:
                attachISO[name] = true
            case .detachInstallerISO:
                attachISO[name] = false
                // Reclaim successful one-use provisioning media. A failed run
                // keeps it so Retry can re-attach the exact verified input.
                if case .installed = currentState(name) {
                    let media = config.effectiveProvisioningMode == .prebuiltAppliance
                        ? store.layout.applianceSeedURL(name)
                        : store.layout.installerISOURL(name)
                    try? FileManager.default.removeItem(at: media)
                }
            case .startVirtualMachine:
                await startVM(config: config)
            case .stopVirtualMachine:
                if let host = hosts[name] {
                    try? await host.forceStop()
                    hosts[name] = nil
                }
            }
        }
    }

    private func currentState(_ name: String) -> VMState {
        server(named: name)?.record.state ?? .created
    }

    private func startVM(config: VMConfig) async {
        let name = config.name
        #if canImport(Virtualization)
        do {
            try VZHost.ensureMainDisk(config: config, layout: store.layout)
            let host = VZHost()
            host.onGuestStopped = { [weak self] error in
                guard let self else { return }
                Task { await self.guestStopped(name: name, error: error) }
            }
            hosts[name] = host
            try await host.start(config: config, layout: store.layout,
                                 attachInstallerISO: attachISO[name] ?? false)
            log("VM \(name): started (\(config.cpuCount) vCPU, \(config.memoryBytes / VMResourcePlan.gib) GiB)")
        } catch {
            hosts[name] = nil
            let reason = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            log("VM \(name): failed to start — \(reason)")
            switch currentState(name) {
            case .installing: await apply(.installFailed(reason), to: name)
            case .awaitingPhoneUnlock, .running: await apply(.runtimeFailed(reason), to: name)
            default: break
            }
        }
        #else
        log("VM \(name): Virtualization.framework unavailable on this build")
        #endif
    }

    /// The guest stopped on its own. What it MEANS depends on the phase the
    /// pure lifecycle is in: during install, a clean self-stop is the
    /// unattended installer completing; afterwards it's a shutdown (clean) or
    /// a crash (error).
    ///
    /// The install→success read is guarded by ELAPSED TIME (see
    /// `VMLifecycle.verdictForCleanInstallStop`): the shipping preseed powers
    /// the guest off at the end of a multi-minute install, and a finish-install
    /// that instead REBOOTS also surfaces here as a clean stop — both are
    /// "installed" once a plausible amount of time has passed. But a guest that
    /// never booted (e.g. a wrong-architecture base image, which VZ stops ~0.3s
    /// after start with no error) must NOT be read as a successful install; it
    /// is a fast-clean-stop failure.
    private func guestStopped(name: String, error: Error?) async {
        hosts[name] = nil
        switch currentState(name) {
        case .installing:
            if let error {
                await apply(.installFailed((error as? LocalizedError)?.errorDescription ?? "\(error)"), to: name)
            } else {
                let startedAt = lifecycles[name]?.stateChangedAt ?? .distantPast
                switch VMLifecycle.verdictForCleanProvisioningStop(
                    mode: server(named: name)?.record.config.effectiveProvisioningMode ?? .installerISO,
                    installStartedAt: startedAt,
                    now: Date()) {
                case .installed:
                    let verb = server(named: name)?.record.config.effectiveProvisioningMode == .prebuiltAppliance
                        ? "specialization finished"
                        : "install finished"
                    log("VM \(name): \(verb) — booting sealed disk")
                    await apply(.installSucceeded, to: name)
                    // First boot from disk follows immediately; an encrypted
                    // guest then sits sealed in awaiting-phone-unlock.
                    await apply(.powerOn, to: name)
                case .failedTooFast(let elapsed):
                    let operation = server(named: name)?.record.config.effectiveProvisioningMode == .prebuiltAppliance
                        ? "specialization"
                        : "install"
                    log("VM \(name): stopped after \(Int(elapsed))s, before \(operation) could run")
                    await apply(.installFailed(
                        "The virtual machine stopped after \(Int(elapsed))s, before \(operation) could run. "
                        + "The base image may be the wrong architecture for this Mac "
                        + "(Apple silicon can only run an arm64 image) or otherwise not bootable."),
                        to: name)
                }
            }
        case .awaitingPhoneUnlock, .running:
            if let error {
                await apply(.runtimeFailed((error as? LocalizedError)?.errorDescription ?? "\(error)"), to: name)
            } else {
                await apply(.powerOff, to: name)
            }
        default:
            break
        }
    }

    // MARK: - Unlock detection

    /// While a guest sits sealed, poll its public FQDN. Any HTTP response
    /// means the LUKS unlock completed, the daemon came up, and the tunnel is
    /// serving — real evidence, not a timer. (The phone-approval itself
    /// happens phone↔box; the host app is not in that loop and never holds a
    /// key.)
    private func syncUnlockPoll(for config: VMConfig) {
        let name = config.name
        let sealed = currentState(name) == .awaitingPhoneUnlock
        if !sealed {
            unlockPolls[name]?.cancel()
            unlockPolls[name] = nil
            return
        }
        guard unlockPolls[name] == nil,
              let url = URL(string: "https://\(config.serverDomain)/") else { return }
        unlockPolls[name] = Task { [weak self] in
            let session = URLSession(configuration: {
                let c = URLSessionConfiguration.ephemeral
                c.timeoutIntervalForRequest = 10
                return c
            }())
            while !Task.isCancelled {
                if let (_, response) = try? await session.data(from: url),
                   response is HTTPURLResponse {
                    await self?.apply(.guestUnlocked, to: name)
                    return
                }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    // MARK: - Privacy-safe install checkpoints

    /// Read the same allowlisted order-status stream the phone consumes. The
    /// guest sends only a canonical phase, a fixed stage label, and elapsed
    /// minutes — never syslog, package output, recipe bytes, keys, or content.
    private func syncInstallPoll(for config: VMConfig) {
        let name = config.name
        guard currentState(name) == .installing,
              installPolls[name] == nil,
              let serial = config.provisionStatusSerial,
              let url = VMInstallObservation.statusURL(serial: serial) else {
            if currentState(name) != .installing {
                installPolls[name]?.cancel()
                installPolls[name] = nil
                installStallLogged.remove(name)
            }
            return
        }
        let installStartedAt = server(named: name)?.record.stateChangedAt ?? Date()
        installPolls[name] = Task { [weak self] in
            let session = URLSession(configuration: {
                let c = URLSessionConfiguration.ephemeral
                c.timeoutIntervalForRequest = 10
                return c
            }())
            while !Task.isCancelled {
                if let (data, response) = try? await session.data(from: url),
                   (response as? HTTPURLResponse)?.statusCode == 200,
                   let observation = VMInstallObservation.decode(data),
                   observation.updatedAt >= installStartedAt.addingTimeInterval(-30) {
                    self?.receiveInstallObservation(observation, name: name)
                }
                self?.reportInstallStallIfNeeded(name: name)
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    private func receiveInstallObservation(_ observation: VMInstallObservation, name: String) {
        let prior = installObservations[name]
        installObservations[name] = observation
        if prior != observation {
            log("VM \(name): installer checkpoint — \(observation.summary)")
        }
        if !observation.isStale(at: Date()) { installStallLogged.remove(name) }
    }

    private func reportInstallStallIfNeeded(name: String) {
        guard let observation = installObservations[name],
              observation.isStale(at: Date()),
              !installStallLogged.contains(name) else { return }
        installStallLogged.insert(name)
        log("VM \(name): no guest checkpoint for \(observation.staleMinutes(at: Date())) minutes; last: \(observation.summary)")
    }

    private func upsert(_ server: HostedServer) {
        if let i = servers.firstIndex(where: { $0.id == server.id }) {
            servers[i] = server
        } else {
            servers.append(server)
            servers.sort { $0.id < $1.id }
        }
    }
}
