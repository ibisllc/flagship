import AppKit

/// Draws a determinate progress bar over the app's Dock icon during a
/// burn, so progress is visible even when the window is hidden. Pass nil
/// to clear it and restore the plain icon.
enum DockProgress {
    @MainActor static func set(_ fraction: Double?) {
        let tile = NSApp.dockTile
        guard let fraction else {
            tile.contentView = nil
            tile.display()
            return
        }
        let size: CGFloat = 128
        let container = NSImageView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        container.image = NSApp.applicationIconImage
        container.imageScaling = .scaleProportionallyUpOrDown

        let inset: CGFloat = 14
        let barH: CGFloat = 18
        let trackW = size - inset * 2
        let track = NSView(frame: NSRect(x: inset, y: 16, width: trackW, height: barH))
        track.wantsLayer = true
        // OPAQUE dark track (not the old 40%-black, which let the teal app icon
        // bleed through so a teal fill read teal-on-teal). A near-black track
        // separates the bar from the teal icon and makes empty-vs-filled
        // obvious; a hairline light border crisps its edge against the icon.
        track.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.8).cgColor
        track.layer?.cornerRadius = barH / 2
        track.layer?.borderColor = NSColor.white.withAlphaComponent(0.3).cgColor
        track.layer?.borderWidth = 1

        let f = max(0, min(1, fraction))
        let fill = NSView(frame: NSRect(x: 0, y: 0, width: trackW * f, height: barH))
        fill.wantsLayer = true
        // Brand teal #14B8A6 — now legible on the dark track.
        fill.layer?.backgroundColor = NSColor(srgbRed: 0.078, green: 0.722, blue: 0.651, alpha: 1).cgColor
        fill.layer?.cornerRadius = barH / 2
        track.addSubview(fill)
        container.addSubview(track)

        tile.contentView = container
        tile.display()
    }
}
