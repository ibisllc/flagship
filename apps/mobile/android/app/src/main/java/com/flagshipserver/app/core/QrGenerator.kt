// Compose-friendly QR rendering. PairingQr.encode produces a raw Android
// Bitmap (zxing-core, pure JVM); QrGenerator wraps that for the UI layer
// so screens depend on a single, side-effect-free helper:
//
//   QrImage(payload = joinUrl, size = 220.dp)
//
// Internally the bitmap is cached per payload so a stable QR doesn't
// re-encode on every recomposition. Tests round-trip the bitmap through
// zxing's MultiFormatReader to assert byte-identical decoding.

package com.flagshipserver.app.core

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp

/** Pure helper: encode [payload] into an ARGB QR [Bitmap] of [sizePx]
 *  square via zxing-core. Delegates to [PairingQr.encode] so the
 *  encoding parameters (margin, error-correction) stay in one place. */
fun qrBitmap(payload: String, sizePx: Int = 720): Bitmap =
    PairingQr.encode(payload, sizePx)

/** [qrBitmap] returned as an [ImageBitmap] for direct use in Compose
 *  Image composables. Kept separate so non-Composable callers (preview
 *  generators, share-sheet writers) can grab the raw Bitmap. */
fun qrImageBitmap(payload: String, sizePx: Int = 720): ImageBitmap =
    qrBitmap(payload, sizePx).asImageBitmap()

/** Render [payload] as a square QR of [size] dp. The underlying bitmap
 *  is cached against [payload] so a recomposition that doesn't change
 *  the payload reuses the same bytes. Scales nearest-neighbor (default
 *  Compose Image filter) — the QR modules stay crisp at any [size]. */
@Composable
fun QrImage(
    payload: String,
    size: Dp,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val sizePx = with(density) { size.toPx().toInt().coerceAtLeast(1) }
    val bitmap = remember(payload, sizePx) { qrImageBitmap(payload, sizePx) }
    Image(
        bitmap = bitmap,
        contentDescription = contentDescription,
        modifier = modifier,
        contentScale = ContentScale.Fit,
    )
}
