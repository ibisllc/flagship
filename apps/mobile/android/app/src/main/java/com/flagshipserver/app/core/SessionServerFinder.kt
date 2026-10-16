// The server holding a build chat, when the link to it names no server this
// device knows. Kotlin twin of the webapp's findSessionServer
// (apps/web/public/webapp/lib/vibeSessions.js).

package com.flagshipserver.app.core

object SessionServerFinder {
    const val NOT_FOUND = "That build isn't open on any of your servers any more."

    /**
     * The first server holding [sessionId]: the [first] candidates in order (a
     * hint, then the current server), then [more] (every server this device
     * has a session on, read only when those miss). [probe] answers true when
     * that box holds the session; a throw or false moves on. Null when none
     * does. Servers are compared case-blind and each is asked once.
     */
    suspend fun find(
        sessionId: String,
        first: List<String?>,
        more: suspend () -> List<String> = { emptyList() },
        probe: suspend (String) -> Boolean,
    ): String? {
        if (sessionId.isEmpty()) return null
        val tried = HashSet<String>()
        suspend fun tryOne(fqdn: String?): String? {
            val f = fqdn?.trim()?.lowercase().orEmpty()
            if (f.isEmpty() || !tried.add(f)) return null
            return try {
                if (probe(f)) f else null
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Throwable) {
                null
            }
        }
        for (f in first) tryOne(f)?.let { return it }
        val rest = try {
            more()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            emptyList()
        }
        for (f in rest) tryOne(f)?.let { return it }
        return null
    }
}
