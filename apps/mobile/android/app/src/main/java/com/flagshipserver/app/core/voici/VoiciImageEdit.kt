// The photo editor's state for a voi.ci picture: quarter turns clockwise, a horizontal flip applied after the turns,
// and a square crop (zoom and centre) in the turned picture's pixels. iOS (VoiciImageEdit.swift) and the webapp
// (lib/voiciImageEdit.js) run the same rules; packages/protocol/test-vectors/voici-image-edit pins them.
// Affine maps are [a, b, c, d, tx, ty]: (x, y) → (a·x + c·y + tx, b·x + d·y + ty).

package com.flagshipserver.app.core.voici

data class VoiciImageEdit(
    val width: Double,
    val height: Double,
    val turns: Int = 0,
    val flipped: Boolean = false,
    val zoom: Double = 1.0,
    val cx: Double = width / 2,
    val cy: Double = height / 2,
) {
    data class Crop(val x: Double, val y: Double, val side: Double)

    val displayWidth: Double get() = if (turns % 2 == 0) width else height
    val displayHeight: Double get() = if (turns % 2 == 0) height else width

    val crop: Crop
        get() {
            val side = minOf(displayWidth, displayHeight) / zoom
            return Crop(cx - side / 2, cy - side / 2, side)
        }

    /** Source pixel → turned (and flipped) pixel. */
    fun orient(): DoubleArray {
        val m = when (turns) {
            1 -> doubleArrayOf(0.0, 1.0, -1.0, 0.0, height, 0.0)
            2 -> doubleArrayOf(-1.0, 0.0, 0.0, -1.0, width, height)
            3 -> doubleArrayOf(0.0, -1.0, 1.0, 0.0, 0.0, width)
            else -> doubleArrayOf(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        }
        return if (flipped) doubleArrayOf(-m[0], m[1], -m[2], m[3], displayWidth - m[4], m[5]) else m
    }

    /** Source pixel → output pixel for an output square [out] pixels wide. */
    fun output(out: Double): DoubleArray {
        val o = orient()
        val c = crop
        val s = out / c.side
        return doubleArrayOf(s * o[0], s * o[1], s * o[2], s * o[3], s * (o[4] - c.x), s * (o[5] - c.y))
    }

    /** The picture as shown turned a quarter clockwise; the crop turns with it. */
    fun rotate(): VoiciImageEdit =
        copy(cx = displayHeight - cy, cy = cx, turns = if (flipped) (turns + 3) % 4 else (turns + 1) % 4).clamped()

    /** The picture as shown mirrored left to right; the crop mirrors with it. */
    fun flip(): VoiciImageEdit = copy(flipped = !flipped, cx = displayWidth - cx).clamped()

    /** A drag of (dx, dy) on a crop frame [viewSide] wide moves the picture under the crop. */
    fun pan(dx: Double, dy: Double, viewSide: Double): VoiciImageEdit {
        if (viewSide <= 0) return this
        val k = crop.side / viewSide
        return copy(cx = cx - dx * k, cy = cy - dy * k).clamped()
    }

    fun withZoom(z: Double): VoiciImageEdit = copy(zoom = if (z.isFinite()) z else 1.0).clamped()

    private fun clamped(): VoiciImageEdit {
        val dw = displayWidth
        val dh = displayHeight
        val z = zoom.coerceIn(1.0, maxZoom(dw, dh))
        val half = minOf(dw, dh) / z / 2
        return copy(zoom = z, cx = cx.coerceIn(half, dw - half), cy = cy.coerceIn(half, dh - half))
    }

    companion object {
        const val MAX_ZOOM = 8.0
        const val MIN_CROP = 64.0
        fun maxZoom(dw: Double, dh: Double): Double = maxOf(1.0, minOf(MAX_ZOOM, minOf(dw, dh) / MIN_CROP))
        fun of(width: Int, height: Int): VoiciImageEdit = VoiciImageEdit(maxOf(1, width).toDouble(), maxOf(1, height).toDouble())
    }
}
