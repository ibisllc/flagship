// Copying a secret (an app API key, a backup passcode).
//
// Android 13+ honours the clip's IS_SENSITIVE flag: the system's copy preview hides the text.
// Android 10 to 12 have no such flag (and no preview), so there the app takes the secret off the
// clipboard a minute after copying it, but only while the clip is still the one it copied: a
// person who copied something else since keeps it. Android 10+ lets only the focused app read the
// clipboard, so a minute that ends while the app is in the background is settled the next time it
// has focus. Only a SHA-256 of the copied text is kept in memory.

package com.flagshipserver.app.core

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import java.security.MessageDigest

object SensitiveClipboard {
    /** ClipDescription.EXTRA_IS_SENSITIVE (API 33); harmless on older versions. */
    const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    const val CLEAR_AFTER_MS = 60_000L

    enum class Action { CLEAR, LEAVE, LATER }

    /**
     * What to do with the clipboard once a copied secret's minute is up. [readable] is false while
     * the app can't read the clipboard (not focused): decide again later. A clip that is empty or
     * different was replaced by the person, so it stays.
     */
    fun decide(pendingDigest: String?, dueAt: Long, now: Long, readable: Boolean, current: String?): Action = when {
        pendingDigest == null -> Action.LEAVE
        now < dueAt -> Action.LATER
        !readable -> Action.LATER
        current != null && digest(current) == pendingDigest -> Action.CLEAR
        else -> Action.LEAVE
    }

    fun digest(text: String): String =
        HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))

    @Volatile private var pending: String? = null
    @Volatile private var dueAt: Long = 0
    /** Set by MainActivity from onWindowFocusChanged: Android 10+ hides the clipboard otherwise. */
    @Volatile var appHasFocus: Boolean = false

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** Copies [text] flagged sensitive, and on Android 10 to 12 arranges for it to be cleared. */
    fun copy(context: Context, label: String, text: String, sdk: Int = Build.VERSION.SDK_INT) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val clip = ClipData.newPlainText(label, text)
        clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
        cm.setPrimaryClip(clip)
        if (!AndroidVersionPolicy.clipboardNeedsAutoClear(sdk)) return
        pending = digest(text)
        dueAt = System.currentTimeMillis() + CLEAR_AFTER_MS
        val app = context.applicationContext
        main.postDelayed({ settle(app) }, CLEAR_AFTER_MS)
    }

    /** Clear the copied secret if its minute is up and it is still on the clipboard. */
    fun settle(context: Context, now: Long = System.currentTimeMillis()) {
        val digest = pending ?: return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val readable = appHasFocus
        val current = if (readable) runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() }.getOrNull() else null
        when (decide(digest, dueAt, now, readable, current)) {
            Action.CLEAR -> {
                runCatching { cm.clearPrimaryClip() }
                pending = null
            }
            Action.LEAVE -> pending = null
            Action.LATER -> Unit
        }
    }

    /** Test seam. */
    internal fun pendingForTest(): Pair<String?, Long> = pending to dueAt
}
