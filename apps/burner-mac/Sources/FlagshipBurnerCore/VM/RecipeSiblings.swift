import Foundation

/// Reads the UNSIGNED top-level siblings that ride beside the signed blob in
/// the recipe JSON. Mirrors the canonical engine's `readSiblings`
/// (Resources/preseed-engine.js): the sibling lives at the TOP level of the
/// raw recipe document in both shapes — the flattened recipe and the issued
/// `{blob, blobSignature, …}` envelope — so this reads the raw bytes, not the
/// flattened form `RecipeLoader.normalizeEnvelope` produces.
public enum RecipeSiblings {
    /// The owner-IRK-signed `flagship/debug-access/v1` grant, if the phone
    /// baked one in at mint time. Its PRESENCE is the only debug signal the
    /// host app may act on (consent-as-crypto): the box verifies the grant
    /// against the owner IRK; the host merely decides whether a serial
    /// console is worth attaching. Absent ⇒ production ⇒ no console, ever.
    ///
    /// Matches the engine's `asStr`: a non-empty string is passed through; an
    /// object is stringified; anything else (missing/empty/other types) ⇒ nil.
    public static func debugGrant(inRecipeJSON data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["debugGrant"] else { return nil }
        if let s = raw as? String { return s.isEmpty ? nil : s }
        if JSONSerialization.isValidJSONObject(raw),
           let d = try? JSONSerialization.data(withJSONObject: raw),
           let s = String(data: d, encoding: .utf8) {
            return s
        }
        return nil
    }
}
