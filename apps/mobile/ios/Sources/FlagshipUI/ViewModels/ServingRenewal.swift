import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Renewal on use (serving-wiring.md section 4): each time the app opens on an admin device, sign
/// the serving lease of every server whose policy has a time limit and post them to `.com` in one
/// call, best effort also to each box. Never a prompt: the renewal key signs without one. Until
/// the key is delegated (one admin-root signature, at a Face ID the owner does anyway) a lease is
/// signed with the admin root only when the session already holds it; otherwise nothing is signed.
@MainActor
public struct ServingRenewer {
    public typealias BoxClient = (String) async -> (any ScreensClient)?

    let username: String
    let mailbox: any SecretMailboxClient
    let box: BoxClient?
    /// The renewal key, made if there is none. Nil where the device can't hold one.
    let renewalKey: () -> RenewalKey.Signer?
    /// The admin root without a prompt (the session holds it), else nil.
    let silentAdminRoot: () -> Curve25519.Signing.PrivateKey?
    /// This device's account device key (64 hex), without a prompt; nil when not at hand.
    let deviceKeyPub: () -> String?
    let delegation: (String) -> SignedServingRecord<RenewalKeyDelegation>?
    let recordDelegation: (SignedServingRecord<RenewalKeyDelegation>) -> Void
    let state: ServingStateStore
    let now: () -> Int64

    public init(
        username: String,
        mailbox: any SecretMailboxClient,
        box: BoxClient?,
        renewalKey: @escaping () -> RenewalKey.Signer? = { try? RenewalKey.loadOrCreate() },
        silentAdminRoot: @escaping () -> Curve25519.Signing.PrivateKey? = { Keystore.sessionAdminRoot() },
        deviceKeyPub: @escaping () -> String?,
        delegation: @escaping (String) -> SignedServingRecord<RenewalKeyDelegation>? = { RenewalKey.delegation(account: $0) },
        recordDelegation: @escaping (SignedServingRecord<RenewalKeyDelegation>) -> Void = { RenewalKey.recordDelegation($0) },
        state: ServingStateStore = ServingStateStore(),
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.username = username.lowercased()
        self.mailbox = mailbox
        self.box = box
        self.renewalKey = renewalKey
        self.silentAdminRoot = silentAdminRoot
        self.deviceKeyPub = deviceKeyPub
        self.delegation = delegation
        self.recordDelegation = recordDelegation
        self.state = state
        self.now = now
    }

    /// Delegate this device's renewal key with the admin root (already opened by the caller), once.
    @discardableResult
    public func delegate(with adminRoot: Curve25519.Signing.PrivateKey) async -> SignedServingRecord<RenewalKeyDelegation>? {
        if let d = delegation(username) { return d }
        guard let key = renewalKey(), let device = deviceKeyPub() else { return nil }
        let record = RenewalKeyDelegation(account: username, renewalPub: key.publicKeyHex, deviceId: device, issuedAt: now())
        guard let bytes = try? record.canonicalBytes(),
              let sig = try? ServingAuthority.signEd25519(bytes, key: adminRoot) else { return nil }
        do {
            try await mailbox.postRenewalDelegation(username: username, body: RenewalDelegationPost(delegation: record, signature: sig))
        } catch {
            return nil
        }
        let signed = SignedServingRecord(record: record, signature: sig)
        recordDelegation(signed)
        return signed
    }

    /// Sign a lease for `policy` with the renewal key when it is delegated, else with `adminRoot`.
    /// Nil under an indefinite policy or with no key to sign with.
    public func signLease(_ policy: ServingPolicy, adminRoot: Curve25519.Signing.PrivateKey?) -> SignedServingLease? {
        guard let lease = ServingAuthority.leaseFor(policy, now: now(), leaseId: ServingAuthority.randomLeaseId()) else { return nil }
        if let d = delegation(username), let key = renewalKey(), key.publicKeyHex == d.record.renewalPub,
           let sig = try? ServingAuthority.signLeaseP256(lease, sign: key.sign) {
            return SignedServingLease(record: lease, signature: sig, delegation: d)
        }
        guard let adminRoot, let bytes = try? lease.canonicalBytes(),
              let sig = try? ServingAuthority.signEd25519(bytes, key: adminRoot) else { return nil }
        return SignedServingLease(record: lease, signature: sig)
    }

    /// Post signed leases to `.com` in one call, and to each lease's box (best effort).
    @discardableResult
    public func post(_ leases: [(serverDomain: String, lease: SignedServingLease)]) async -> Bool {
        guard !leases.isEmpty else { return true }
        let body = ServingLeasesPost(leases: leases.map {
            .init(lease: $0.lease.record, signature: $0.lease.signature, delegationPub: $0.lease.delegation?.record.renewalPub)
        })
        let posted = (try? await mailbox.postServingLeases(username: username, body: body)) != nil
        if let box {
            await withTaskGroup(of: Void.self) { group in
                for item in leases {
                    group.addTask { @MainActor in
                        let l = item.lease
                        try? await box(item.serverDomain)?.postServing(BoxServingPost(
                            leases: [BoxServingLease(record: l.record, signature: l.signature, delegationPub: l.delegation?.record.renewalPub)],
                            delegations: l.delegation.map { [$0] }))
                    }
                }
            }
        }
        return posted
    }

    /// One renewal pass: every server of the account whose policy has a time limit. Returns how many leases were signed.
    @discardableResult
    public func renew() async -> Int {
        guard let servers = try? await mailbox.fetchServing(username: username).servers else { return 0 }
        for s in servers {
            let grace = ServingGrace(rawValue: s.policy?.record.grace ?? s.grace ?? "") ?? .indefinite
            let onLapse = ServingOnLapse(rawValue: s.policy?.record.onLapse ?? s.onLapse ?? "") ?? .stopApps
            state.record(s.serverDomain, onLapse: onLapse, grace: grace, until: s.until)
        }
        let finite = servers.compactMap { s -> (String, ServingPolicy)? in
            guard let p = s.policy?.record, p.account == username, p.graceValue != nil, p.graceValue != .indefinite else { return nil }
            return (s.serverDomain, p)
        }
        guard !finite.isEmpty else { return 0 }
        let root = silentAdminRoot()
        if delegation(username) == nil, let root { await delegate(with: root) }
        let signed = finite.compactMap { domain, policy in signLease(policy, adminRoot: root).map { (serverDomain: domain, lease: $0) } }
        guard !signed.isEmpty else { return 0 }
        if await post(signed) {
            for item in signed {
                if let p = finite.first(where: { $0.0 == item.serverDomain })?.1, let g = p.graceValue, let o = p.onLapseValue {
                    state.record(item.serverDomain, onLapse: o, grace: g, until: item.lease.record.notAfter)
                }
            }
        }
        return signed.count
    }
}

/// The app's wiring of the renewer: on launch and each time the app comes to the foreground, and
/// at each Face ID that opens the admin root (it delegates the renewal key then, once).
@MainActor
public enum ServingRenewal {
    private static weak var app: AppState?
    private static var mailbox: (any SecretMailboxClient)?
    private static var clients: PodScreensClientFactory?
    private static var lastRun: Date?
    private static var running = false
    private static var hooked = false

    public static func install(app: AppState, mailbox: any SecretMailboxClient, clients: PodScreensClientFactory?) {
        self.app = app
        self.mailbox = mailbox
        self.clients = clients
        guard !hooked else { return }
        hooked = true
        let prior = Keystore.onAdminRootOpened
        Keystore.onAdminRootOpened = { key in
            prior?(key)
            Task { @MainActor in
                guard let r = renewer(), RenewalKey.delegation(account: r.username) == nil else { return }
                if await r.delegate(with: key) != nil { await r.renew() }
            }
        }
    }

    /// App open: renew, at most once a minute.
    public static func appOpened() async {
        if let lastRun, Date().timeIntervalSince(lastRun) < 60 { return }
        guard !running, let r = renewer() else { return }
        running = true
        defer { running = false }
        lastRun = Date()
        await r.renew()
    }

    /// A renewer for the signed-in account on an admin device, else nil.
    public static func renewer() -> ServingRenewer? {
        guard let app, let mailbox, let user = app.currentUser, !user.isEmpty,
              !app.isDemoAccount, Keystore.hasAdminRoot else { return nil }
        let deviceId = app.activeProfile?.deviceId ?? ""
        let clients = self.clients
        return ServingRenewer(
            username: user,
            mailbox: mailbox,
            box: clients.map { c in { domain in await c.client(forFqdn: domain) } },
            deviceKeyPub: {
                Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId)
                    .map { HexUtil.encode($0.publicKey.rawRepresentation) }
            }
        )
    }
}
