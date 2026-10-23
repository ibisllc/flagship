import Foundation
import CryptoKit
import FlagshipAPI

/// Box key pins (packages/protocol/src/boxKeyPin.ts; shared vectors in
/// packages/protocol/test-vectors/box-key-pin/).
///
/// Everything this device seals for a server (the disk-key reply, an
/// auto-unlock lease, the SWK / CGK / pairing deposits) goes to the box key
/// `.com`'s `/pods` lists. The device pins that key per server the first time
/// it learns it and refuses to seal to any other afterwards, so a `.com` that
/// turns hostile can't swap in its own key and collect the disk key. A key
/// changes legitimately only when the server is reinstalled, replaced or
/// moved: the device that does it re-pins, and any other device asks its
/// owner first ("Trust its new key").
public enum BoxKeyPinVerdict: String, Equatable, Sendable {
    case first, match, mismatch, invalid
}

public struct BoxKeyChangedError: Error, LocalizedError, Equatable, Sendable {
    public static let message =
        "This server's identity key changed since this device first saw it, so Flagship won't send it your disk key. "
        + "If you reinstalled, replaced or moved this server, choose Trust its new key. If you didn't, someone may be impersonating it."

    public let username: String
    public let serverDomain: String
    public let pinnedHex: String
    public let reportedHex: String

    public var errorDescription: String? { Self.message }
}

public final class BoxKeyPins: @unchecked Sendable {
    public static let shared = BoxKeyPins()

    struct Pin: Codable, Equatable {
        var stk: String
        var pinnedAt: Int64
        var boot: String?
        var bootIssuedAt: Int64?
        /// Architecture v2: the ML-DSA-65 key the pinned STK bound (`box-stk` binding), and that
        /// binding's issuedAt. Once set, a boot-key binding needs the STK's hybrid signature too.
        var mldsa: String?
        var mldsaIssuedAt: Int64?
    }

    private let defaults: UserDefaults?
    private let lock = NSLock()
    private var memory: [String: [String: Pin]] = [:]
    private let now: () -> Int64

    /// `defaults == nil` keeps pins in memory only (tests).
    public init(defaults: UserDefaults? = .standard,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.defaults = defaults
        self.now = now
    }

    public static func decide(pinned: String?, reported: String) -> BoxKeyPinVerdict {
        let r = reported.lowercased()
        guard isHex32(r) else { return .invalid }
        guard let pinned else { return .first }
        return pinned.lowercased() == r ? .match : .mismatch
    }

    public func pinned(username: String, serverDomain: String) -> String? {
        withPins(username) { $0[serverDomain.lowercased()]?.stk }
    }

    public func pinnedBootKey(username: String, serverDomain: String) -> String? {
        withPins(username) { $0[serverDomain.lowercased()]?.boot }
    }

    /// The key this device may seal to: pins `reportedHex` the first time,
    /// returns it while it matches, throws `BoxKeyChangedError` when it differs.
    @discardableResult
    public func require(username: String, serverDomain: String, reportedHex: String) throws -> String {
        let domain = serverDomain.lowercased()
        let reported = reportedHex.lowercased()
        return try withPins(username) { pins in
            switch Self.decide(pinned: pins[domain]?.stk, reported: reported) {
            case .invalid:
                throw BoxKeyChangedError(username: username.lowercased(), serverDomain: domain, pinnedHex: pins[domain]?.stk ?? "", reportedHex: reported)
            case .mismatch:
                throw BoxKeyChangedError(username: username.lowercased(), serverDomain: domain, pinnedHex: pins[domain]!.stk, reportedHex: reported)
            case .first:
                pins[domain] = Pin(stk: reported, pinnedAt: now())
            case .match:
                break
            }
            return reported
        }
    }

    /// Pin every listed server not pinned yet, so the pin predates any request.
    public func observe(username: String, pods: [PodDirectoryEntryLike]) {
        withPins(username) { pins in
            for p in pods where p.revoked == false {
                let domain = p.domain.lowercased()
                let stk = p.stkHex.lowercased()
                guard !domain.isEmpty, pins[domain] == nil, Self.isHex32(stk) else { continue }
                pins[domain] = Pin(stk: stk, pinnedAt: now())
            }
        }
    }

    /// Replace the pin: only for a change the owner made or confirmed here
    /// ("Trust its new key", or this device moved the server). Drops any boot
    /// key the old STK had bound.
    public func repin(username: String, serverDomain: String, stkHex: String) {
        let stk = stkHex.lowercased()
        guard Self.isHex32(stk) else { return }
        withPins(username) { $0[serverDomain.lowercased()] = Pin(stk: stk, pinnedAt: now()) }
    }

    /// This device is (re)creating `serverDomain`: pin its next registered key fresh.
    public func forget(username: String, serverDomain: String) {
        withPins(username) { _ = $0.removeValue(forKey: serverDomain.lowercased()) }
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
        return withPins(username) { pins -> String? in
            guard var pin = pins[domain],
                  let stk = HexUtil.decode(pin.stk), let sig = HexUtil.decode(signatureHex),
                  Self.verifyBootKeyBinding(serverDomain: domain, bootPubHex: bootPubHex, issuedAt: issuedAt,
                                            signature: sig, pinnedStkPub: stk, forServer: domain),
                  (pin.bootIssuedAt ?? -1) <= issuedAt
            else { return nil }
            // Once this server's ML-DSA key is pinned, the boot key needs the STK's hybrid
            // signature too, so stripping it cannot downgrade the server back to classical.
            if let mldsa = pin.mldsa,
               !Self.verifyBootKeyBindingV2(serverDomain: domain, bootPubHex: bootPubHex, issuedAt: issuedAt,
                                            hybridSignatureHex: hybridSignatureHex, stkHex: pin.stk, mldsaPubHex: mldsa) {
                return nil
            }
            pin.boot = bootPubHex
            pin.bootIssuedAt = issuedAt
            pins[domain] = pin
            return bootPubHex
        }
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
        return try withPins(username) { pins -> String? in
            guard var pin = pins[domain] else { return nil }
            switch Self.decideBoxPqKeyPin(stkHex: pin.stk, mldsaPubHex: pin.mldsa, minIssuedAt: pin.mldsaIssuedAt,
                                          serverDomain: domain, wire: wire, now: now()) {
            case .first(let k, let at), .match(let k, let at):
                if pin.mldsa != k || pin.mldsaIssuedAt != at {
                    pin.mldsa = k
                    pin.mldsaIssuedAt = at
                    pins[domain] = pin
                }
                return k
            case .mismatch:
                let reported = ((wire as? [String: Any])?["mldsaPubHex"] as? String) ?? ""
                throw BoxKeyChangedError(username: username.lowercased(), serverDomain: domain, pinnedHex: pin.mldsa ?? "", reportedHex: reported)
            case .invalid:
                return nil
            }
        }
    }

    public func pinnedBoxPqKey(username: String, serverDomain: String) -> String? {
        withPins(username) { $0[serverDomain.lowercased()]?.mldsa }
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

    // MARK: Storage

    private static func isHex32(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private func key(_ username: String) -> String { "flagship.boxKeyPins.v1:\(username.lowercased())" }

    private func withPins<T>(_ username: String, _ body: (inout [String: Pin]) throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        let k = key(username)
        var pins: [String: Pin]
        if let defaults {
            pins = (defaults.data(forKey: k)).flatMap { try? JSONDecoder().decode([String: Pin].self, from: $0) } ?? [:]
        } else {
            pins = memory[k] ?? [:]
        }
        let before = pins
        let out = try body(&pins)
        if pins != before {
            if let defaults {
                if let data = try? JSONEncoder().encode(pins) { defaults.set(data, forKey: k) }
            } else {
                memory[k] = pins
            }
        }
        return out
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
    public func observe(username: String, pods: [PodDirectoryEntry]) {
        observe(username: username, pods: pods.map {
            PodDirectoryEntryLike(domain: $0.serverDomain, stkHex: $0.identityPubKey, revoked: $0.revokedAt != nil)
        })
    }
}
