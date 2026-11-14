package com.flagshipserver.app.push

import android.app.Activity
import android.content.Context
import com.flagshipserver.app.R
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import org.unifiedpush.android.connector.UnifiedPush

/** The UnifiedPush connector, and the choice between it and FCM ([PushTransport.choose]). */
object UnifiedPushTransport {
    fun distributors(context: Context): List<String> =
        runCatching { UnifiedPush.getDistributors(context) }.getOrDefault(emptyList())
            .filter { it != context.packageName }

    fun hasPlayServices(context: Context): Boolean = runCatching {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }.getOrDefault(false)

    /**
     * Picks this phone's transport and, for UnifiedPush, its distributor: the
     * one saved earlier if still installed, the only one, the user's default
     * (from an [activity], which may ask which to use), else the first.
     */
    fun resolve(context: Context, activity: Activity? = null, done: (PushTransport, String?) -> Unit) {
        val installed = distributors(context)
        if (installed.isEmpty()) {
            done(PushTransport.choose(false, hasPlayServices(context)), null)
            return
        }
        val saved = runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull()
        when {
            saved != null && saved in installed -> done(PushTransport.UNIFIEDPUSH, saved)
            installed.size == 1 || activity == null -> {
                UnifiedPush.saveDistributor(context, installed.first())
                done(PushTransport.UNIFIEDPUSH, installed.first())
            }
            else -> UnifiedPush.tryUseDefaultDistributor(activity) { ok ->
                val picked = if (ok) runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull() else null
                if (picked != null) {
                    done(PushTransport.UNIFIEDPUSH, picked)
                } else {
                    UnifiedPush.saveDistributor(context, installed.first())
                    done(PushTransport.UNIFIEDPUSH, installed.first())
                }
            }
        }
    }

    /** Asks the distributor for an endpoint; it answers through [FlagshipUnifiedPushService.onNewEndpoint]. */
    fun register(context: Context, vapidPublicKey: String?): Boolean {
        val saved = runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull()
        if (saved == null) {
            val installed = distributors(context)
            if (installed.isEmpty()) return false
            UnifiedPush.saveDistributor(context, installed.first())
        }
        val label = context.getString(R.string.app_name)
        return try {
            UnifiedPush.register(context, messageForDistributor = label, vapid = vapidPublicKey)
            true
        } catch (_: UnifiedPush.VapidNotValidException) {
            runCatching { UnifiedPush.register(context, messageForDistributor = label) }.isSuccess
        } catch (_: Throwable) {
            false
        }
    }

    fun unregister(context: Context) {
        runCatching { UnifiedPush.unregister(context) }
    }

    fun distributorLabel(context: Context, packageName: String?): String? {
        if (packageName.isNullOrEmpty()) return null
        return runCatching {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        }.getOrNull() ?: packageName
    }
}
