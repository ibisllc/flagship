// GYM Android — the outbound proxy (docs/outbound-proxy.md "Failure handling") against the mock box and `.com`:
// the create flow's Pro gate, the server page's red line per failure code, the fallback line, Home's badge from
// `/pods`, a change sent through `.com`'s lane while the box can't be reached, and the refusal to carry a new
// password there. NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymOutboundProxyTest : GymBase() {

    private val home = "Living-room mini-PC"

    private fun openAdvanced(plan: String) {
        launch(tab = "home", adminRoot = true, listsPlan = plan)
        addNewServer()
        nameServerAndNext()
        waitUntilExists("cs-advanced-toggle", timeoutMs = 15_000)
        composeRule.onNodeWithTag("cs-advanced-toggle").performScrollTo().performClick()
        composeRule.waitForIdle()
    }

    @Test
    fun freeAccountSeesTheProRowInsteadOfTheFields() {
        openAdvanced("free")
        waitUntilExists("proxy-pro", 15_000)
        assertEquals(0, tagCount("proxy-kind-socks5"))
        gymShot("create-free")
    }

    @Test
    fun proAccountSeesTheFields() {
        openAdvanced("pro")
        waitUntilExists("proxy-kind-socks5", 15_000)
        assertEquals(0, tagCount("proxy-pro"))
    }

    private fun openHomeServer(proxy: String) {
        launch(tab = "home", adminRoot = true, proxy = proxy)
        openServerFromHome(home)
    }

    @Test
    fun failingProxyShowsTheRedLineForEachCode() {
        val want = mapOf(
            "unreachable" to "Can't reach the proxy.",
            "auth" to "The proxy refused the username or password.",
            "refused" to "The proxy refused the connection.",
            "protocol" to "The proxy gave an answer the server doesn't understand.",
        )
        for ((code, sentence) in want) {
            openHomeServer("failing-$code")
            waitUntilExists("sd-proxy-alert-failing", 20_000)
            assertEquals("The outbound proxy isn't working: $sentence", textOfTag("sd-proxy-alert-failing"))
            gymShot("failing-$code")
        }
    }

    @Test
    fun fallbackShowsTheWarningLine() {
        openHomeServer("fallback-refused")
        waitUntilExists("sd-proxy-alert-fallback", 20_000)
        assertEquals(
            "The outbound proxy isn't working, so this server is connecting directly: The proxy refused the connection.",
            textOfTag("sd-proxy-alert-fallback"),
        )
        gymShot("fallback")
    }

    @Test
    fun homeShowsTheBadgeFromPods() {
        launch(tab = "home", adminRoot = true, proxy = "failing-auth")
        // The pill sits inside the row's merged click target.
        composeRule.waitUntil(20_000) { tagCount("pod-card-proxy-alert", unmerged = true) > 0 }
        assertTrue(textCount("Outbound proxy not working") >= 1)
        gymShot("home-badge")
    }

    @Test
    fun unreachableBoxTakesTheChangeThroughTheLane() {
        openHomeServer("failing-down")
        waitUntilExists("sd-proxy-alert-failing", 20_000)
        waitUntilExists("sd-proxy-alert-offline", 20_000)
        tap("sd-proxy-off", 20_000)
        waitUntilExists("sd-proxy-lane-sent", 20_000)
        assertEquals(
            "Sent. The server picks up the change within a few minutes, even while its proxy is down.",
            textOfTag("sd-proxy-lane-sent"),
        )
        gymShot("lane-sent")
    }

    @Test
    fun aNewPasswordNeverTakesTheLane() {
        openHomeServer("failing-down")
        tap("sd-proxy-change", 20_000)
        tap("proxy-kind-socks5")
        for ((tag, text) in listOf("proxy-host" to "proxy2.example.net", "proxy-username" to "alice", "proxy-password" to "secret")) {
            type(tag, text)
        }
        hideKeyboard()
        tap("sd-proxy-save")
        waitText("Flagship never carries proxy passwords.", 20_000)
        assertEquals(0, tagCount("sd-proxy-lane-sent"))
        gymShot("lane-password")
    }
}
