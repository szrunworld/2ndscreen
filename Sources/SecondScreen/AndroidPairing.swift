import AppKit
import CoreImage.CIFilterBuiltins
import SecondScreenCore

/// Pairs a phone over Wi-Fi with Android's wireless debugging, the way
/// Android Studio does: the phone scans a QR code naming a service and a
/// password, advertises that service over mDNS, and adb pairs with it. A
/// pairing code typed by hand works too, and so does connecting to a phone
/// paired before.
@MainActor
final class AndroidPairingWindow: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let serviceName = "2ndscreen-" + randomString(6)
    private let password = randomString(10)
    private let status = NSTextField(wrappingLabelWithString: "")
    private let addressField = NSTextField()
    private let codeField = NSTextField()
    private var polling: Task<Void, Never>?
    private var busy = false

    /// Called with the device's serial once it is connected.
    var onConnected: ((String) -> Void)?
    var onClose: (() -> Void)?

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Connect Android Phone"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = makeContent()
        window.contentView = content
        window.setContentSize(content.fittingSize)
        setStatus("Waiting for the phone to scan the code…")
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        startPolling()
    }

    func close() {
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        polling?.cancel()
        onClose?()
        onClose = nil
    }

    // MARK: Layout

    private func makeContent() -> NSView {
        let qr = NSImageView(image: Self.qrCode("WIFI:T:ADB;S:\(serviceName);P:\(password);;", size: 200))
        qr.translatesAutoresizingMaskIntoConstraints = false
        qr.widthAnchor.constraint(equalToConstant: 200).isActive = true
        qr.heightAnchor.constraint(equalToConstant: 200).isActive = true

        let title = NSTextField(labelWithString: "Scan with your phone")
        title.font = .boldSystemFont(ofSize: 15)
        let steps = NSTextField(wrappingLabelWithString: """
            1. Put the phone on the same Wi‑Fi as this Mac.
            2. Open Settings → Developer options → Wireless debugging, and turn it on.
            3. Tap "Pair device with QR code" and scan this code.

            No app is installed on the phone. To show Developer options, tap \
            "Build number" in About phone seven times.
            """)
        steps.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        let instructions = NSStackView(views: [title, steps, status])
        instructions.orientation = .vertical
        instructions.alignment = .leading
        instructions.spacing = 10
        let top = NSStackView(views: [qr, instructions])
        top.alignment = .top
        top.spacing = 20

        addressField.placeholderString = "192.168.1.20:37000"
        codeField.placeholderString = "Pairing code (first time only)"
        let manualTitle = NSTextField(labelWithString: "Or enter the address shown under Wireless debugging:")
        manualTitle.textColor = .secondaryLabelColor
        let connect = NSButton(title: "Connect", target: self, action: #selector(connectManually))
        connect.keyEquivalent = "\r"
        let manualRow = NSStackView(views: [addressField, codeField, connect])
        manualRow.distribution = .fill
        addressField.widthAnchor.constraint(equalToConstant: 180).isActive = true
        codeField.widthAnchor.constraint(equalToConstant: 200).isActive = true
        let hint = NSTextField(wrappingLabelWithString:
            "For a pairing code, tap \"Pair device with pairing code\" and enter the address and code it shows.")
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: NSFont.smallSystemFontSize)

        let content = NSStackView(views: [top, NSBox.separator(), manualTitle, manualRow, hint])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        instructions.widthAnchor.constraint(equalToConstant: 300).isActive = true
        return content
    }

    private func setStatus(_ text: String, error: Bool = false) {
        status.stringValue = text
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }

    // MARK: Pairing

    /// Watch for the phone advertising our pairing service after it scans the code.
    private func startPolling() {
        polling?.cancel()
        let name = serviceName, password = password
        polling = Task { [weak self] in
            while !Task.isCancelled {
                let busy = self?.busy ?? true
                if !busy, let service = await Self.background({
                    try? ADB.services().first { $0.name == name && $0.type.contains("pairing") }
                }) ?? nil {
                    await self?.pair(address: service.address, code: password)
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    @objc private func connectManually() {
        let address = addressField.stringValue.trimmingCharacters(in: .whitespaces)
        let code = codeField.stringValue.trimmingCharacters(in: .whitespaces)
        guard address.contains(":") else {
            setStatus("Enter the address with its port, such as 192.168.1.20:37000.", error: true)
            return
        }
        Task {
            if code.isEmpty {
                await connect(address: address)
            } else {
                await pair(address: address, code: code)
            }
        }
    }

    private func pair(address: String, code: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        setStatus("Pairing with \(address)…")
        let before = await Self.background { (try? ADB.devices()) ?? [] }
        let result = await Self.attempt { try ADB.pair(address: address, code: code) }
        guard case .success(let paired) = result, paired.ok else {
            setStatus("Pairing failed: \(Self.message(result))", error: true)
            return
        }
        setStatus("Paired. Connecting…")
        // adb connects by itself to paired phones it sees over mDNS; if it
        // has not after a few seconds, connect to the phone's service directly.
        let host = String(address.split(separator: ":").first ?? "")
        let serial = await Self.background { () -> String? in
            for attempt in 0..<20 {
                let devices = (try? ADB.devices()) ?? []
                if let new = devices.first(where: { device in
                    device.state == "device" && !before.contains { $0.serial == device.serial }
                }) {
                    return new.serial
                }
                if attempt == 6,
                   let service = (try? ADB.services())?.first(where: {
                       $0.type.contains("connect") && $0.address.hasPrefix(host + ":")
                   }) {
                    _ = try? ADB.connect(address: service.address)
                }
                Thread.sleep(forTimeInterval: 0.5)
            }
            return nil
        }
        guard let serial else {
            setStatus("""
                Paired, but the phone did not connect. Enter the address shown under \
                Wireless debugging (not the pairing one) and press Connect.
                """, error: true)
            return
        }
        connected(serial)
    }

    private func connect(address: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        setStatus("Connecting to \(address)…")
        let result = await Self.attempt { try ADB.connect(address: address) }
        guard case .success(let connection) = result, connection.ok else {
            setStatus("Could not connect: \(Self.message(result)). If this phone was never paired, enter its pairing code too.",
                      error: true)
            return
        }
        connected(address)
    }

    private func connected(_ serial: String) {
        polling?.cancel()
        setStatus("Connected.")
        onConnected?(serial)
        window.close()
    }

    // MARK: Helpers

    private static func message(_ result: Result<ADB.Result, Error>) -> String {
        switch result {
        case .success(let output): return output.message.isEmpty ? "unknown error" : output.message
        case .failure(let error): return error.localizedDescription
        }
    }

    /// Run blocking adb work off the main actor, catching its error.
    private static func attempt<T>(_ work: @escaping () throws -> T) async -> Result<T, Error> {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: Result { try work() })
            }
        }
    }

    /// Run blocking adb work off the main actor.
    private static func background<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: work()) }
        }
    }

    private static func randomString(_ length: Int) -> String {
        let characters = Array("abcdefghijkmnpqrstuvwxyz23456789")
        return String((0..<length).map { _ in characters.randomElement()! })
    }

    private static func qrCode(_ text: String, size: CGFloat) -> NSImage {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return NSImage() }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: size / output.extent.width * 2,
                                                              y: size / output.extent.height * 2))
        let representation = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: NSSize(width: size, height: size))
        image.addRepresentation(representation)
        return image
    }
}

private extension NSBox {
    static func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        return box
    }
}
