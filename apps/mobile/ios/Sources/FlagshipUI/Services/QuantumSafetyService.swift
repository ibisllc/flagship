import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Architecture v2 milestone 4 on iOS: which servers this device holds as strict, the PQ tunnel
/// to them, and the hybrid signature strict servers need on sensitive orders
/// (docs/architecture-v2/pq-suites.md §13).
public enum QuantumSafetyService {
    public static let store = QuantumSafety.Store()

    private static let lock = NSLock()
    nonisolated(unsafe) private static var account: (user: String, deviceId: String)?
    nonisolated(unsafe) private static var tunnel: PqBoxChannelTunnel?

    /// Installs the tunnel for the signed-in account (launch, sign-in); nil uninstalls it.
    public static func activate(username: String?, deviceId: String?) {
        lock.lock(); defer { lock.unlock() }
        tunnel?.reset()
        guard let username, let deviceId, !username.isEmpty, !deviceId.isEmpty else {
            account = nil; tunnel = nil
            PqBoxTunnelRegistry.register(nil)
            return
        }
        let user = username.lowercased()
        account = (user, deviceId.lowercased())
        let t = PqBoxChannelTunnel(
            isStrict: { host in store.replayed(account: user, scope: PolicyScope(kind: .installation, id: host))
                .map { AssurancePolicy.strictInForce($0.state) } ?? false },
            responder: { host in BoxKeyPins.shared.verifiedBoxPqBinding(username: user, serverDomain: host) },
            identity: { await deviceIdentity(username: user, deviceId: deviceId.lowercased()) })
        tunnel = t
        PqBoxTunnelRegistry.register(t)
    }

    /// Sign out, Wipe and Remove this device: forget the held policy and the open sessions.
    public static func forget(username: String?) {
        if let username { store.forget(account: username) }
        activate(username: nil, deviceId: nil)
    }

    /// This device's own binding and hybrid signer, from keys this unlocked session holds.
    static func deviceIdentity(username: String, deviceId: String) async -> PqBoxChannelTunnel.Identity? {
        guard let edKey = Keystore.sessionAccountDeviceKey(accountId: username, deviceId: deviceId) else { return nil }
        let id = PqIdentity(role: .device, subjectId: deviceId, edKey: edKey)
        guard let held = await PqKeyStore.shared.key(for: id), let ml = QSHex.unhex(held.mldsaPubHex) else { return nil }
        let edPub = [UInt8](edKey.publicKey.rawRepresentation)
        let sign: @Sendable (String, [UInt8]) throws -> [UInt8] = { purpose, payload in
            try PqHybrid.hybridSign(edPublicKey: edPub, mldsaPublicKey: ml, purpose: purpose, payload: payload,
                                    edSign: { [UInt8](try edKey.signature(for: Data($0))) }, mldsaSign: held.sign)
        }
        let st = PqKeyBindingStatement(role: "device", subjectId: deviceId, ed25519PubHex: QSHex.hex(edPub), mldsaPubHex: held.mldsaPubHex,
                                       issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
        guard let wire = try? PqTrust.signPqKeyBinding(st, signer: sign),
              let b = try? PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: "device", subjectId: deviceId, ed25519PubHex: st.ed25519PubHex, now: st.issuedAt))
        else { return nil }
        return PqBoxChannelTunnel.Identity(binding: b, sign: sign)
    }

    /// Boot unlock v2: the account key's (IRK) hybrid half on this device, as the coordinator's
    /// owner signer; nil when this device holds no ML-DSA key for it.
    public static func ownerPqSigner(irk: Curve25519.Signing.PrivateKey, username: String) async -> SecretRequestCoordinator.OwnerPqSigner? {
        let id = PqIdentity(role: .accountIrk, subjectId: username, edKey: irk)
        guard let held = await PqKeyStore.shared.key(for: id), let ml = QSHex.unhex(held.mldsaPubHex) else { return nil }
        let edPub = [UInt8](irk.publicKey.rawRepresentation)
        return SecretRequestCoordinator.OwnerPqSigner(publicKey: edPub + ml) { purpose, payload in
            try PqHybrid.hybridSign(edPublicKey: edPub, mldsaPublicKey: ml, purpose: purpose, payload: payload,
                                    edSign: { [UInt8](try irk.signature(for: Data($0))) }, mldsaSign: held.sign)
        }
    }

    /// Whether this device replays the server's installation policy as strict.
    public static func isStrict(username: String, serverDomain: String) -> Bool {
        guard let r = store.replayed(account: username, scope: PolicyScope(kind: .installation, id: serverDomain.lowercased())) else { return false }
        return AssurancePolicy.strictInForce(r.state)
    }

    /// True when any server this device holds for the account is strict: sensitive orders then
    /// carry the signer's hybrid signature too.
    public static func anyStrict(username: String) -> Bool { store.anyStrict(account: username) }

    /// The hybrid signature over an order's canonical bytes by `edKey` (the admin root or the
    /// IRK) and its ML-DSA key on this device; nil when this device holds no PQ half for it.
    public static func pqSignature(canonical: Data, edKey: Curve25519.Signing.PrivateKey, role: PqBindingRole, username: String) async -> PqSignatureWire? {
        let id = PqIdentity(role: role, subjectId: username, edKey: edKey)
        guard let held = await PqKeyStore.shared.key(for: id),
              let env = try? QuantumSafety.hybridEnvelope(message: [UInt8](canonical), edPublicKey: [UInt8](edKey.publicKey.rawRepresentation),
                                                          edSign: { [UInt8](try edKey.signature(for: Data($0))) }, held: held)
        else { return nil }
        return PqSignatureWire(suite: env.suite, signature: env.signature)
    }
}

/// Lowercase hex, for this module (FlagshipCore's helper is internal).
enum QSHex {
    static func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }
    static func unhex(_ s: String) -> [UInt8]? {
        guard s.count % 2 == 0 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let v = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(v)
            i = j
        }
        return out
    }
}
