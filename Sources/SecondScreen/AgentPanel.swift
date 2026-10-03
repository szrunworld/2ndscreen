import AppKit
import SecondScreenCore
import TarsAgent

/// A side panel that runs an instruction with UI-TARS, in this app, on the
/// screen beside it, and shows each step. When the run stops short of
/// sending, the held-back action waits for Confirm. Any `AgentScreen`
/// will do: a phone's mirror window has one for the phone.
@MainActor
final class AgentPanel: NSView {
    static let width: CGFloat = 340

    private let makeScreen: () -> AgentScreen
    private let options: TarsAgent.Options
    private let example: String
    private let instruction = NSTextField()
    private let runButton = NSButton()
    private let log = NSTextView()
    private let pendingBox = NSStackView()
    private let pendingLabel = NSTextField(wrappingLabelWithString: "")
    private var run: AgentRun?
    /// What the run held back, such as a tap on Send, and where.
    private var pending: (action: InputAction, screen: AgentScreen)?

    init(options: TarsAgent.Options, example: String, makeScreen: @escaping () -> AgentScreen) {
        self.makeScreen = makeScreen
        self.options = options
        self.example = example
        super.init(frame: NSRect(x: 0, y: 0, width: Self.width, height: 600))
        build()
    }

    /// For an Android phone, by its adb serial.
    static func android(serial: String) -> AgentPanel {
        var options = TarsAgent.Options()
        options.forPhone()
        return AgentPanel(options: options, example: text("例如：给文件传输助手写一句早安",
                                                          "e.g. Open Settings and find the Android version")) {
            AndroidAgentScreen(serial: serial)
        }
    }

    /// For an iPhone through iPhone Mirroring on the agent screen `screen`.
    static func iPhone(screen: String) -> AgentPanel {
        var options = TarsAgent.Options()
        options.forIPhone()
        return AgentPanel(options: options, example: text("例如：打开微信，给文件传输助手写一句早安",
                                                          "e.g. Open WeChat and write good morning to File Transfer")) {
            IPhoneAgentScreen(screen: screen)
        }
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

        instruction.placeholderString = example
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
            append(text("正在停止，等这一步做完…", "Stopping after this step…"), color: .secondaryLabelColor)
            return
        }
        let task = instruction.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return }
        hidePending()
        log.string = ""
        append("▶ \(task)", color: .systemBlue)
        let run = AgentRun(screen: makeScreen(), options: options, instruction: task)
        run.onLine = { [weak self] line in line.split(separator: "\n").forEach { self?.show(String($0)) } }
        run.onFinish = { [weak self, screen = run.screen] result in self?.finished(result, on: screen) }
        run.start()
        self.run = run
        setRunning(true)
    }

    /// The runner's progress lines: thoughts (·), actions (→), commands ($),
    /// errors (!) and the stop reason.
    private func show(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if trimmed.hasPrefix("·") {
            append(trimmed, color: .labelColor)
        } else if trimmed.hasPrefix("!") || trimmed.hasPrefix("error") {
            append(trimmed, color: .systemRed)
        } else {
            append("  " + trimmed, color: .secondaryLabelColor)
        }
    }

    private func finished(_ result: AgentRun.Result, on screen: AgentScreen) {
        run = nil
        setRunning(false)
        let color: NSColor = result.ok ? .systemGreen : .systemOrange
        append("■ \(result.reason)", color: color)
        if let held = result.held {
            pending = (held, screen)
            pendingLabel.stringValue = text("它停在了发送之前。确认后由它执行：", "It stopped before sending. Confirm to run:")
                + "\n" + TarsAgent.describe(held)
            pendingBox.isHidden = false
        }
    }

    @objc private func confirmPressed() {
        guard let pending else { return }
        hidePending()
        append("✓ " + text("已确认，执行中…", "Confirmed, running…"), color: .systemGreen)
        let (action, screen) = pending
        Task { [weak self] in
            let result = await Task.detached { AgentRun.perform(action, on: screen) }.value
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

/// One UI-TARS run, in this app: the agent works on its screen on a thread
/// of its own and reports each step on the main queue. It reads the
/// model's key from ~/.config/2ndscreen/model.env or ark.env.
final class AgentRun: @unchecked Sendable {
    struct Result {
        var ok: Bool
        var reason: String
        /// What it stopped before because it would send.
        var held: InputAction?
    }

    /// Called on the main queue.
    var onLine: ((String) -> Void)?
    var onFinish: ((Result) -> Void)?

    let screen: AgentScreen
    private let options: TarsAgent.Options
    private let instruction: String
    private let lock = NSLock()
    private var cancelled = false

    init(screen: AgentScreen, options: TarsAgent.Options, instruction: String) {
        self.screen = screen
        self.options = options
        self.instruction = instruction
    }

    func start() {
        Thread.detachNewThread { [self] in
            let result: Result
            do {
                var options = options
                options.isCancelled = { [weak self] in self?.lock.withLock { self?.cancelled ?? true } ?? true }
                let model = ChatCompletionsModel(try ModelConfig.fromEnvironment())
                let agent = TarsAgent(screen: screen, model: model, options: options) { [weak self] event in
                    let line = TarsAgent.describe(event)
                    DispatchQueue.main.async { self?.onLine?(line) }
                }
                let ended = agent.run(instruction)
                result = Result(ok: ended.outcome == .done, reason: ended.reason, held: ended.held)
            } catch {
                result = Result(ok: false, reason: error.localizedDescription)
            }
            DispatchQueue.main.async { [weak self] in
                self?.onFinish?(result)
                self?.onFinish = nil
            }
        }
    }

    /// Ends the run once the step under way is done.
    func stop() {
        lock.withLock { cancelled = true }
    }

    /// Run a held-back action; returns an error message, or nil.
    static func perform(_ action: InputAction, on screen: AgentScreen) -> String? {
        do {
            let response = try screen.perform(action)
            return response.ok ? nil : response.error ?? "failed"
        } catch {
            return error.localizedDescription
        }
    }
}

/// Chinese on a Chinese Mac, English otherwise.
func text(_ chinese: String, _ english: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? chinese : english
}
