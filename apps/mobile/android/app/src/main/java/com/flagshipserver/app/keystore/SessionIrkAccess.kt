// IrkAccess for work that must never open a biometric prompt (a watch
// approval answered while the phone may be in a pocket): it hands out the IRK
// only while this app session is already unlocked, and refuses otherwise.
// Without a bound activity, Keystore.deriveIRK skips its prompt entirely, so
// background callers must check the session first, which this does.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.IrkAccess
import com.flagshipserver.app.core.IrkMaterial
import com.flagshipserver.app.core.WatchDelegateSigner

class SessionLockedException : Exception(FSStrings.get(R.string.this_app_session_isnt_unlocked))

class SessionIrkAccess(
    private val sessionUnlocked: () -> Boolean = { isSessionUnlocked() },
    private val inner: com.flagshipserver.app.core.IrkAccess = KeystoreIrkAccess(),
) : IrkAccess {
    override suspend fun resolve(reason: String): IrkMaterial {
        if (!sessionUnlocked()) throw SessionLockedException()
        return inner.resolve(reason)
    }

    companion object {
        /** True while a biometric-authenticated session is open in the app. */
        fun isSessionUnlocked(): Boolean = BiometricAuthority.current()?.isFresh() == true

        /** The enrolled watch-delegate key, or null when Quick approve is off on
         *  this device (never mints one). */
        fun watchDelegate(): WatchDelegateSigner? {
            if (!Keystore.hasWatchDelegateKey()) return null
            val pub = Keystore.watchDelegatePubHex() ?: return null
            return WatchDelegateSigner(Keystore.loadOrCreateWatchDelegateKey(), pub)
        }
    }
}
