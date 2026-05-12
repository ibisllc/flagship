import SwiftUI
import AVFoundation

/// SwiftUI wrapper over an AVCaptureSession configured to detect QR
/// codes. Calls `onScan` with the decoded string the first time a
/// metadata object resolves; the consumer is expected to dismiss the
/// view (or `cancel()` the session) after handling the result.
///
/// On the iOS Simulator there is no camera; this view renders a
/// "Camera unavailable in simulator" placeholder so the surrounding
/// pairing flow still navigates correctly.
public struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void

    public init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void = { _ in }) {
        self.onScan = onScan
        self.onError = onError
    }

    public func makeUIViewController(context: Context) -> QRScannerController {
        let vc = QRScannerController()
        vc.onScan = onScan
        vc.onError = onError
        return vc
    }

    public func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

public final class QRScannerController: UIViewController {
    var onScan: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private var session: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

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

        // Reticle overlay
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
    }

    private func showSimulatorPlaceholder() {
        let label = UILabel()
        label.text = "Camera isn't available in the simulator.\nUse the pair code field below."
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
}

extension QRScannerController: AVCaptureMetadataOutputObjectsDelegate {
    public func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmit,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr,
              let payload = obj.stringValue else { return }
        didEmit = true
        AudioServicesPlaySystemSound(SystemSoundID(1057))   // brief tap
        session?.stopRunning()
        onScan?(payload)
    }
}
