import SwiftUI
import AVFoundation
#if canImport(UIKit)
import UIKit
#endif

/// SwiftUI wrapper over an AVCaptureSession configured to detect QR
/// codes. Calls `onScan` with the decoded string the first time a
/// metadata object passes the optional `validate` predicate; if
/// `validate` is supplied and rejects a frame, the scanner plays an
/// error haptic, briefly flashes a red reticle, and keeps scanning.
///
/// On the iOS Simulator there is no camera; this view renders a
/// "Camera unavailable in simulator" placeholder so the surrounding
/// pairing flow still navigates correctly.
public struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void
    let validate: (String) -> Bool

    public init(
        onScan: @escaping (String) -> Void,
        onError: @escaping (String) -> Void = { _ in },
        validate: @escaping (String) -> Bool = { _ in true }
    ) {
        self.onScan = onScan
        self.onError = onError
        self.validate = validate
    }

    public func makeUIViewController(context: Context) -> QRScannerController {
        let vc = QRScannerController()
        vc.onScan = onScan
        vc.onError = onError
        vc.validate = validate
        return vc
    }

    public func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

public final class QRScannerController: UIViewController {
    var onScan: ((String) -> Void)?
    var onError: ((String) -> Void)?
    var validate: ((String) -> Bool)?

    private var session: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var reticle: UIView?
    private var didEmit = false
    /// When a frame fails validation we throttle further "bad QR"
    /// haptics for a short window so the scanner doesn't buzz on
    /// every video frame while the user is still aiming.
    private var rejectionCooldownUntil: Date = .distantPast

    private let successHaptic = UINotificationFeedbackGenerator()
    private let errorHaptic = UINotificationFeedbackGenerator()

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        #if targetEnvironment(simulator)
        showSimulatorPlaceholder()
        #else
        setupCapture()
        #endif
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if let session, !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }
        successHaptic.prepare()
        errorHaptic.prepare()
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session?.stopRunning()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func setupCapture() {
        let session = AVCaptureSession()
        self.session = session
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            onError?("No camera available.")
            return
        }
        session.addInput(input)

        let metadata = AVCaptureMetadataOutput()
        guard session.canAddOutput(metadata) else {
            onError?("Couldn't attach metadata output.")
            return
        }
        session.addOutput(metadata)
        metadata.setMetadataObjectsDelegate(self, queue: .main)
        metadata.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        self.previewLayer = preview

        let reticleSize: CGFloat = 240
        let reticle = UIView(frame: CGRect(
            x: (view.bounds.width - reticleSize) / 2,
            y: (view.bounds.height - reticleSize) / 2,
            width: reticleSize, height: reticleSize
        ))
        reticle.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        reticle.layer.borderWidth = 2
        reticle.layer.cornerRadius = 16
        reticle.backgroundColor = .clear
        reticle.autoresizingMask = [.flexibleTopMargin, .flexibleBottomMargin, .flexibleLeftMargin, .flexibleRightMargin]
        view.addSubview(reticle)
        self.reticle = reticle
    }

    private func showSimulatorPlaceholder() {
        let label = UILabel()
        label.text = "Camera isn't available in the simulator.\nUse the \"copy the QR link instead\" path below."
        label.textColor = .white.withAlphaComponent(0.85)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)
        ])
    }

    fileprivate func handleDetected(_ payload: String) {
        guard !didEmit else { return }
        let accepts = validate?(payload) ?? true
        if accepts {
            didEmit = true
            successHaptic.notificationOccurred(.success)
            AudioServicesPlaySystemSound(SystemSoundID(1057))
            session?.stopRunning()
            onScan?(payload)
        } else {
            // Stay live. Throttle the buzz so a steadily-aimed bad QR
            // doesn't vibrate the device continuously.
            let now = Date()
            guard now >= rejectionCooldownUntil else { return }
            rejectionCooldownUntil = now.addingTimeInterval(1.5)
            errorHaptic.notificationOccurred(.error)
            flashReticleRed()
            onError?("That QR doesn't look like a Flagship invite.")
        }
    }

    private func flashReticleRed() {
        guard let reticle else { return }
        UIView.animate(withDuration: 0.15, animations: {
            reticle.layer.borderColor = UIColor.systemRed.cgColor
        }) { _ in
            UIView.animate(withDuration: 0.4, delay: 0.15, options: []) {
                reticle.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
            }
        }
    }
}

extension QRScannerController: AVCaptureMetadataOutputObjectsDelegate {
    public func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr,
              let payload = obj.stringValue else { return }
        handleDetected(payload)
    }
}
