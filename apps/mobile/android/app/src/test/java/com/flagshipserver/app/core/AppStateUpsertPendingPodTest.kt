// Mirror of the iOS AppStateTests upsertPendingPod block (commit 48a4b9e).
// Pins the delivered-page instant-surface semantics: idempotent insert keyed
// on the fqdn, serial re-attachment to a reconciler-surfaced serial-less
// twin, never downgrading a known serial, and the online pod always winning.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class AppStateUpsertPendingPodTest {

    @Test fun insertsFreshPodKeyedOnFqdn() {
        val s = AppState()
        val id = s.upsertPendingPod(
            name = "abc", description = "box",
            fqdn = "abc.harry.flagship.services", serial = "SER-1",
        )
        assertEquals(1, s.pods.value.size)
        assertEquals(PodInfo.podId("abc.harry.flagship.services"), id)
        assertEquals(PodInfo.Status.PENDING, s.pods.value.first().status)
        assertEquals("SER-1", s.pods.value.first().pendingAuthCodeSerial)
        assertEquals("box", s.pods.value.first().description)
    }

    @Test fun isIdempotent_noDuplicate() {
        // Fires the moment delivery succeeds AND again when the progress
        // screen is left — same fqdn (case-insensitive) collapses to ONE pod.
        val s = AppState()
        val first = s.upsertPendingPod(
            name = "abc", fqdn = "abc.harry.flagship.services", serial = "SER-1",
        )
        val second = s.upsertPendingPod(
            name = "abc", fqdn = "ABC.harry.flagship.services", serial = "SER-1",
        )
        assertEquals(1, s.pods.value.size)
        assertEquals(first, second)
        assertEquals("SER-1", s.pods.value.first().pendingAuthCodeSerial)
    }

    @Test fun attachesSerialToReconcilerSurfacedTwin() {
        // The /pods reconciler can surface the order serial-less BEFORE the
        // create flow upserts (the directory only carries opaque orderRefs).
        // The creating device's upsert must attach its locally-known serial
        // in place — restoring deep progress + cancel — not duplicate.
        val s = AppState()
        s.addPod(
            PodInfo(
                podId = PodInfo.podId("abc.harry.flagship.services"),
                name = "abc",
                fqdn = "abc.harry.flagship.services",
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = null,
            ),
        )
        val id = s.upsertPendingPod(
            name = "abc", description = "my box",
            fqdn = "abc.harry.flagship.services", serial = "SER-9",
        )
        assertEquals(1, s.pods.value.size)
        assertEquals(PodInfo.podId("abc.harry.flagship.services"), id)
        assertEquals("SER-9", s.pods.value.first().pendingAuthCodeSerial)
        assertEquals("my box", s.pods.value.first().description)
    }

    @Test fun neverDowngradesKnownSerialOrOnlinePod() {
        val fqdn = "abc.harry.flagship.services"
        val s = AppState()
        s.addPod(
            PodInfo(
                podId = "p1", name = "abc", fqdn = fqdn,
                status = PodInfo.Status.PENDING, pendingAuthCodeSerial = "SER-1",
            ),
        )
        s.upsertPendingPod(name = "abc", fqdn = fqdn, serial = null)
        assertEquals("null never clobbers a known serial", "SER-1", s.pods.value.first().pendingAuthCodeSerial)

        val online = AppState()
        online.addPod(PodInfo(podId = "o1", name = "abc", fqdn = fqdn, status = PodInfo.Status.ONLINE))
        val id = online.upsertPendingPod(name = "abc", fqdn = fqdn, serial = "SER-2")
        assertEquals("o1", id)
        assertEquals("online pod always wins", PodInfo.Status.ONLINE, online.pods.value.first().status)
    }
}
