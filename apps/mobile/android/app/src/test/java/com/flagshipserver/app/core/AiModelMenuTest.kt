package com.flagshipserver.app.core

import com.flagshipserver.app.api.AiModelsResponse
import com.flagshipserver.app.api.InferenceCatalogResponse
import com.flagshipserver.app.api.VibeCodeAttachment
import com.flagshipserver.app.api.VibeCodeReplyRequest
import com.flagshipserver.app.api.VibeCodeSessionPublicState
import com.flagshipserver.app.api.VibeCodeStartRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiModelMenuTest {
    /** The screens client's JSON (LiveScreensClient). */
    private val screensJson = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        classDiscriminator = "kind"
    }

    private val catalogJson = """
        { "models": [
            { "id": "low", "tier": "Low", "model": "Qwen3.6-35B-A3B", "multiplier": 1,
              "label": "Low 1× (Qwen3.6-35B-A3B)", "descriptor": "Quick and thrifty.",
              "contextTokens": 262144, "modalities": ["text","image"], "reasoning": true, "default": true,
              "upstream": {"deepinfra": "Qwen/Qwen3.6-35B-A3B", "openrouter": "qwen/qwen3.6-35b-a3b"} },
            { "id": "medium", "tier": "Medium", "model": "DeepSeek-V4-Flash", "multiplier": 1,
              "label": "Medium 1× (DeepSeek-V4-Flash)", "descriptor": "Stronger code.",
              "contextTokens": 131072, "modalities": ["text"], "reasoning": true, "visionAlternative": "medium-vision" },
            { "id": "medium-vision", "tier": "Medium multimodal", "model": "GLM-5.3-Flash", "multiplier": 2,
              "label": "Medium multimodal 2× (GLM-5.3-Flash)", "descriptor": "Sees images.",
              "contextTokens": 131072, "modalities": ["text","image"], "reasoning": false },
            { "id": "high", "tier": "High", "model": "MiniMax-M3", "multiplier": 3.5,
              "label": "High 3.5× (MiniMax-M3)", "descriptor": "Hardest problems.",
              "contextTokens": 200000, "modalities": ["text"], "reasoning": true } ],
          "defaultModel": "low", "creditTokens": 1000, "inputWeight": 1, "outputWeight": 4 }
    """.trimIndent()

    private val catalog = screensJson.decodeFromString(InferenceCatalogResponse.serializer(), catalogJson)
    private val flagship = ModelMenu.Flagship(catalog)

    private val ownJson = """
        { "provider": "openai", "kind": "own", "listed": true, "defaultModel": "gpt-5",
          "models": [
            { "id": "gpt-5.4-mini", "label": "GPT-5.4 Mini", "contextTokens": 400000, "vision": true, "tools": true,
              "efforts": ["none","low","medium","high","xhigh"], "defaultEffort": "medium", "known": true },
            { "id": "brand-new", "label": "brand-new", "vision": null, "tools": null, "known": false },
            { "id": "qwen3-coder", "label": "Qwen3 Coder", "vision": false, "tools": true, "known": true,
              "visionAlternative": "gpt-5.4-mini" },
            { "id": "text-only", "label": "Text Only", "vision": false, "tools": true, "known": true } ] }
    """.trimIndent()
    private val own = ModelMenus.from(screensJson.decodeFromString(AiModelsResponse.serializer(), ownJson))

    @Test fun parsesTheCatalog() {
        assertEquals(4, catalog.models.size)
        assertEquals("low", catalog.defaultModel)
        assertEquals(3.5, catalog.models[3].multiplier, 0.0)
        assertEquals("medium-vision", catalog.models[1].visionAlternative)
        assertEquals(true, catalog.models[0].default)
        assertEquals("qwen/qwen3.6-35b-a3b", catalog.models[0].upstream?.get("openrouter"))
        assertEquals(4.0, catalog.outputWeight, 0.0)
    }

    @Test fun parsesBothModelAnswers() {
        own as ModelMenu.Own
        assertTrue(own.listed)
        assertEquals("gpt-5", own.defaultModel)
        assertEquals(listOf("none", "low", "medium", "high", "xhigh"), own.options[0].efforts)
        assertNull(own.options[1].vision)
        assertFalse(own.options[1].known)
        assertNull(own.options[1].efforts)
        val f = screensJson.decodeFromString(
            AiModelsResponse.serializer(),
            """{"provider":"flagship","kind":"flagship","catalog":$catalogJson}""",
        )
        assertTrue(ModelMenus.from(f) is ModelMenu.Flagship)
        val none = screensJson.decodeFromString(
            AiModelsResponse.serializer(),
            """{"provider":"openai","kind":"own","listed":false,"models":[],"reason":"rejected","defaultModel":"gpt-5"}""",
        )
        val m = ModelMenus.from(none) as ModelMenu.Own
        assertFalse(m.listed)
        assertEquals("rejected", m.reason)
        assertEquals(ModelChoice("gpt-5"), ModelMenus.initial(m, null))
        val nullCatalog = screensJson.decodeFromString(
            AiModelsResponse.serializer(), """{"provider":"flagship","kind":"flagship","catalog":null}""",
        )
        assertNull((ModelMenus.from(nullCatalog) as ModelMenu.Flagship).catalog)
    }

    @Test fun creditsLine() {
        assertEquals("used 2.8 credits", ModelMenus.creditsLine(2.8))
        assertEquals("used 2.8 credits", ModelMenus.creditsLine(2.84))
        assertEquals("used 3 credits", ModelMenus.creditsLine(3.0))
        assertEquals("used 3 credits", ModelMenus.creditsLine(2.96))
        assertEquals("used 1 credit", ModelMenus.creditsLine(1.0))
        assertEquals("used 1 credit", ModelMenus.creditsLine(0.98))
        assertEquals("used 0.4 credits", ModelMenus.creditsLine(0.4))
        assertEquals("used 12 credits", ModelMenus.creditsLine(12.0))
    }

    @Test fun effortLabels() {
        assertEquals("Low", ModelMenus.effortLabel("low"))
        assertEquals("Medium", ModelMenus.effortLabel("medium"))
        assertEquals("High", ModelMenus.effortLabel("high"))
        assertEquals("Extra high", ModelMenus.effortLabel("xhigh"))
        assertEquals("Max", ModelMenus.effortLabel("max"))
        assertEquals("Minimal", ModelMenus.effortLabel("minimal"))
        assertEquals("None", ModelMenus.effortLabel("none"))
    }

    @Test fun titlesAndMultipliers() {
        assertEquals("Low 1×", ModelMenus.title(flagship, ModelChoice("low")))
        assertEquals("High 3.5×", ModelMenus.title(flagship, ModelChoice("high")))
        assertEquals("Flagship Inference", ModelMenus.title(ModelMenu.Flagship(null), null))
        assertEquals("GPT-5.4 Mini", ModelMenus.title(own, ModelChoice("gpt-5.4-mini")))
        assertEquals("typed-model", ModelMenus.title(own, ModelChoice("typed-model")))
        assertEquals("2×", ModelMenus.multiplier(2.0))
        assertEquals("3.5×", ModelMenus.multiplier(3.5))
    }

    @Test fun initialChoice() {
        // Catalog default, then a saved default, then what the session uses now.
        assertEquals(ModelChoice("low"), ModelMenus.initial(flagship, null))
        // An effort the model doesn't list (an old "Think harder" pick) is dropped.
        assertEquals(ModelChoice("high"), ModelMenus.initial(flagship, ModelChoice("high", "high")))
        assertEquals(ModelChoice("medium"), ModelMenus.initial(flagship, ModelChoice("high"), ModelChoice("medium")))
        assertEquals(ModelChoice("low"), ModelMenus.initial(flagship, ModelChoice("retired")))
        assertNull(ModelMenus.initial(ModelMenu.Flagship(null), ModelChoice("low")))
        // Own key: provider default isn't listed here, so the first option with its default effort.
        assertEquals(ModelChoice("gpt-5.4-mini", "medium"), ModelMenus.initial(own, null))
    }

    @Test fun effortsComeOnlyFromWhatAModelLists() {
        // A Flagship model that reasons but lists no efforts gets no control and no effort.
        assertTrue(ModelMenus.efforts(flagship, ModelChoice("low")).isEmpty())
        assertEquals(ModelChoice("high"), ModelMenus.select(flagship, "high"))
        assertNull(ModelMenus.select(flagship, "medium-vision").effort)
        assertEquals(5, ModelMenus.efforts(own, ModelChoice("gpt-5.4-mini")).size)
        assertTrue(ModelMenus.efforts(own, ModelChoice("brand-new")).isEmpty())
        assertEquals(ModelChoice("gpt-5.4-mini", "medium"), ModelMenus.select(own, "gpt-5.4-mini"))
        assertEquals(ModelChoice("brand-new"), ModelMenus.select(own, "brand-new"))
    }

    @Test fun aFlagshipModelThatListsEffortsGetsTheControl() {
        val listed = screensJson.decodeFromString(
            InferenceCatalogResponse.serializer(),
            """{"models":[
                {"id":"low","label":"Low 1× (Qwen)","contextTokens":262144,"reasoning":true,
                 "efforts":["low","medium","high"],"defaultEffort":"medium","default":true},
                {"id":"plain","label":"Plain 1× (X)","contextTokens":131072,"reasoning":true,"efforts":[]}],
               "defaultModel":"low"}""",
        )
        assertEquals(listOf("low", "medium", "high"), listed.models[0].efforts)
        assertEquals("medium", listed.models[0].defaultEffort)
        val m = ModelMenu.Flagship(listed)
        assertEquals(listOf("low", "medium", "high"), ModelMenus.efforts(m, ModelChoice("low")))
        assertTrue(ModelMenus.efforts(m, ModelChoice("plain")).isEmpty())
        assertEquals(ModelChoice("low", "medium"), ModelMenus.select(m, "low"))
        assertEquals(ModelChoice("low", "medium"), ModelMenus.initial(m, null))
        assertEquals(ModelChoice("low", "high"), ModelMenus.initial(m, ModelChoice("low", "high")))
        assertEquals(262144L, ModelMenus.contextTokens(m, "low"))
        assertNull(ModelMenus.contextTokens(m, "gone"))
        assertNull(ModelMenus.contextTokens(own, "brand-new"))
        assertEquals(400000L, ModelMenus.contextTokens(own, "gpt-5.4-mini"))
    }

    @Test fun wire() {
        assertEquals("low" to null, ModelMenus.startWire(ModelChoice("low")))
        assertEquals("low" to "high", ModelMenus.startWire(ModelChoice("low", "high")))
        assertEquals(null to null, ModelMenus.startWire(null))
        assertEquals("low" to "", ModelMenus.replyWire(ModelChoice("low")))
        assertEquals("gpt-5.4-mini" to "xhigh", ModelMenus.replyWire(ModelChoice("gpt-5.4-mini", "xhigh")))
        assertEquals(null to null, ModelMenus.replyWire(null))
    }

    @Test fun visionSwitchFlagship() {
        assertEquals(VisionCheck.Send, ModelMenus.visionCheck(flagship, ModelChoice("medium"), hasImage = false))
        assertEquals(VisionCheck.Send, ModelMenus.visionCheck(flagship, ModelChoice("low"), hasImage = true))
        val s = ModelMenus.visionCheck(flagship, ModelChoice("medium", "high"), hasImage = true) as VisionCheck.Switch
        assertEquals("I'll have to switch to GLM-5.3-Flash (2×) for this.", s.message)
        assertEquals(ModelChoice("medium-vision"), s.to)
        val b = ModelMenus.visionCheck(flagship, ModelChoice("high"), hasImage = true) as VisionCheck.Blocked
        assertEquals("MiniMax-M3 can't see images. Remove them or pick another model.", b.message)
    }

    @Test fun visionSwitchOwnKey() {
        val s = ModelMenus.visionCheck(own, ModelChoice("qwen3-coder"), hasImage = true) as VisionCheck.Switch
        assertEquals("I'll have to switch to GPT-5.4 Mini for this.", s.message)
        assertEquals(ModelChoice("gpt-5.4-mini", "medium"), s.to)
        val b = ModelMenus.visionCheck(own, ModelChoice("text-only"), hasImage = true) as VisionCheck.Blocked
        assertEquals("Text Only can't see images. Remove them or pick another model.", b.message)
        // Unknown capabilities: send as is.
        assertEquals(VisionCheck.Send, ModelMenus.visionCheck(own, ModelChoice("brand-new"), hasImage = true))
        assertEquals(VisionCheck.Send, ModelMenus.visionCheck(own, ModelChoice("typed"), hasImage = true))
        assertEquals(VisionCheck.Send, ModelMenus.visionCheck(ModelMenu.Unknown, ModelChoice("x"), hasImage = true))
    }

    @Test fun sessionStateWithCreditsAndAttachments() {
        val raw = """
            {"id":"s1","appId":null,"status":"awaiting-tool-response","model":"medium","effort":"high","summarised":true,
             "messages":[
               {"role":"user","text":"build it","timestamp":1,"attachments":[
                  {"kind":"image","mediaType":"image/png","dataBase64":"iVBO","name":"mock.png"},
                  {"kind":"text","text":"hello","name":"notes.md"},
                  {"kind":"data","name":"plants.csv","mediaType":"text/csv","text":"a,b\n1,2"},
                  {"kind":"document","name":"spec.pdf","mediaType":"application/pdf","dataBase64":"JVBE"}]},
               {"role":"assistant","text":"done","timestamp":2,"credits":2.8}],
             "pendingRequest":{"kind":"talkToUser","toolUseId":"t1","payload":{"message":"ok?"}}}
        """.trimIndent()
        val s = screensJson.decodeFromString(VibeCodeSessionPublicState.serializer(), raw)
        assertEquals("medium", s.model)
        assertEquals("high", s.effort)
        assertTrue(s.summarised)
        val a = s.messages[0].attachments!!
        assertEquals(listOf(AttachKind.IMAGE, AttachKind.TEXT, AttachKind.DATA, AttachKind.DOCUMENT), a.map(ChatAttachments::kindOf))
        assertEquals("plants.csv", a[2].name)
        assertEquals(2.8, s.messages[1].credits!!, 0.0)
        assertNull(s.messages[0].credits)
        // An older box sends none of the continuation fields.
        assertFalse(s.canContinue)
        assertNull(s.provider)
        assertNull(s.conversationTokens)
    }

    @Test fun sessionStateSaysItCanContinueAndWhichProvider() {
        val s = screensJson.decodeFromString(
            VibeCodeSessionPublicState.serializer(),
            """{"id":"s1","appId":null,"status":"failed","failureReason":"boom","messages":[],
                "canContinue":true,"provider":"anthropic","conversationTokens":91234,"needsCredential":true}""",
        )
        assertTrue(s.canContinue)
        assertEquals("anthropic", s.provider)
        assertEquals(91234L, s.conversationTokens)
        assertEquals(true, s.needsCredential)
    }

    @Test fun replyAndStartEncodeModelEffortAndAttachments() {
        val req = VibeCodeReplyRequest(
            model = "low", effort = "", text = "hi",
            attachments = listOf(
                VibeCodeAttachment.Data(name = "x.json", mediaType = "application/json", text = "{}"),
                VibeCodeAttachment.Document(name = "a.pdf", dataBase64 = "JVBE"),
            ),
        )
        val o = screensJson.parseToJsonElement(screensJson.encodeToString(VibeCodeReplyRequest.serializer(), req)).jsonObject
        assertEquals("low", o["model"]!!.jsonPrimitive.content)
        assertEquals("", o["effort"]!!.jsonPrimitive.content)
        val att = o["attachments"]!!.jsonArray
        assertEquals("data", att[0].jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("application/json", att[0].jsonObject["mediaType"]!!.jsonPrimitive.content)
        assertEquals("document", att[1].jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("application/pdf", att[1].jsonObject["mediaType"]!!.jsonPrimitive.content)
        val start = screensJson.parseToJsonElement(
            screensJson.encodeToString(VibeCodeStartRequest.serializer(), VibeCodeStartRequest(prompt = "p", model = "medium")),
        ).jsonObject
        assertEquals("medium", start["model"]!!.jsonPrimitive.content)
        assertFalse("effort" in start)
        assertFalse("attachments" in start)
    }
}
