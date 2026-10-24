import Foundation
import CryptoKit
import FlagshipAPI

/// Box key pins (packages/protocol/src/boxKeyPin.ts; shared vectors in
/// packages/protocol/test-vectors/box-key-pin/).
///
/// Everything this device seals for a server (the disk-key reply, an
/// auto-unlock lease, the SWK / CGK / pairing deposits) goes to the key this
/// device pinned for it, so a `.com` that turns hostile can't swap in its own
/// key and collect the disk key. The pin lives in `ServerKeyPins`, the one pin
/// store, and is made only by first contact (docs/first-contact.md): the first
/// blessing, with the server code shown above Approve, or an explicit re-trust
/// by the owner. Nothing here pins a key because `.com` lists it.
public enum BoxKeyPinVerdict: String, Equatable, Sendable {
    case first, match, mismatch, invalid
}

public struct BoxKeyChangedError: Error, LocalizedError, Equatable, Sendable {
    public static var message: String { FirstContact.keyChangedText }

    public let username: String
    public let serverDomain: String
    public let pinnedHex: String
    public let reportedHex: String

    public var errorDescription: String? { Self.message }
}

/// This device has not pinned the server yet, so nothing is sealed to it.
public struct BoxKeyNotPinnedError: Error, LocalizedError, Equatable, Sendable {
    public let serverDomain: String
    public var errorDescription: String? {
        String(localized: "Check this server's code before you approve it. Open Server approvals in Activity.")
    }
}

public final class BoxKeyPins: @unchecked Sendable {
    public static let shared = BoxKeyPins()

    /// The one pin store this reads and writes.
    public let serverKeys: ServerKeyPins
    private let lock = NSLock()
    private let now: () -> Int64

    public init(serverKeys: ServerKeyPins,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverKeys = serverKeys
        self.now = now
    }

    /// `defaults == nil` keeps pins in memory only (tests).
    public convenience init(defaults: UserDefaults? = .standard,
                            now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.init(serverKeys: defaults.map { ServerKeyPins(defaults: $0) } ?? .volatile(), now: now)
    }

    public static func decide(pinned: String?, reported: String) -> BoxKeyPinVerdict {
        let r = reported.lowercased()
        guard isHex32(r) else { return .invalid }
        guard let pinned else { return .first }
        return pinned.lowercased() == r ? .match : .mismatch
    }

    public func pinned(username: String, serverDomain: String) -> String? {
        serverKeys.pinnedStkHex(serverDomain)
    }

    public func pinnedBootKey(username: String, serverDomain: String) -> String? {
        serverKeys.record(serverDomain)?.boot
    }

    /// The key this device may seal to: the pin, while `reportedHex` matches it. Throws
    /// `BoxKeyChangedError` when it differs and `BoxKeyNotPinnedError` before a pin: a first
    /// sight is never pinned here, only by first contact.
    @discardableResult
    public func require(username: String, serverDomain: String, reportedHex: String) throws -> String {
        let domain = serverDomain.lowercased()
        let reported = reportedHex.lowercased()
        let pin = serverKeys.pinnedStkHex(domain)
        switch Self.decide(pinned: pin, reported: reported) {
        case .invalid, .mismatch:
            throw BoxKeyChangedError(username: username.lowercased(), serverDomain: domain, pinnedHex: pin ?? "", reportedHex: reported)
        case .first:
            throw BoxKeyNotPinnedError(serverDomain: domain)
        case .match:
            return reported
        }
    }

    /// The listed servers whose key differs from this device's pin. Never pins.
    @discardableResult
    public func observe(username: String, pods: [PodDirectoryEntryLike]) -> [String] {
        pods.compactMap { p in
            let domain = p.domain.lowercased()
            let stk = p.stkHex.lowercased()
            guard !p.revoked, Self.isHex32(stk), let pin = serverKeys.pinnedStkHex(domain), pin != stk else { return nil }
            return domain
        }
    }

    /// The owner's explicit re-pin (this device reinstalled or moved the server). Drops the old
    /// pin and anything its STK had bound.
    public func repin(username: String, serverDomain: String, stkHex: String) {
        let stk = stkHex.lowercased()
        guard Self.isHex32(stk), let data = HexUtil.decode(stk) else { return }
        lock.lock(); defer { lock.unlock() }
        serverKeys.forget(serverDomain)
        serverKeys.pin(data, for: serverDomain)
    }

    /// The explicit re-trust: the next blessing pins whatever key the server then has.
    public func forget(username: String, serverDomain: String) {
        lock.lock(); defer { lock.unlock() }
        serverKeys.forget(serverDomain)
    }

    // MARK: Boot-only key

    public static let bootKeyBindingTag = "flagship/boot-key-binding/v1"

    public static func canonicalBootKeyBinding(serverDomain: String, bootPubHex: String, issuedAt: Int64) -> Data? {
        guard isHex32(bootPubHex), issuedAt >= 0,
              !serverDomain.contains("|"), serverDomain.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f })
        else { return nil }
        return Data([bootKeyBindingTag, serverDomain.lowercased(), bootPubHex, String(issuedAt)].joined(separator: "|").utf8)
    }

    public static func verifyBootKeyBinding(serverDomain bindingDomain: String, bootPubHex: String, issuedAt: Int64,
                                            signature: Data, pinnedStkPub: Data, forServer serverDomain: String) -> Bool {
        guard bindingDomain.lowercased() == serverDomain.lowercased(),
              let msg = canonicalBootKeyBinding(serverDomain: bindingDomain, bootPubHex: bootPubHex, issuedAt: issuedAt),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pinnedStkPub)
        else { return false }
        return key.isValidSignature(signature, for: msg)
    }

    /// Adopt a box's boot-only key only through a binding the PINNED STK
    /// signed, never because `.com` lists it. Returns the key, or nil.
    @discardableResult
    public func acceptBootKeyBinding(username: String, serverDomain: String, bootPubHex: String,
                                     issuedAt: Int64, signatureHex: String, hybridSignatureHex: String? = nil) -> String? {
        let domain = serverDomain.lowercased()
        lock.lock(); defer { lock.unlock() }
        guard let pin = serverKeys.record(domain),
              let stk = pin.stk, let sig = HexUtil.decode(signatureHex),
              Self.verifyBootKeyBinding(serverDomain: domain, bootPubHex: bootPubHex, issuedAt: issuedAt,
                                        signature: sig, pinnedStkPub: stk, forServer: domain),
              (pin.bootIssuedAt ?? -1) <= issuedAt
        else { return nil }
        // Once this server's ML-DSA key is pinned, the boot key needs the STK's hybrid
        // signature too, so stripping it cannot downgrade the server back to classical.
        if let mldsa = pin.mldsa,
           !Self.verifyBootKeyBindingV2(serverDomain: domain, bootPubHex: bootPubHex, issuedAt: issuedAt,
                                        hybridSignatureHex: hybridSignatureHex, stkHex: pin.stkHex, mldsaPubHex: mldsa) {
            return nil
        }
        let kept = serverKeys.update(domain, stkHex: pin.stkHex) {
            $0.boot = bootPubHex
            $0.bootIssuedAt = issuedAt
        }
        return kept ? bootPubHex : nil
    }

    // MARK: Architecture v2: the box's ML-DSA key

    public static let bootKeyBindingV2Tag = "flagship/boot-key-binding/v2"

    /// What a device does with a box's `box-stk` binding (packages/protocol/src/boxKeyPin.ts
    /// `decideBoxPqKeyPin`): accepted only under the PINNED STK; a different ML-DSA key than the
    /// pinned one is a key change (`mismatch`), anything else that fails is `invalid`.
    public enum BoxPqKeyPinVerdict: Equatable, Sendable {
        case first(mldsaPubHex: String, issuedAt: Int64)
        case match(mldsaPubHex: String, issuedAt: Int64)
        case mismatch(code: String)
        case invalid(code: String)
    }

    public static func decideBoxPqKeyPin(stkHex: String, mldsaPubHex: String?, minIssuedAt: Int64?,
                                         serverDomain: String, wire: Any?, now: Int64) -> BoxPqKeyPinVerdict {
        do {
            let b = try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(
                role: PqBindingRole.boxStk.rawValue, subjectId: serverDomain.lowercased(), ed25519PubHex: stkHex,
                mldsaPubHex: mldsaPubHex, now: now, minIssuedAt: minIssuedAt))
            return mldsaPubHex == nil ? .first(mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt)
                                      : .match(mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt)
        } catch let e as PqTrustError {
            return e.code == "binding-pq-key-changed" ? .mismatch(code: e.code) : .invalid(code: e.code)
        } catch {
            return .invalid(code: "binding-malformed")
        }
    }

    /// Pin the ML-DSA key a box's STK bound, through a binding the PINNED STK and that key both
    /// signed (webapp `acceptStkPqBinding`). Returns the ML-DSA key, or nil when there is no STK
    /// pin or the binding is refused. A different ML-DSA key than the pinned one throws
    /// `BoxKeyChangedError`.
    @discardableResult
    public func acceptStkPqBinding(username: String, serverDomain: String, wire: Any?) throws -> String? {
        let domain = serverDomain.lowercased()
        lock.lock(); defer { lock.unlock() }
        guard let pin = serverKeys.record(domain) else { return nil }
        switch Self.decideBoxPqKeyPin(stkHex: pin.stkHex, mldsaPubHex: pin.mldsa, minIssuedAt: pin.mldsaIssuedAt,
                                      serverDomain: domain, wire: wire, now: now()) {
        case .first(let k, let at), .match(let k, let at):
            if pin.mldsa != k || pin.mldsaIssuedAt != at {
                guard serverKeys.update(domain, stkHex: pin.stkHex, {
                    $0.mldsa = k
                    $0.mldsaIssuedAt = at
                }) else { return nil }
            }
            if let b = try? PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: "box-stk", subjectId: domain, ed25519PubHex: pin.stkHex,
                                                                               mldsaPubHex: k, now: Int64.max / 2)) {
                Self.verifiedPqLock.lock()
                Self.verifiedPq[domain] = (pin.stkHex, k, b)
                Self.verifiedPqLock.unlock()
            }
            return k
        case .mismatch:
            let reported = ((wire as? [String: Any])?["mldsaPubHex"] as? String) ?? ""
            throw BoxKeyChangedError(username: username.lowercased(), serverDomain: domain, pinnedHex: pin.mldsa ?? "", reportedHex: reported)
        case .invalid:
            return nil
        }
    }

    /// Shared by every view of the one pin store; an entry counts only while its keys are still the pin.
    nonisolated(unsafe) private static var verifiedPq: [String: (stk: String, mldsa: String, binding: VerifiedPqKeyBinding)] = [:]
    private static let verifiedPqLock = NSLock()

    /// The box's verified `box-stk` binding under the pinned keys, once `acceptStkPqBinding` saw
    /// one this launch: what the PQ session pins the box to.
    public func verifiedBoxPqBinding(username: String, serverDomain: String) -> VerifiedPqKeyBinding? {
        let domain = serverDomain.lowercased()
        guard let pin = serverKeys.record(domain), let mldsa = pin.mldsa else { return nil }
        Self.verifiedPqLock.lock(); defer { Self.verifiedPqLock.unlock() }
        guard let v = Self.verifiedPq[domain], v.stk == pin.stkHex, v.mldsa == mldsa else { return nil }
        return v.binding
    }

    public func pinnedBoxPqKey(username: String, serverDomain: String) -> String? {
        serverKeys.record(serverDomain)?.mldsa
    }

    /// The STK's v2 hybrid signature over a boot-key binding, under the pinned STK + ML-DSA keys.
    public static func verifyBootKeyBindingV2(serverDomain: String, bootPubHex: String, issuedAt: Int64,
                                              hybridSignatureHex: String?, stkHex: String, mldsaPubHex: String) -> Bool {
        guard let sigHex = hybridSignatureHex?.lowercased(), sigHex.utf8.count == PqHybrid.sigLen * 2,
              let sig = PqBin.unhex(sigHex), isHex32(stkHex), isHex32(bootPubHex), issuedAt >= 0,
              mldsaPubHex.utf8.count == 3904, let pk = PqBin.unhex(stkHex + mldsaPubHex)
        else { return false }
        let msg = Array([bootKeyBindingV2Tag, serverDomain.lowercased(), bootPubHex, String(issuedAt)].joined(separator: "|").utf8)
        return (try? PqHybrid.hybridVerify(publicKey: pk, purpose: bootKeyBindingV2Tag, payload: msg, signature: sig)) != nil
    }

    private static func isHex32(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}

/// What `observe` needs from a `/pods` row.
public struct PodDirectoryEntryLike: Sendable {
    public let domain: String
    public let stkHex: String
    public let revoked: Bool
    public init(domain: String, stkHex: String, revoked: Bool) {
        self.domain = domain; self.stkHex = stkHex; self.revoked = revoked
    }
}

extension BoxKeyPins {
    @discardableResult
    public func observe(username: String, pods: [PodDirectoryEntry]) -> [String] {
        observe(username: username, pods: pods.map {
            PodDirectoryEntryLike(domain: $0.serverDomain, stkHex: $0.identityPubKey, revoked: $0.revokedAt != nil)
        })
    }
}
