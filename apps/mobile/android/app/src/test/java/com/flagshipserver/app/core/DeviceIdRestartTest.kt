package com.flagshipserver.app.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A cold start must sign as the device `.com` registered, never a new random one (W-2026-11-07). */
class DeviceIdRestartTest {
    private class MemoryStore : AppState.DeviceIdStore {
        val ids = mutableMapOf<String, String>()
        override fun load(cloudName: String) = ids[cloudName]
        override fun save(cloudName: String, deviceId: String) { ids[cloudName] = deviceId }
    }

    private val registered = "91523f" + "0".repeat(26)

    @Test fun restartRestoresTheRegisteredDeviceId() {
        val store = MemoryStore()
        val first = AppState().also { it.deviceIdStore = store }
        first.completeOnboarding("plucky-daisy", emptyList())
        first.addProfile(first.activeProfile!!.copy(deviceId = registered))
        assertEquals(registered, store.ids["plucky-daisy"])

        val afterRestart = AppState().also { it.deviceIdStore = store }
        afterRestart.restorePersistedSession("plucky-daisy")
        assertEquals(registered, afterRestart.activeProfile?.deviceId)
    }

    @Test fun anInventedIdIsNeverSaved() {
        val store = MemoryStore()
        val s = AppState().also { it.deviceIdStore = store }
        s.restorePersistedSession("plucky-daisy")
        assertNull(store.ids["plucky-daisy"])
    }

    @Test fun adoptingTheAcceptedIdSavesIt() {
        val store = MemoryStore()
        val s = AppState().also { it.deviceIdStore = store }
        s.restorePersistedSession("plucky-daisy")
        s.adoptRegisteredDeviceId(registered)
        assertEquals(registered, s.activeProfile?.deviceId)
        assertEquals(registered, store.ids["plucky-daisy"])
    }

    @Test fun repairTriesBoundKeysFirstAndStopsWhenOffline() = runBlocking {
        val random = "39b80d" + "0".repeat(26)
        val other = "ab" + "0".repeat(30)
        val order = DeviceIdRepair.candidates(random, listOf(registered), listOf(other), listOf(random, "junk"))
        assertEquals(listOf(random, registered, other), order)
        val tried = mutableListOf<String>()
        val found = DeviceIdRepair.find(order) { id ->
            tried += id
            if (id == registered) DeviceIdRepair.Verdict.ACCEPTED else DeviceIdRepair.Verdict.REFUSED
        }
        assertEquals(registered, found)
        assertEquals(listOf(random, registered), tried)
        assertNull(DeviceIdRepair.find(order) { DeviceIdRepair.Verdict.UNREACHABLE })
    }
}
