import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(CoreImage)
import CoreImage
import CoreImage.CIFilterBuiltins
#endif

/// Phase 3b — screenshot / screen-recording protection for the pairing
/// screens (admin QR + incoming scan). Safeguard #1 from
/// docs/login-and-account-redesign.md: the QR is the doorway to the UMK,
/// so:
///   - blank the protected content while the screen IS being captured
///     (mirrored / recorded / AirPlay) — driven by `UIScreen.isCaptured`;
///   - invalidate the pairing session if the user takes a SCREENSHOT
///     (`UIApplication.userDidTakeScreenshotNotification`).
///
/// The modifier overlays an opaque "hidden for your security" card while
/// captured, and fires `onScreenshot` once when a screenshot is taken so
/// the host view-model can tear down the relay session.
public struct CaptureProtected: ViewModifier {
    let onScreenshot: () -> Void
    @State private var isCaptured: Bool = false

    public init(onScreenshot: @escaping () -> Void) {
        self.onScreenshot = onScreenshot
    }

    public func body(content: Content) -> some View {
        content
            .overlay {
                if isCaptured {
                    captureOverlay
                }
            }
            #if canImport(UIKit)
            .onAppear {
                isCaptured = UIScreen.main.isCaptured
            }
            .onReceive(NotificationCenter.default.publisher(
                for: UIScreen.capturedDidChangeNotification
            )) { _ in
                isCaptured = UIScreen.main.isCaptured
            }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.userDidTakeScreenshotNotification
            )) { _ in
                onScreenshot()
            }
            #endif
    }

    private var captureOverlay: some View {
        ZStack {
            Color.black
            VStack(spacing: 12) {
                Image(systemName: "eye.slash.fill")
                    .font(.system(size: 32))
                    .foregroundColor(.white)
                Text("Hidden while your screen is being recorded or shared.")
                    .font(.system(size: 14, weight: .medium))
                    .multilineTextAlignment(.center)
                    .foregroundColor(.white)
                    .padding(.horizontal, 24)
            }
        }
    }
}

public extension View {
    /// Apply Phase-3b capture protection: blank under screen capture +
    /// invalidate on screenshot. See `CaptureProtected`.
    func captureProtected(onScreenshot: @escaping () -> Void) -> some View {
        modifier(CaptureProtected(onScreenshot: onScreenshot))
    }
}

/// Phase 3b — a REAL QR code rendered from a string via
/// CIQRCodeGenerator (the pairing QR encodes a `/join` universal link,
/// which the incoming phone's native camera must actually scan — a
/// placeholder won't do). Falls back to a plain label if CoreImage is
/// unavailable.
public struct PairingQRView: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var size: CGFloat = 240

    public init(text: String, size: CGFloat = 240) {
        self.text = text
        self.size = size
    }

    public var body: some View {
        Group {
            #if canImport(UIKit) && canImport(CoreImage)
            if let img = Self.qrImage(from: text, scale: size / 30) {
                Image(uiImage: img)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: size, height: size)
            } else {
                fallback
            }
            #else
            fallback
            #endif
        }
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }

    private var fallback: some View {
        Text(text)
            .font(.system(size: 10, design: .monospaced))
            .frame(width: size, height: size)
            .padding(8)
    }

    #if canImport(UIKit) && canImport(CoreImage)
    static func qrImage(from string: String, scale: CGFloat) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: max(scale, 1), y: max(scale, 1)))
        guard let cg = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
    #endif
}
