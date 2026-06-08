// Provisioning observability — pin the Android canonical `provision-status`
// FCM parser. Mirror of iOS ProvisionPhaseBridge.parse + the webapp SW
// branch + the Worker fan-out payload
// (packages/control-plane/src/provisionStatus.ts `fanOutStatusPush`).
//
// Contract point 3 (LOCKED DESIGN §2.3): the FCM `data` map is flat —
// category/kind == "provision-status", meta.phase flattened to data["phase"],
// meta.serial → data["serial"], meta.detail → data["detail"].

package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProvisionPhasePushTest {

    @Test fun parse_provisionStatusPush_viaCategory() {
        val e = ProvisionStatusPush.parse(
            mapOf(
                "category" to "provision-status",
                "kind" to "provision-status",
                "serial" to "ORDER-123",
                "phase" to "registering",
                "title" to "Registering with Flagship",
                "body" to "Your server is checking in with Flagship.",
                "deepLink" to "flagship://install-progress",
            )
        )
        assertEquals("registering", e?.phase)
        assertEquals("ORDER-123", e?.serial)
        assertNull(e?.detail)
    }

    @Test fun parse_provisionStatusPush_viaKindMeta() {
        val e = ProvisionStatusPush.parse(
            mapOf("kind" to "provision-status", "serial" to "S", "phase" to "live")
        )
        assertEquals("live", e?.phase)
        assertEquals("S", e?.serial)
    }

    @Test fun parse_errorPhaseCarriesDetail() {
        val e = ProvisionStatusPush.parse(
            mapOf(
                "category" to "provision-status",
                "serial" to "S",
                "phase" to "error",
                "detail" to "tunnel never came online",
            )
        )
        assertEquals("error", e?.phase)
        assertEquals("tunnel never came online", e?.detail)
    }

    @Test fun parse_emptyDetailBecomesNull() {
        val e = ProvisionStatusPush.parse(
            mapOf("category" to "provision-status", "serial" to "S", "phase" to "live", "detail" to "")
        )
        assertNull(e?.detail)
    }

    @Test fun parse_ignoresOtherCategories() {
        assertNull(ProvisionStatusPush.parse(mapOf("category" to "unlock-approve")))
        // The retired channel-C `provision-phase` category is NOT recognized.
        assertNull(ProvisionStatusPush.parse(mapOf("category" to "provision-phase", "phase" to "deps")))
        // provision-status but no phase string → not parseable.
        assertNull(ProvisionStatusPush.parse(mapOf("category" to "provision-status", "serial" to "S")))
        assertNull(ProvisionStatusPush.parse(emptyMap()))
    }
}
