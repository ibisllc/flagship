package com.flagshipserver.app.core

import com.flagshipserver.app.api.VibeCodeSessionMessage

/**
 * A build chat's transcript, kept readable. The AI writes whole files inline
 * (`=== path ===` … `=== END ===`); shown verbatim they are thousands of lines
 * re-rendered on every poll, and the code is on the box anyway. Each finished
 * file becomes one "wrote" line, a file still being written shows only its
 * last few lines, and only the newest messages are kept. Mirror of iOS
 * VibeTranscript.
 */
object VibeTranscript {
    const val MAX_MESSAGES = 40
    const val LIVE_TAIL_LINES = 6

    private fun boundary(line: String): String? {
        val t = line.trim()
        if (!t.startsWith("===") || !t.endsWith("===") || t.length <= 6) return null
        return t.substring(3, t.length - 3).trim().ifEmpty { null }
    }

    /** Collapse file blocks. [live] keeps the tail of an unfinished block. */
    fun compact(text: String, live: Boolean = false): String {
        val out = mutableListOf<String>()
        var file: String? = null
        val body = mutableListOf<String>()
        fun closeFile() {
            val f = file ?: return
            if (f != "QUESTION") {
                out.add("  wrote $f (${body.size} line${if (body.size == 1) "" else "s"})")
            } else {
                out.addAll(body)
            }
            file = null
            body.clear()
        }
        for (line in text.split("\n")) {
            val name = boundary(line)
            when {
                name != null -> {
                    closeFile()
                    if (name != "END") file = name
                }
                file != null -> body.add(line)
                else -> out.add(line)
            }
        }
        val open = file
        if (open != null) {
            if (live && open != "QUESTION") {
                out.add("  writing $open… (${body.size} lines)")
                body.takeLast(LIVE_TAIL_LINES).forEach { out.add("    $it") }
            } else {
                closeFile()
            }
        }
        while (out.isNotEmpty() && out.last().isBlank()) out.removeAt(out.lastIndex)
        return out.joinToString("\n")
    }

    /** The newest messages, the AI's compacted, and how many older ones were left out. */
    fun lines(messages: List<VibeCodeSessionMessage>): Pair<Int, List<VibeCodeSessionMessage>> {
        val shown = messages.takeLast(MAX_MESSAGES)
        return (messages.size - shown.size) to shown.map {
            if (it.role == "assistant") it.copy(text = compact(it.text)) else it
        }
    }

    fun hiddenText(n: Int): String = "… $n earlier message${if (n == 1) "" else "s"} not shown"
}
