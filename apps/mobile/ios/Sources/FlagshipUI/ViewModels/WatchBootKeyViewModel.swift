import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// One server's "Start from watch while iPhone is locked" (docs/watch-boot-approval-without-unlock.md,
/// option (a)). On: unseal the disk key once (Face ID) and leave a copy on the boot worker sealed to this
/// device's watch boot key, attested by the account key. Off: every watch copy for the server goes.
@Observable
@MainActor
public final class WatchBootKeyViewModel {
    public enum Phase: Equatable {
        case idle
        case working
        case failed(String)
    }

    public let serverDomain: String
    public private(set) var phase: Phase = .idle
    public private(set) var expiresAt: Int64?
    /// Approve from watch is on for this device (it holds the delegate key).
    public private(set) var watchReady = false

    private let enroller: WatchBootKeyEnroller
    private let store: WatchBootKeyStore
    private let delegateReady: () -> Bool
    private let now: () -> Int64

    public init(serverDomain: String, enroller: WatchBootKeyEnroller, store: WatchBootKeyStore = WatchBootKeyStore(),
                delegateReady: @escaping () -> Bool, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverDomain = serverDomain
        self.enroller = enroller
        self.store = store
        self.delegateReady = delegateReady
        self.now = now
        reload()
    }

    /// The live wiring: the Keystore's watch keys, the account key behind Face ID, the boot worker.
    public static func live(serverDomain: String, mailbox: SecretMailboxClient) -> WatchBootKeyViewModel {
        let reason = String(localized: "Let your watch start \(serverDomain)")
        let enroller = WatchBootKeyEnroller(
            mailbox: mailbox,
            irk: { try await Keystore.deriveIRK(reason: reason) },
            unsealSeeds: { domain in
                var seeds: [Data] = []
                if let bak = try? await Keystore.deriveBAK(serverId: domain, reason: reason) { seeds.append(bak.rawRepresentation) }
                if let irk = try? await Keystore.deriveIRK(reason: reason) { seeds.append(irk.rawRepresentation) }
                return seeds
            },
            delegatePub: { Keystore.watchDelegateKey()?.publicKey.rawRepresentation },
            bootPub: { try Keystore.loadOrCreateWatchBootKey().publicKey.rawRepresentation }
        )
        return WatchBootKeyViewModel(serverDomain: serverDomain, enroller: enroller,
                                     delegateReady: { Keystore.watchDelegateKey() != nil })
    }

    public var isOn: Bool { expiresAt != nil }

    public func reload() {
        watchReady = delegateReady()
        expiresAt = watchReady ? store.expiresAt(for: serverDomain, now: now()) : nil
    }

    public func turnOn() async {
        guard phase != .working else { return }
        guard watchReady, let delegateEnds = store.delegateExpiresAt else {
            phase = .failed(WatchBootKeyEnroller.Failure.notEnrolled.errorDescription ?? "")
            return
        }
        phase = .working
        do {
            let ends = try await enroller.turnOn(serverDomain: serverDomain, delegateExpiresAt: delegateEnds)
            store.set(ends, for: serverDomain)
            expiresAt = ends
            phase = .idle
        } catch {
            phase = .failed(Self.message(for: error, on: true))
        }
    }

    public func turnOff() async {
        guard phase != .working else { return }
        phase = .working
        do {
            try await enroller.turnOff(serverDomain: serverDomain)
            store.set(nil, for: serverDomain)
            expiresAt = nil
            phase = .idle
        } catch {
            phase = .failed(Self.message(for: error, on: false))
        }
    }

    static func message(for error: Error, on: Bool) -> String {
        if let e = error as? WatchBootKeyEnroller.Failure { return e.errorDescription ?? "" }
        if let e = error as? SecretRequestCoordinator.CoordinatorError { return e.errorDescription ?? "" }
        if BiometricGate.GateError.from(error) == .userCancelled {
            return on ? String(localized: "Nothing was turned on.") : String(localized: "Nothing was turned off.")
        }
        if case ScreensClientError.http(let status, _) = error {
            switch status {
            case 403: return String(localized: "Your watch's approval isn't active any more. Turn Approve from watch off and on again in Account security.")
            case 404: return String(localized: "This server isn't registered to your account.")
            default: return ScreensClientError.plainLanguage(forStatus: status)
            }
        }
        return String(localized: "Couldn't reach the server. Check your connection and try again.")
    }
}
