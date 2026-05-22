// Provisioning observability — pin the Android `provision-phase` FCM
// parser. Mirror of iOS ProvisionPhaseTests + the Worker fan-out
// payload (packages/control-plane/src/provisionEvents.ts).

package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProvisionPhasePushTest {

    @Test fun parse_provisionPhasePush_viaCategory() {
        val e = ProvisionPhasePush.parse(
            mapOf(
                "category" to "provision-phase",
                "username" to "demoalice",
                "fqdn" to "home.demoalice.flagship.services",
                "phase" to "deps",
            )
        )
        assertEquals("deps", e?.phase)
        assertEquals("demoalice", e?.username)
        assertEquals("home.demoalice.flagship.services", e?.fqdn)
        assertNull(e?.error)
    }

    @Test fun parse_provisionPhasePush_viaKindMeta() {
        val e = ProvisionPhasePush.parse(
            mapOf("kind" to "provision-phase", "phase" to "ready")
        )
        assertEquals("ready", e?.phase)
    }

    @Test fun parse_failedPhaseCarriesError() {
        val e = ProvisionPhasePush.parse(
            mapOf(
                "category" to "provision-phase",
                "phase" to "failed",
                "error" to "tunnel never came online",
            )
        )
        assertEquals("failed", e?.phase)
        assertEquals("tunnel never came online", e?.error)
    }

    @Test fun parse_emptyErrorBecomesNull() {
        val e = ProvisionPhasePush.parse(
            mapOf("category" to "provision-phase", "phase" to "ready", "error" to "")
        )
        assertNull(e?.error)
    }

    @Test fun parse_ignoresOtherCategories() {
        assertNull(ProvisionPhasePush.parse(mapOf("category" to "unlock-approve")))
        // provision-phase but no phase string → not parseable.
        assertNull(ProvisionPhasePush.parse(mapOf("category" to "provision-phase")))
        assertNull(ProvisionPhasePush.parse(emptyMap()))
    }

    @Test fun bridge_onPhaseFires() {
        var received: ProvisionPhaseEvent? = null
        ProvisionPhaseBridge.onPhase = { received = it }
        try {
            val e = ProvisionPhasePush.parse(
                mapOf(
                    "category" to "provision-phase",
                    "username" to "demoalice",
                    "fqdn" to "home.demoalice.flagship.services",
                    "phase" to "tunnel-online",
                )
            )!!
            ProvisionPhaseBridge.onPhase?.invoke(e)
            assertEquals("tunnel-online", received?.phase)
        } finally {
            ProvisionPhaseBridge.onPhase = null
        }
    }
}
