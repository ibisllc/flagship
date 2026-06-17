// Inbound URL → DeepLink resolution for both the primary
// `flagship://` scheme AND the https://flagshipserver.com/app/...
// universal-link form. Extracted from MainActivity so it's reachable
// from unit tests without needing to instantiate the activity.

package com.flagshipserver.app.core

import android.net.Uri

object AppLink {
    /**
     * Translate any inbound URI we recognize into a [DeepLink]. Returns
     * null if the URI isn't ours. Two recognized forms:
     *
     *   1. `flagship://<host>?<params>` — the primary in-app scheme.
     *      Handed straight to [DeepLink.parse].
     *
     *   2. `https://flagshipserver.com/app/<host>?<params>` — the
     *      app-link form. The OS routes these to the app via
     *      `autoVerify=true` + the assetlinks.json on
     *      flagshipserver.com. We rewrite the URI to the equivalent
     *      `flagship://<host>?<params>` and re-parse so a single
     *      DeepLink contract serves both surfaces.
     */
    fun resolve(uri: Uri): DeepLink? {
        DeepLink.parse(uri)?.let { return it }
        if (uri.scheme in setOf("http", "https") && uri.host == Endpoints.controlHost) {
            val segments = uri.pathSegments
            if (segments.size >= 2 && segments[0] == "app") {
                val translated = Uri.Builder()
                    .scheme("flagship")
                    .authority(segments[1])
                    .encodedQuery(uri.encodedQuery)
                    .build()
                return DeepLink.parse(translated)
            }
            // Phase 3b — the cross-device pairing universal link
            // (https://flagshipserver.com/join?sid=…&pk=…). It is a
            // top-level path, so it maps to the `join` host of the
            // flagship:// scheme directly.
            if (segments.size == 1 && segments[0] == "join") {
                val translated = Uri.Builder()
                    .scheme("flagship")
                    .authority("join")
                    .encodedQuery(uri.encodedQuery)
                    .build()
                return DeepLink.parse(translated)
            }
        }
        return null
    }
}
