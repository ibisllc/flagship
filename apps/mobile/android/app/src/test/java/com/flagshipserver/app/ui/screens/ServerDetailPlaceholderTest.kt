package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.COMING_UP
import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.CONNECTING
import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.NEVER_ONLINE
import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.NOT_PAIRED
import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.OFFLINE
import com.flagshipserver.app.ui.screens.ServerDetailPlaceholderKind.SKELETON
import org.junit.Assert.assertEquals
import org.junit.Test

// The server page's states while the box's detail isn't loaded, as iOS draws
// them: never a skeleton that can't resolve.
class ServerDetailPlaceholderTest {
    private fun of(
        loading: Boolean = false,
        attempted: Boolean = false,
        dead: Boolean = false,
        offline: Boolean = false,
        comingUp: Boolean = false,
        notPaired: Boolean = false,
    ) = ServerDetailPlaceholderKind.of(loading, attempted, dead, offline, comingUp, notPaired)

    @Test fun firstLoadOfALiveBoxIsASkeletonThenConnecting() {
        assertEquals(SKELETON, of(loading = true))
        assertEquals(CONNECTING, of(loading = true, attempted = true))
    }

    @Test fun anOfflineOrComingUpBoxSaysSoWhileLoading() {
        assertEquals(OFFLINE, of(loading = true, offline = true))
        assertEquals(COMING_UP, of(loading = true, comingUp = true))
    }

    @Test fun afterGivingUpTheDirectoryDecides() {
        assertEquals(NEVER_ONLINE, of(dead = true, notPaired = true))
        assertEquals(OFFLINE, of(offline = true, notPaired = true))
        assertEquals(COMING_UP, of(comingUp = true))
    }

    @Test fun aReachableUnpairedBoxOffersPairing() {
        assertEquals(NOT_PAIRED, of(notPaired = true))
        assertEquals(CONNECTING, of())
    }
}
