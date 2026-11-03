// Phase 3b — FLAG_SECURE scope for sensitive screens.
//
// While this composable is in the tree, the host window carries
// WindowManager.LayoutParams.FLAG_SECURE: the OS blocks screenshots,
// blanks the preview in the app-switcher, and prevents non-secure screen
// captures. We add the flag on enter and CLEAR it on dispose so the rest
// of the app behaves normally. Used by the cross-device pairing QR +
// scan windows (the QR is the doorway to the account UMK; a leaked still
// is a key leak).

package com.flagshipserver.app.ui.components

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext

/** Arms FLAG_SECURE for as long as this composable is in the tree.
 *  No-op when the context can't be resolved to an Activity (e.g. some
 *  preview surfaces) so it never crashes a render. */
@Composable
fun SecureWindow() {
    val context = LocalContext.current
    DisposableEffect(Unit) {
        if (com.flagshipserver.app.core.Variant.allowScreenCapture) return@DisposableEffect onDispose { }
        val activity = context.findActivity() ?: return@DisposableEffect onDispose { }
        val holder = Any()
        WindowSecurity.hold(activity, holder)
        onDispose { WindowSecurity.release(activity, holder) }
    }
}

/**
 * Who wants FLAG_SECURE on a window: a sensitive screen ([SecureWindow]) or, on Android 10 to 12,
 * the app lock (no `setRecentsScreenshotEnabled` there, so FLAG_SECURE keeps the account out of
 * Recents). The flag stays while anyone holds it, so one leaving never clears the other's.
 */
object WindowSecurity {
    private val holders = java.util.WeakHashMap<Activity, MutableSet<Any>>()

    fun hold(activity: Activity, holder: Any) {
        synchronized(holders) { holders.getOrPut(activity) { mutableSetOf() }.add(holder) }
        activity.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    fun release(activity: Activity, holder: Any) {
        val empty = synchronized(holders) {
            val set = holders[activity] ?: return
            set.remove(holder)
            set.isEmpty()
        }
        if (empty) activity.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
}

private fun Context.findActivity(): Activity? {
    var ctx: Context? = this
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}
