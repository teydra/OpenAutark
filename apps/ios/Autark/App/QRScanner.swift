// Owns: the full-height camera view of level 2 – AVFoundation's QR detector on the back camera; the camera permission is asked
// only here, when the scanner opens, and a refusal, a missing camera (the simulator) or a foreign QR code say so in words while
// the code field stays one tap away. A code the app accepts ends the scan; any other keeps scanning (the same text is not
// reported twice a second). Never: records, saves or sends a picture.
import SwiftUI
import AVFoundation
import UIKit

struct QRScannerView: UIViewControllerRepresentable {
    /// Gets each QR text; true when it was an Autark pair code (the scan ends).
    let onCode: (String) -> Bool

    func makeUIViewController(context: Context) -> ScannerController { ScannerController(onCode: onCode) }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "autark-scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private let onCode: (String) -> Bool
    private var finished = false
    private var lastText = ""
    private var lastAt = Date.distantPast
    private let note = UILabel()

    init(onCode: @escaping (String) -> Bool) {
        self.onCode = onCode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        note.textColor = .white
        note.textAlignment = .center
        note.numberOfLines = 0
        note.font = .systemFont(ofSize: 16)
        note.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(note)
        NSLayoutConstraint.activate([
            note.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            note.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            note.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: setUp()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async { if granted { self?.setUp() } else { self?.say("The camera is off for Autark. Allow it in Settings, or enter the code instead.") } }
            }
        default: say("The camera is off for Autark. Allow it in Settings, or enter the code instead.")
        }
    }

    private func say(_ text: String) { note.text = text }

    private func setUp() {
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            say("This device has no camera. Enter the code instead.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { say("The camera could not start. Enter the code instead."); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        sessionQueue.async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
    }

    private func stop() { sessionQueue.async { [session] in if session.isRunning { session.stopRunning() } } }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !finished, let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first, let text = code.stringValue else { return }
        if text == lastText && Date().timeIntervalSince(lastAt) < 1.5 { return }
        lastText = text
        lastAt = Date()
        if onCode(text) { finished = true; stop() }
    }
}
