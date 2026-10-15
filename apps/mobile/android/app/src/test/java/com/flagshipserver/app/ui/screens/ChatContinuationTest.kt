// A build chat that is ready to deploy or failed takes a new message.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.api.TalkToUserPayload
import com.flagshipserver.app.api.VibeCodePendingRequest
import com.flagshipserver.app.api.VibeCodeSessionPublicState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatContinuationTest {
    private fun state(status: String, canContinue: Boolean, asking: Boolean = false) = VibeCodeSessionPublicState(
        id = "s1",
        status = status,
        messages = emptyList(),
        canContinue = canContinue,
        pendingRequest = if (asking) VibeCodePendingRequest.TalkToUser("t1", TalkToUserPayload("ok?")) else null,
    )

    @Test fun theComposerOpensWhenTheBoxSaysTheChatCanContinue() {
        assertTrue(ChatContinuation.takesMessage(state("ready-to-deploy", canContinue = true)))
        assertTrue(ChatContinuation.takesMessage(state("failed", canContinue = true)))
        // An older box doesn't say so: only the AI's question opens it.
        assertFalse(ChatContinuation.takesMessage(state("failed", canContinue = false)))
        assertFalse(ChatContinuation.takesMessage(state("deployed", canContinue = false)))
        // The question's own composer answers it.
        assertFalse(ChatContinuation.takesMessage(state("awaiting-tool-response", canContinue = false, asking = true)))
    }

    @Test fun placeholdersSayWhatToWrite() {
        assertEquals("Ask for a change…", ChatContinuation.placeholder("ready-to-deploy"))
        assertEquals("Tell the AI what to try next…", ChatContinuation.placeholder("failed"))
    }

    @Test fun aNewMessageNeedsWords() {
        assertFalse(ChatContinuation.canSend("   ", continuing = true))
        assertTrue(ChatContinuation.canSend("make it blue", continuing = true))
        assertTrue(ChatContinuation.canSend(" ", continuing = false))
        assertFalse(ChatContinuation.canSend("", continuing = false))
    }
}
