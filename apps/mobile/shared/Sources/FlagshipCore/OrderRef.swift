import Foundation
import CryptoKit

/// Deterministic opaque reference for an install order — the value the
/// UNAUTHENTICATED `/pods` `pending[]` carries instead of the raw auth-code
/// serial. The serial is a capability (anyone who knows username+serial can
/// POST fake provision phases to `/api/order/<serial>/status` +
/// `/api/install-events/<serial>`), so it never rides an unauthenticated
/// response. A device that minted the order knows the real serial and
/// computes the SAME ref locally to reconcile against the directory; the
/// deep-progress poll keeps using the locally-stored serial only.
///
/// Mirrors control-plane `orderRefForSerial`
/// (packages/control-plane/src/podInventory.ts) byte-for-byte:
/// `hex(sha256("flagship/order-ref/v1|" + serial))`.
public enum OrderRef {
    public static func compute(serial: String) -> String {
        let bytes = Data("flagship/order-ref/v1|\(serial)".utf8)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
