// The background half of "Keep a copy on this phone": a unique periodic
// WorkManager job, every 12 hours, only on an unmetered network while the
// phone charges with battery and storage not low. Each run fetches the newest
// saved backup of every server this phone has an owner session for
// (PhoneBackupFetcher). WorkManager cancels a run that loses its constraints;
// the chunk downloader then picks up where it stopped on the next run.
// Mirror of iOS's BGProcessingTask `com.flagshipserver.app.backup-fetch`.

package com.flagshipserver.app.core

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.flagshipserver.app.api.EncryptedSessionStore
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.LiveScreensClient
import java.util.concurrent.TimeUnit

class BackupFetchWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // A security notice has the app locked until it is updated: no backup fetch.
        SecurityNoticeCenter.install(ctx).evaluate()
        if (UpdateLock.isLocked) return Result.success()
        val sessions = runCatching { EncryptedSessionStore.create(ctx) }.getOrNull() ?: return Result.success()
        val servers = sessions.podTokenIds().map { it.removePrefix("pod-") }.filter { it.isNotEmpty() }
        if (servers.isEmpty()) return Result.success()
        val http = HttpClientFactory.build()
        val fetcher = PhoneBackupFetcher(
            copies = PhoneBackupCopies.from(ctx),
            clientFor = { server ->
                sessions.sessionToken(forPodId = PodInfo.podId(server))?.let { token ->
                    LiveScreensClient(
                        client = http,
                        store = InMemorySessionStore().apply {
                            setPodBaseUrl("https://$server")
                            setSessionToken(token)
                        },
                    )
                }
            },
            freeBytes = { ctx.filesDir.usableSpace },
            log = { android.util.Log.i("BackupFetch", it) },
        )
        fetcher.run(servers)
        return Result.success()
    }

    companion object {
        const val UNIQUE_NAME = "backup-fetch"

        /** Schedule the periodic fetch once (kept across launches). */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.UNMETERED)
                .setRequiresCharging(true)
                .setRequiresBatteryNotLow(true)
                .setRequiresStorageNotLow(true)
                .build()
            val req = PeriodicWorkRequestBuilder<BackupFetchWorker>(12, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
