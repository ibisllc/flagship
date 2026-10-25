import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The words of the server page's "Container stack" card (also read by tests). Mirrors the webapp
/// `lib/stackSwitch.js` and Android `StackCopy`.
public enum StackCopy {
    public static let title = String(localized: "Container stack")
    public static let classic = String(localized: "This server runs the classic stack (Docker).")
    public static let arch = String(localized: "This server runs the new stack (Podman and the Rust services).")
    public static let moveNew = String(localized: "Move to the new stack")
    public static let moveBack = String(localized: "Go back to the classic stack")
    public static let signReason = String(localized: "Move this server to another stack")
    public static let planTitle = String(localized: "What the move does")
    public static let moveNow = String(localized: "Move now")
    public static let installing = String(localized: "Moving: the server restarts and its apps come back on the new stack.")
    public static let started = String(localized: "The server is restarting for the move. This card shows how it goes.")

    public static func current(_ s: StackStatus) -> String { s.stack == "arch-v2" ? arch : classic }
    public static func move(_ target: String) -> String { target == "classic" ? moveBack : moveNew }

    static func size(_ b: Int64) -> String { ByteCountFormatter.string(fromByteCount: b, countStyle: .file) }
    static func when(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    public static func room(_ p: StackPlan) -> String? {
        guard p.needBytes > 0 else { return nil }
        return String(localized: "Needs about \(size(p.needBytes)) free; this server has \(size(p.freeBytes)).")
    }

    /// What the switch record says, or nil when there is none worth a line.
    public static func record(_ r: StackSwitchRecord?) -> String? {
        guard let r else { return nil }
        switch r.state {
        case "installing": return installing
        case "trial": return String(localized: "On trial until \(when(r.trialUntil ?? r.startedAt)). If it doesn't stay healthy, the server goes back by itself.")
        case "done": return String(localized: "Moved on \(when(r.finishedAt ?? r.startedAt)).")
        case "reverted": return String(localized: "The move was undone: \(r.reason ?? "")")
        default: return nil
        }
    }
}

/// Backs the server page's "Container stack" card (admin devices only): the stack the box runs,
/// a dry run of the move (the box's plan or its refusal), then the same signed
/// `flagship/arch-v2-switch/v1` order sent for real, and the switch's progress afterwards.
@MainActor
@Observable
public final class StackSwitchViewModel {
    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    public enum Phase: Equatable {
        case idle
        /// The dry run's plan, waiting for Move now.
        case review(StackPlan)
    }

    public let serverDomain: String
    public private(set) var status: StackStatus?
    public private(set) var unsupported = false
    public private(set) var phase: Phase = .idle
    public private(set) var busy = false
    public private(set) var notice: String?
    public private(set) var error: String?
    /// The box restarts for the move: reads fail for a while.
    public private(set) var restarting = false

    private var signed: (order: StackSwitchOrder, signatureHex: String)?
    private let client: any ScreensClient
    private let signer: Signer
    private let now: () -> Int64

    public init(serverDomain: String, client: any ScreensClient, signer: Signer? = nil,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverDomain = serverDomain
        self.client = client
        self.signer = signer ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
    }

    public var shows: Bool { !unsupported && status != nil }
    public var moving: Bool { restarting || status?.switchRecord?.state == "installing" }

    public func load() async {
        do {
            status = try await client.stackStatus()
            unsupported = false
            if status?.switchRecord?.state != "installing" { restarting = false }
        } catch ScreensClientError.notImplemented {
            unsupported = true
        } catch ScreensClientError.http(let s, _) where s == 404 || s == 405 {
            if !restarting { unsupported = true }
        } catch {
            // A box restarting for the move doesn't answer: keep what we showed.
        }
    }

    /// Sign the move once (one Face ID) and ask the box for its plan without changing anything.
    public func prepare() async {
        guard !busy, let target = status?.plan.target else { return }
        busy = true
        error = nil
        notice = nil
        defer { busy = false }
        do {
            let order = StackSwitchOrder(serverDomain: serverDomain.lowercased(), target: target, nonce: StackSwitchOrder.newNonce(), issuedAt: now())
            let key = try await signer(StackCopy.signReason)
            let sig = HexUtil.encode(try key.signature(for: order.canonicalBytes()))
            let r = try await client.stackSwitch(body: order.body(signatureHex: sig, dryRun: true))
            signed = (order, sig)
            phase = .review(r.plan ?? status!.plan)
        } catch {
            self.error = Self.message(error)
        }
    }

    public func cancel() {
        signed = nil
        phase = .idle
    }

    /// Send the order the dry run checked (signed again only when it is close to the box's 5-minute limit).
    public func confirm() async {
        guard !busy, case .review(let plan) = phase, plan.blockers.isEmpty else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            var s = signed
            if s == nil || now() - s!.order.issuedAt > 4 * 60_000 {
                let order = StackSwitchOrder(serverDomain: serverDomain.lowercased(), target: plan.target, nonce: StackSwitchOrder.newNonce(), issuedAt: now())
                let key = try await signer(StackCopy.signReason)
                s = (order, HexUtil.encode(try key.signature(for: order.canonicalBytes())))
            }
            _ = try await client.stackSwitch(body: s!.order.body(signatureHex: s!.signatureHex, dryRun: false))
            signed = nil
            phase = .idle
            restarting = true
            notice = StackCopy.started
        } catch {
            self.error = Self.message(error)
        }
        await load()
    }

    /// Read again while the move is under way (the card's ticker).
    public func follow(every seconds: Double = 3, rounds: Int = 200) async {
        var n = 0
        while moving, n < rounds, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(seconds))
            await load()
            n += 1
        }
    }

    static func message(_ error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled { return LocalAiCopy.notChanged }
        return ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
    }
}
