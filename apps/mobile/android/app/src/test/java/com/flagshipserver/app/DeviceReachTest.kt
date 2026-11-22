package com.flagshipserver.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import java.util.Properties
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Device reach: Google Play reads a permission as a hardware requirement (CAMERA as a camera with autofocus,
 * RECORD_AUDIO as a microphone, ...) unless the manifest declares that feature `required="false"`, and hides the app
 * from every device without it. Build 12 lost about 1,577 devices that way. This reads the merged manifest (the app's
 * and every library's) the unit tests run against; scripts/check-release-clean.sh repeats the check on the release
 * APK with aapt2, which applies Play's own rules.
 */
class DeviceReachTest {
    companion object {
        private val LOCATION = listOf("android.hardware.location")
        private val BLUETOOTH = listOf("android.hardware.bluetooth")
        private val TELEPHONY = listOf("android.hardware.telephony")
        private val WIFI = listOf("android.hardware.wifi")

        /** Play's implied features (developer.android.com, "Permissions that imply feature requirements"); the newer
         *  Bluetooth permissions are counted too, to be safe. */
        val IMPLIED: Map<String, List<String>> = mapOf(
            "android.permission.CAMERA" to listOf("android.hardware.camera", "android.hardware.camera.autofocus"),
            "android.permission.RECORD_AUDIO" to listOf("android.hardware.microphone"),
            "android.permission.BLUETOOTH" to BLUETOOTH,
            "android.permission.BLUETOOTH_ADMIN" to BLUETOOTH,
            "android.permission.BLUETOOTH_CONNECT" to BLUETOOTH,
            "android.permission.BLUETOOTH_SCAN" to BLUETOOTH,
            "android.permission.BLUETOOTH_ADVERTISE" to BLUETOOTH,
            "android.permission.ACCESS_FINE_LOCATION" to LOCATION + "android.hardware.location.gps",
            "android.permission.ACCESS_COARSE_LOCATION" to LOCATION + "android.hardware.location.network",
            "android.permission.ACCESS_MOCK_LOCATION" to LOCATION,
            "android.permission.ACCESS_LOCATION_EXTRA_COMMANDS" to LOCATION,
            "android.permission.CALL_PHONE" to TELEPHONY,
            "android.permission.CALL_PRIVILEGED" to TELEPHONY,
            "android.permission.MODIFY_PHONE_STATE" to TELEPHONY,
            "android.permission.PROCESS_OUTGOING_CALLS" to TELEPHONY,
            "android.permission.READ_SMS" to TELEPHONY,
            "android.permission.RECEIVE_SMS" to TELEPHONY,
            "android.permission.RECEIVE_MMS" to TELEPHONY,
            "android.permission.RECEIVE_WAP_PUSH" to TELEPHONY,
            "android.permission.SEND_SMS" to TELEPHONY,
            "android.permission.WRITE_APN_SETTINGS" to TELEPHONY,
            "android.permission.WRITE_SMS" to TELEPHONY,
            "android.permission.ACCESS_WIFI_STATE" to WIFI,
            "android.permission.CHANGE_WIFI_STATE" to WIFI,
            "android.permission.CHANGE_WIFI_MULTICAST_STATE" to WIFI,
        )

        private const val NS = "http://schemas.android.com/apk/res/android"

        /** Each implied feature a permission brings that is not declared `required="false"`, as "permission -> feature";
         *  a hardware feature declared required is a problem too. */
        fun problems(manifestXml: String): List<String> {
            val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
                .parse(manifestXml.byteInputStream())
            fun elements(tag: String) = doc.getElementsByTagName(tag).let { l -> (0 until l.length).map { l.item(it) as Element } }
            val permissions = (elements("uses-permission") + elements("uses-permission-sdk-23")).map { it.getAttributeNS(NS, "name") }
            val optional = HashSet<String>()
            val out = ArrayList<String>()
            for (f in elements("uses-feature")) {
                val name = f.getAttributeNS(NS, "name").takeIf { it.isNotEmpty() } ?: continue
                if (f.getAttributeNS(NS, "required") == "false") optional += name
                else if (name.startsWith("android.hardware.")) out += "declared required -> $name"
            }
            for (p in permissions.distinct()) for (feature in IMPLIED[p].orEmpty()) {
                if (feature !in optional) out += "$p -> $feature"
            }
            return out.distinct()
        }
    }

    private fun mergedManifest(): File {
        val props = Properties()
        val res = javaClass.classLoader!!.getResourceAsStream("com/android/tools/test_config.properties")
            ?: error("no test_config.properties: unit tests need isIncludeAndroidResources")
        res.use { props.load(it) }
        return File(props.getProperty("android_merged_manifest") ?: error("no android_merged_manifest"))
    }

    @Test fun everyImpliedFeatureIsOptional() {
        val problems = problems(mergedManifest().readText())
        assertTrue(
            "Declare these <uses-feature android:required=\"false\"/> in app/src/main/AndroidManifest.xml or Play hides the app from devices without them: $problems",
            problems.isEmpty(),
        )
    }

    @Test fun aMissingDeclarationIsCaught() {
        val xml = """
            <manifest xmlns:android="$NS" package="x">
              <uses-permission android:name="android.permission.CAMERA"/>
              <uses-permission android:name="android.permission.RECORD_AUDIO"/>
              <uses-feature android:name="android.hardware.camera" android:required="false"/>
              <uses-feature android:name="android.hardware.microphone"/>
            </manifest>
        """.trimIndent()
        assertEquals(
            listOf(
                "declared required -> android.hardware.microphone",
                "android.permission.CAMERA -> android.hardware.camera.autofocus",
                "android.permission.RECORD_AUDIO -> android.hardware.microphone",
            ),
            problems(xml),
        )
    }
}
