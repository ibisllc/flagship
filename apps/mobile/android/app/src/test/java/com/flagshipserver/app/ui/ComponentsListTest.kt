// Pure-logic tests for the reusable Compose primitives' non-Compose helpers:
//   - fsInitials (two-alnum rule + "?" fallback)  [ui/theme/Tokens.kt]
//   - PodStatusStyle label/pillKind mapping        [ui/components/PodStatusStyle.kt]
//   - HomeStatusFilter bucket rules                [ui/components/PodStatusStyle.kt]
// Mirrors the iOS semantics in FlagshipUI/Components/ComponentsList.swift +
// HomeScreen.swift (PodStatusStyle / HomeStatusFilter). No Context → no @Config.

package com.flagshipserver.app.ui

import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.HomeStatusFilter
import com.flagshipserver.app.ui.components.PodStatusStyle
import com.flagshipserver.app.ui.theme.fsInitials
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private typealias L = PodInfo.LivenessState
private typealias S = PodInfo.Status

class ComponentsListTest {

    // ── fsInitials ─────────────────────────────────────────────

    @Test
    fun fsInitials_takesFirstTwoAlphanumericsUppercased() {
        assertEquals("HA", fsInitials("harry"))
        assertEquals("AB", fsInitials("ab-cde"))
        assertEquals("JO", fsInitials("john doe"))
        assertEquals("US", fsInitials("user7"))
    }

    @Test
    fun fsInitials_skipsLeadingSymbolsAndWhitespace() {
        assertEquals("AB", fsInitials("  @a.b!"))
        assertEquals("X9", fsInitials("-x_9"))
    }

    @Test
    fun fsInitials_fallsBackToQuestionMarkForSymbolOnlyOrEmpty() {
        assertEquals("?", fsInitials(""))
        assertEquals("?", fsInitials("   "))
        assertEquals("?", fsInitials("@#$%"))
    }

    @Test
    fun fsInitials_singleAlphanumericGivesOneChar() {
        assertEquals("A", fsInitials("a"))
        assertEquals("Z", fsInitials("---z---"))
    }

    // ── PodStatusStyle labels ──────────────────────────────────

    @Test
    fun podStatusStyle_labelsMatchIos() {
        assertEquals("Never came online", PodStatusStyle.label(L.DEAD, S.OFFLINE))
        assertEquals("Waiting for approval", PodStatusStyle.label(L.WAITING_FOR_APPROVAL, S.UNKNOWN))
        assertEquals("Coming online…", PodStatusStyle.label(L.COMING_ONLINE, S.UNKNOWN))
        assertEquals("Pending", PodStatusStyle.label(L.COMING_ONLINE, S.PENDING))
        assertEquals("Online", PodStatusStyle.label(L.ONLINE, S.ONLINE))
        assertEquals("Offline", PodStatusStyle.label(L.ONLINE, S.OFFLINE))
        assertEquals("Checking", PodStatusStyle.label(L.ONLINE, S.UNKNOWN))
    }

    @Test
    fun podStatusStyle_pillKindsMatchIos() {
        assertEquals(FSPillKind.Offline, PodStatusStyle.pillKind(L.DEAD, S.OFFLINE))
        assertEquals(FSPillKind.Provisioning, PodStatusStyle.pillKind(L.WAITING_FOR_APPROVAL, S.UNKNOWN))
        assertEquals(FSPillKind.Pending, PodStatusStyle.pillKind(L.COMING_ONLINE, S.PENDING))
        assertEquals(FSPillKind.Pending, PodStatusStyle.pillKind(L.DEAD, S.PENDING))
        assertEquals(FSPillKind.Online, PodStatusStyle.pillKind(L.ONLINE, S.ONLINE))
        assertEquals(FSPillKind.Offline, PodStatusStyle.pillKind(L.ONLINE, S.OFFLINE))
        assertEquals(FSPillKind.Idle, PodStatusStyle.pillKind(L.ONLINE, S.UNKNOWN))
    }

    // ── HomeStatusFilter buckets ───────────────────────────────

    @Test
    fun filter_all_matchesEverything() {
        for (l in L.entries) for (s in S.entries) {
            assertTrue(HomeStatusFilter.ALL.matches(l, s))
        }
    }

    @Test
    fun filter_online_isStrictlyLive() {
        assertTrue(HomeStatusFilter.ONLINE.matches(L.ONLINE, S.ONLINE))
        assertFalse(HomeStatusFilter.ONLINE.matches(L.ONLINE, S.OFFLINE))
        assertFalse(HomeStatusFilter.ONLINE.matches(L.COMING_ONLINE, S.ONLINE))
        assertFalse(HomeStatusFilter.ONLINE.matches(L.DEAD, S.ONLINE))
    }

    @Test
    fun filter_pending_bucketsWaitingAndComingOnline() {
        assertTrue(HomeStatusFilter.PENDING.matches(L.WAITING_FOR_APPROVAL, S.UNKNOWN))
        assertTrue(HomeStatusFilter.PENDING.matches(L.COMING_ONLINE, S.PENDING))
        assertTrue(HomeStatusFilter.PENDING.matches(L.COMING_ONLINE, S.ONLINE))
        // a still-pending / unknown online box is pending too
        assertTrue(HomeStatusFilter.PENDING.matches(L.ONLINE, S.PENDING))
        assertTrue(HomeStatusFilter.PENDING.matches(L.ONLINE, S.UNKNOWN))
        // a live or dead box is not pending
        assertFalse(HomeStatusFilter.PENDING.matches(L.ONLINE, S.ONLINE))
        assertFalse(HomeStatusFilter.PENDING.matches(L.DEAD, S.OFFLINE))
    }

    @Test
    fun filter_offline_bucketsDeadAndOffline() {
        assertTrue(HomeStatusFilter.OFFLINE.matches(L.DEAD, S.OFFLINE))
        assertTrue(HomeStatusFilter.OFFLINE.matches(L.DEAD, S.ONLINE))
        assertTrue(HomeStatusFilter.OFFLINE.matches(L.ONLINE, S.OFFLINE))
        // live / provisioning are not offline
        assertFalse(HomeStatusFilter.OFFLINE.matches(L.ONLINE, S.ONLINE))
        assertFalse(HomeStatusFilter.OFFLINE.matches(L.WAITING_FOR_APPROVAL, S.UNKNOWN))
        assertFalse(HomeStatusFilter.OFFLINE.matches(L.COMING_ONLINE, S.PENDING))
    }

    @Test
    fun filter_labelsAndOrderMatchIos() {
        assertEquals(
            listOf("All", "Online", "Pending", "Offline"),
            HomeStatusFilter.allCases().map { it.label },
        )
    }
}
