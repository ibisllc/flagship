// The plan screen's warning before Pro ends while apps keep a separate access
// list on each server (feat/marketplace): the three wordings, and nothing
// without Pro, without such apps, or when the server can't say.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.AppListScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SeparateListsWarningTest {
    private val names = mapOf("home.a.flagship.services" to "Living room")
    private fun nameOf(f: String) = names[f] ?: AppListScope.firstLabel(f)

    @Test fun theThreeWordings() {
        assertEquals(
            "1 app has a separate access list on each server. When Pro ends it will use Living room's list.",
            AppListScope.separateListsWarning("pro", 1, listOf("home.a.flagship.services"), ::nameOf),
        )
        assertEquals(
            "3 apps have a separate access list on each server. When Pro ends they'll all use Living room's list.",
            AppListScope.separateListsWarning("pro", 3, listOf("home.a.flagship.services", "HOME.a.flagship.services"), ::nameOf),
        )
        assertEquals(
            "2 apps have a separate access list on each server. When Pro ends each will use its lead server's list.",
            AppListScope.separateListsWarning("pro", 2, listOf("home.a.flagship.services", "office.a.flagship.services"), ::nameOf),
        )
        assertEquals(
            "2 apps have a separate access list on each server. When Pro ends they'll all use office's list.",
            AppListScope.separateListsWarning("pro", 2, listOf("office.a.flagship.services"), ::nameOf),
        )
    }

    @Test fun nothingWithoutProOrWithoutSuchApps() {
        assertNull(AppListScope.separateListsWarning("free", 2, listOf("home.a.flagship.services"), ::nameOf))
        assertNull(AppListScope.separateListsWarning("unknown", 1, emptyList(), ::nameOf))
        assertNull(AppListScope.separateListsWarning("pro", 0, emptyList(), ::nameOf))
    }

    @Test fun theViewModelReadsTheAccountSummary() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            listScopePlan = "pro"
            listScopes["bright-maple--notes"] = "server"
        }
        val vm = TierStatusViewModel(client, scope = backgroundScope, serverName = { if (it.startsWith("home.")) "Living room" else it })
        vm.load().join()
        assertEquals(
            "1 app has a separate access list on each server. When Pro ends it will use Living room's list.",
            vm.separateListsWarning.value,
        )
    }

    @Test fun theViewModelHidesItWhenTheServerCantSay() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply { shouldFail = true }
        val vm = TierStatusViewModel(client, scope = backgroundScope)
        vm.load().join()
        assertNull(vm.separateListsWarning.value)
    }
}
