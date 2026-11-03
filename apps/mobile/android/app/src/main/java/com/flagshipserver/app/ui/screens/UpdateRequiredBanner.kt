// "This server needs an update" (owner decision 2026-11-02): the box runs a
// release from before the one `.com` needs (`/pods` `updateRequired`, a 0.2 box
// under 0.3). Its certificate can't renew, so it goes dark when the one it holds
// runs out. The update itself is the page's Software update card, which the page
// moves right under this banner. Mirror of iOS UpdateRequiredBanner.
package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.flagshipserver.app.R
import com.flagshipserver.app.api.UpdateRequiredWire
import com.flagshipserver.app.ui.theme.FS
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** The certificate's end as a long date in [locale], or null when `.com` doesn't know it. */
internal fun updateRequiredCertificateDate(
    view: UpdateRequiredWire,
    locale: Locale = Locale.getDefault(),
    zone: ZoneId = ZoneId.systemDefault(),
): String? {
    val ms = view.certificateExpiresAt?.takeIf { it > 0 } ?: return null
    return DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale)
        .format(Instant.ofEpochMilli(ms).atZone(zone))
}

@Composable
internal fun UpdateRequiredBanner(view: UpdateRequiredWire) {
    val date = updateRequiredCertificateDate(view)
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s1),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8))
            .background(FS.colors.warning.copy(alpha = 0.10f))
            .padding(FS.space.s3)
            .testTag("sd-update-required"),
    ) {
        Text(
            stringResource(R.string.update_required_title),
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(
            if (date != null) stringResource(R.string.update_required_cert_ends, date) else stringResource(R.string.update_required_cert_unknown),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("sd-update-required-detail"),
        )
    }
}
