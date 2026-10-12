// Settings → Push notifications (docs/ai-privacy-and-staging.md §3a,
// "Turning alerts off"). Hiding notifications in the OS only hides them after
// they've travelled through Flagship and Google, so off really means off:
// this device drops its push registration with .com (and ignores FCM token
// rotations), deletes its FCM token so Google has nothing to deliver to even
// if the .com revoke fails or is cancelled, and every box it manages is told to send no access-request push
// (`POST /api/screens/settings/access-alerts {enabled:false}`). Requests still
// wait on each app's page, and the app shows no access sheets.

package com.flagshipserver.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class PushNotificationsSwitch(
    /** The device's choice (default on), persisted by [persist]. */
    val enabled: StateFlow<Boolean>,
    private val persist: (Boolean) -> Unit,
    /** The boxes this device manages, resolved at each write. */
    private val boxes: () -> List<AccessBox>,
    /** Register this device's push token with .com; false when it didn't. */
    private val register: suspend () -> Boolean,
    /** Revoke it; false when a registration may remain (retried later). */
    private val revoke: suspend () -> Boolean,
    /** Whether this device still holds a registration it would revoke. */
    private val isRegistered: () -> Boolean,
    /** Delete this device's FCM token with Google (a fresh one is fetched
     *  when the switch goes back on). */
    private val dropProviderToken: suspend () -> Unit = {},
    /** Outlives the Settings screen, so leaving it mid-toggle (say, during
     *  the biometric prompt for the revoke) doesn't cancel the change. */
    private val scope: CoroutineScope? = null,
) {
    private val mutex = Mutex()
    private var registrationOwed = false
    private var providerDropOwed = false

    /** The Settings switch: [set] on [scope]. */
    fun toggle(value: Boolean) {
        val s = scope ?: return
        s.launch { set(value) }
    }

    /** Persists at once (the switch flips without waiting on the network),
     *  then writes every box and (un)registers this device's push token. */
    suspend fun set(value: Boolean) {
        persist(value)
        mutex.withLock {
            writeAllLocked(value)
            if (value) {
                providerDropOwed = false
                registrationOwed = !safely { register() }
            } else {
                registrationOwed = false
                // Before the revoke, whose biometric prompt can be cancelled.
                providerDropOwed = !safely { dropProviderToken(); true }
                safely { revoke() }
            }
        }
    }

    /** App start / foreground: put the device's value on every box that
     *  disagrees, and finish a push (un)registration that failed earlier. */
    suspend fun resync() {
        mutex.withLock {
            val want = enabled.value
            for (box in boxes()) {
                val current = try {
                    box.client.accessAlerts().enabled
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    // An older box (404), an offline one, or no session.
                    continue
                }
                if (current != want) write(box, want)
            }
            if (!want && providerDropOwed) providerDropOwed = !safely { dropProviderToken(); true }
            if (!want && isRegistered()) safely { revoke() }
            if (want && registrationOwed) registrationOwed = !safely { register() }
        }
    }

    /** How many boxes took the write. */
    private suspend fun writeAllLocked(value: Boolean): Int =
        boxes().count { write(it, value) }

    private suspend fun write(box: AccessBox, value: Boolean): Boolean = try {
        box.client.accessAlertsSet(value)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        false
    }

    private suspend fun safely(block: suspend () -> Boolean): Boolean = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        false
    }

    companion object {
        const val TITLE = "Push notifications"
        const val SUBTEXT = "When this is off, nothing from Flagship is pushed to this device, so Apple " +
            "and Google never see when your servers need you. You'll have to open Flagship to approve " +
            "unlocks and see requests."
    }
}
