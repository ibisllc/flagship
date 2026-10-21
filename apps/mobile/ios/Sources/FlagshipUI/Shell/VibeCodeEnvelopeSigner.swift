import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// W10 — environment key for the env-change signer: the owner IRK signs one
/// `ServiceEnvChange` (flagship/service-env-change/v1, canonical bytes in
/// FlagshipAPI `ServiceEnvChange.canonicalBytes()`), which names the one
/// variable it sets or unsets and a nonce the box spends once.
///
/// Previews + tests inject a stub that returns a fixed hex string —
/// the daemon rejects the signature on a mismatch, which is the
/// correct behavior for offline preview surfaces.
public typealias VibeCodeEnvelopeSigner = @MainActor (ServiceEnvChange) async throws -> String

private struct VibeCodeEnvelopeSignerKey: EnvironmentKey {
    // `EnvironmentKey.defaultValue` is a `nonisolated` protocol requirement,
    // so it cannot be satisfied by a `@MainActor`-isolated stored property
    // without crossing actor isolation (an error under the Swift 6 language
    // mode). The closure body captures no main-actor state — it just returns
    // a constant — so we build it lazily in a `nonisolated` computed property.
    // Production still overrides this via `.environment(\.vibeCodeEnvelopeSigner, …)`.
    nonisolated static var defaultValue: VibeCodeEnvelopeSigner {
        { _ in
            // Preview / test default — returns a placeholder hex string the
            // daemon always rejects, which is correct for offline surfaces.
            String(repeating: "0", count: 128)
        }
    }
}

public extension EnvironmentValues {
    var vibeCodeEnvelopeSigner: VibeCodeEnvelopeSigner {
        get { self[VibeCodeEnvelopeSignerKey.self] }
        set { self[VibeCodeEnvelopeSignerKey.self] = newValue }
    }
}

/// Production signer: derive the owner IRK from the Keystore and sign the
/// canonical bytes. Bound at the app root via
/// `.environment(\.vibeCodeEnvelopeSigner, keystoreVibeCodeEnvelopeSigner())`.
/// Replaces the 128-zero placeholder the daemon always rejected.
@MainActor public func keystoreVibeCodeEnvelopeSigner() -> VibeCodeEnvelopeSigner {
    return { change in
        let bytes = try change.canonicalBytes()
        let irk = try await Keystore.deriveIRK(reason: String(localized: "Sign service configuration"))
        let sig = try irk.signature(for: bytes)
        return HexUtil.encode(sig)
    }
}
