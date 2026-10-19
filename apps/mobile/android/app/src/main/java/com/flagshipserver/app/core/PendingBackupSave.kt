package com.flagshipserver.app.core

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Saves a downloaded backup into the document the person picks. The picker is registered on the
 * Activity and the file is held here, not in a dialog's state: coming back from the picker re-locks
 * the app, which rebuilds the dialog with a fresh view model, and a result read from that state
 * left the new document empty (the server had already removed its own copy).
 */
object PendingBackupSave {
    @Volatile var launcher: ((String) -> Unit)? = null
    @Volatile private var file: File? = null
    @Volatile private var listener: ((Boolean) -> Unit)? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun start(backup: File, name: String, onResult: (Boolean) -> Unit) {
        file = backup
        listener = onResult
        val open = launcher
        if (open == null) onResult(false) else open(name)
    }

    fun onPicked(context: Context, doc: Uri?) {
        val backup = file
        val done = listener
        if (doc == null || backup == null) return
        scope.launch {
            val ok = runCatching { copyInto(context, doc, backup) }.isSuccess
            withContext(Dispatchers.Main) { done?.invoke(ok) }
        }
    }

    internal fun copyInto(context: Context, doc: Uri, backup: File) {
        context.contentResolver.openOutputStream(doc)?.use { out -> backup.inputStream().use { it.copyTo(out, 1 shl 20) } }
            ?: throw java.io.IOException("couldn't write ${backup.name}")
    }
}
