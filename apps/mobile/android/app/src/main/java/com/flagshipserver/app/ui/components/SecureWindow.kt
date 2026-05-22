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
        val activity = context.findActivity()
        activity?.window?.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        onDispose {
            activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
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
