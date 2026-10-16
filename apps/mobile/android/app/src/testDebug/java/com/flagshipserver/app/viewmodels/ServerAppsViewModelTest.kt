// A server's apps on its page (docs/app-placement.md §3): installed apps open
// their page; one being copied here is greyed out with "Copying…" and its
// progress, and the page keeps polling while it is underway.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppCopiesResponse
import com.flagshipserver.app.api.AppCopyRecord
import com.flagshipserver.app.api.AppCopying
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAppsViewModelTest {

    private fun app(id: String, slug: String, copying: AppCopying? = null, status: String = "running") = AppSummary(
        serviceId = id, creator = "harry", slug = slug, urlLabel = slug,
        url = "https://$slug.home.harry.flagship.services/", status = status, installedAt = 1, copying = copying,
    )

    private class Box(
        var apps: List<AppSummary>,
        var copies: List<AppCopyRecord>? = emptyList(),
    ) : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        override suspend fun appsList() = AppsListResponse(apps)
        override suspend fun serviceCopies() =
            AppCopiesResponse(copies ?: throw ScreensError.Http(404, "not found"))
    }

    private fun loaded(vm: ServerAppsViewModel) = (vm.phase.value as ServerAppsViewModel.Phase.Loaded).rows

    @Test fun listsTheServersAppsWithAddressAndStatus() = runTest {
        val vm = ServerAppsViewModel(Box(listOf(app("harry--notes", "notes"), app("harry--wiki", "wiki", status = "stopped"))))
        vm.load()
        val rows = loaded(vm)
        assertEquals(listOf("Notes", "Wiki"), rows.map { it.name })
        assertEquals("notes.home.harry.flagship.services", rows[0].address)
        assertEquals("Running", rows[0].status)
        assertEquals("Stopped", rows[1].status)
        assertTrue(rows.all { it.opens })
        assertFalse(vm.underway)
    }

    // A copy still underway has no manifest on this box yet; the row carries its name.
    @Test fun aCopyWithoutASlugShowsTheNameTheBoxSent() = runTest {
        val vm = ServerAppsViewModel(Box(listOf(app("harry--notes", "", AppCopying("copying", 0.1)).copy(name = "Notes"))))
        vm.load()
        assertEquals("Notes", loaded(vm).single().name)
    }

    @Test fun aCopyArrivingIsGreyedWithItsProgress() = runTest {
        val box = Box(listOf(app("harry--notes", "notes", AppCopying("copying", 0.25))))
        val vm = ServerAppsViewModel(box)
        vm.load()
        val row = loaded(vm).single()
        assertTrue(row.copying)
        assertFalse(row.opens)
        assertEquals("Copying… 25%", row.status)
        assertTrue(vm.underway)

        box.apps = listOf(app("harry--notes", "notes"))
        vm.load()
        assertTrue(loaded(vm).single().opens)
        assertFalse(vm.underway)
    }

    @Test fun aCopyTheBoxDoesntListYetComesFromTheCopiesList() = runTest {
        val box = Box(
            emptyList(),
            listOf(AppCopyRecord("c1", "harry--notes", "Notes", "office.harry.flagship.services", "copying", 10.0, startedAt = 1)),
        )
        val vm = ServerAppsViewModel(box)
        vm.load()
        val row = loaded(vm).single()
        assertEquals("Notes", row.name)
        assertEquals("Copying… 10%", row.status)
        assertTrue(vm.underway)

        // It fails while the page watches: shown with the reason, not openable.
        box.copies = listOf(AppCopyRecord("c1", "harry--notes", "Notes", "", "failed", reason = "source unreachable", startedAt = 1))
        vm.load()
        val failed = loaded(vm).single()
        assertTrue(failed.failed)
        assertEquals("Couldn't copy: source unreachable", failed.status)
        assertFalse(vm.underway)
    }

    @Test fun anOldFailureIsNotShown() = runTest {
        val vm = ServerAppsViewModel(Box(emptyList(), listOf(AppCopyRecord("c1", "harry--notes", "Notes", "", "failed", startedAt = 1))))
        vm.load()
        assertTrue(loaded(vm).isEmpty())
    }

    @Test fun anOlderBoxWithoutCopiesStillListsItsApps() = runTest {
        val vm = ServerAppsViewModel(Box(listOf(app("harry--notes", "notes")), copies = null))
        vm.load()
        assertEquals(1, loaded(vm).size)
    }
}
