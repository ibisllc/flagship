// Mirror of FlagshipMobileTests/MultiProfileTests.swift. Same
// invariants: completeOnboarding records a profile, addProfile +
// setActiveProfile switches the active cloud and mirrors the new
// profile's session state into the single-identity fields, switching
// drops the pod list (the new cloud's pods come from /devices).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MultiProfileTest {

    @Test fun completeOnboarding_addsProfileAndMarksActive() {
        val s = AppState()
        s.completeOnboarding("harry", emptyList())
        assertEquals(1, s.profiles.value.size)
        assertEquals("harry", s.profiles.value.first().cloudName)
        assertEquals("harry", s.activeCloudName.value)
        assertEquals("harry", s.activeProfile?.cloudName)
    }

    @Test fun addProfile_thenSwitch_changesActiveAndCurrentUser() {
        val s = AppState()
        s.completeOnboarding(
            "harry",
            listOf(PodInfo(podId = "a", name = "A", fqdn = "a.harry.flagship.services")),
        )
        s.addProfile(Profile(cloudName = "jay-family", deviceDisplayName = "phone"), setActive = false)
        assertEquals(2, s.profiles.value.size)
        assertEquals("harry", s.activeCloudName.value)
        assertEquals("harry", s.currentUser.value)
        assertEquals(1, s.pods.value.size)

        s.setActiveProfile("jay-family")
        assertEquals("jay-family", s.activeCloudName.value)
        assertEquals("jay-family", s.activeProfile?.cloudName)
        assertEquals("jay-family", s.currentUser.value)
        // Pods are NOT carried across — the new cloud's pods come from
        // /devices on the next fetch.
        assertTrue(s.pods.value.isEmpty())
    }

    @Test fun setActiveProfile_ignoresUnknownCloudName() {
        val s = AppState()
        s.completeOnboarding("harry", emptyList())
        s.setActiveProfile("does-not-exist")
        assertEquals("harry", s.activeCloudName.value)
        assertEquals("harry", s.currentUser.value)
    }

    @Test fun profileSerialization_preservesIdentityFields() {
        val p = Profile(
            cloudName = "harry",
            cloudRootPubHex = "deadbeef",
            deviceDisplayName = "android",
            createdAt = 1_700_000_000_000L,
        )
        val json = Json { ignoreUnknownKeys = true }
        val data = json.encodeToString(Profile.serializer(), p)
        val decoded = json.decodeFromString(Profile.serializer(), data)
        assertEquals("harry", decoded.cloudName)
        assertEquals("deadbeef", decoded.cloudRootPubHex)
        assertEquals("android", decoded.deviceDisplayName)
        assertEquals(1_700_000_000_000L, decoded.createdAt)
    }

    @Test fun completeOnboarding_replacesExistingProfileForSameCloud() {
        val s = AppState()
        s.completeOnboarding("harry", emptyList())
        s.completeOnboarding(
            "harry",
            listOf(PodInfo(podId = "x", name = "X", fqdn = "x.harry.flagship.services")),
        )
        assertEquals(1, s.profiles.value.size)
        assertEquals("harry", s.profiles.value.first().cloudName)
    }

    @Test fun signOut_clearsActiveProfileButKeepsProfileList() {
        val s = AppState()
        s.completeOnboarding("harry", emptyList())
        s.addProfile(Profile(cloudName = "jay-family"))
        assertEquals(2, s.profiles.value.size)

        s.signOut()
        assertNull(s.activeCloudName.value)
        assertNull(s.currentUser.value)
        // Profile list survives sign-out (durable across re-auth).
        assertEquals(2, s.profiles.value.size)
        assertFalse(s.isPaired.value)
    }

    @Test fun keychainSyncClass_enumIsAvailable() {
        // W8 — the enum is a no-op marker on Android (no iCloud-style
        // auto-sync) but it exists so the future device-IRK split
        // shares a vocabulary with the iOS side.
        val cloud = KeychainSyncClass.CloudRoot
        val device = KeychainSyncClass.DeviceLocal
        assertTrue(cloud != device)
    }
}
