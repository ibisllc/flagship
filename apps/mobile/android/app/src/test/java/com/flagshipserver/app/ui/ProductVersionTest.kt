// About shows the one product version all surfaces share, plus the store build.

package com.flagshipserver.app.ui

import com.flagshipserver.app.BuildConfig
import com.flagshipserver.app.ui.screens.productAboutLine
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ProductVersionTest {
    @Test
    fun aboutNamesTheProductVersionLabelAndStoreBuild() {
        assertEquals("Flagship 0.2 Beta (build 9)", productAboutLine("0.2", "Beta", 9))
    }

    @Test
    fun thisBuildReadsTheSharedReleaseFile() {
        val file = File(System.getProperty("user.dir"), "../../../../release/version.json")
        val v = Json.parseToJsonElement(file.readText()).jsonObject
        assertEquals(v.getValue("product").jsonPrimitive.content, BuildConfig.VERSION_NAME)
        assertEquals(v.getValue("label").jsonPrimitive.content, BuildConfig.PRODUCT_LABEL)
        assertEquals(v.getValue("androidVersionCode").jsonPrimitive.int, BuildConfig.VERSION_CODE)
    }
}
