import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Settings → Quantum-safe protection (docs/architecture-v2/pq-suites.md §13.6). Per server:
/// where its policy stands, whether it is ready, and the owner's choices for turning strict on
/// (the browser question, then each classical connector) or leaving it.
@MainActor
@Observable
public final class QuantumSafetyViewModel {
    public struct ServerRow: Identifiable, Equatable {
        public let fqdn: String
        public let name: String
        public var replayed: QuantumSafety.Replayed?
        public var readiness: QuantumSafety.Readiness?
        /// This server's apps and each one's browser answer (strict servers only).
        public var apps: [AppChoice] = []
        public var id: String { fqdn }
        public var strict: Bool { replayed.map { AssurancePolicy.strictInForce($0.state) } ?? false }
    }

    /// One app's own scope (`<server>:<service id>`): strict there means only the Flagship app
    /// reaches it; otherwise browsers may (pq-suites.md §13.6, the box's app gate).
    public struct AppChoice: Identifiable, Equatable {
        public let serviceId: String
        public let name: String
        public var replayed: QuantumSafety.Replayed?
        public var id: String { serviceId }
        public var appOnly: Bool { replayed.map { AssurancePolicy.strictInForce($0.state) } ?? false }
    }

    public enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    public private(set) var phase: Phase = .idle
    public private(set) var servers: [ServerRow] = []
    public private(set) var connectors: [QuantumSafety.Connector] = QuantumSafety.connectors(aiProviders: [])
    public private(set) var thisDeviceCustody: String?
    public var message: String?
    public private(set) var busy = false

    private let app: AppState
    private let now: () -> Int64
    private let clients: PodScreensClientFactory?
    /// What load() verified, kept for the re-entry evidence a later turnOn signs.
    private var verified: (devices: [StrictReentry.Binding], deviceCount: Int, adminRoot: StrictReentry.Binding?, recovery: [String: Bool]) = ([], 0, nil, [:])

    public init(app: AppState, clients: PodScreensClientFactory? = nil, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.app = app
        self.clients = clients
        self.now = now
    }

    private var user: String { (app.currentUser ?? "").lowercased() }
    private var deviceId: String { (app.activeProfile?.deviceId ?? "").lowercased() }

    public func load(aiProviders: [String] = []) async {
        guard let client = PqIdentityBindingService.client, !user.isEmpty else {
            phase = .failed("Quantum-safe protection isn't available on this account.")
            return
        }
        phase = .loading
        connectors = QuantumSafety.connectors(aiProviders: aiProviders)
        let deviceKey = Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId)
        let deviceIdentity = deviceKey.map { PqIdentity(role: .device, subjectId: deviceId, edKey: $0) }
        thisDeviceCustody = deviceIdentity.flatMap { PqKeyStore.shared.custody(for: $0) }?.label
        let thisBound = deviceIdentity.flatMap { PqKeyStore.shared.status(for: $0) } == .bound
        let counts = await client.deviceBindingCounts(username: user)
        let bindings = try? await client.fetch(username: user)
        let root = Keystore.adminRootPubHex()?.lowercased()
        let rootBinding = root.flatMap { r in bindings?.adminRoot.flatMap { try? PqTrust.verifyPqKeyBinding($0, PqBindingExpectation(role: "admin-root", subjectId: user, ed25519PubHex: r, now: now())) } }
        let myPub = deviceKey.map { QSHex.hex([UInt8]($0.publicKey.rawRepresentation)) }
        let myBinding = myPub.flatMap { p in bindings?.devices.first { $0.ed25519PubHex == p }.flatMap { try? PqTrust.verifyPqKeyBinding($0, PqBindingExpectation(role: "device", subjectId: deviceId, ed25519PubHex: p, now: now())) } }
        var rows: [ServerRow] = []
        for pod in app.pods where !pod.isRevoked && !pod.fqdn.isEmpty {
            let host = pod.fqdn.lowercased()
            let wire = await client.fetchServerBinding(serverDomain: host)
            let serverBound = (try? BoxKeyPins.shared.acceptStkPqBinding(username: user, serverDomain: host, wire: wire)) != nil
            let scope = PolicyScope(kind: .installation, id: host)
            var row = ServerRow(fqdn: host, name: pod.name, replayed: QuantumSafetyService.store.replayed(account: user, scope: scope), readiness: nil)
            if let served = try? await client.fetchPolicy(username: user, scope: scope) {
                if let r = try? QuantumSafety.replay(scope: scope, account: user, chain: served.chain, current: row.replayed?.state,
                                                     adminRootHex: root, isAdminDevice: { $0 == myPub },
                                                     bindingFor: { $0 == root ? rootBinding : ($0 == myPub ? myBinding : nil) }) {
                    try? QuantumSafetyService.store.adopt(account: user, r)
                    row.replayed = r
                }
                row.readiness = QuantumSafety.Readiness(devicesBound: counts?.bound ?? 0, devices: counts?.devices ?? 0, thisDeviceBound: thisBound,
                                                        thisDeviceIsAdmin: Keystore.hasAdminRoot, recoveryChecked: served.recoveryChecked, serverBound: serverBound)
            }
            verified.recovery[host] = row.readiness?.recoveryChecked ?? false
            if row.strict, let clients { row.apps = await loadApps(host: host, clients: clients, root: root, myPub: myPub, rootBinding: rootBinding, myBinding: myBinding) }
            rows.append(row)
        }
        // Every device binding verified under its own registered key: the enrollment the
        // re-entry evidence commits to (the device list itself comes from .com's device book).
        let deviceBindings = (bindings?.devices ?? []).compactMap { w in
            (try? PqTrust.verifyPqKeyBinding(w, PqBindingExpectation(role: "device", subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: now()))).map(StrictReentry.Binding.init)
        }
        verified.devices = deviceBindings
        verified.deviceCount = counts?.devices ?? 0
        verified.adminRoot = rootBinding.map(StrictReentry.Binding.init)
        servers = rows
        phase = .loaded
    }

    private func loadApps(host: String, clients: PodScreensClientFactory, root: String?, myPub: String?,
                          rootBinding: VerifiedPqKeyBinding?, myBinding: VerifiedPqKeyBinding?) async -> [AppChoice] {
        guard let client = PqIdentityBindingService.client,
              let list = try? await clients.client(forFqdn: host).appsList().apps else { return [] }
        var out: [AppChoice] = []
        for a in list {
            let scope = QuantumSafety.serviceScope(server: host, service: a.serviceId)
            var choice = AppChoice(serviceId: a.serviceId, name: a.urlLabel.isEmpty ? a.slug : a.urlLabel,
                                   replayed: QuantumSafetyService.store.replayed(account: user, scope: scope))
            if let served = try? await client.fetchPolicy(username: user, scope: scope),
               let r = try? QuantumSafety.replay(scope: scope, account: user, chain: served.chain, current: choice.replayed?.state,
                                                 adminRootHex: root, isAdminDevice: { $0 == myPub },
                                                 bindingFor: { $0 == root ? rootBinding : ($0 == myPub ? myBinding : nil) }) {
                try? QuantumSafetyService.store.adopt(account: user, r)
                choice.replayed = r
            }
            out.append(choice)
        }
        return out
    }

    /// The re-entry evidence for a scope that was strict before (assurancePolicy.ts): what this
    /// device verified in load(), the server's PQ key it holds pinned, and a fresh nonce.
    private func reentryEvidence(scope: PolicyScope, server fqdn: String) async throws -> StrictReentryEvidence {
        guard let client = PqIdentityBindingService.client,
              let head = try? await client.fetchPolicy(username: user, scope: scope).chain.last?.change else {
            throw QuantumSafetyRefusal("Couldn't read this server's protection history. Check your connection and try again.")
        }
        guard let box = BoxKeyPins.shared.verifiedBoxPqBinding(username: user, serverDomain: fqdn) else {
            throw QuantumSafetyRefusal("This device hasn't checked the server's post-quantum key yet. Open the server once, then try again.")
        }
        let t = now()
        let inputs = StrictReentry.Inputs(account: user, scope: scope, leftStrictAt: head.issuedAt, devices: verified.devices,
                                          deviceCount: verified.deviceCount, adminRoot: verified.adminRoot, server: StrictReentry.Binding(box),
                                          recoveryChecked: verified.recovery[fqdn] ?? false, recoveryCheckedAt: t,
                                          nonceHex: StrictReentry.freshNonce(), checkedAt: t)
        do { return try StrictReentry.evidence(inputs) } catch let r as StrictReentry.Refusal { throw QuantumSafetyRefusal(r.sentence) }
    }

    /// One app's browser answer on a strict server: "only the Flagship app" signs the app's own
    /// scope to strict; "also browsers" signs it back to compatibility, naming the loss.
    public func setAppBrowsers(server fqdn: String, serviceId: String, allowed: Bool) async -> Bool {
        guard let row = servers.first(where: { $0.fqdn == fqdn }), let a = row.apps.first(where: { $0.serviceId == serviceId }) else { return false }
        guard a.appOnly == allowed else { return true }
        busy = true; defer { busy = false }
        do {
            let s = try await signer(reason: allowed ? "Let browsers reach \(a.name)" : "Keep browsers away from \(a.name)")
            let pub = QSHex.hex([UInt8](s.edKey.publicKey.rawRepresentation))
            let scope = QuantumSafety.serviceScope(server: fqdn, service: serviceId)
            let state = a.replayed?.state ?? AssurancePolicy.legacyState(scope)
            let change: AssurancePolicyChange
            if allowed {
                change = QuantumSafety.compatibilityChange(account: user, scope: scope, from: state, loss: [QuantumSafety.browserLoss],
                                                           peers: [fqdn], signerKind: s.kind, signerKeyId: pub, now: now())
            } else {
                let reentry = state.enforcedEver ? try await reentryEvidence(scope: scope, server: fqdn) : nil
                change = QuantumSafety.strictChange(account: user, scope: scope, from: state, browsersAllowed: false, peers: [fqdn],
                                                    signerKind: s.kind, signerKeyId: pub, now: now(), reentry: reentry)
            }
            try await signAndPost(change, s)
            message = allowed ? "Browsers can reach \(a.name) again, within 15 minutes." : "Only the Flagship app reaches \(a.name) now, within 15 minutes."
            await load()
            return true
        } catch {
            message = (error as? QuantumSafetyRefusal)?.sentence ?? "\(a.name) wasn't changed."
            return false
        }
    }

    /// The admin root and its PQ half when this device bound it, else this admin device's key.
    private func signer(reason: String) async throws -> (kind: PolicySignerKind, edKey: Curve25519.Signing.PrivateKey, role: PqBindingRole, subject: String) {
        let key = try await ServerOrderSaver.sensitiveOrderKey(reason: reason)
        if Keystore.hasAdminRoot, await PqKeyStore.shared.key(for: PqIdentity(role: .adminRoot, subjectId: user, edKey: key)) != nil {
            return (.adminRoot, key, .adminRoot, user)
        }
        guard let dev = Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId) else { throw QuantumSafetyRefusal("Unlock the app and try again.") }
        return (.adminDevice, dev, .device, deviceId)
    }

    private func signAndPost(_ change: AssurancePolicyChange, _ s: (kind: PolicySignerKind, edKey: Curve25519.Signing.PrivateKey, role: PqBindingRole, subject: String)) async throws {
        guard let client = PqIdentityBindingService.client else { throw QuantumSafetyRefusal("Not available on this account.") }
        guard let held = await PqKeyStore.shared.key(for: PqIdentity(role: s.role, subjectId: s.subject, edKey: s.edKey)) else {
            throw QuantumSafetyRefusal("This device's post-quantum key isn't ready. Unlock the app once while online, then try again.")
        }
        let env = try QuantumSafety.hybridEnvelope(message: try AssurancePolicy.canonical(change), edPublicKey: [UInt8](s.edKey.publicKey.rawRepresentation),
                                                   edSign: { [UInt8](try s.edKey.signature(for: Data($0))) }, held: held)
        if let code = await client.postPolicyChange(username: user, change: change, signature: env) {
            throw QuantumSafetyRefusal(Self.sentence(for: code))
        }
    }

    /// Turns strict on for one server. `browsersAllowed` is the owner's answer to the browser
    /// question; `blocked` lists the classical connectors the owner chose to block.
    public func turnOn(server fqdn: String, browsersAllowed: Bool, blocked: Set<String>) async -> Bool {
        guard let row = servers.first(where: { $0.fqdn == fqdn }) else { return false }
        busy = true; defer { busy = false }
        do {
            let s = try await signer(reason: "Turn on quantum-safe protection for \(row.name)")
            let pub = QSHex.hex([UInt8](s.edKey.publicKey.rawRepresentation))
            let scope = PolicyScope(kind: .installation, id: fqdn)
            let state = row.replayed?.state ?? AssurancePolicy.legacyState(scope)
            // Back to strict after a compatibility period: sign what this device re-checked.
            let reentry = state.enforcedEver ? try await reentryEvidence(scope: scope, server: fqdn) : nil
            try await signAndPost(QuantumSafety.strictChange(account: user, scope: scope, from: state, browsersAllowed: browsersAllowed, peers: [fqdn],
                                                             signerKind: s.kind, signerKeyId: pub, now: now(), reentry: reentry), s)
            for c in connectors where c.needsChoice && blocked.contains(c.id) {
                let cs = QuantumSafety.connectorScope(server: fqdn, connector: c.id)
                let held = QuantumSafetyService.store.replayed(account: user, scope: cs)?.state ?? AssurancePolicy.legacyState(cs)
                guard !AssurancePolicy.strictInForce(held) else { continue }
                let connectorReentry = held.enforcedEver ? try await reentryEvidence(scope: cs, server: fqdn) : nil
                try await signAndPost(QuantumSafety.strictChange(account: user, scope: cs, from: held, browsersAllowed: false, peers: [fqdn],
                                                                 signerKind: s.kind, signerKeyId: pub, now: now(), reentry: connectorReentry), s)
            }
            message = "Quantum-safe protection is on for \(row.name). It takes effect when the server next checks in, within 15 minutes."
            await load()
            return true
        } catch {
            message = (error as? QuantumSafetyRefusal)?.sentence ?? "Quantum-safe protection wasn't changed."
            return false
        }
    }

    /// Leaves strict for one server after the owner read and accepted what is lost.
    public func turnOff(server fqdn: String) async -> Bool {
        guard let row = servers.first(where: { $0.fqdn == fqdn }), let state = row.replayed?.state else { return false }
        busy = true; defer { busy = false }
        do {
            let s = try await signer(reason: "Turn off quantum-safe protection for \(row.name)")
            let pub = QSHex.hex([UInt8](s.edKey.publicKey.rawRepresentation))
            try await signAndPost(QuantumSafety.compatibilityChange(account: user, scope: state.scope, from: state, loss: QuantumSafety.leavingStrictLoss,
                                                                    peers: [fqdn], signerKind: s.kind, signerKeyId: pub, now: now()), s)
            message = "\(row.name) is back to compatibility. Turning strict on again later needs a fresh check of every device and your recovery."
            await load()
            return true
        } catch {
            message = (error as? QuantumSafetyRefusal)?.sentence ?? "Quantum-safe protection wasn't changed."
            return false
        }
    }

    static func sentence(for code: String) -> String {
        switch code {
        case "not-prepared": return "The server isn't ready yet: every device, the server and your recovery need their post-quantum keys first."
        case "classical-signer-refused", "strict-requires-hybrid", "strict-requires-binding": return "This device's post-quantum key isn't registered yet. Unlock the app once while online, then try again."
        case "stale-generation", "fork": return "Another device changed this at the same time. Refresh and try again."
        case "reentry-incomplete": return "Turning strict on again needs a fresh check of every device, a rekey and a tested recovery."
        case "network": return "Couldn't reach flagshipserver.com. Check your connection and try again."
        default: return "flagshipserver.com didn't accept the change (\(code))."
        }
    }
}

public struct QuantumSafetyRefusal: Error, Equatable {
    public let sentence: String
    public init(_ s: String) { sentence = s }
}
