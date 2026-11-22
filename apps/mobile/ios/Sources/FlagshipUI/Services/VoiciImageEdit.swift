import CoreGraphics

/// The photo editor's state for a voi.ci picture: quarter turns clockwise, a horizontal flip applied after the turns,
/// and a square crop (zoom and centre) in the turned picture's pixels. The same rules run in the webapp
/// (`lib/voiciImageEdit.js`) and on Android (`VoiciImageEdit.kt`); `test-vectors/voici-image-edit` pins them.
public struct VoiciImageEdit: Equatable, Sendable {
    public static let maxZoomCap: Double = 8
    /// The crop never gets narrower than this many source pixels (zoom stops there).
    public static let minCropSide: Double = 64

    public let width: Double
    public let height: Double
    public private(set) var turns = 0
    public private(set) var flipped = false
    public private(set) var zoom: Double = 1
    public private(set) var cx: Double
    public private(set) var cy: Double

    public init(width: Double, height: Double) {
        self.width = max(1, width)
        self.height = max(1, height)
        cx = self.width / 2
        cy = self.height / 2
    }

    public var displayWidth: Double { turns % 2 == 0 ? width : height }
    public var displayHeight: Double { turns % 2 == 0 ? height : width }

    public static func maxZoom(_ dw: Double, _ dh: Double) -> Double { max(1, min(maxZoomCap, min(dw, dh) / minCropSide)) }

    /// The crop square in the turned picture: origin and side.
    public var crop: (x: Double, y: Double, side: Double) {
        let side = min(displayWidth, displayHeight) / zoom
        return (cx - side / 2, cy - side / 2, side)
    }

    /// Source pixel → turned (and flipped) pixel, as an affine map.
    public var orientTransform: CGAffineTransform {
        let w = width, h = height
        var t: CGAffineTransform
        switch turns {
        case 1: t = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: h, ty: 0)
        case 2: t = CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: w, ty: h)
        case 3: t = CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: w)
        default: t = .identity
        }
        if flipped { t = CGAffineTransform(a: -t.a, b: t.b, c: -t.c, d: t.d, tx: displayWidth - t.tx, ty: t.ty) }
        return t
    }

    /// Source pixel → output pixel for an output square of `side` pixels.
    public func outputTransform(side out: Double) -> CGAffineTransform {
        let o = orientTransform, c = crop, s = out / c.side
        return CGAffineTransform(a: s * o.a, b: s * o.b, c: s * o.c, d: s * o.d, tx: s * (o.tx - c.x), ty: s * (o.ty - c.y))
    }

    /// Turns the picture as it is shown a quarter clockwise; the crop turns with it.
    public mutating func rotate() {
        let oldH = displayHeight
        (cx, cy) = (oldH - cy, cx)
        turns = flipped ? (turns + 3) % 4 : (turns + 1) % 4
        clamp()
    }

    /// Mirrors the picture as it is shown, left to right; the crop mirrors with it.
    public mutating func flip() {
        flipped.toggle()
        cx = displayWidth - cx
        clamp()
    }

    /// Moves the picture under the crop by a drag of (dx, dy) points on a crop frame `viewSide` points wide.
    public mutating func pan(dx: Double, dy: Double, viewSide: Double) {
        guard viewSide > 0 else { return }
        let k = crop.side / viewSide
        cx -= dx * k
        cy -= dy * k
        clamp()
    }

    public mutating func setZoom(_ z: Double) {
        zoom = z.isFinite ? z : 1
        clamp()
    }

    mutating func clamp() {
        let dw = displayWidth, dh = displayHeight
        zoom = min(max(zoom, 1), Self.maxZoom(dw, dh))
        let half = min(dw, dh) / zoom / 2
        cx = min(max(cx, half), dw - half)
        cy = min(max(cy, half), dh - half)
    }
}
