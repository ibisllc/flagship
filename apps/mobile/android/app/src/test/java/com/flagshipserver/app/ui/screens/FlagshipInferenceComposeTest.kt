// Flagship Inference is the built-in provider: listed first in the key step
// and Settings → AI keys, never deletable, still listed (disabled) once the
// promotion has ended, and read out as a built-in provider. Set
// INFERENCE_SHOT_DIR to also write PNGs of both screens.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.FreeAiClient
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.AiKeysViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33], qualifiers = "w411dp-h1200dp-xxhdpi")
class FlagshipInferenceComposeTest {
    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private class Canned(val status: Int, val body: String) : JsonHttpTransport {
        override val json: Json = OkHttpJsonTransport.defaultJson
        override suspend fun execute(
            method: String, url: String, body: ByteArray?, contentType: String?,
            extraHeaders: Map<String, String>, accept: Set<Int>,
        ): HttpResponse {
            if (status !in accept) throw HttpException(status, this.body)
            return HttpResponse(status, this.body.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = Unit
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = Unit
    }

    private fun service(body: String) = FreeAiService(
        client = FreeAiClient(Canned(200, body)) { "https://flagshipserver.com" },
        signer = { Ed25519Sign(ByteArray(32) { 3 }) },
        username = { "harry" },
    )

    private val available =
        """{"available":true,"ended":false,"credits":{"week":{"used":160000,"allowance":500000,"remaining":340000},"starter":{"used":500000,"allowance":2000000,"remaining":1500000},"usedTokens":660000,"allowanceTokens":2500000,"remainingTokens":1840000,"remainingCredits":1840,"weeklyCredits":500,"tokensPerCredit":1000}}"""
    private val line = "1,840 free credits left · 500 added each week"
    private val ended = """{"available":false,"ended":true,"credits":{"usedTokens":0,"allowanceTokens":0,"remainingTokens":0}}"""

    @Before fun setUp() {
        java.util.Locale.setDefault(java.util.Locale.US)
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        AiKeyStore.attachForTest(ctx.getSharedPreferences("flagship-inference-compose", Context.MODE_PRIVATE))
        AiKeyStore.clear()
        AiKeyStore.add("anthropic", "sk-ant-api03-abcdefgh1234", "Personal")
    }

    @After fun tearDown() = AiKeyStore.clear()

    private fun shot(name: String) {
        val dir = System.getenv("INFERENCE_SHOT_DIR")?.takeIf { it.isNotEmpty() } ?: return
        composeRule.waitForIdle()
        val root = composeRule.activity.window.decorView
        val bmp = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(android.graphics.Canvas(bmp))
        File(dir).mkdirs()
        File(dir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun screen(content: @androidx.compose.runtime.Composable () -> Unit) {
        composeRule.setContent {
            FlagshipTheme { Box(Modifier.background(FS.colors.bg)) { content() } }
        }
    }

    @Test fun keyStepListsFlagshipInferenceFirstWithoutADelete() {
        screen { AiKeyStepScreen(onConfirm = {}, onBack = {}, vm = AiKeysViewModel(), freeAiService = service(available)) }
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasTestTag("build-key-use-free-ai")).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText(FreeAiCopy.PROVIDER_TITLE, useUnmergedTree = true).assertIsDisplayed()
        composeRule.onNodeWithText(FreeAiCopy.PROVIDER_SUBTITLE, useUnmergedTree = true).assertIsDisplayed()
        composeRule.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        composeRule.onNode(hasContentDescription(FreeAiCopy.A11Y_LABEL, substring = true)).assertExists()
        // One delete: the saved key's, none on Flagship Inference.
        composeRule.onAllNodes(hasTestTag("build-key-delete")).fetchSemanticsNodes().size.let { check(it == 1) { "deletes: $it" } }
        composeRule.onNodeWithTag("build-key-free-ai").assertIsDisplayed()
        // Flagship Inference sits above the saved keys.
        val inference = composeRule.onNodeWithTag("build-key-free-ai").fetchSemanticsNode().boundsInRoot.top
        val saved = composeRule.onAllNodes(hasText("Saved keys")).fetchSemanticsNodes().single().boundsInRoot.top
        check(inference < saved)
        shot("credits-android-key-step")
    }

    @Test fun settingsListsFlagshipInferenceFirstAndCanMakeItDefault() {
        screen {
            AiKeysManagerScreen(
                nav = androidx.navigation.compose.rememberNavController(),
                vm = AiKeysViewModel(),
                freeAiService = service(available),
            )
        }
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasTestTag("free-ai-make-default")).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText(FreeAiCopy.PROVIDER_TITLE, useUnmergedTree = true).assertIsDisplayed()
        composeRule.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        composeRule.onAllNodes(hasText("Delete")).fetchSemanticsNodes().size.let { check(it == 1) { "deletes: $it" } }
        shot("credits-android-settings")
        composeRule.onNodeWithTag("free-ai-make-default").performClick()
        composeRule.waitForIdle()
        check(AiKeyStore.activeId() == AiKeyStore.FLAGSHIP_INFERENCE_ID)
        composeRule.onNodeWithText("Default for new builds", useUnmergedTree = true).assertExists()
    }

    @Test fun anEndedPromotionKeepsTheEntryDisabled() {
        screen { AiKeyStepScreen(onConfirm = {}, onBack = {}, vm = AiKeysViewModel(), freeAiService = service(ended)) }
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasText(FreeAiCopy.ENDED), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText(FreeAiCopy.PROVIDER_TITLE, useUnmergedTree = true).assertIsDisplayed()
        check(composeRule.onAllNodes(hasTestTag("build-key-use-free-ai")).fetchSemanticsNodes().isEmpty())
        shot("credits-android-ended")
    }

    @Test fun theBuildChooserOffersFlagshipInference() {
        screen { VibeCodeProviderPickScreen(androidx.navigation.compose.rememberNavController()) }
        composeRule.onNodeWithText(FreeAiCopy.TITLE).assertIsDisplayed()
        composeRule.onNodeWithText(FreeAiCopy.USE_BUTTON).assertIsDisplayed()
        check(composeRule.onAllNodes(hasText("free AI", substring = true, ignoreCase = true)).fetchSemanticsNodes().isEmpty())
        shot("credits-android-chooser")
    }
}
