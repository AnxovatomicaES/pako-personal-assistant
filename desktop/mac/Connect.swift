// The Connect Claude window: one sheet on the app's window, one main button. It shows a ConnectStep (Claude.swift) in the app's words
// (Texts); what the buttons do is the app's (App.swift).

import AppKit

@MainActor
final class ConnectWindow: NSObject {
    let panel: NSPanel
    private let titleLabel = NSTextField(labelWithString: "")
    private let leadLabel = NSTextField(wrappingLabelWithString: "")
    private let textLabel = NSTextField(wrappingLabelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let warnLabel = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    /// The code Claude's sign-in page shows, pasted here: sent as typed (trimmed by cleanLoginCode), then cleared; never logged nor saved.
    private let codeField = NSTextField(string: "")
    private let primary = NSButton(title: "", target: nil, action: nil)
    private let secondary = NSButton(title: "", target: nil, action: nil)
    private let openAgain = NSButton(title: "", target: nil, action: nil)
    private let connections = NSButton(title: "", target: nil, action: nil)
    private let useKey = NSButton(title: "", target: nil, action: nil)
    /// "Try the demo week" (src/demo.ts): on the first run, beside Connect, for someone who wants to see Pako before signing in.
    private let demo = NSButton(title: "", target: nil, action: nil)
    /// Whether the demo is offered (the app's first run, before Claude was ever connected).
    var offerDemo = false
    var onDemo: () -> Void = {}
    /// The raw output behind a failure, shown only on request: the window speaks in the person's words first (Texts.connectFailure).
    private let detailsToggle = NSButton(title: "", target: nil, action: nil)
    private var detailsOpen = false
    /// A code was sent and its answer is awaited: the field and Continue wait, and the window says it is checking.
    private var codeSent = false
    private var lastError = ""
    private var lastSent = 0
    private var lastAnnounced = ""
    var onPrimary: () -> Void = {}
    var onSecondary: () -> Void = {}
    var onOpenAgain: () -> Void = {}
    var onCode: (String) -> Void = { _ in }
    var onConnections: () -> Void = {}

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 460, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        titleLabel.font = .boldSystemFont(ofSize: 15)
        leadLabel.textColor = .secondaryLabelColor
        detailLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.isSelectable = true
        warnLabel.textColor = .systemOrange
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        for (b, sel) in [(primary, #selector(primaryPressed)), (secondary, #selector(secondaryPressed)), (openAgain, #selector(openAgainPressed)),
                         (connections, #selector(connectionsPressed)), (useKey, #selector(connectionsPressed)), (detailsToggle, #selector(detailsPressed)),
                         (demo, #selector(demoPressed))] {
            b.target = self
            b.action = sel
            b.bezelStyle = .rounded
        }
        primary.keyEquivalent = "\r"
        codeField.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        codeField.isEditable = true
        codeField.isSelectable = true
        codeField.usesSingleLineMode = true
        codeField.cell?.sendsActionOnEndEditing = false
        codeField.cell?.wraps = false
        codeField.cell?.isScrollable = true
        // Not the system's autofill, spelling or text completion: it is a one-time code, kept nowhere but in the field.
        codeField.isAutomaticTextCompletionEnabled = false
        codeField.contentType = .oneTimeCode
        codeField.target = self
        codeField.action = #selector(primaryPressed)
        secondary.keyEquivalent = "\u{1b}"
        useKey.isBordered = false
        useKey.contentTintColor = .linkColor
        openAgain.isBordered = false
        openAgain.contentTintColor = .linkColor
        detailsToggle.bezelStyle = .disclosure
        detailsToggle.setButtonType(.pushOnPushOff)
        detailsToggle.imagePosition = .imageLeading
        let head = NSStackView(views: [spinner, titleLabel])
        head.spacing = 8
        let buttons = NSStackView(views: [useKey, NSView(), demo, secondary, primary])
        buttons.distribution = .fill
        let stack = NSStackView(views: [head, leadLabel, textLabel, codeField, detailsToggle, detailLabel, openAgain, warnLabel, connections, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 18, right: 22)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: 460),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -44),
            codeField.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -44),
        ])
        for l in [leadLabel, textLabel, detailLabel, warnLabel] { l.preferredMaxLayoutWidth = 416 }
        panel.contentView = content
    }

    /// Shows `step`; `keySource` is where an API key that wins over the plan is set (nil: none); `note`, a word on whose `claude` it is;
    /// `account`, who is signed in (the Connected line says "ana@example.com · Pro plan").
    func show(_ step: ConnectStep, keySource: String?, texts t: Texts, note: String? = nil, account: ClaudeAuthStatus? = nil) {
        var (title, text) = t.step(step)
        let connectedNow: Bool
        switch step {
        case .connected, .idle(.plan): connectedNow = true
        default: connectedNow = false
        }
        if connectedNow {
            let line = claudeAccountLine(account, planWord: t.planWord)
            if !line.isEmpty { text = line }
        }
        var needsPlan = false
        if case .idle(.needsPlan) = step { needsPlan = true }
        leadLabel.stringValue = t.connectLead
        // The promise under the button, only while there is a button to press: not once connected, nor on the plan check.
        switch step {
        case .idle(.notInstalled), .idle(.notSignedIn), .idle(.unknown), .checking: leadLabel.isHidden = false
        default: leadLabel.isHidden = true
        }
        textLabel.stringValue = text
        textLabel.isHidden = text.isEmpty
        var detail = ""
        var busy = false
        var page: URL?
        switch step {
        case .checking, .downloading: busy = true
        case let .installing(last, _): busy = true; detail = last
        case let .signingIn(p, _, error, _): busy = true; page = p; detail = error
        case let .installFailed(tail), let .signInFailed(tail): detail = tail
        default: break
        }
        // A failure in plain words, with what to do; what the program said stays behind Details.
        var failure: ConnectFailure?
        switch step {
        case let .installFailed(tail), let .signInFailed(tail):
            failure = connectFailure(tail)
            text = t.connectFailure(failure!)
            if failure == .notAnthropic { detail = "" }
        default: break
        }
        // The code sent: checking until the sign-in answers (signed in: another step; refused: an error line about a code sent since, even
        // the same words as the last refusal).
        if case let .signingIn(_, code, error, sent) = step, code {
            if !error.isEmpty && (error != lastError || sent != lastSent) { codeSent = false }
            lastError = error
            lastSent = sent
            // The sign-in still waits for a code: the same field takes the whole code again (there is no Try again here).
            if !error.isEmpty, connectFailure(error) == .invalidCode { detail = t.codeRefused }
            if codeSent { title = t.checkingCode; detail = "" }
        } else {
            codeSent = false
            lastError = ""
            lastSent = 0
        }
        titleLabel.stringValue = title
        textLabel.stringValue = text
        textLabel.isHidden = text.isEmpty
        let behindToggle = failure != nil && !detail.isEmpty
        detailsToggle.title = t.details
        detailsToggle.isHidden = !behindToggle
        detailsToggle.state = detailsOpen ? .on : .off
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty || (behindToggle && !detailsOpen)
        if failure == nil { detailsOpen = false }
        spinner.isHidden = !busy
        busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        spinner.setAccessibilityLabel(title)
        // The same link button: the sign-in page again while signing in, the upgrade page for a free plan.
        openAgain.title = needsPlan ? t.upgrade : t.openAgain
        openAgain.isHidden = page == nil && !needsPlan
        let warning = [keySource.map(t.keyWarning), note].compactMap { $0 }.joined(separator: "\n")
        warnLabel.stringValue = warning
        warnLabel.isHidden = warning.isEmpty
        connections.title = t.openConnections
        connections.isHidden = keySource == nil
        useKey.title = t.useKey
        useKey.isHidden = keySource != nil
        // The demo week next to Connect, while there is something to connect: not once connected, nor while it works.
        demo.title = t.tryDemo
        switch step {
        case .idle(.notInstalled), .idle(.notSignedIn), .idle(.unknown): demo.isHidden = !offerDemo
        default: demo.isHidden = true
        }
        var asksCode = false
        if case let .signingIn(_, code, _, _) = step { asksCode = code }
        codeField.placeholderString = t.codePlaceholder
        codeField.setAccessibilityLabel(t.codeFieldLabel)
        codeField.isEnabled = !codeSent
        let newlyAsked = asksCode && codeField.isHidden
        codeField.isHidden = !asksCode
        if !asksCode { codeField.stringValue = "" }
        // The main button: what comes next. While it works, only Cancel (and Continue, for the code).
        switch step {
        case let .signingIn(_, code, _, _) where code:
            primary.isHidden = false; primary.title = t.continueCode; primary.isEnabled = !codeSent
        case .checking, .downloading, .installing, .signingIn:
            primary.isHidden = true
        case .installFailed, .signInFailed:
            primary.isHidden = false; primary.title = failure == .oldVersion ? t.updateClaude : t.retry
        case .connected:
            primary.isHidden = false; primary.title = t.done
        case let .idle(state):
            primary.isHidden = false
            primary.title = state.ready ? t.done : state == .unknown || state == .needsPlan ? t.checkAgain : t.connect
        }
        if case .signingIn(_, true, _, _) = step {} else { primary.isEnabled = true }
        secondary.title = busy ? t.cancel : t.close
        secondary.isHidden = !busy && primary.title == t.done
        panel.contentView?.layoutSubtreeIfNeeded()
        if newlyAsked { panel.makeFirstResponder(codeField) }
        if let size = panel.contentView?.fittingSize { panel.setContentSize(size) }
        // VoiceOver hears each new step ("Installing…", "Paste the code", "Connected"), not only what the focus is on.
        let say = text.isEmpty ? title : "\(title). \(text)"
        if say != lastAnnounced {
            lastAnnounced = say
            NSAccessibility.post(element: panel, notification: .announcementRequested,
                                 userInfo: [.announcement: say, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
        lastTexts = t
        lastStep = step
        lastKey = keySource
        lastNote = note
        lastAccount = account
    }
    private var lastAccount: ClaudeAuthStatus?
    private var lastTexts: Texts?
    private var lastStep: ConnectStep = .checking
    private var lastKey: String?
    private var lastNote: String?

    /// The window's content as a PNG (PAKO_APP_REPORT only).
    func snapshotPNG() -> Data? { panel.contentView.flatMap(viewSnapshotPNG) }

    @objc private func primaryPressed() {
        guard !codeField.isHidden else { return onPrimary() }
        guard !codeSent, cleanLoginCode(codeField.stringValue) != nil else { return }
        let pasted = codeField.stringValue
        codeField.stringValue = ""
        codeSent = true
        if let t = lastTexts { show(lastStep, keySource: lastKey, texts: t, note: lastNote, account: lastAccount) }
        onCode(pasted)
    }
    @objc private func detailsPressed() {
        detailsOpen.toggle()
        if let t = lastTexts { show(lastStep, keySource: lastKey, texts: t, note: lastNote, account: lastAccount) }
    }
    @objc private func secondaryPressed() { onSecondary() }
    @objc private func openAgainPressed() { onOpenAgain() }
    @objc private func connectionsPressed() { onConnections() }
    @objc private func demoPressed() { onDemo() }
}
