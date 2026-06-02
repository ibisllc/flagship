import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// W10 — environment key for the SetServiceEnvRequest envelope signer.
///
/// Production wires this to the platform Keystore (`deriveIRK` →
/// `signature(for: canonicalBytes)`), with the canonical-bytes shape
/// mirroring `@flagship/protocol/auth.ts` signSetServiceEnv:
///
///     "flagship/set-service-env/v1"
///         | serverId
///         | creator
///         | slug
///         | <pairCount>
///         | <sortedKey>=<value>...
///         | issuedAt
///
/// Previews + tests inject a stub that returns a fixed hex string —
/// the daemon rejects the signature on a mismatch, which is the
/// correct behavior for offline preview surfaces.
public typealias VibeCodeEnvelopeSigner = @MainActor (ServiceEnvSetEnvelope) async throws -> String

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

/// Canonical bytes for a `SetServiceEnvRequest`, byte-identical to the webapp's
/// `canonicalSetServiceEnv` and `@flagship/protocol/auth.ts` `signSetServiceEnv`.
/// Keys sorted; pairs `key=value`; `|` separator. The daemon re-derives these
/// to verify the owner-IRK signature, so the layout must match exactly.
public func canonicalSetServiceEnv(_ envelope: ServiceEnvSetEnvelope) -> Data {
    let pairs = envelope.env.keys.sorted().map { "\($0)=\(envelope.env[$0] ?? "")" }
    var parts = [
        "flagship/set-service-env/v1",
        envelope.serverId,
        envelope.creator,
        envelope.slug,
        String(pairs.count),
    ]
    parts.append(contentsOf: pairs)
    parts.append(String(envelope.issuedAt))
    return Data(parts.joined(separator: "|").utf8)
}

/// Production signer: derive the owner IRK from the Keystore and sign the
/// canonical bytes. Bound at the app root via
/// `.environment(\.vibeCodeEnvelopeSigner, keystoreVibeCodeEnvelopeSigner())`.
/// Replaces the 128-zero placeholder the daemon always rejected.
@MainActor public func keystoreVibeCodeEnvelopeSigner() -> VibeCodeEnvelopeSigner {
    return { envelope in
        let irk = try await Keystore.deriveIRK(reason: "Sign service configuration")
        let sig = try irk.signature(for: canonicalSetServiceEnv(envelope))
        return HexUtil.encode(sig)
    }
}
