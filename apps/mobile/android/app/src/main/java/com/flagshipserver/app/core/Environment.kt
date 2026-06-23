// Kotlin equivalent of FlagshipCore/Environment.swift.
//
// SwiftUI uses an EnvironmentValues type-map; Compose has
// CompositionLocal. We expose ScreensClient, FlagshipServerClient, and
// QrRelayClient through their own statics so any composable can call
// `LocalScreensClient.current` without prop-drilling.

package com.flagshipserver.app.core

import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.DemoConnectClient
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.MockDemoConnectClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.MockServerTransferClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SessionStoring

val LocalScreensClient = staticCompositionLocalOf<ScreensClient> { MockScreensClient() }

/** "Build a service" modes client (the `/api/build/` surface, paired-
 *  session gated). Production wires the live client (OkHttp + session
 *  token) in MainActivity; previews + tests get the in-memory Mock. */
val LocalBuildClient = staticCompositionLocalOf<BuildClient> { MockBuildClient() }

val LocalFlagshipServerClient = staticCompositionLocalOf<FlagshipServerClient> { MockFlagshipServerClient() }

/** Plan A — the demo connect/cancel client. Production wires the live
 *  client (transport + server) in MainActivity; previews + tests get a
 *  Mock over the default MockFlagshipServerClient. */
val LocalDemoConnectClient = staticCompositionLocalOf<DemoConnectClient> {
    MockDemoConnectClient(MockFlagshipServerClient())
}

val LocalQrRelayClient = staticCompositionLocalOf<QrRelayClient> { MockQrRelayClient() }

/** Boot-secret RELAY mailbox client. Production wires the live client
 *  (OkHttp transport) in MainActivity; previews + tests get the in-memory
 *  Mock. The SecretRequestsScreen builds a SecretRequestCoordinator over this. */
val LocalSecretMailboxClient = staticCompositionLocalOf<SecretMailboxClient> { MockSecretMailboxClient() }

/** Transfer-a-box broker client (`.com`): deposits the giver's offer, polls for
 *  the acquirer's claim, hands off the re-sealed disk key. Hits `.com`, not a
 *  box-pinned pipe. Production MainActivity wires the live client; previews +
 *  tests get the in-memory Mock. */
val LocalServerTransferClient = staticCompositionLocalOf<ServerTransferClient> { MockServerTransferClient() }

/** The pod session store backing the BFF (holds podBaseUrl + session token).
 *  Production MainActivity installs the EncryptedSessionStore; previews + tests
 *  get an in-memory one. Create-server reads this to persist the create-time
 *  pairing token so the BFF authenticates once the box claims the deposit. */
val LocalSessionStore = staticCompositionLocalOf<SessionStoring> { InMemorySessionStore() }

val LocalAppState = staticCompositionLocalOf<AppState> { AppState() }

val LocalToastCenter = staticCompositionLocalOf<ToastCenter> { ToastCenter() }

val LocalDeepLinker = staticCompositionLocalOf<DeepLinker> { DeepLinker() }

/** App-wide "active operations" registry feeding the global teal sliver
 *  (the WhatsApp-style active-call bar). Production MainActivity installs
 *  one instance; previews + tests get the default empty center. */
val LocalActiveOperationsCenter = staticCompositionLocalOf<ActiveOperationsCenter> { ActiveOperationsCenter() }

/** App-wide maintainer-trust verdict + failing-cert registry feeding the red
 *  persistent trust sliver + the `.com` backend short-circuit. Production
 *  MainActivity installs one instance; previews + tests get the default
 *  (UNKNOWN ⇒ trusted, no halt). */
val LocalTrustCenter = staticCompositionLocalOf<TrustCenter> { TrustCenter() }

val LocalDeveloperSettings = staticCompositionLocalOf<DeveloperSettings?> { null }

/** C12 — PrivacySettings persistence handle. Null on previews and in
 *  unit tests; the production MainActivity always installs a real one. */
val LocalPrivacySettings = staticCompositionLocalOf<PrivacySettings?> { null }

/**
 * W10 — `SetServiceEnvRequest` envelope signer. Production wires this
 * to the platform Keystore (derive IRK → sign canonical bytes). Tests
 * + previews use the default no-op which returns a placeholder hex
 * string (the daemon rejects it on signature verify — correct
 * behavior for an offline preview surface).
 *
 * Canonical-bytes shape mirrors `@flagship/protocol/auth.ts`
 * `signSetServiceEnv`:
 *
 *     "flagship/set-service-env/v1"
 *         | serverId | creator | slug | <pairCount>
 *         | <sortedKey>=<value>... | issuedAt
 */
typealias VibeCodeEnvelopeSigner = suspend (com.flagshipserver.app.api.ServiceEnvSetEnvelope) -> String

val LocalVibeCodeEnvelopeSigner = staticCompositionLocalOf<VibeCodeEnvelopeSigner> {
    { _ -> "0".repeat(128) }
}

/**
 * Canonical bytes for a `SetServiceEnvRequest`, byte-identical to the
 * webapp's `canonicalSetServiceEnv` and `@flagship/protocol/auth.ts`
 * `signSetServiceEnv`. Keys are sorted; pairs are `key=value`; the field
 * separator is `|`. The daemon re-derives these bytes and verifies the
 * Ed25519 signature against the owner IRK, so the layout must match exactly.
 */
fun canonicalSetServiceEnv(req: com.flagshipserver.app.api.ServiceEnvSetEnvelope): ByteArray {
    val pairs = req.env.keys.sorted().map { "$it=${req.env[it]}" }
    val parts = buildList {
        add("flagship/set-service-env/v1")
        add(req.serverId)
        add(req.creator)
        add(req.slug)
        add(pairs.size.toString())
        addAll(pairs)
        add(req.issuedAt.toString())
    }
    return parts.joinToString("|").toByteArray(Charsets.UTF_8)
}

/** P6 — owner-only invite label book. Maps `(serviceId, opaqueTag)`
 *  to local display name + channel + sent-to memo + notes. NEVER
 *  leaves the device. Default is an in-memory book; production
 *  MainActivity installs the SharedPreferences-backed variant. */
val LocalInviteLabelBook = staticCompositionLocalOf<InviteLabelBook> { InMemoryInviteLabelBook() }
