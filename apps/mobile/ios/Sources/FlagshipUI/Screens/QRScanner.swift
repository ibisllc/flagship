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
    private var wantsCapture = false
    private var isConfigured = false
    private let sessionQueue = DispatchQueue(label: "com.flagshipserver.qr-scanner")
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
        prepareCapture()
        #endif
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        wantsCapture = true
        startCaptureIfReady()
        successHaptic.prepare()
        errorHaptic.prepare()
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        wantsCapture = false
        stopCapture()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func prepareCapture() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureCapture()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.configureCapture()
                    } else {
                        self.showUnavailablePlaceholder("Camera access is off. Enable it in Settings to scan the burner QR.")
                        self.onError?("Camera access is off.")
                    }
                }
            }
        case .denied, .restricted:
            showUnavailablePlaceholder("Camera access is off. Enable it in Settings to scan the burner QR.")
            onError?("Camera access is off.")
        @unknown default:
            showUnavailablePlaceholder("The camera isn't available right now.")
            onError?("No camera available.")
        }
    }

    private func configureCapture() {
        guard !isConfigured else {
            startCaptureIfReady()
            return
        }
        isConfigured = true
        sessionQueue.async { [weak self] in
            self?.buildCaptureSession()
        }
    }

    private func buildCaptureSession() {
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            reportCaptureFailure("No camera available.")
            return
        }
        session.beginConfiguration()
        session.addInput(input)

        let metadata = AVCaptureMetadataOutput()
        guard session.canAddOutput(metadata) else {
            session.commitConfiguration()
            reportCaptureFailure("Couldn't attach metadata output.")
            return
        }
        session.addOutput(metadata)
        metadata.setMetadataObjectsDelegate(self, queue: .main)
        metadata.metadataObjectTypes = [.qr]
        session.commitConfiguration()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.session = session
            self.installPreview(for: session)
            self.startCaptureIfReady()
        }
    }

    private func installPreview(for session: AVCaptureSession) {
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

    private func startCaptureIfReady() {
        guard wantsCapture, let session else { return }
        sessionQueue.async {
            if !session.isRunning { session.startRunning() }
        }
    }

    private func stopCapture() {
        guard let session else { return }
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
    }

    private func reportCaptureFailure(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.showUnavailablePlaceholder(message)
            self.onError?(message)
        }
    }

    private func showSimulatorPlaceholder() {
        showUnavailablePlaceholder("Camera isn't available in the simulator.\nUse the \"copy the QR link instead\" path below.")
    }

    private func showUnavailablePlaceholder(_ message: String) {
        let label = UILabel()
        label.text = message
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
            stopCapture()
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
