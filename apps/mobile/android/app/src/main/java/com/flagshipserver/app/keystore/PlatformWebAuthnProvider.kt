// Production WebAuthnProvider — adapts the real PasskeyRecoveryManager
// (CredentialManager + PRF) to the register()/prfAssert() seam that the
// Wipe & restart and Login-takeover ceremonies consume.
//
// WHY THIS EXISTS: WipeRestartViewModel and LoginViewModel default their
// `webAuthn` to MockWebAuthnProvider. The Recovery + Secure-account flows
// already drive the REAL PasskeyRecoveryManager directly, but those two
// ceremonies (Wipe and credentialed login-takeover) were left on the Mock
// at their production call sites — so the atomic UMK+IRK+recovery-passkey
// rotation minted a FAKE credential and sealed cloud recovery under a
// passkey that doesn't exist (unrecoverable after a wipe), and "credentialed"
// takeover login wasn't actually credentialed. This adapter lets those
// production call sites inject the same real provider Recovery uses, while
// the Mock stays the default for previews + unit tests.
//
// SEAM BRIDGE: the interface splits register() (mint → return credentialId)
// from prfAssert(credentialId) (re-derive the secret), but
// PasskeyRecoveryManager.createPasskey() does BOTH in one ceremony (it
// harvests the PRF secret immediately on create). To avoid a second
// biometric prompt during Wipe, register() stashes the harvested secret
// keyed by credentialId; the paired prfAssert() returns it. A prfAssert()
// for a credential we didn't just mint (the login-takeover path, asserting
// against an existing cloud credential) falls through to a real assertion.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Components/PlatformWebAuthnProvider.swift.

package com.flagshipserver.app.keystore

import android.app.Activity

class PlatformWebAuthnProvider(
    /** Foreground activity to host the CredentialManager UI. Supplied
     *  lazily so the provider can be constructed before the Activity is
     *  resolved (and so a backgrounded host fails closed rather than
     *  crashing). */
    private val activity: () -> Activity?,
    /** The relying-party username embedded in a freshly-minted passkey.
     *  Defaults to the iOS placeholder when no account handle is known. */
    private val username: () -> String? = { null },
    private val manager: PasskeyRecoveryManager,
) : WebAuthnProvider {

    /** PRF secret harvested by [register]'s create ceremony, keyed by the
     *  new credentialId so the immediately-following [prfAssert] reuses it
     *  instead of prompting the user a second time. */
    private val freshSecrets = HashMap<String, ByteArray>()

    override suspend fun register(): String {
        val act = activity()
            ?: throw IllegalStateException("Open this screen from the foreground to use a passkey.")
        val created = manager.createPasskey(act, username() ?: "you")
        freshSecrets[created.credentialId] = created.prfSecret
        return created.credentialId
    }

    override suspend fun prfAssert(credentialId: String): ByteArray {
        // Reuse the secret captured during register() for this credential
        // (Wipe path) so we don't re-prompt; otherwise assert for real
        // (login-takeover path against an existing cloud credential).
        freshSecrets.remove(credentialId)?.let { return it }
        val act = activity()
            ?: throw IllegalStateException("Open this screen from the foreground to use a passkey.")
        return manager.assertPrf(act, credentialId)
    }
}
