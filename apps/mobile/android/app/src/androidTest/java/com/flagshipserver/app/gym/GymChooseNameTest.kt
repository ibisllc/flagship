// GYM Android: "Choose your own account name" with a name held for a `.com` holder, at font scale 2.0 (owner,
// 2026-11-27). The screen runs on its own against a mock `.com` (the precheck and quote of
// packages/control-plane/src/nameChange.ts: clou-dflare is held for cloudflare.com, acme's lookup fails, every other
// name is free). Typing a held name shows one status line under the field, whole and on screen, Pay and Use a voucher
// stay off, Done closes the keyboard, Why? opens the sheet; nothing is opened or paid for the held name.

package com.flagshipserver.app.gym

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.NameChoiceOps
import com.flagshipserver.app.core.NameChoicePayment
import com.flagshipserver.app.core.NameGrant
import com.flagshipserver.app.core.NameQuote
import com.flagshipserver.app.core.PackOutcome
import com.flagshipserver.app.core.PendingNameChoice
import com.flagshipserver.app.ui.screens.ChooseOwnNameScreen
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.CreatedAccount
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import java.io.File
import java.io.FileOutputStream

class GymChooseNameTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val testName = TestName()

    /** `.com` as the screen sees it; records every call so the test can prove nothing was opened or paid. */
    private class MockCom : NameChoiceOps {
        val calls = mutableListOf<String>()
        val prechecks = mutableListOf<String>()
        private fun answer(n: String): NameQuote = when (n) {
            "clou-dflare" -> NameQuote.Refused("dibs-held", heldUntil = HELD_UNTIL, domain = "cloudflare.com")
            "acme" -> NameQuote.Refused("dibs-held", heldUntil = HELD_UNTIL, domain = "acme.com", checked = false)
            else -> NameQuote.Available(10)
        }
        override suspend fun precheck(newName: String, grant: NameGrant?): NameQuote? { prechecks += newName; return answer(newName) }
        override suspend fun createAccount(suggested: String): CreatedAccount {
            calls += "create"
            return CreatedAccount(suggested, "d".repeat(32), "grant-1", "Plucky Avocet", "Pixel")
        }
        override suspend fun quote(oldName: String, newName: String, grant: NameGrant?): NameQuote { calls += "quote:$newName"; return answer(newName) }
        override suspend fun walletBalance() = 0
        override suspend fun buyPack(units: Int): PackOutcome { calls += "buy"; return PackOutcome.Cancelled }
        override suspend fun rename(oldName: String, newName: String, payment: NameChoicePayment, units: Int, grant: NameGrant?) { calls += "rename" }
        override suspend fun ownsName(name: String): Boolean? = false
        override suspend fun settle(p: PendingNameChoice) {}
        override suspend fun onboard(name: String, previous: String?, account: CreatedAccount) {}
        override fun bindPq() {}
    }

    private val com = MockCom()

    private fun show(fontScale: Float = 2f) {
        FSStrings.init(compose.activity)
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale)) {
                FlagshipTheme(darkTheme = false) {
                    ChooseOwnNameScreen(suggested = "plucky-avocet", ops = com, grant = null, onOpened = {}, onBack = {}, precheckDelayMs = 300)
                }
            }
        }
    }

    private fun field() = compose.onNode(hasSetTextAction() and hasTestTag("choose-name-field"))

    /** The node is drawn whole inside the window (nothing cut off by the screen's edge or the keyboard). */
    private fun assertWhollyOnScreen(tag: String) {
        val node = compose.onNodeWithTag(tag).assertIsDisplayed().fetchSemanticsNode()
        val root = compose.onNode(isRoot()).fetchSemanticsNode().boundsInWindow
        val b = node.boundsInWindow
        val view = compose.activity.window.decorView
        val insets = androidx.core.view.ViewCompat.getRootWindowInsets(view)
        val imeTop = view.height - (insets?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0)
        assertTrue("$tag at $b should be inside $root and above the keyboard ($imeTop)", b.top >= root.top && b.bottom <= root.bottom && b.bottom <= imeTop)
        // The whole sentence is laid out: no ellipsis, no line cap.
        val layout = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        node.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult)?.action?.invoke(layout)
        layout.firstOrNull()?.let { assertTrue("$tag is cut off", !it.hasVisualOverflow) }
    }

    private fun shot(point: String) {
        compose.waitForIdle()
        try {
            val instr = InstrumentationRegistry.getInstrumentation()
            val dir = File(compose.activity.filesDir, GymBase.GYM_SHOT_SUBDIR).also { it.mkdirs() }
            val bitmap: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
            FileOutputStream(File(dir, "gym-screenshot-GymChooseNameTest.${testName.methodName}--$point.png")).use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
        } catch (_: Throwable) {
            // Best-effort.
        }
    }

    private fun waitTag(tag: String, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) { runCatching { compose.onNodeWithTag(tag).fetchSemanticsNode() }.isSuccess }
    }

    @Test
    fun aHeldNameShowsUnderTheFieldWhileTyping_payStaysOff_doneClosesTheKeyboard_andWhyExplains() {
        show()
        field().performClick()
        field().performTextInput("clou-dflare")
        waitTag("choose-name-status")
        // Still typing: the field keeps focus (the keyboard stays up) and the line shows whole under it.
        field().assertIsFocused()
        val status = compose.onNodeWithTag("choose-name-status").fetchSemanticsNode()
        val text = status.config.getOrNull(SemanticsProperties.Text)?.joinToString("") ?: ""
        assertTrue(text, text.startsWith("Held for the owner of cloudflare.com until "))
        assertEquals(androidx.compose.ui.semantics.LiveRegionMode.Polite, status.config.getOrNull(SemanticsProperties.LiveRegion))
        assertWhollyOnScreen("choose-name-status")
        compose.onNodeWithTag("choose-name-pay").assertIsNotEnabled()
        compose.onNodeWithTag("choose-name-show-code").assertIsNotEnabled()
        shot("held-typing")

        // Done on the keyboard closes it; the line is still whole.
        field().performImeAction()
        field().assertIsNotFocused()
        assertWhollyOnScreen("choose-name-status")
        shot("held-done")

        compose.onNodeWithTag("choose-name-why").performClick()
        waitTag("held-why-title")
        val title = compose.onNodeWithTag("held-why-title").fetchSemanticsNode()
        assertEquals("Why is clou-dflare held?", title.config.getOrNull(SemanticsProperties.Text)?.joinToString(""))
        assertTrue(title.config.contains(SemanticsProperties.Heading))
        compose.onNodeWithTag("held-why-email").assertIsDisplayed()
        shot("held-why")
        compose.onNodeWithTag("held-why-ok").performClick()
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("held-why-title").fetchSemanticsNode() }.isFailure }

        compose.onNodeWithTag("choose-name-pay").performClick()
        compose.waitForIdle()
        assertTrue("nothing opened or paid for a held name: ${com.calls}", com.calls.isEmpty())

        // Another name: Pay works again.
        field().performTextReplacement("bob")
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("choose-name-status").fetchSemanticsNode() }.isFailure }
        compose.onNodeWithTag("choose-name-pay").assertIsEnabled()
    }

    @Test
    fun aFailedLookupSaysCouldntCheck_andPayRightAfterTypingClosesTheKeyboardAndStays() {
        show()
        field().performClick()
        field().performTextInput("acme")
        // Pay before the pause: the screen asks first and stays.
        compose.onNodeWithTag("choose-name-pay").performClick()
        waitTag("choose-name-status")
        field().assertIsNotFocused()
        val text = compose.onNodeWithTag("choose-name-status").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)?.joinToString("")
        assertEquals("Couldn't check acme.com just now. Try again in a minute.", text)
        assertTrue(runCatching { compose.onNodeWithTag("choose-name-why").fetchSemanticsNode() }.isFailure)
        assertWhollyOnScreen("choose-name-status")
        assertTrue(com.calls.isEmpty())
        shot("held-unchecked")
    }

    private companion object {
        const val HELD_UNTIL = 1_823_558_400_000L
    }
}
