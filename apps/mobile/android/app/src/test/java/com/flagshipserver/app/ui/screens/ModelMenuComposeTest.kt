// The build chat's model menu (grouped by provider), the effort beside it,
// the context line, attachment chips + notice and the vision-switch alert. Set MODELS_SHOT_DIR (env) or models.shot.dir
// (system property) to also write review PNGs.

package com.flagshipserver.app.ui.screens

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AiModelsResponse
import com.flagshipserver.app.api.InferenceCatalogResponse
import com.flagshipserver.app.api.InferenceModel
import com.flagshipserver.app.api.ModelOption
import com.flagshipserver.app.api.VibeCodeAttachment
import com.flagshipserver.app.api.VibeCodeSessionMessage
import com.flagshipserver.app.core.ModelChoice
import com.flagshipserver.app.core.ModelGroups
import com.flagshipserver.app.core.SavedAiKey
import com.flagshipserver.app.core.ModelMenu
import com.flagshipserver.app.core.ModelMenus
import com.flagshipserver.app.core.VisionCheck
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.io.FileOutputStream

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33], qualifiers = "w411dp-h860dp-xxhdpi")
class ModelMenuComposeTest {
    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val outDir: String? = System.getenv("MODELS_SHOT_DIR") ?: System.getProperty("models.shot.dir")

    private val catalog = InferenceCatalogResponse(
        models = listOf(
            InferenceModel("low", "Low", "Qwen3.6-35B-A3B", 1.0, "Low 1× (Qwen3.6-35B-A3B)", "Quick and thrifty. Good for small apps and fixes.", 262144, listOf("text", "image"), true, default = true),
            InferenceModel("medium", "Medium", "DeepSeek-V4-Flash", 1.0, "Medium 1× (DeepSeek-V4-Flash)", "Stronger at code. Text only.", 131072, listOf("text"), true, visionAlternative = "medium-vision"),
            InferenceModel("medium-vision", "Medium multimodal", "GLM-5.3-Flash", 2.0, "Medium multimodal 2× (GLM-5.3-Flash)", "Reads screenshots and mockups.", 131072, listOf("text", "image"), false),
            InferenceModel("high", "High", "MiniMax-M3", 3.5, "High 3.5× (MiniMax-M3)", "For the hardest builds.", 200000, listOf("text"), true),
        ),
        defaultModel = "low",
    )
    private val flagship = ModelMenu.Flagship(catalog)
    private val own = ModelMenus.from(
        AiModelsResponse(
            provider = "openai", kind = "own", listed = true, defaultModel = "gpt-5.4-mini",
            models = listOf(
                ModelOption("gpt-5.4-mini", "GPT-5.4 Mini", 400000, true, true, listOf("none", "low", "medium", "high", "xhigh"), "medium", true),
                ModelOption("brand-new", "brand-new", known = false),
            ),
        ),
    )
    private val staged = listOf(
        VibeCodeAttachment.Image("image/png", "iVBO", "mockup.png"),
        VibeCodeAttachment.Data("plants.csv", "text/csv", "name,water\nfern,weekly"),
        VibeCodeAttachment.Document("spec.pdf", "application/pdf", "JVBE"),
    )

    private fun show(content: @Composable () -> Unit) {
        composeRule.setContent {
            FlagshipTheme(darkTheme = false) {
                Column(Modifier.fillMaxSize().background(FS.colors.bg)) { content() }
            }
        }
        composeRule.waitForIdle()
    }

    private fun save(name: String) {
        val dir = outDir ?: return
        composeRule.waitForIdle()
        val view = composeRule.activity.window.decorView
        val bmp = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        view.draw(canvas)
        // A Compose dialog is its own window: dim the screen and draw it on top.
        ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView?.let { d ->
            canvas.drawColor(0x66000000)
            canvas.save()
            canvas.translate((view.width - d.width) / 2f, (view.height - d.height) / 2f)
            d.draw(canvas)
            canvas.restore()
        }
        File(dir).mkdirs()
        FileOutputStream(File(dir, name)).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Composable
    private fun Header(menu: ModelMenu, choice: ModelChoice?) {
        Spacer(Modifier.height(FS.space.s8))
        Text("Vibe-code session", color = FS.colors.text, style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium))
        Spacer(Modifier.height(FS.space.s2))
        ChatModelBar(menu, choice, onChoice = {})
    }

    @Test fun headerShowsShortNameAndNoEffortForAFlagshipModelThatListsNone() {
        show { Column(Modifier.padding(FS.space.s6)) { Header(flagship, ModelChoice("low")) } }
        composeRule.onNodeWithText("Low 1×").assertIsDisplayed()
        composeRule.onNodeWithTag("model-effort").assertDoesNotExist()
        composeRule.onNodeWithText("Think harder").assertDoesNotExist()
    }

    @Test fun headerShowsTheEffortBesideAModelThatListsEfforts() {
        show { Column(Modifier.padding(FS.space.s6)) { Header(own, ModelChoice("gpt-5.4-mini", "high")) } }
        composeRule.onNodeWithText("GPT-5.4 Mini").assertIsDisplayed()
        composeRule.onNodeWithTag("model-effort").assertIsDisplayed()
        composeRule.onNodeWithText("High").assertIsDisplayed()
    }

    private val keys = listOf(SavedAiKey("k1", "openai", "Work", "sk-one"), SavedAiKey("k2", "anthropic", "Home", "sk-two"))
    private val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = "openai")

    @Test fun groupedMenuListsFlagshipThenEachKeyWithItsModels() {
        show {
            Column(Modifier.padding(horizontal = FS.space.s6)) {
                GroupedChatModelBar(
                    groups = groups,
                    menus = mapOf("flagship" to flagship, "k1" to own),
                    groupId = "k1",
                    choice = ModelChoice("gpt-5.4-mini", "medium"),
                    notice = ModelGroups.CONTEXT_NOTICE,
                    onOpen = {}, onPick = { _, _ -> }, onEffort = {},
                )
                Spacer(Modifier.height(4.dp))
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = FS.colors.surface,
                    shadowElevation = 3.dp,
                    tonalElevation = 3.dp,
                    modifier = Modifier.width(320.dp),
                ) {
                    Column(Modifier.padding(vertical = 8.dp)) {
                        GroupedModelMenuItems(
                            groups, mapOf("flagship" to flagship, "k1" to own), "k1", ModelChoice("gpt-5.4-mini", "medium"),
                            onPick = { _, _ -> }, onClose = {},
                        )
                    }
                }
            }
        }
        composeRule.onNodeWithText("GPT-5.4 Mini · Work").assertIsDisplayed()
        composeRule.onNodeWithTag("model-effort").assertIsDisplayed()
        composeRule.onNodeWithText("Older messages will be summarised to fit this model.").assertIsDisplayed()
        composeRule.onNodeWithTag("model-group-flagship").assertIsDisplayed()
        composeRule.onNodeWithText("openai · Work").assertIsDisplayed()
        composeRule.onNodeWithText("anthropic · Home").assertIsDisplayed()
        composeRule.onNodeWithText(MODELS_LOADING).assertIsDisplayed()
        save("models-grouped-android.png")
    }

    @Test fun pickingAModelFromAnotherGroupSaysWhichGroup() {
        var picked: Pair<String, ModelChoice?>? = null
        show {
            Column(Modifier.padding(FS.space.s6)) {
                GroupedModelMenuItems(
                    groups, mapOf("flagship" to flagship, "k1" to own), "k1", ModelChoice("gpt-5.4-mini", "medium"),
                    onPick = { id, c -> picked = id to c }, onClose = {},
                )
            }
        }
        composeRule.onNodeWithTag("model-item-flagship-medium").performClick()
        assertEquals("flagship" to ModelChoice("medium"), picked)
    }

    @Test fun menuOpenShowsLabelsAndDescriptors() {
        show {
            Column(Modifier.padding(horizontal = FS.space.s6)) {
                Header(flagship, ModelChoice("low"))
                Spacer(Modifier.height(4.dp))
                // The dropdown's own rows, drawn in place (a popup is its own window).
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = FS.colors.surface,
                    shadowElevation = 3.dp,
                    tonalElevation = 3.dp,
                    modifier = Modifier.width(320.dp),
                ) {
                    Column(Modifier.padding(vertical = 8.dp)) { ModelMenuItems(flagship, ModelChoice("low"), {}, {}) }
                }
            }
        }
        composeRule.onNodeWithText("Medium multimodal 2× (GLM-5.3-Flash)").assertIsDisplayed()
        composeRule.onNodeWithText("Quick and thrifty. Good for small apps and fixes.").assertIsDisplayed()
        save("models-menu-android.png")
    }

    @Test fun ownKeyMenuShowsUnknownCapsAndEfforts() {
        var picked: String? = null
        show {
            Column(Modifier.padding(FS.space.s6)) {
                ModelMenuItems(own, ModelChoice("gpt-5.4-mini", "medium"), {}, {})
                EffortItems(ModelMenus.efforts(own, ModelChoice("gpt-5.4-mini")), "medium") { picked = it }
            }
        }
        composeRule.onNodeWithText(ModelMenus.UNKNOWN_CAPS).assertIsDisplayed()
        composeRule.onNodeWithText("Extra high").assertIsDisplayed()
        composeRule.onNodeWithTag("model-effort-xhigh").performClick()
        assertEquals("xhigh", picked)
        save("models-own-android.png")
    }

    @Test fun switchDialog() {
        val check = ModelMenus.visionCheck(flagship, ModelChoice("medium"), hasImage = true) as VisionCheck.Switch
        var switched: ModelChoice? = null
        show {
            Column(Modifier.padding(horizontal = FS.space.s6)) {
                Header(flagship, ModelChoice("medium"))
            }
            VisionDialog(check, onSwitch = { switched = it }, onDismiss = {})
        }
        composeRule.onNodeWithText("I'll have to switch to GLM-5.3-Flash (2×) for this.").assertIsDisplayed()
        composeRule.onNodeWithText("Cancel").assertIsDisplayed()
        save("models-switch-android.png")
        composeRule.onNodeWithText("Switch").performClick()
        assertEquals(ModelChoice("medium-vision"), switched)
    }

    @Test fun stagedAttachmentsWithNotice() {
        show {
            Column(Modifier.padding(horizontal = FS.space.s6)) {
                Header(own, ModelChoice("gpt-5.4-mini", "medium"))
                Spacer(Modifier.height(FS.space.s4))
                FSCard {
                    Column {
                        ChatMessage(VibeCodeSessionMessage("assistant", "Want a watering reminder too?", 1, credits = 2.8))
                        Spacer(Modifier.height(FS.space.s2))
                        // A still stand-in for the reply field (a live text field keeps
                        // Robolectric's clock from going idle in the full suite).
                        Text(
                            "Yes. Use this sample data and match the mockup.",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .border(1.dp, FS.colors.border, RoundedCornerShape(4.dp))
                                .padding(16.dp),
                        )
                        Spacer(Modifier.height(FS.space.s2))
                        ChatComposerAttachments(staged, "movie.mp4 can't be attached. Try an image, a text or code file, CSV, JSON or PDF.", {}, {}, {})
                        Spacer(Modifier.height(FS.space.s3))
                        FSPrimaryButton(label = "Send", onClick = {})
                    }
                }
            }
        }
        composeRule.onNodeWithText("The AI will see what you attach. Sample data goes only to the private test copy.").assertIsDisplayed()
        composeRule.onNodeWithText("plants.csv").assertIsDisplayed()
        composeRule.onNodeWithText("used 2.8 credits").assertIsDisplayed()
        save("models-attach-android.png")
    }
}
