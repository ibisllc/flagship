package com.flagshipserver.app.core

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.SensitiveClipboard.Action
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SensitiveClipboardTest {
    private val ctx: Context get() = ApplicationProvider.getApplicationContext()
    private val cm get() = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private fun clipText() = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
    private val d = SensitiveClipboard.digest("key-123")

    @After fun reset() {
        SensitiveClipboard.appHasFocus = false
        SensitiveClipboard.settle(ctx, Long.MAX_VALUE) // drops anything pending
    }

    @Test fun decisions() {
        assertEquals(Action.LEAVE, SensitiveClipboard.decide(null, 0, 100, true, "key-123"))
        assertEquals(Action.LATER, SensitiveClipboard.decide(d, 200, 100, true, "key-123"))
        assertEquals(Action.LATER, SensitiveClipboard.decide(d, 100, 200, false, null))
        assertEquals(Action.CLEAR, SensitiveClipboard.decide(d, 100, 200, true, "key-123"))
        assertEquals(Action.LEAVE, SensitiveClipboard.decide(d, 100, 200, true, "something else"))
        assertEquals(Action.LEAVE, SensitiveClipboard.decide(d, 100, 200, true, null))
    }

    @Test fun onAndroid10To12TheSecretIsClearedAfterAMinute() {
        SensitiveClipboard.copy(ctx, "Flagship API key", "key-123", sdk = 29)
        assertEquals("key-123", clipText())
        assertEquals(true, cm.primaryClip!!.description.extras!!.getBoolean(SensitiveClipboard.EXTRA_IS_SENSITIVE))
        val (pending, due) = SensitiveClipboard.pendingForTest()
        assertEquals(d, pending)
        SensitiveClipboard.appHasFocus = true
        SensitiveClipboard.settle(ctx, due - 1)
        assertEquals("key-123", clipText())
        SensitiveClipboard.settle(ctx, due)
        assertTrue(clipText().isNullOrEmpty())
        assertNull(SensitiveClipboard.pendingForTest().first)
    }

    @Test fun inTheBackgroundItWaitsForFocus() {
        SensitiveClipboard.copy(ctx, "Flagship API key", "key-123", sdk = 31)
        val due = SensitiveClipboard.pendingForTest().second
        SensitiveClipboard.appHasFocus = false
        SensitiveClipboard.settle(ctx, due + 1)
        assertEquals("key-123", clipText())
        SensitiveClipboard.appHasFocus = true
        SensitiveClipboard.settle(ctx, due + 5_000)
        assertTrue(clipText().isNullOrEmpty())
    }

    @Test fun somethingCopiedSinceIsKept() {
        SensitiveClipboard.copy(ctx, "Flagship API key", "key-123", sdk = 30)
        cm.setPrimaryClip(ClipData.newPlainText("note", "my own text"))
        SensitiveClipboard.appHasFocus = true
        SensitiveClipboard.settle(ctx, SensitiveClipboard.pendingForTest().second)
        assertEquals("my own text", clipText())
        assertNull(SensitiveClipboard.pendingForTest().first)
    }

    @Test fun android13AndUpRelyOnTheSensitiveFlag() {
        SensitiveClipboard.copy(ctx, "Flagship API key", "key-123", sdk = 33)
        assertNull(SensitiveClipboard.pendingForTest().first)
        assertEquals(true, cm.primaryClip!!.description.extras!!.getBoolean(SensitiveClipboard.EXTRA_IS_SENSITIVE))
    }
}
