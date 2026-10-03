import AppKit

/// A side panel in the mirror window that runs an instruction with UI-TARS
/// on the phone (agents/ui-tars, `--android`) and shows each step. When the
/// run stops short of sending, the held-back action waits for Confirm.
@MainActor
final class AndroidAgentPanel: NSView {
    static let width: CGFloat = 340

    private let serial: String
    private let instruction = NSTextField()
    private let runButton = NSButton()
    private let log = NSTextView()
    private let pendingBox = NSStackView()
    private let pendingLabel = NSTextField(wrappingLabelWithString: "")
    private var run: AndroidAgentRun?
    /// The 2ndscreen command the run held back, such as a tap on Send.
    private var pending: [String]?

    init(serial: String) {
        self.serial = serial
        super.init(frame: NSRect(x: 0, y: 0, width: Self.width, height: 600))
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func stop() {
        run?.stop()
    }

    func focus() {
        window?.makeFirstResponder(instruction)
    }

    // MARK: Layout

    private func build() {
        let title = NSTextField(labelWithString: "UI-TARS")
        title.font = .boldSystemFont(ofSize: 13)
        let hint = NSTextField(wrappingLabelWithString: text(
            "告诉它要在手机上做什么。发送、提交、付款之前它会停下，等你确认。",
            "Tell it what to do on the phone. It stops before sending, submitting or paying, for you to confirm."))
        hint.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        hint.textColor = .secondaryLabelColor

        instruction.placeholderString = text("例如：给文件传输助手写一句早安", "e.g. Open Settings and find the Android version")
        instruction.target = self
        instruction.action = #selector(runPressed)
        instruction.lineBreakMode = .byWordWrapping
        instruction.usesSingleLineMode = false
        instruction.cell?.wraps = true
        instruction.cell?.isScrollable = false
        instruction.heightAnchor.constraint(equalToConstant: 54).isActive = true

        runButton.bezelStyle = .rounded
        runButton.target = self
        runButton.action = #selector(runPressed)
        runButton.keyEquivalent = "\r"
        setRunning(false)

        let confirm = NSButton(title: text("确认发送", "Confirm"), target: self, action: #selector(confirmPressed))
        confirm.bezelStyle = .rounded
        confirm.contentTintColor = .systemGreen
        let discard = NSButton(title: text("放弃", "Discard"), target: self, action: #selector(discardPressed))
        discard.bezelStyle = .rounded
        pendingLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        let buttons = NSStackView(views: [confirm, discard])
        pendingBox.orientation = .vertical
        pendingBox.alignment = .leading
        pendingBox.addArrangedSubview(pendingLabel)
        pendingBox.addArrangedSubview(buttons)
        pendingBox.isHidden = true

        log.isEditable = false
        log.isRichText = false
        log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        log.textContainerInset = NSSize(width: 4, height: 4)
        log.autoresizingMask = [.width]
        let scroll = NSScrollView()
        scroll.documentView = log
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [title, hint, instruction, runButton, pendingBox, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            instruction.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
            pendingLabel.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
        ])
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    }

    private func setRunning(_ running: Bool) {
        runButton.title = running ? text("停止", "Stop") : text("运行", "Run")
        instruction.isEnabled = !running
    }

    private func append(_ line: String, color: NSColor = .labelColor) {
        let attributes: [NSAttributedString.Key: Any] = [.font: log.font as Any, .foregroundColor: color]
        log.textStorage?.append(NSAttributedString(string: line + "\n", attributes: attributes))
        log.scrollToEndOfDocument(nil)
    }

    // MARK: Actions

    @objc private func runPressed() {
        if let run {
            run.stop()
            return
        }
        let task = instruction.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return }
        hidePending()
        log.string = ""
        append("▶ \(task)", color: .systemBlue)
        do {
            let run = try AndroidAgentRun(serial: serial, instruction: task)
            run.onLine = { [weak self] line in self?.show(line) }
            run.onFinish = { [weak self] result in self?.finished(result) }
            try run.start()
            self.run = run
            setRunning(true)
        } catch {
            append(error.localizedDescription, color: .systemRed)
        }
    }

    /// The runner's progress lines: thoughts (·), actions (→), commands ($),
    /// errors (!) and the stop reason.
    private func show(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        // The SDK logs its errors with stack traces; the "error:" line that
        // follows says the same in one line.
        guard !trimmed.isEmpty, !trimmed.hasPrefix("at "), !trimmed.hasPrefix("[GUIAgent]") else { return }
        if trimmed.hasPrefix("·") {
            append(trimmed, color: .labelColor)
        } else if trimmed.hasPrefix("!") || trimmed.hasPrefix("error") {
            append(trimmed, color: .systemRed)
        } else {
            append("  " + trimmed, color: .secondaryLabelColor)
        }
    }

    private func finished(_ result: AndroidAgentRun.Result) {
        run = nil
        setRunning(false)
        let color: NSColor = result.ok ? .systemGreen : .systemOrange
        append("■ \(result.reason)", color: color)
        if let pending = result.pending {
            self.pending = pending
            pendingLabel.stringValue = text("它停在了发送之前。确认后由它执行：", "It stopped before sending. Confirm to run:")
                + "\n" + pending.prefix(while: { $0 != "--serial" }).joined(separator: " ")
            pendingBox.isHidden = false
        }
    }

    @objc private func confirmPressed() {
        guard let pending else { return }
        hidePending()
        append("✓ " + text("已确认，执行中…", "Confirmed, running…"), color: .systemGreen)
        Task { [weak self] in
            let result = await Task.detached { AndroidAgentRun.runCommand(pending) }.value
            self?.append(result ?? text("已执行", "Done"), color: result == nil ? .systemGreen : .systemRed)
        }
    }

    @objc private func discardPressed() {
        hidePending()
        append(text("已放弃，没有发送。", "Discarded; nothing was sent."), color: .secondaryLabelColor)
    }

    private func hidePending() {
        pending = nil
        pendingBox.isHidden = true
    }
}

/// One UI-TARS run on a phone: `node --import tsx src/cli.ts --android`,
/// started through a login shell for the user's PATH and with the model's
/// key from ~/.config/2ndscreen/ark.env.
final class AndroidAgentRun: @unchecked Sendable {
    struct Result {
        var ok: Bool
        var reason: String
        var pending: [String]?
    }

    enum Failure: LocalizedError {
        case notFound

        var errorDescription: String? {
            text("找不到 agents/ui-tars。请从仓库的 build/2ndscreen.app 运行，并在 agents/ui-tars 里执行 npm install。",
                 "agents/ui-tars was not found. Run build/2ndscreen.app from the repository, and npm install in agents/ui-tars.")
        }
    }

    /// Called on the main queue.
    var onLine: ((String) -> Void)?
    var onFinish: ((Result) -> Void)?

    private let process = Process()
    private var stdout = Data()
    private var stderrBuffer = Data()
    private let lock = NSLock()

    init(serial: String, instruction: String) throws {
        guard let repository = Self.repository() else { throw Failure.notFound }
        let agents = repository.appendingPathComponent("agents/ui-tars")
        let script = """
            [ -f "$HOME/.config/2ndscreen/ark.env" ] && set -a && . "$HOME/.config/2ndscreen/ark.env" && set +a
            cd "$1" && shift && exec node --import tsx src/cli.ts "$@"
            """
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", script, "zsh", agents.path, "--android", "--serial", serial, instruction]
        var environment = ProcessInfo.processInfo.environment
        environment["SECONDSCREEN_CLI"] = repository.appendingPathComponent(".build/release/2ndscreen").path
        process.environment = environment
    }

    func start() throws {
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.lock.withLock { self?.stdout.append(data) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.lines(from: data)
        }
        process.terminationHandler = { [weak self] process in
            // Let the pipes drain before reading the result.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { self?.finish(process) }
        }
        try process.run()
    }

    func stop() {
        if process.isRunning { process.terminate() }
    }

    private func lines(from data: Data) {
        let complete: [String] = lock.withLock {
            stderrBuffer.append(data)
            var lines: [String] = []
            while let newline = stderrBuffer.firstIndex(of: 0x0A) {
                lines.append(String(decoding: stderrBuffer[stderrBuffer.startIndex..<newline], as: UTF8.self))
                stderrBuffer.removeSubrange(stderrBuffer.startIndex...newline)
            }
            return lines
        }
        guard !complete.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in complete.forEach { self?.onLine?($0) } }
    }

    private func finish(_ process: Process) {
        let output = lock.withLock { String(decoding: stdout, as: UTF8.self) }
        var result = Result(ok: false, reason: process.terminationReason == .uncaughtSignal
            ? text("已停止", "Stopped") : text("运行失败", "The run failed"))
        if let line = output.split(separator: "\n").last(where: { $0.hasPrefix("{") }),
           let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
            result.ok = json["ok"] as? Bool ?? false
            result.reason = json["reason"] as? String ?? result.reason
            result.pending = json["pending"] as? [String]
        }
        DispatchQueue.main.async { [weak self] in
            self?.onFinish?(result)
            self?.onFinish = nil
        }
    }

    /// Run a held-back 2ndscreen command; returns an error message, or nil.
    static func runCommand(_ words: [String]) -> String? {
        guard let repository = repository() else { return Failure.notFound.localizedDescription }
        let process = Process()
        process.executableURL = repository.appendingPathComponent(".build/release/2ndscreen")
        process.arguments = words
        let out = Pipe()
        process.standardOutput = out
        process.standardError = out
        do {
            try process.run()
        } catch {
            return error.localizedDescription
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus != 0 else { return nil }
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["error"] as? String ?? String(decoding: data, as: UTF8.self)
    }

    /// The repository this app was built from: build/2ndscreen.app sits in
    /// it. `defaults write io.github.szrunworld.2ndscreen repository PATH`
    /// points elsewhere.
    static func repository() -> URL? {
        var candidates: [URL] = []
        if let path = UserDefaults.standard.string(forKey: "repository") {
            candidates.append(URL(fileURLWithPath: path))
        }
        candidates.append(Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent())
        return candidates.first {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("agents/ui-tars/src/cli.ts").path)
        }
    }
}

/// Chinese on a Chinese Mac, English otherwise.
func text(_ chinese: String, _ english: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? chinese : english
}
