import CFlagshipPQ
import CryptoKit
import Foundation

/// Ed25519 public keys from outside are checked here before any signature is verified under them
/// (test-vectors/ed25519-low-order; edSync.isAcceptableEd25519PublicKey on `.com`). CryptoKit accepts
/// small-order keys, under which an identity R and a zero S verify for any message, so the verifier
/// alone is no guard. The check is CFlagshipPQ's strict point decode, the one PqHybrid uses
/// (canonical, not small order, torsion-free, which every honestly made key is).
public enum Ed25519Keys {
    public static func isAcceptable<D: DataProtocol>(_ publicKey: D) -> Bool {
        let b = Array(publicKey)
        guard b.count == 32 else { return false }
        return b.withUnsafeBufferPointer { fl_ed25519_point_strict($0.baseAddress) } == 1
    }

    public static func isAcceptableHex(_ publicKeyHex: String) -> Bool {
        let h = publicKeyHex.lowercased()
        guard h.count == 64, h.allSatisfy(\.isHexDigit) else { return false }
        var out = [UInt8]()
        out.reserveCapacity(32)
        var i = h.startIndex
        while i < h.endIndex {
            let j = h.index(i, offsetBy: 2)
            guard let byte = UInt8(h[i..<j], radix: 16) else { return false }
            out.append(byte)
            i = j
        }
        return isAcceptable(out)
    }
}

extension Curve25519.Signing.PublicKey {
    /// CryptoKit's Ed25519 verify behind `Ed25519Keys.isAcceptable`. Every app-side Ed25519 verify
    /// goes through it.
    public func isValidCheckedSignature<S: DataProtocol, D: DataProtocol>(_ signature: S, for data: D) -> Bool {
        Ed25519Keys.isAcceptable(rawRepresentation) && isValidSignature(signature, for: data)
    }
}
