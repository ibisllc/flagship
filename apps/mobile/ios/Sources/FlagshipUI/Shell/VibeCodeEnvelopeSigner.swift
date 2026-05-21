import SwiftUI
import FlagshipAPI

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
    @MainActor static let defaultValue: VibeCodeEnvelopeSigner = { _ in
        // Preview / test default — returns a placeholder hex string.
        // Production replaces this via `.environment(\.vibeCodeEnvelopeSigner, …)`
        // at the RootShell level.
        return String(repeating: "0", count: 128)
    }
}

public extension EnvironmentValues {
    var vibeCodeEnvelopeSigner: VibeCodeEnvelopeSigner {
        get { self[VibeCodeEnvelopeSignerKey.self] }
        set { self[VibeCodeEnvelopeSignerKey.self] = newValue }
    }
}
