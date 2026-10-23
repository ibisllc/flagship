import Foundation
import FlagshipAPI

/// A box's boot key (packages/protocol/src/bootKey.ts; webapp lib/bootKey.js):
/// the only key a box keeps on its unencrypted /boot, used before its disk is
/// open. Disk-key replies and auto-unlock leases are sealed to it, never to the
/// STK (which stays inside the encrypted root). A device adopts a boot key only
/// through a binding the server's PINNED STK signed, never because `.com` lists
/// it. A box installed before boot keys has none: callers then seal to the STK.
public enum BootKey {
    /// The boot key `wire` binds for `serverDomain` under `stkPubHex`, or nil
    /// when the binding is for another server, isn't signed by that STK, or
    /// names the STK itself.
    public static func verified(_ wire: BootKeyBindingWire, serverDomain: String, stkPubHex: String) -> String? {
        guard let n = normalized(wire),
              n.bootPubHex != stkPubHex.lowercased(),
              let stk = HexUtil.decode(stkPubHex.lowercased()), stk.count == 32,
              let sig = HexUtil.decode(n.signatureHex),
              BoxKeyPins.verifyBootKeyBinding(serverDomain: n.serverDomain, bootPubHex: n.bootPubHex, issuedAt: n.issuedAt,
                                              signature: sig, pinnedStkPub: stk, forServer: serverDomain)
        else { return nil }
        return n.bootPubHex
    }

    /// The boot key to seal to for `serverDomain` on this account, or nil when
    /// the server has none. A binding that doesn't verify under the pinned STK
    /// is ignored; the boot key pinned earlier, if any, still applies.
    public static func forServer(username: String, serverDomain: String,
                                 mailbox: any SecretMailboxClient, pins: BoxKeyPins) async -> String? {
        if let wire = try? await mailbox.fetchBootKeyBinding(serverDomain: serverDomain),
           let stk = pins.pinned(username: username, serverDomain: serverDomain),
           verified(wire, serverDomain: serverDomain, stkPubHex: stk) != nil,
           let n = normalized(wire),
           let accepted = pins.acceptBootKeyBinding(username: username, serverDomain: serverDomain,
                                                    bootPubHex: n.bootPubHex, issuedAt: n.issuedAt,
                                                    signatureHex: n.signatureHex) {
            return accepted
        }
        return pins.pinnedBootKey(username: username, serverDomain: serverDomain)
    }

    /// For a shared server: the boot key the STK pinned in the owner's offer
    /// vouches for, or nil. Nothing is stored.
    public static func forSharedServer(serverDomain: String, pinnedStkHex: String,
                                       fetch: () async throws -> BootKeyBindingWire?) async -> String? {
        guard let wire = try? await fetch() else { return nil }
        return verified(wire, serverDomain: serverDomain, stkPubHex: pinnedStkHex)
    }

    private struct Normalized {
        let serverDomain: String
        let bootPubHex: String
        let issuedAt: Int64
        let signatureHex: String
    }

    private static func normalized(_ w: BootKeyBindingWire) -> Normalized? {
        let boot = w.binding.bootPubHex.lowercased()
        let sig = w.signature.lowercased()
        guard boot.count == 64, boot.allSatisfy(\.isHexDigit),
              sig.count == 128, sig.allSatisfy(\.isHexDigit)
        else { return nil }
        return Normalized(serverDomain: w.binding.serverDomain.lowercased(), bootPubHex: boot,
                          issuedAt: w.binding.issuedAt, signatureHex: sig)
    }
}
