import Foundation

/// Swift mirror of `packages/protocol/src/pairingOrder.ts` `pairingOrderToJson` —
/// the PLAINTEXT `add-paired-session` envelope JSON for the SECRET-FREE pairing
/// path (the twin of `SwkDelivery`, for the paired-session token).
///
/// The first recipe carries ZERO pairing secrets. The owner-IRK-signed
/// `add-paired-session` order is serialized into this plaintext `{request,
/// signature}` JSON, which the box parses verbatim. It is either:
///   - EMBEDDED in the recipe as the unsigned `pairingOrder` sibling (offline),
///     or
///   - SEALED to the box's directory identity + deposited on `.com`'s blind
///     pairing-deposit lane post-registration (default online).
///
/// The box re-derives canonical bytes from the field VALUES, so key order is
/// irrelevant to verification — but we reproduce the pinned cross-platform
/// vector's key order
/// (`{request:{type,serverId,token,issuedAt}, signature}`) byte-for-byte
/// (`packages/protocol/tests/pairingOrder.test.ts`), so the embedded sibling +
/// the sealed deposit payload are identical to the TS / webapp / Kotlin twins.
public enum PairingOrderEnvelope {
    /// Serialize an `add-paired-session` order + its owner-IRK signature into the
    /// plaintext envelope JSON string (UTF-8). Built by hand (NOT
    /// `JSONSerialization`, which doesn't preserve key order) to be byte-identical
    /// to the TS `pairingOrderToJson` pinned vector.
    public static func toJson(order: AddPairedSessionOrder, signatureHex: String) -> String {
        // JSON.stringify emits no whitespace, strings double-quoted with the
        // standard JS escapes, and `issuedAt` as a bare number. The order's
        // string fields are field-guarded at sign time (no '|'/control chars);
        // serverId/token are hostname/hex.
        let req = "{\"type\":\"add-paired-session\","
            + "\"serverId\":\(jsonString(order.serverId)),"
            + "\"token\":\(jsonString(order.token)),"
            + "\"issuedAt\":\(order.issuedAt)}"
        return "{\"request\":\(req),\"signature\":\(jsonString(signatureHex))}"
    }

    /// Minimal JSON string encoder matching `JSON.stringify` for the characters
    /// that can appear in these fields (`"`, `\`, and control chars). Mirrors
    /// the ECMAScript string-serialization rules.
    static func jsonString(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
