// GYM Android mock tier — the server page's Container stack (packages/server-daemon/src/archV2Switch.ts),
// twins of iOS GymRelease03Tests' stack scenarios: Move to the new stack signs flagship/arch-v2-switch/v1
// with the admin root and dry-runs it (the box's plan shows); Move now sends the same order and the card
// follows the move; a blocked plan says why; a device without the admin root has no card.

package com.flagshipserver.app.gym

import com.flagshipserver.app.api.MockScreensClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymStackSwitchTest : GymBase() {

    private val mock: MockScreensClient get() = MockScreensClient.smokeInstance!!

    private fun openServer(blocked: Boolean = false, adminRoot: Boolean = true) {
        launch(tab = "home", adminRoot = adminRoot)
        mock.stackFixture = mock.classicStack(blocked)
        mock.stackBodies.clear()
        openServerFromHome("Living-room mini-PC")
    }

    @After fun noStack() {
        MockScreensClient.smokeInstance?.stackFixture = null
    }

    /** android-stack-move: dry run, the plan, Move now, then the trial. */
    @Test
    fun stackMoveDryRunThenMove() {
        openServer()
        waitUntilExists("stack-current", 20_000)
        assertEquals("This server runs the classic stack (Docker).", textOfTag("stack-current"))
        tap("stack-move")
        assertSigned("arch-v2-switch", "admin")
        waitUntilExists("stack-step-0", 15_000)
        assertTrue(textOfTag("stack-room").startsWith("Needs about"))
        gymShot("stack-plan")
        tap("stack-move-now")
        eventually(what = "the move") { mock.stackBodies.size == 2 && mock.stackBodies.last().dryRun == null }
        eventually(timeoutMs = 30_000, what = "the trial") { tagCount("stack-record") == 1 && textOfTag("stack-record").startsWith("On trial until") }
        assertEquals("This server runs the new stack (Podman and the Rust services).", textOfTag("stack-current"))
        gymShot("stack-trial")
    }

    /** android-stack-blocked: the box's sentence, Move now off. */
    @Test
    fun stackMoveBlockedSaysWhy() {
        openServer(blocked = true)
        tap("stack-move", 20_000)
        waitUntilExists("stack-blocker-0", 15_000)
        assertEquals("Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.", textOfTag("stack-blocker-0"))
        assertEquals(1, mock.stackBodies.size)
        gymShot("stack-blocked")
    }

    /** android-stack-admin-only: no card without the admin root. */
    @Test
    fun stackCardIsAdminOnly() {
        openServer(adminRoot = false)
        waitUntilExists("sd-local-ai", 20_000)
        composeRule.waitForIdle()
        assertEquals(0, tagCount("stack-card"))
        gymShot("stack-admin-only")
    }
}
