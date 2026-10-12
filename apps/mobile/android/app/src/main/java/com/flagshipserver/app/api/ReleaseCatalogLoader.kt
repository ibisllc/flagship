// The release list behind "Update this server": the box's own verified list,
// or `.com`'s copy for a box from before 2026-10-11 that doesn't have the
// route. Mirror of the webapp's loadReleaseCatalog (lib/serverUpdate.js).

package com.flagshipserver.app.api

import com.flagshipserver.app.core.ServerUpdateDeposit

/**
 * Asks the box first. Only a 404 from a box that reported a full commit falls
 * back to `.com`; any other box error is rethrown. Whatever list is shown, the
 * order still names one exact commit and the box checks its endorsement.
 */
suspend fun loadReleaseCatalog(
    screens: ScreensClient,
    mailbox: SecretMailboxClient,
    currentCommit: String?,
    refresh: Boolean,
): ReleaseCatalogResponse {
    try {
        return screens.serverUpdates(refresh)
    } catch (e: ScreensError.Http) {
        if (e.status != 404) throw e
        val commit = currentCommit?.takeIf(ServerUpdateDeposit::isValidCommit) ?: throw e
        return mailbox.fetchReleases(commit, refresh)
    }
}
