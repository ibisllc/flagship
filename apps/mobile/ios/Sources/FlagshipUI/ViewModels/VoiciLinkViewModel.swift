import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// One line under the "Your link" field and what may be done about it.
public struct VoiciLinkMessage: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case none, ok, bad, info }
    public enum Action: Equatable, Sendable { case dibs, freeUp }

    public let tone: Tone
    public let text: String
    public let action: Action?
    public let canSave: Bool

    public init(tone: Tone = .none, text: String = "", action: Action? = nil, canSave: Bool = false) {
        self.tone = tone; self.text = text; self.action = action; self.canSave = canSave
    }
}

/// The "Your link" field on a service's page (docs/named-links.md). It shows
/// `voi.ci/<name>`: until an admin picks a custom name it holds the service's
/// random code, so the page never says "code". Typing runs the local rules at
/// once and asks `.com` 400 ms after the typing stops; Save appears for an
/// available name. Mirrors the webapp's `lib/linkField.js`, message for
/// message and in the same order.
@MainActor
@Observable
public final class VoiciLinkViewModel {
    /// A replace or clear waiting for the owner's yes.
    public struct PendingChange: Equatable, Sendable {
        /// The live name that stops working.
        public let replacing: String
        public let serviceId: String
        /// "" clears.
        public let name: String
    }

    public nonisolated static let debounceNanos: UInt64 = 400_000_000
    private nonisolated static let dayMs: Int64 = 86_400_000

    public private(set) var link: VoiciLinkState
    public let shortCode: String
    public let admin: Bool
    public let serviceId: String
    public private(set) var typed: String
    public private(set) var isSaving = false
    /// A refusal from the last save, shown in place of the live message until the next edit.
    public private(set) var refusal: String?
    public var pendingChange: PendingChange?
    /// The name to prove a `.com` for; set by "I own it", cleared when the sheet closes.
    public var dibsName: String?
    /// The "Free one up" sheet: the account's live names, nil while closed.
    public private(set) var freeUpNames: [VoiciNameListed]?
    public var showsFreeUp = false
    /// The last `.com` answer, with the name it was for.
    public private(set) var lastCheck: (name: String, result: VoiciNameCheck)?

    public var onChanged: ((VoiciLinkState) -> Void)?

    private let client: any VoiciNameClient
    private let username: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private let debounce: UInt64
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var sequence = 0

    public init(
        client: any VoiciNameClient,
        username: String,
        serviceId: String,
        link: VoiciLinkState,
        shortCode: String,
        admin: Bool,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        debounceNanos: UInt64 = VoiciLinkViewModel.debounceNanos
    ) {
        self.client = client
        self.username = username.lowercased()
        self.serviceId = serviceId
        self.link = link
        self.shortCode = shortCode
        self.admin = admin
        self.signer = signer ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
        self.debounce = debounceNanos
        self.typed = link.name ?? shortCode
    }

    /// What the service shows now: the custom name, else the random code.
    public var current: String { link.name ?? shortCode }

    public var message: VoiciLinkMessage {
        if let refusal { return VoiciLinkMessage(tone: .bad, text: refusal) }
        return Self.message(
            typed: typed, current: current, link: link,
            check: lastCheck?.name == typed ? lastCheck?.result : nil,
            admin: admin, now: now()
        )
    }

    /// The field is editable for an admin device only.
    public var isEditable: Bool { admin }

    /// "Use default" sits beside a live custom name that is showing unedited.
    public var showsUseDefault: Bool { link.name != nil && admin && typed == link.name }

    /// The 60-day rule, stated under the field while a custom name is live.
    public var showsReleaseNote: Bool { link.name != nil && link.releasesAt != nil }

    public var shortUrl: String { "https://voi.ci/\(current)" }

    // MARK: - The pure state function

    /// Typed text + the link state + the last `.com` check → one line and what
    /// may be done. Same messages and precedence as the webapp's `linkMessage`.
    public nonisolated static func message(
        typed: String,
        current: String,
        link: VoiciLinkState,
        check: VoiciNameCheck?,
        admin: Bool,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        formatDate: (Int64) -> String = VoiciLinkViewModel.formatDate
    ) -> VoiciLinkMessage {
        if !admin {
            return VoiciLinkMessage(tone: .info, text: String(localized: "Only an admin device can change this"))
        }
        if link.changesLeft <= 0 {
            let when = formatDate(link.nextChangeAt ?? now + dayMs)
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Next change \(when)"))
        }
        if typed == current || typed.isEmpty { return VoiciLinkMessage() }
        switch VoiciName.problem(typed) {
        case .characters:
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Letters, numbers and hyphens only"))
        case .tooShort:
            return VoiciLinkMessage(tone: .bad, text: String(localized: "At least 4 characters"))
        case .tooLong:
            return VoiciLinkMessage(tone: .bad, text: String(localized: "At most 40 characters"))
        case nil:
            break
        }
        if link.held >= link.limit && link.name == nil {
            return VoiciLinkMessage(tone: .bad, text: String(localized: "All \(link.limit) names in use"), action: .freeUp)
        }
        guard let check else { return VoiciLinkMessage() }
        switch check.status {
        case "available":
            return VoiciLinkMessage(tone: .ok, text: String(localized: "Available"), canSave: true)
        case "current":
            return VoiciLinkMessage()
        case "invalid":
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Letters, numbers and hyphens only"))
        case "reserved":
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Reserved"))
        case "taken":
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Taken"))
        case "dibs":
            let domain = check.domain ?? ""
            return VoiciLinkMessage(tone: .info, text: String(localized: "Reserved for the owner of \(domain)"), action: .dibs)
        default:
            return VoiciLinkMessage(tone: .bad, text: String(localized: "Couldn't check \(typed). Try again."))
        }
    }

    /// The sentence for a refusal from the save call.
    public nonisolated static func refusalMessage(_ e: VoiciNameError, typed: String, formatDate: (Int64) -> String = VoiciLinkViewModel.formatDate) -> String {
        switch e.code {
        case "taken": return String(localized: "Taken")
        case "reserved": return String(localized: "Reserved")
        case "invalid": return String(localized: "Letters, numbers and hyphens only")
        case "dibs":
            let domain = e.domain ?? ""
            return String(localized: "Reserved for the owner of \(domain)")
        case "dibs-unchecked": return String(localized: "Couldn't check \(typed). Try again.")
        case "change-limit":
            let when = e.nextChangeAt.map(formatDate) ?? ""
            return String(localized: "Next change \(when)")
        case "name-limit":
            let limit = e.limit ?? 0
            return String(localized: "All \(limit) names in use")
        case "rate-limited": return String(localized: "Too many changes today")
        case "not-admin": return String(localized: "Only an admin device can change this")
        default:
            if e.status == 429 { return String(localized: "Too many changes today") }
            return String(localized: "Couldn't save. Try again.")
        }
    }

    public nonisolated static func formatDate(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .omitted)
    }

    // MARK: - Typing and checking

    /// The field changed: fold to lower case, show the local verdict now and
    /// ask `.com` once the typing stops.
    public func edit(_ text: String) {
        guard admin else { return }
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard next != typed else { return }
        typed = next
        lastCheck = nil
        refusal = nil
        debounceTask?.cancel()
        let wait = debounce
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: wait)
            guard !Task.isCancelled else { return }
            await self?.runCheck()
        }
    }

    /// Ask `.com` about the typed name, but only when the local rules and
    /// limits would let it be saved.
    public func runCheck() async {
        let name = typed
        let probe = Self.message(
            typed: name, current: current, link: link,
            check: VoiciNameCheck(status: "available"), admin: admin, now: now()
        )
        guard probe.canSave else { return }
        sequence += 1
        let mine = sequence
        let result: VoiciNameCheck
        do {
            result = try await client.check(username: username, serviceId: serviceId, name: name)
        } catch {
            result = VoiciNameCheck(status: "error")
        }
        guard mine == sequence else { return }
        lastCheck = (name, result)
    }

    // MARK: - Saving

    /// Save the typed name (Save button).
    public func requestSave() async {
        guard message.canSave else { return }
        await request(serviceId: serviceId, name: typed)
    }

    /// Back to the random code (Use default beside the field).
    public func requestUseDefault() async {
        await request(serviceId: serviceId, name: "")
    }

    /// Back to the random code for a service of the "Free one up" list.
    public func requestUseDefault(listed: VoiciNameListed) async {
        await request(serviceId: listed.serviceId, name: "", replacing: listed.name)
    }

    private func request(serviceId: String, name: String, replacing: String? = nil) async {
        if let live = replacing ?? link.name {
            pendingChange = PendingChange(replacing: live, serviceId: serviceId, name: name)
            return
        }
        await commit(serviceId: serviceId, name: name)
    }

    /// The owner said yes to the replace sheet.
    public func confirmPending(_ change: PendingChange) async {
        pendingChange = nil
        await commit(serviceId: change.serviceId, name: change.name)
    }

    public func cancelPending() { pendingChange = nil }

    private func commit(serviceId target: String, name: String) async {
        guard admin, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        refusal = nil
        do {
            let key = try await signer(String(localized: "Change your link"))
            let order = VoiciNameOrder.make(
                user: username, serviceId: target, name: name, op: name.isEmpty ? .clear : .set, now: now()
            )
            let signature = try order.sign(with: key)
            let wire = VoiciNameOrderWire(
                user: order.user, serviceId: order.serviceId, name: order.name, op: order.op.rawValue,
                issuedAt: order.issuedAt, nonce: order.nonce
            )
            let next = try await client.save(
                username: username, serviceId: target, body: VoiciNameSaveBody(order: wire, signature: signature)
            )
            lastCheck = nil
            if target == serviceId {
                link = next
                typed = next.name ?? shortCode
            } else {
                link = VoiciLinkState(
                    name: link.name, held: max(0, link.held - 1), limit: link.limit, changesLeft: link.changesLeft,
                    nextChangeAt: link.nextChangeAt, releasesAt: link.releasesAt
                )
            }
            freeUpNames = nil
            showsFreeUp = false
            onChanged?(link)
        } catch let e as VoiciNameError {
            refusal = Self.refusalMessage(e, typed: name)
        } catch {
            if BiometricGate.GateError.from(error) == .userCancelled { return }
            refusal = String(localized: "Couldn't save. Try again.")
        }
    }

    // MARK: - Free one up, and the .com hand-off

    public func openFreeUp() async {
        do {
            freeUpNames = try await client.list(username: username)
            showsFreeUp = true
        } catch {
            refusal = String(localized: "Couldn't save. Try again.")
        }
    }

    public func ownIt() {
        guard admin else { return }
        dibsName = typed
    }

    /// The `.com` is proven: the name goes back in the field, ready to save.
    public func dibsFinished() async {
        guard let name = dibsName else { return }
        dibsName = nil
        edit(name)
        debounceTask?.cancel()
        lastCheck = nil
        refusal = nil
        await runCheck()
    }

    /// The page reloaded the service's links: take the newest state.
    public func adopt(link next: VoiciLinkState) {
        guard next != link else { return }
        link = next
        typed = next.name ?? shortCode
        lastCheck = nil
        refusal = nil
    }
}
