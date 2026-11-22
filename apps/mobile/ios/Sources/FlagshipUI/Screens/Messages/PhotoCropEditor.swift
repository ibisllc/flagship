import SwiftUI
import UIKit
import AVFoundation
import UniformTypeIdentifiers
import FlagshipCore

/// The photo editor before a picture becomes the page photo (docs/social-tab.md): the square the page will show, the
/// picture moved under it with a drag and zoomed with a pinch, Rotate (a quarter clockwise) and Flip (left to right),
/// then Use or Cancel. What is drawn here is the same map the encoder applies (`VoiciImageEdit.outputTransform`).
struct PhotoCropEditor: View {
    let image: CGImage
    let onUse: (VoiciImageEdit) -> Void
    let onCancel: () -> Void

    @State private var edit: VoiciImageEdit
    @State private var dragged: CGSize = .zero
    @State private var pinchStart: Double?

    init(image: CGImage, onUse: @escaping (VoiciImageEdit) -> Void, onCancel: @escaping () -> Void) {
        self.image = image
        self.onUse = onUse
        self.onCancel = onCancel
        _edit = State(initialValue: VoiciImageEdit(width: Double(image.width), height: Double(image.height)))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                GeometryReader { geo in
                    let side = min(geo.size.width, geo.size.height)
                    crop(side: side)
                        .frame(width: side, height: side)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                HStack(spacing: 32) {
                    Button { withAnimation(.snappy) { edit.rotate() } } label: {
                        Label("Rotate", systemImage: "rotate.right")
                    }
                    .accessibilityIdentifier("photo-edit-rotate")
                    Button { withAnimation(.snappy) { edit.flip() } } label: {
                        Label("Flip", systemImage: "arrow.left.and.right.righttriangle.left.righttriangle.right")
                    }
                    .accessibilityIdentifier("photo-edit-flip")
                }
                .labelStyle(.titleAndIcon)
                .buttonStyle(.bordered)
                Text("Drag to move the photo, pinch to zoom.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .navigationTitle(Text("Edit photo"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).accessibilityIdentifier("photo-edit-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") { onUse(edit) }.accessibilityIdentifier("photo-edit-use")
                }
            }
        }
        .accessibilityIdentifier("photo-editor")
    }

    private func crop(side: CGFloat) -> some View {
        Canvas { ctx, size in
            ctx.concatenate(edit.outputTransform(side: Double(size.width)))
            ctx.draw(Image(decorative: image, scale: 1), in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        .background(Color.white)
        .overlay {
            // The page shows the photo in a circle: dim what falls outside it.
            Rectangle().fill(.black.opacity(0.45))
                .mask { Rectangle().overlay(Circle().blendMode(.destinationOut)).compositingGroup() }
                .allowsHitTesting(false)
            Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1.5).allowsHitTesting(false)
        }
        .clipShape(Rectangle())
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { v in
                    edit.pan(dx: Double(v.translation.width - dragged.width), dy: Double(v.translation.height - dragged.height), viewSide: Double(side))
                    dragged = v.translation
                }
                .onEnded { _ in dragged = .zero }
                .simultaneously(with: MagnifyGesture()
                    .onChanged { v in
                        let start = pinchStart ?? edit.zoom
                        pinchStart = start
                        edit.setZoom(start * Double(v.magnification))
                    }
                    .onEnded { _ in pinchStart = nil })
        )
        .accessibilityElement()
        .accessibilityLabel(Text("Photo crop"))
        .accessibilityValue(Text(verbatim: edit.zoom.formatted(.percent.precision(.fractionLength(0)))))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: edit.setZoom(edit.zoom * 1.25)
            case .decrement: edit.setZoom(edit.zoom / 1.25)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("photo-edit-crop")
    }
}

/// Where a new photo comes from.
enum PhotoSource: Identifiable {
    case camera, library, files
    var id: Self { self }

    static var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    /// False when the person has turned the camera off for Flagship (the system asks the first time).
    static var cameraAllowed: Bool { AVCaptureDevice.authorizationStatus(for: .video) != .denied && AVCaptureDevice.authorizationStatus(for: .video) != .restricted }
}

/// The system camera, returning one still (no editing: the crop editor comes next).
struct CameraCapture: UIViewControllerRepresentable {
    let onPicked: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.cameraCaptureMode = .photo
        c.allowsEditing = false
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPicked: (UIImage?) -> Void
        init(onPicked: @escaping (UIImage?) -> Void) { self.onPicked = onPicked }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onPicked(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onPicked(nil) }
    }
}
