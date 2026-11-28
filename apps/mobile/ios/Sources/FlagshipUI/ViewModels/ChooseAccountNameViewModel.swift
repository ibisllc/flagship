import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

// "Choose your own account name" at sign-up (owner decision 2026-11-23). The account is opened under the suggested
// name exactly as before (without its PQ binding yet), the chosen name is quoted, paid for ($10: ten vouchers bought
// through the App Store, or a voucher code) and renamed on `.com`, and then the device catches up with the rename
// (`AccountRenameFinisher`). Only then are the identities PQ-bound and onboarding continues, as the chosen name.
// Anything that fails leaves the account at the suggested name and keeps what was paid.

/// The account's keys a rename's follow-up work signs with.
public struct AccountRenameKeys: Sendable {
    public let irk: Curve25519.Signing.PrivateKey
    public let adminRoot: Curve25519.Signing.PrivateKey
    /// The account device key `.com` registered (derived from the OLD name).
    public let deviceKey: Curve25519.Signing.PrivateKey
    public let umk: Data

    public init(irk: Curve25519.Signing.PrivateKey, adminRoot: Curve25519.Signing.PrivateKey, deviceKey: Curve25519.Signing.PrivateKey, umk: Data) {
        self.irk = irk; self.adminRoot = adminRoot; self.deviceKey = deviceKey; self.umk = umk
    }
}

/// The voucher wallet as the rename needs it.
@MainActor
public protocol NameChangeWallet: AnyObject {
    /// Point the wallet at `username` and read it.
    func prepare(username: String, deviceId: String) async
    /// `n` vouchers, or nil when the wallet holds fewer.
    func vouchers(_ n: Int) -> [Voucher]?
    func buy(units: Int64) async -> NameChangeWalletPurchase
    func markSpent(username: String, deviceId: String, _ nullifiers: [String]) async
}

public enum NameChangeWalletPurchase: Equatable, Sendable {
    case added
    case cancelled
    case failed
}

/// The app's wallet: `PaymentsCenter` (StoreKit purchases land in it like any other).
@MainActor
public final class PaymentsCenterNameChangeWallet: NameChangeWallet {
    private let center: PaymentsCenter
    private let client: any PaymentsComClient

    public init(center: PaymentsCenter = .shared, client: any PaymentsComClient) {
        self.center = center
        self.client = client
    }

    public func prepare(username: String, deviceId: String) async {
        center.configure(client: client, username: username, deviceId: deviceId)
        await center.refreshAndTick()
    }

    public func vouchers(_ n: Int) -> [Voucher]? { center.takeVouchers(n) }

    public func buy(units: Int64) async -> NameChangeWalletPurchase {
        if await center.buy(units: units) { return .added }
        return center.shop?.outcome == nil ? .cancelled : .failed
    }

    public func markSpent(username: String, deviceId: String, _ nullifiers: [String]) async {
        await prepare(username: username, deviceId: deviceId)
        await center.markSpent(nullifiers)
    }
}

/// What the device does once `.com` has renamed the account (docs in AccountNameChange.swift): its keys and records
/// move to the new name, the founding grant is minted again under it (admin root) and the old one revoked (IRK), the
/// profiles are signed again as revision 2, and the vouchers the rename spent leave the wallet. Each step is saved in
/// the pending record, so a restart resumes where it stopped; every step is safe to repeat.
@MainActor
public final class AccountRenameFinisher {
    public struct Local {
        /// Move the keystore's profile slot (no keys needed).
        public var moveSlot: @MainActor (_ old: String, _ new: String) -> Void
        /// Keep the registered device key, and the device id, under the new name; forget the old name's read token.
        public var keepDeviceKey: @MainActor (_ old: String, _ new: String, _ deviceId: String, _ key: Curve25519.Signing.PrivateKey) -> Void

        public init(moveSlot: @escaping @MainActor (String, String) -> Void,
                    keepDeviceKey: @escaping @MainActor (String, String, String, Curve25519.Signing.PrivateKey) -> Void) {
            self.moveSlot = moveSlot; self.keepDeviceKey = keepDeviceKey
        }

        public static let keystore = Local(
            moveSlot: { Keystore.moveProfileSlot(from: $0, to: $1) },
            keepDeviceKey: { old, new, deviceId, key in
                try? Keystore.storeAccountDeviceSigningKey(key, accountId: new, deviceId: deviceId)
                Keystore.storeAccountDeviceId(deviceId, accountId: new)
                var tokens = Keystore.loadAccountReadTokens()
                if tokens.removeValue(forKey: old) != nil { Keystore.saveAccountReadTokens(tokens) }
            }
        )
    }

    private let client: any AccountNameChangeClient
    private let server: any FlagshipServerClient
    private let store: any PendingAccountRenameStore
    private let wallet: (any NameChangeWallet)?
    private let local: Local
    private let now: () -> Int64

    public init(client: any AccountNameChangeClient, server: any FlagshipServerClient, store: any PendingAccountRenameStore,
                wallet: (any NameChangeWallet)?, local: Local = .keystore,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.client = client; self.server = server; self.store = store; self.wallet = wallet; self.local = local; self.now = now
    }

    public func finish(_ start: PendingAccountRename, keys: AccountRenameKeys) async throws {
        var rec = start
        let new = rec.newName
        if rec.stage == .renaming || rec.stage == .renamed {
            local.moveSlot(rec.oldName, new)
            local.keepDeviceKey(rec.oldName, new, rec.deviceId, keys.deviceKey)
            rec.stage = .movedLocally
            store.save(rec)
        }
        let devicePub = HexUtil.encode(keys.deviceKey.publicKey.rawRepresentation)
        if rec.stage == .movedLocally {
            let issuedAt = now()
            let grant = DeviceCapabilityGrantEnvelope(
                grantId: rec.newGrantId, username: new, deviceId: rec.deviceId, devicePubKeyHex: devicePub,
                scopes: OpenAccountViewModel.foundingScopes, issuedAt: issuedAt, expiresAt: issuedAt + 90 * 24 * 3_600_000
            )
            try await client.mintDeviceGrant(grant, signatureHex: HexUtil.encode(try keys.adminRoot.signature(for: grant.canonicalBytes())))
            let revokedAt = now()
            let revokeSig = try keys.irk.signature(for: RevokeDeviceCapabilityGrantEnvelope.canonicalBytes(
                grantId: rec.oldGrantId, username: new, reason: "replaced", issuedAt: revokedAt))
            do {
                try await client.revokeDeviceGrant(username: new, grantId: rec.oldGrantId, reason: "replaced", issuedAt: revokedAt,
                                                   signatureHex: HexUtil.encode(revokeSig))
            } catch let r as NameChangeRefusal where r.status == 404 {
                // Already gone.
            }
            rec.stage = .grantSwapped
            store.save(rec)
        }
        if rec.stage == .grantSwapped {
            try await putProfiles(rec, keys: keys, devicePub: devicePub)
            rec.stage = .profilesDone
            store.save(rec)
        }
        if !rec.spentNullifiers.isEmpty, let wallet {
            await wallet.markSpent(username: new, deviceId: rec.deviceId, rec.spentNullifiers)
        }
        store.clear()
    }

    private func authorization(_ rec: PendingAccountRename, keys: AccountRenameKeys, devicePub: String, method: String, path: String) throws -> AccountDirectoryAuthorization {
        let requestId = try AccountMetadata.generateDeviceId()
        let issuedAt = now()
        let sig = try keys.deviceKey.signature(for: AccountMetadata.canonicalDirectoryRequest(
            accountId: rec.newName, deviceId: rec.deviceId, signerPubHex: devicePub,
            method: method, path: path, requestId: requestId, issuedAt: issuedAt))
        return AccountDirectoryAuthorization(deviceId: rec.deviceId, signerPubHex: devicePub, requestId: requestId,
                                             issuedAt: issuedAt, signatureHex: HexUtil.encode(sig))
    }

    /// Revision 2 of both profiles, under the new name; a 409 means a previous run already wrote it.
    private func putProfiles(_ rec: PendingAccountRename, keys: AccountRenameKeys, devicePub: String) async throws {
        let new = rec.newName
        let adminPub = HexUtil.encode(keys.adminRoot.publicKey.rawRepresentation)
        let issuedAt = now()
        let accountCt = try AccountMetadata.encrypt(
            displayName: rec.accountDisplayName, keyBytes: AccountMetadata.deriveAccountProfileKey(umk: keys.umk),
            coordinates: .init(accountId: new, recordType: .accountProfile, revision: 2, keyVersion: 1))
        let accountSig = try keys.adminRoot.signature(for: AccountMetadata.canonicalAccountProfile(
            accountId: new, revision: 2, keyVersion: 1, ciphertext: accountCt, issuedAt: issuedAt, signerPubHex: adminPub))
        let accountPath = "/api/accounts/\(new)/profile"
        try await tolerateConflict {
            try await server.putAccountProfile(
                accountId: new, authorization: try authorization(rec, keys: keys, devicePub: devicePub, method: "PUT", path: accountPath),
                body: .init(profile: .init(accountId: new, revision: 2, keyVersion: 1, nonceHex: accountCt.nonceHex,
                                           ciphertextHex: accountCt.ciphertextHex, issuedAt: issuedAt, signerPubHex: adminPub,
                                           signatureHex: HexUtil.encode(accountSig)), expectedRevision: 1))
        }
        let deviceCt = try AccountMetadata.encrypt(
            displayName: rec.deviceDisplayName, keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: keys.umk),
            coordinates: .init(accountId: new, deviceId: rec.deviceId, recordType: .deviceSelfProfile, revision: 2, keyVersion: 1))
        let deviceSig = try keys.deviceKey.signature(for: AccountMetadata.canonicalDeviceSelfProfile(
            accountId: new, deviceId: rec.deviceId, revision: 2, keyVersion: 1, ciphertext: deviceCt, issuedAt: issuedAt, signerPubHex: devicePub))
        let devicePath = "/api/accounts/\(new)/devices/\(rec.deviceId.lowercased())/profile"
        try await tolerateConflict {
            try await server.putDeviceSelfProfile(
                accountId: new, deviceId: rec.deviceId,
                authorization: try authorization(rec, keys: keys, devicePub: devicePub, method: "PUT", path: devicePath),
                body: .init(profile: .init(accountId: new, deviceId: rec.deviceId, revision: 2, keyVersion: 1, nonceHex: deviceCt.nonceHex,
                                           ciphertextHex: deviceCt.ciphertextHex, issuedAt: issuedAt, signerPubHex: devicePub,
                                           signatureHex: HexUtil.encode(deviceSig)), expectedRevision: 1))
        }
    }

    private func tolerateConflict(_ f: () async throws -> Void) async throws {
        do { try await f() } catch ScreensClientError.http(let status, _) where status == 409 {}
    }
}

@MainActor
@Observable
public final class ChooseAccountNameViewModel {
    public enum Phase: Equatable {
        case editing
        case working
        /// Renamed and caught up: onboarding continues as `name`.
        case done(name: String)
    }

    /// What `.com` said about the name in the field while it was typed (the precheck).
    public enum NameCheck: Equatable {
        /// Nothing asked: an empty or badly formed name, or a new name not yet asked about.
        case idle
        case open(name: String)
        /// Held for the holder of `domain` (`checked` false: its lookup failed). Pay stays off.
        case held(name: String, domain: String, heldUntil: Int64?, checked: Bool)
        /// Taken, offered, or a link that no longer works: the sentence.
        case refused(name: String, message: String)
        /// `.com` couldn't answer (an older `.com`, no network): Pay checks, as before.
        case unknown(name: String)

        var name: String? {
            switch self {
            case .idle: return nil
            case .open(let n), .held(let n, _, _, _), .refused(let n, _), .unknown(let n): return n
            }
        }
    }

    public var name: String = ""
    public var code: String = ""
    public var showsCode = false
    public private(set) var phase: Phase = .editing
    /// The last refusal or failure, shown under the buttons.
    public private(set) var message: String?
    /// Set once the account exists (under the suggested name).
    public private(set) var opened: OpenedAccountKeys?
    /// The name onboarding continues with, once decided (the chosen one, or the suggested one kept).
    public private(set) var completedName: String?
    /// The precheck's answer for the name in the field.
    public private(set) var check: NameCheck = .idle

    public let suggested: String
    /// A name the owner set aside for this person (a name-grant link), if any.
    public let grant: NameGrant?
    @ObservationIgnored private let openAccount: () async throws -> OpenedAccountKeys
    @ObservationIgnored private let client: any AccountNameChangeClient
    @ObservationIgnored private let wallet: (any NameChangeWallet)?
    @ObservationIgnored private let store: any PendingAccountRenameStore
    @ObservationIgnored private let finisher: AccountRenameFinisher
    @ObservationIgnored private let bindPq: (OpenedAccountKeys, String) -> Void
    @ObservationIgnored private let now: () -> Int64
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private var checkTask: Task<Void, Never>?

    public init(suggested: String,
                grant: NameGrant? = nil,
                openAccount: @escaping () async throws -> OpenedAccountKeys,
                client: any AccountNameChangeClient,
                server: any FlagshipServerClient,
                wallet: (any NameChangeWallet)?,
                store: any PendingAccountRenameStore = DefaultsPendingAccountRenameStore.shared,
                local: AccountRenameFinisher.Local = .keystore,
                bindPq: @escaping (OpenedAccountKeys, String) -> Void = { $0.bindPq(as: $1) },
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                debounce: Duration = .milliseconds(600)) {
        self.suggested = suggested.lowercased()
        self.grant = grant
        if let grant { name = grant.name }
        self.openAccount = openAccount
        self.client = client
        self.wallet = wallet
        self.store = store
        self.finisher = AccountRenameFinisher(client: client, server: server, store: store, wallet: wallet, local: local, now: now)
        self.bindPq = bindPq
        self.now = now
        self.debounce = debounce
    }

    public var isWorking: Bool { phase == .working }

    /// The local format check, as the user types (the real check is the quote).
    public var nameProblem: String? {
        let typed = name.trimmingCharacters(in: .whitespaces)
        guard !typed.isEmpty, let p = VoiciName.problem(typed) else { return nil }
        return NameRuleText.problem(p)
    }

    private var chosen: String { name.trimmingCharacters(in: .whitespaces).lowercased() }
    public var canPay: Bool { !isWorking && completedName == nil && !chosen.isEmpty && nameProblem == nil && !isHeld }

    /// The name in the field is held for a `.com` holder: nothing is opened or charged for it.
    public var isHeld: Bool {
        if case .held(let n, _, _, _) = check, n == chosen { return true }
        return false
    }

    /// The status line under the field while the name is held.
    public var heldStatus: String? {
        guard case .held(let n, let domain, let until, let checked) = check, n == chosen else { return nil }
        return HeldNameText.status(domain: domain, heldUntil: until, checked: checked)
    }

    /// "Why?" shows only for a hold `.com` could check.
    public var showsWhy: Bool {
        if case .held(let n, _, _, true) = check, n == chosen { return true }
        return false
    }

    /// The domain and end date of the hold on the name in the field, for the "Why?" sheet.
    public var heldDetails: (name: String, domain: String, heldUntil: Int64?)? {
        guard case .held(let n, let domain, let until, _) = check, n == chosen else { return nil }
        return (n, domain, until)
    }

    /// The precheck's refusal (taken, a link that no longer works) for the name in the field.
    public var checkProblem: String? {
        guard case .refused(let n, let m) = check, n == chosen else { return nil }
        return m
    }

    /// The field changed: ask `.com` about the new name once typing pauses (the debounce), if it passes the local
    /// rules. A name already answered is not asked again.
    public func nameDidChange() {
        checkTask?.cancel()
        let n = chosen
        if check.name != n, case .held = check { check = .idle }
        guard !n.isEmpty, nameProblem == nil, completedName == nil else {
            check = .idle
            return
        }
        guard check.name != n else { return }
        let wait = debounce
        checkTask = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            await self?.checkNow()
        }
    }

    /// Ask `.com` about the name in the field now (Done on the keyboard, Pay, or after the debounce).
    public func checkNow() async {
        let n = chosen
        guard !n.isEmpty, nameProblem == nil else { return }
        if let known = check.name, known == n {
            // Asked already; only a hold whose lookup failed is worth asking again.
            guard case .held(_, _, _, false) = check else { return }
        }
        let answer = await client.precheck(newUsername: n, grant: grant.flatMap { $0.name == n ? $0 : nil })
        guard chosen == n else { return }
        check = Self.check(for: n, answer)
    }

    static func check(for n: String, _ q: NameChangeQuote?) -> NameCheck {
        guard let q else { return .unknown(name: n) }
        if q.available { return .open(name: n) }
        switch q.code {
        case "dibs-held":
            return .held(name: n, domain: HeldNameText.domain(q.domain, name: n), heldUntil: q.heldUntil, checked: q.checked)
        case "taken", "offered", "reserved", "dibs-used":
            return .refused(name: n, message: NameRuleText.taken)
        case "invalid":
            return .refused(name: n, message: NameRuleText.problem(code: q.problem))
        case "grant-expired":
            return .refused(name: n, message: NameGrantText.expired)
        case "grant-invalid", "grant-used":
            return .refused(name: n, message: NameGrantText.invalid)
        default:
            return .unknown(name: n)
        }
    }
    public var canUseCode: Bool { canPay && !code.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The grant, while the field still holds its name.
    private var activeGrant: NameGrant? { grant.flatMap { $0.name == chosen ? $0 : nil } }
    /// A free grant pays for the name: one "Continue", no payment.
    public var isFreeGrant: Bool { activeGrant?.free ?? false }

    /// The display name a name reads as ("plucky-avocet" → "Plucky Avocet").
    public nonisolated static func displayName(for name: String) -> String {
        name.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    public func pay() async { await run(.vouchers) }
    public func useCode() async { await run(.code) }
    /// A free grant's "Continue".
    public func continueWithGrant() async { await run(.grant) }

    /// Go on with the suggested name (the account already exists under it).
    public func keepSuggested() {
        guard let keys = opened, !isWorking else { return }
        // A rename that already landed can't be kept back: finish it instead (Pay again).
        if let rec = store.load(), rec.oldName == suggested, rec.stage != .renaming { return }
        bindPq(keys, suggested)
        completedName = suggested
    }

    enum Method { case vouchers, code, grant }

    private func run(_ method: Method) async {
        switch method {
        case .code: guard canUseCode else { return }
        case .vouchers: guard canPay else { return }
        case .grant: guard canPay, isFreeGrant else { return }
        }
        let wanted = chosen
        let grant = activeGrant
        if let grant, grant.expiresAt <= now() {
            message = NameGrantText.expired
            return
        }
        message = nil
        phase = .working
        defer { if case .working = phase { phase = .editing } }

        // A rename sent earlier: finish it if it landed, never rename twice.
        if var rec = store.load(), rec.oldName == suggested, let keys = opened {
            if rec.stage == .renaming {
                let owner: Result<String?, Error>
                do { owner = .success(try await client.accountIrk(username: rec.newName)) } catch let e { owner = .failure(e) }
                switch owner {
                case .success(let irk) where irk == rec.irkPubHex:
                    rec.stage = .renamed
                    store.save(rec)
                case .success:
                    store.clear()
                case .failure(let e):
                    message = UserErrorText.of(e)
                    return
                }
            }
            if rec.stage != .renaming {
                await finishRename(rec, keys: keys)
                return
            }
        }

        // Nothing is opened or charged for a name `.com` already refuses: ask first (it waits for a check under way).
        checkTask?.cancel()
        await checkNow()
        guard chosen == wanted else { return }
        switch check {
        case .held, .refused: return
        default: break
        }

        let keys: OpenedAccountKeys
        if let opened {
            keys = opened
        } else {
            do {
                keys = try await openAccount()
                opened = keys
            } catch let e as ChooseNameOpenError {
                message = e.message
                return
            } catch {
                message = NameRuleText.refusal(error) ?? UserErrorText.of(error)
                return
            }
        }

        let quote: NameChangeQuote
        do {
            quote = try await client.quote(username: suggested, newUsername: wanted, grant: grant)
        } catch {
            message = refusalText(error, method: method, paid: false)
            return
        }
        guard quote.available else {
            message = refusalText(NameChangeRefusal(status: 409, code: quote.code ?? "taken", heldUntil: quote.heldUntil, problem: quote.problem,
                                                    domain: quote.domain, checked: quote.checked),
                                  method: method, paid: false)
            return
        }

        let payment: NameChangePayment
        switch method {
        case .grant:
            guard quote.paid else { message = paymentFailed; return }
            payment = .grant
        case .code:
            payment = .code(code.trimmingCharacters(in: .whitespacesAndNewlines))
        case .vouchers:
            guard let wallet else { message = paymentFailed; return }
            await wallet.prepare(username: suggested, deviceId: keys.deviceId)
            var vs = wallet.vouchers(quote.units)
            if vs == nil {
                switch await wallet.buy(units: Int64(quote.units)) {
                case .cancelled:
                    message = String(localized: "Payment cancelled. Your account keeps the name \(suggested).")
                    return
                case .failed:
                    message = paymentFailed
                    return
                case .added:
                    vs = wallet.vouchers(quote.units)
                }
            }
            guard let vs else { message = paymentFailed; return }
            payment = .vouchers(vs)
        }

        var rec = PendingAccountRename(
            oldName: suggested, newName: wanted, deviceId: keys.deviceId, oldGrantId: keys.grantId,
            irkPubHex: HexUtil.encode(keys.irk.publicKey.rawRepresentation),
            spentNullifiers: { if case .vouchers(let vs) = payment { return vs.map(Vouchers.nullifier) }; return [] }(),
            accountDisplayName: Self.displayName(for: wanted), deviceDisplayName: keys.deviceDisplayName)
        store.save(rec)

        do {
            guard let aidPub = ServiceInvite.deriveAccountIdPub(umkSeed: keys.umk) else { throw AccountMetadataError.invalidKey }
            let aidPubHex = HexUtil.encode(aidPub)
            let issuedAt = now()
            let sig = try keys.adminRoot.signature(for: NameChangeEnvelope.canonicalBytes(
                aidPubHex: aidPubHex, oldUsername: suggested, newUsername: wanted, issuedAt: issuedAt))
            _ = try await client.rename(aidPubHex: aidPubHex, oldUsername: suggested, newUsername: wanted, issuedAt: issuedAt,
                                        signatureHex: HexUtil.encode(sig), payment: payment, grant: grant)
        } catch let refusal as NameChangeRefusal {
            store.clear()
            if refusal.code == "voucher-spent", !refusal.spent.isEmpty {
                await wallet?.markSpent(username: suggested, deviceId: keys.deviceId, refusal.spent)
            }
            message = refusalText(refusal, method: method, paid: true)
            return
        } catch {
            // No answer: did the rename land? `.com` says whose the new name is.
            let owner: Result<String?, Error>
            do { owner = .success(try await client.accountIrk(username: wanted)) } catch let e { owner = .failure(e) }
            switch owner {
            case .success(let irk) where irk == rec.irkPubHex:
                break
            case .success:
                store.clear()
                message = refusalText(NameChangeRefusal(status: 0, code: "rename-failed"), method: method, paid: true)
                return
            case .failure:
                // Unknown: the record stays, and the next tap or launch asks again.
                message = UserErrorText.of(error)
                return
            }
        }
        rec.stage = .renamed
        store.save(rec)
        await finishRename(rec, keys: keys)
    }

    private func finishRename(_ rec: PendingAccountRename, keys: OpenedAccountKeys) async {
        do {
            try await finisher.finish(rec, keys: AccountRenameKeys(irk: keys.irk, adminRoot: keys.adminRoot, deviceKey: keys.deviceKey, umk: keys.umk))
        } catch {
            // The rename stands; the next tap (or the next launch) finishes it.
            message = UserErrorText.of(error)
            return
        }
        bindPq(keys, rec.newName)
        completedName = rec.newName
        phase = .done(name: rec.newName)
    }

    private var paymentFailed: String { String(localized: "The payment didn't go through. Your account keeps the name \(suggested).") }

    /// The sentence for a refusal. `paid`: the request carried the payment (a code, or vouchers).
    func refusalText(_ error: Error, method: Method, paid: Bool) -> String {
        guard let r = error as? NameChangeRefusal else {
            return NameRuleText.refusal(error) ?? UserErrorText.of(error)
        }
        switch r.code {
        case "taken", "offered", "same-name", "reserved":
            return NameRuleText.taken
        case "invalid":
            return NameRuleText.problem(code: r.problem)
        case "dibs-held":
            // The hold reads as the status line under the field, the same as the precheck's.
            let n = chosen
            check = .held(name: n, domain: HeldNameText.domain(r.domain, name: n), heldUntil: r.heldUntil, checked: r.checked)
            return HeldNameText.status(domain: HeldNameText.domain(r.domain, name: n), heldUntil: r.heldUntil, checked: r.checked)
        case "dibs-used":
            return NameRuleText.taken
        case "code-invalid", "code-wrong-kind":
            return String(localized: "That voucher code isn't valid for an account name.")
        case "code-used":
            return String(localized: "That voucher code was already used.")
        case "grant-expired":
            return NameGrantText.expired
        case "grant-invalid", "grant-used":
            return NameGrantText.invalid
        default:
            switch method {
            case .grant:
                return String(localized: "The name change didn't go through. Your account keeps the name \(suggested).")
            case .code:
                return String(localized: "The name change didn't go through. Your account keeps the name \(suggested), and your voucher code still works.")
            case .vouchers:
                return paid
                    ? String(localized: "The name change didn't go through. Your account keeps the name \(suggested), and your $10 stays in your account as vouchers.")
                    : paymentFailed
            }
        }
    }
}

/// A name held for a `.com` holder (control-plane nameDibs.ts): the status line under the field and the "Why?" sheet.
public enum HeldNameText {
    /// The `.com` `.com` named (maybe the de-hyphenated label), else `<name>.com`.
    public static func domain(_ domain: String?, name: String) -> String {
        let d = domain?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return d.isEmpty ? "\(name.lowercased()).com" : d
    }

    static func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .long, time: .omitted)
    }

    public static func status(domain: String, heldUntil: Int64?, checked: Bool) -> String {
        if !checked { return String(localized: "Couldn't check \(domain) just now. Try again in a minute.") }
        guard let heldUntil else { return String(localized: "Held for the owner of \(domain).") }
        return String(localized: "Held for the owner of \(domain) until \(date(heldUntil)).")
    }

    public static var why: String { String(localized: "Why?") }
    public static func whyLabel(name: String) -> String { String(localized: "Why is \(name) held?") }
    public static var pickAnother: String { String(localized: "Pick another name, or go back for a new suggestion.") }

    public static func rule(heldUntil: Int64?) -> String {
        guard let heldUntil else {
            return String(localized: "For a limited time, a Flagship name that matches a registered .com is kept for whoever controls that domain. Then it opens to everyone.")
        }
        return String(localized: "Until \(date(heldUntil)), a Flagship name that matches a registered .com is kept for whoever controls that domain. Then it opens to everyone.")
    }

    public static var yoursTitle: String { String(localized: "Is this name yours?") }
    public static func yours(domain: String) -> String {
        String(localized: "If \(domain) is yours, it's your own name, or you have another good reason, email support@flagshipserver.com before you create your account. Say which name you want and why. If we can, we'll send a link that sets it aside for you.")
    }

    public static var emailUs: String { String(localized: "Email us") }
    public static var howDibsWorks: String { String(localized: "How .com dibs works") }

    /// The site's dibs page in the app's language (English at the root).
    public static func dibsPageURL(language: String = Bundle.main.preferredLocalizations.first ?? "en") -> URL {
        let paths = ["es": "es", "fr": "fr", "de": "de", "pt-BR": "pt-br", "ja": "ja", "zh-Hans": "zh-hans"]
        let p = paths[language].map { "\($0)/" } ?? ""
        return URL(string: "https://flagshipserver.com/\(p)dibs")!
    }
}

/// The sentences of a name-grant link (a name the owner set aside for someone).
public enum NameGrantText {
    public static var setAside: String { String(localized: "This name has been set aside for you.") }
    public static var expired: String { String(localized: "This link has expired. Ask for a new one.") }
    public static var invalid: String { String(localized: "This link doesn't work any more. Ask for a new one.") }
    public static var existingAccount: String { String(localized: "Open this link when you create your account.") }
}

/// A rename the app was interrupted in (the pending record): at launch it learns whether `.com` applied it and, if
/// so, moves the profile slot so the session restores as the new name; after the unlock it finishes the rest.
@MainActor
@Observable
public final class AccountRenameResume {
    public static let shared = AccountRenameResume()

    /// True while the follow-up work runs ("Finishing your account name…").
    public private(set) var isFinishing = false
    /// The rename is known to have landed and waits for the account keys.
    public private(set) var needsFinish = false

    @ObservationIgnored private let store: any PendingAccountRenameStore

    public init(store: any PendingAccountRenameStore = DefaultsPendingAccountRenameStore.shared) {
        self.store = store
    }

    /// True while a rename names `username` (the old or the new name): no "account removed" and no PQ binding then.
    public nonisolated static func isRenaming(_ username: String, store: any PendingAccountRenameStore = DefaultsPendingAccountRenameStore.shared) -> Bool {
        store.load()?.names(username) ?? false
    }

    /// Before restoring the session kept under `slot`: the name to restore it as.
    public func atLaunch(slot: String, client: any AccountNameChangeClient,
                         moveSlot: (String, String) -> Void = { Keystore.moveProfileSlot(from: $0, to: $1) }) async -> String {
        guard var rec = store.load(), rec.names(slot) else { return slot }
        if rec.stage == .renaming {
            do {
                guard try await client.accountIrk(username: rec.newName) == rec.irkPubHex else {
                    // Never renamed: the account keeps its name (and anything paid was put back by `.com`).
                    store.clear()
                    return slot
                }
            } catch {
                // Can't tell yet: keep the record and the old name, ask again next launch.
                return slot
            }
            rec.stage = .renamed
            store.save(rec)
        }
        moveSlot(rec.oldName, rec.newName)
        needsFinish = true
        return rec.newName
    }

    /// After the unlock: the grant, the profiles and the wallet, then the PQ binding. Asks for the account keys
    /// (Face ID unless the session holds them).
    public func finishIfNeeded(client: any AccountNameChangeClient, server: any FlagshipServerClient, wallet: (any NameChangeWallet)?) async {
        guard needsFinish, !isFinishing, let rec = store.load(), rec.stage != .renaming else { return }
        isFinishing = true
        defer { isFinishing = false }
        do {
            let reason = String(localized: "Finishing your account name…")
            let umkKey = try await Keystore.currentUMK(reason: reason)
            let umk = umkKey.withUnsafeBytes { Data($0) }
            let irk = try await Keystore.deriveIRK(reason: reason)
            let adminRoot: Curve25519.Signing.PrivateKey
            if let held = Keystore.sessionAdminRoot() { adminRoot = held } else { adminRoot = try await Keystore.adminRootKey(reason: reason) }
            let deviceKey = try Keystore.storedAccountDeviceSigningKey(accountId: rec.newName, deviceId: rec.deviceId)
                ?? Keystore.storedAccountDeviceSigningKey(accountId: rec.oldName, deviceId: rec.deviceId)
                ?? AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: rec.oldName, deviceId: rec.deviceId)
            try await AccountRenameFinisher(client: client, server: server, store: store, wallet: wallet)
                .finish(rec, keys: AccountRenameKeys(irk: irk, adminRoot: adminRoot, deviceKey: deviceKey, umk: umk))
            needsFinish = false
            PqIdentityBindingService.bindInBackground(username: rec.newName, identities: [
                PqIdentity(role: .accountIrk, subjectId: rec.newName, edKey: irk),
                PqIdentity(role: .adminRoot, subjectId: rec.newName, edKey: adminRoot),
                PqIdentity(role: .device, subjectId: rec.deviceId, edKey: deviceKey),
            ])
        } catch {
            // Tried again at the next unlock.
        }
    }
}
