// `/pods` `updateRequired` (control-plane boxUpdateRequired.ts): a 0.2 box under
// 0.3. Decoded leniently like iOS (a garbled value never fails the list), kept
// per lowercased fqdn for registered servers only, and its date shown long.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.api.UpdateRequiredWire
import com.flagshipserver.app.ui.screens.updateRequiredCertificateDate
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneOffset
import java.util.Locale

class UpdateRequiredWireTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    private fun pod(extra: String) = json.decodeFromString(
        PodDirectoryEntry.serializer(),
        """{"serverDomain":"Home.harry.flagship.services","identityPubKey":"${"ab".repeat(32)}"$extra}""",
    )

    @Test fun decodesPresent() {
        assertEquals(
            UpdateRequiredWire("box-too-old", 1_900_000_000_000),
            pod(""","updateRequired":{"reason":"box-too-old","certificateExpiresAt":1900000000000}""").updateRequired,
        )
        assertEquals(
            UpdateRequiredWire("box-too-old", null),
            pod(""","updateRequired":{"reason":"box-too-old","certificateExpiresAt":null}""").updateRequired,
        )
    }

    @Test fun absentOrNullIsNull() {
        assertNull(pod("").updateRequired)
        assertNull(pod(""","updateRequired":null""").updateRequired)
    }

    @Test fun garbledIsNullAndTheListStillDecodes() {
        assertNull(pod(""","updateRequired":"yes"""").updateRequired)
        assertNull(pod(""","updateRequired":{"certificateExpiresAt":"soon"}""").updateRequired)
        val list = json.decodeFromString(
            PodsDirectoryResponse.serializer(),
            """{"username":"harry","pods":[{"serverDomain":"a.harry.flagship.services","identityPubKey":"00","updateRequired":[1]}]}""",
        )
        assertEquals(1, list.pods.size)
        assertNull(list.pods[0].updateRequired)
    }

    @Test fun roundTrips() {
        val p = pod(""","updateRequired":{"reason":"box-too-old","certificateExpiresAt":5}""")
        val again = json.decodeFromString(PodDirectoryEntry.serializer(), json.encodeToString(PodDirectoryEntry.serializer(), p))
        assertEquals(p.updateRequired, again.updateRequired)
        assertNull(json.decodeFromString(PodDirectoryEntry.serializer(), json.encodeToString(PodDirectoryEntry.serializer(), pod(""))).updateRequired)
    }

    @Test fun keptPerLowercasedFqdnForLiveServersOnly() {
        val u = UpdateRequiredWire(certificateExpiresAt = 7)
        val map = updatesRequired(
            listOf(
                PodDirectoryEntry(serverDomain = "Home.harry.flagship.services", identityPubKey = "00", updateRequired = u),
                PodDirectoryEntry(serverDomain = "old.harry.flagship.services", identityPubKey = "00", revokedAt = 1, updateRequired = u),
                PodDirectoryEntry(serverDomain = "new.harry.flagship.services", identityPubKey = "00"),
            ),
        )
        assertEquals(mapOf("home.harry.flagship.services" to u), map)
        val s = AppState()
        s.setPodsUpdateRequired(mapOf("HOME.harry.flagship.services" to u))
        assertEquals(mapOf("home.harry.flagship.services" to u), s.podsUpdateRequired.value)
    }

    @Test fun certificateDateIsLongAndLocalized() {
        val v = UpdateRequiredWire(certificateExpiresAt = 1_900_000_000_000) // 2030-03-17T17:46:40Z
        assertEquals("March 17, 2030", updateRequiredCertificateDate(v, Locale.US, ZoneOffset.UTC))
        assertEquals("17 mars 2030", updateRequiredCertificateDate(v, Locale.FRANCE, ZoneOffset.UTC))
        assertNull(updateRequiredCertificateDate(UpdateRequiredWire(certificateExpiresAt = null)))
    }
}
