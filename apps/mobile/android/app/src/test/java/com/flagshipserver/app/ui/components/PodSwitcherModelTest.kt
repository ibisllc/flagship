// Pure display + filtering logic for the Android PodSwitcher (parity with
// iOS FlagshipUI/Components/PodSwitcher.swift + ServicesListViewModel's
// pod-name URL match). Compose-free so it unit-tests on the JVM.

package com.flagshipserver.app.ui.components

import com.flagshipserver.app.core.PodInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PodSwitcherModelTest {
    private val pods = listOf(
        PodInfo(podId = "home", name = "Home", fqdn = "home.harry.flagship.services"),
        PodInfo(podId = "office", name = "Office", fqdn = "office.harry.flagship.services"),
    )

    @Test
    fun currentName_showsAllLabelWhenNothingSelected() {
        assertEquals("All servers", PodSwitcherModel.currentName(pods, null, "All servers"))
    }

    @Test
    fun currentName_showsSelectedPodName() {
        assertEquals("Office", PodSwitcherModel.currentName(pods, "office", "All servers"))
    }

    @Test
    fun currentName_dashWhenSelectionUnknownAndNoAllLabel() {
        assertEquals("—", PodSwitcherModel.currentName(pods, "ghost", null))
        // No allLabel + null selection also can't resolve a name.
        assertEquals("—", PodSwitcherModel.currentName(pods, null, null))
    }

    @Test
    fun leaderFlag_onlyForConcreteSelectedLeader() {
        assertTrue(PodSwitcherModel.showsLeaderFlag("home", "home"))
        assertFalse(PodSwitcherModel.showsLeaderFlag("office", "home"))
        // The "All" state (null selection) never shows the flag, even if the
        // leader is set.
        assertFalse(PodSwitcherModel.showsLeaderFlag(null, "home"))
    }

    @Test
    fun matchesPod_bySubdomainSegmentCaseInsensitive() {
        val url = "https://blog.home.harry.flagship.services"
        assertTrue(PodSwitcherModel.matchesPod(url, "home"))
        assertTrue(PodSwitcherModel.matchesPod(url, "HOME"))
        assertFalse(PodSwitcherModel.matchesPod(url, "office"))
    }

    @Test
    fun matchesPod_falseForNullUrlOrEmptyName() {
        assertFalse(PodSwitcherModel.matchesPod(null, "home"))
        assertFalse(PodSwitcherModel.matchesPod("https://blog.home.harry.flagship.services", ""))
    }

    @Test
    fun matchesPod_requiresDelimitedSegmentNotBareSubstring() {
        // "home" must appear as a `.home.` segment, not as part of another
        // label like "homestead" — guards against over-broad filtering.
        assertFalse(PodSwitcherModel.matchesPod("https://blog.homestead.harry.flagship.services", "home"))
    }
}
