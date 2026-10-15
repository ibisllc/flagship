package com.flagshipserver.app.core

import com.flagshipserver.app.api.VibeCodeSessionMessage
import org.junit.Assert.assertEquals
import org.junit.Test

// Same cases as iOS VibeTranscriptTests: files collapse to one line, a live
// file keeps its tail, questions stay readable, and only the newest 40
// messages are kept.
class VibeTranscriptTest {
    @Test fun finishedFilesCollapseToOneLine() {
        val text = "Here it is.\n=== app/server.js ===\nconst a = 1\nconst b = 2\n=== END ===\n=== package.json ===\n{}\n=== END ===\nDone."
        assertEquals(
            "Here it is.\n  wrote app/server.js (2 lines)\n  wrote package.json (1 line)\nDone.",
            VibeTranscript.compact(text),
        )
    }

    @Test fun aLiveFileShowsOnlyItsTail() {
        val body = (1..10).joinToString("\n") { "line $it" }
        val out = VibeTranscript.compact("=== big.js ===\n$body", live = true)
        assertEquals(
            listOf("  writing big.js… (10 lines)") + (5..10).map { "    line $it" },
            out.split("\n"),
        )
        assertEquals("  wrote big.js (10 lines)", VibeTranscript.compact("=== big.js ===\n$body"))
    }

    @Test fun aQuestionBlockStaysVerbatim() {
        assertEquals("Which colour?", VibeTranscript.compact("=== QUESTION ===\nWhich colour?\n=== END ===\n\n"))
    }

    @Test fun onlyTheNewestMessagesAreKept_andOnlyTheAisAreCompacted() {
        val msgs = (1..45).map { VibeCodeSessionMessage(role = if (it % 2 == 0) "user" else "assistant", text = "=== f$it ===\nx\n=== END ===", timestamp = it.toLong()) }
        val (hidden, shown) = VibeTranscript.lines(msgs)
        assertEquals(5, hidden)
        assertEquals(40, shown.size)
        assertEquals("  wrote f45 (1 line)", shown.last().text)
        assertEquals("=== f44 ===\nx\n=== END ===", shown[shown.size - 2].text)
        assertEquals("… 5 earlier messages not shown", VibeTranscript.hiddenText(hidden))
        assertEquals("… 1 earlier message not shown", VibeTranscript.hiddenText(1))
    }
}
