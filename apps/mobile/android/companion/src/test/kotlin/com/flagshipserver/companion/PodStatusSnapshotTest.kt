package com.flagshipserver.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PodStatusSnapshotTest {
    private fun pod(id: String, status: String = "online", leader: Boolean = false) =
        PodStatusSnapshot.Pod(id, id.replaceFirstChar { it.uppercase() }, "$id.bright-maple.flagship.services", status, leader)

    @Test fun headlineIsTheLeaderElseTheFirst() {
        val s = PodStatusSnapshot(pods = listOf(pod("home"), pod("office", leader = true)))
        assertEquals("office", s.headline?.podId)
        assertEquals("home", PodStatusSnapshot(pods = listOf(pod("home"), pod("office"))).headline?.podId)
        assertNull(PodStatusSnapshot.EMPTY.headline)
    }

    @Test fun listShowsAtMostFourInOrder() {
        val s = PodStatusSnapshot(pods = (1..6).map { pod("p$it") })
        assertEquals(listOf("p1", "p2", "p3", "p4"), s.listed().map { it.podId })
    }

    @Test fun roundTripsAndToleratesGarbage() {
        val s = PodStatusSnapshot("bright-maple", listOf(pod("home", leader = true)), 42, "gym.flagshipserver.com")
        assertEquals(s, PodStatusSnapshot.decode(s.encode()))
        assertEquals(PodStatusSnapshot.EMPTY, PodStatusSnapshot.decode(null))
        assertEquals(PodStatusSnapshot.EMPTY, PodStatusSnapshot.decode("{not json"))
        // A field a later build adds doesn't break an older reader.
        assertEquals("x", PodStatusSnapshot.decode("""{"username":"x","extra":1}""").username)
    }

    @Test fun serverLinkUsesTheRecordedControlHost() {
        val home = pod("home")
        assertEquals(
            "https://flagshipserver.com/app/server?podId=home",
            PodStatusSnapshot(pods = listOf(home)).serverUrl(home),
        )
        assertEquals(
            "https://gym.flagshipserver.com/app/server?podId=a+b%26c",
            PodStatusSnapshot(controlHost = "gym.flagshipserver.com").serverUrl(home.copy(podId = "a b&c")),
        )
    }

    @Test fun labelsAndTones() {
        assertEquals("Online", PodStatusText.label("online"))
        assertEquals("Offline", PodStatusText.label("offline"))
        assertEquals("Pending", PodStatusText.label("pending"))
        assertEquals("Unknown", PodStatusText.label("weird"))
        assertEquals(PodStatusText.Tone.BAD, PodStatusText.tone("offline"))
        assertEquals(PodStatusText.Tone.NEUTRAL, PodStatusText.tone("weird"))
    }

    @Test fun summaryCountsServers() {
        assertEquals("You don't have any servers yet.", PodStatusText.summary(PodStatusSnapshot.EMPTY))
        assertEquals("Your server is online.", PodStatusText.summary(PodStatusSnapshot(pods = listOf(pod("a")))))
        assertEquals("All 2 servers are online.", PodStatusText.summary(PodStatusSnapshot(pods = listOf(pod("a"), pod("b")))))
        assertEquals(
            "All 2 servers are offline.",
            PodStatusText.summary(PodStatusSnapshot(pods = listOf(pod("a", "offline"), pod("b", "offline")))),
        )
        assertEquals(
            "1 of 3 online, 1 offline.",
            PodStatusText.summary(PodStatusSnapshot(pods = listOf(pod("a"), pod("b", "offline"), pod("c", "pending")))),
        )
    }
}
