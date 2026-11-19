// The app's own native views: the page shown while Pako starts or when something is wrong (instead of a blank or white window), Pako's orb
// drawn for it and for the menu bar, and the Settings window. All in system colours, so they follow light and dark mode by themselves, and
// labelled for VoiceOver. On that page Pako's figure (the panel's blue orb with its eyes) breathes and blinks while Pako starts.

import AppKit
import WebKit

/// A view as a PNG, over its window's background colour in the view's own appearance (cacheDisplay alone leaves the background out, so a
/// dark-mode window came out as white text on nothing). For PAKO_APP_REPORT only.
@MainActor
func viewSnapshotPNG(_ v: NSView) -> Data? {
    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return nil }
    v.cacheDisplay(in: v.bounds, to: rep)
    let out = NSImage(size: v.bounds.size)
    out.lockFocus()
    v.effectiveAppearance.performAsCurrentDrawingAppearance {
        NSColor.windowBackgroundColor.setFill()
        NSRect(origin: .zero, size: v.bounds.size).fill()
    }
    rep.draw(in: NSRect(origin: .zero, size: v.bounds.size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation, let full = NSBitmapImageRep(data: tiff) else { return nil }
    return full.representation(using: .png, properties: [:])
}

/// Pako's orb as an image: the window's large one (in colour), or the menu bar's (a template that macOS tints), with a dot when something is
/// unread and hollow when Pako is stopped.
enum Orb {
    static func large(size: CGFloat = 72) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { r in
            let colors = [NSColor.white, NSColor(red: 0.62, green: 0.55, blue: 1, alpha: 1), NSColor(red: 0.29, green: 0.24, blue: 1, alpha: 1),
                          NSColor(red: 0, green: 0.76, blue: 1, alpha: 1)]
            let g = NSGradient(colors: colors, atLocations: [0, 0.25, 0.6, 1], colorSpace: .sRGB)
            g?.draw(in: NSBezierPath(ovalIn: r.insetBy(dx: 2, dy: 2)), relativeCenterPosition: NSPoint(x: -0.3, y: 0.4))
            return true
        }
        img.accessibilityDescription = "Pako"
        return img
    }

    static func menuBar(unread: Bool, stopped: Bool) -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
            NSColor.black.setStroke()
            let ring = NSBezierPath(ovalIn: r.insetBy(dx: 2, dy: 2))
            ring.lineWidth = 1.6
            ring.stroke()
            NSColor.black.setFill()
            if !stopped { NSBezierPath(ovalIn: NSRect(x: 5.5, y: 8, width: 5, height: 5)).fill() }
            if unread { NSBezierPath(ovalIn: NSRect(x: 12, y: 12, width: 6, height: 6)).fill() }
            return true
        }
        img.isTemplate = true
        return img
    }
}

/// Pako's figure on the page shown while Pako starts: the panel's blue orb with its two eyes (src/panel/figure.css, its CSS twin), breathing,
/// blinking and with its particles in orbit; amber when something is wrong. HTML and CSS from this string: no network, no file. It lies over
/// the image orb, which shows until the figure has drawn (and in PAKO_APP_REPORT's snapshots, which cannot see into a web view).
@MainActor
final class FigureView: WKWebView, WKNavigationDelegate {
    var onReady: (() -> Void)?
    private var state = "idle"

    init() {
        super.init(frame: .zero, configuration: WKWebViewConfiguration())
        setValue(false, forKey: "drawsBackground")
        navigationDelegate = self
        setAccessibilityElement(false)
        loadHTMLString(FigureView.page, baseURL: nil)
    }

    required init?(coder: NSCoder) { nil }

    // Clicks go to what is under it: it is a picture.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func webView(_ wv: WKWebView, didFinish navigation: WKNavigation!) {
        set(state)
        onReady?()
    }

    /// idle (starting) or error (a problem to look at).
    func set(_ name: String) {
        state = name == "error" ? "error" : "idle"
        evaluateJavaScript("document.body.dataset.state='\(state)'", completionHandler: nil)
    }

    static let page = """
    <!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;overflow:hidden}
    body{display:grid;place-items:center}
    .f{position:relative;width:72px;height:72px}
    .f>span,.b>span{position:absolute;display:block}
    .a{inset:-42%;border-radius:50%;background:radial-gradient(closest-side,rgba(70,150,255,.5),rgba(91,70,255,.2) 52%,transparent 78%);
      animation:aura 5.5s ease-in-out infinite;z-index:-1}
    .o{inset:-30%;transform:rotate(-14deg) scaleY(.34)}
    .o i{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px;border-radius:50%;background:#bfeeff;
      box-shadow:0 0 5px #39b8ff;animation:orb 9s linear infinite}
    .o i:nth-child(2){animation-delay:-2.25s;width:3px;height:3px}.o i:nth-child(3){animation-delay:-4.5s}
    .o i:nth-child(4){animation-delay:-6.75s;width:3px;height:3px}
    .b{inset:0;border-radius:50%;overflow:hidden;animation:breathe 4.2s ease-in-out infinite;
      background:radial-gradient(circle at 34% 26%,#f2f8ff 0,#a9c8ff 9%,#6b5cff 34%,#3d2fd6 58%,#1f8fe6 84%,#4fe0ff 100%);
      box-shadow:inset 0 0 2px 1px rgba(255,255,255,.4),inset -4px -6px 16px rgba(41,196,255,.75),0 0 22px rgba(70,140,255,.55)}
    .fl{inset:-20%;mix-blend-mode:screen;animation:spin 16s linear infinite;
      background:radial-gradient(circle at 72% 70%,rgba(79,242,176,.5),transparent 38%),
        radial-gradient(circle at 22% 78%,rgba(41,196,255,.6),transparent 42%),radial-gradient(circle at 80% 22%,rgba(140,110,255,.55),transparent 40%)}
    .t{inset:0;border-radius:50%;opacity:0;transition:opacity .8s;
      background:radial-gradient(circle at 34% 26%,#fff4e0 0,#ffd08a 12%,#ffb547 40%,#c46a0c 72%,#ff7a45 100%)}
    .fc{inset:0;background:radial-gradient(circle at 50% 44%,rgba(30,24,120,.32),transparent 52%)}
    .e{position:absolute;top:39%;left:34.5%;width:5.4px;height:8.6px;margin-left:-2.7px;border-radius:9px;background:#f4faff;
      box-shadow:0 0 4px rgba(170,230,255,.95);animation:blink 5.3s infinite}
    .e+.e{left:65.5%}
    body[data-state=error] .t{opacity:1}
    body[data-state=error] .a{background:radial-gradient(closest-side,rgba(255,181,71,.45),transparent 78%)}
    @keyframes aura{50%{transform:scale(1.1);opacity:.8}}
    @keyframes breathe{50%{transform:scale(1.03)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes orb{from{transform:rotate(0) translateX(58px)}to{transform:rotate(360deg) translateX(58px)}}
    @keyframes blink{0%,93%,100%{transform:scaleY(1)}95.5%{transform:scaleY(.08)}}
    @media (prefers-color-scheme:light){.a{background:radial-gradient(closest-side,rgba(60,120,255,.32),transparent 78%)}
      .o i{background:#3d7dff;box-shadow:0 0 4px rgba(41,120,255,.7)}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style></head><body data-state="idle"><div class="f"><span class="a"></span><span class="o"><i></i><i></i><i></i><i></i></span>
    <span class="b"><span class="fl"></span><span class="t"></span><span class="fc"><i class="e"></i><i class="e"></i></span></span></div></body></html>
    """
}

/// What the window shows while Pako is not on screen: starting (a spinner), or a problem with its buttons. Opaque, over the web view, so
/// nothing white or stale shows through; hidden once the panel is in.
@MainActor
final class StatusView: NSView {
    private let orb = NSImageView()
    private let figure = FigureView()
    private var figureLive = false
    private let title = NSTextField(labelWithString: "")
    private let text = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let buttons = NSStackView()
    private var actions: [() -> Void] = []
    private var pulse: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        orb.image = Orb.large()
        orb.imageScaling = .scaleProportionallyUpOrDown
        orb.setAccessibilityElement(false)
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.alignment = .center
        title.textColor = .labelColor
        title.setAccessibilityRole(.staticText)
        text.font = .systemFont(ofSize: 14)
        text.alignment = .center
        text.textColor = .secondaryLabelColor
        text.isSelectable = true
        text.preferredMaxLayoutWidth = 440
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        buttons.orientation = .horizontal
        buttons.spacing = 10
        let stack = NSStackView(views: [orb, title, spinner, text, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.setCustomSpacing(22, after: orb)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            orb.widthAnchor.constraint(equalToConstant: 72), orb.heightAnchor.constraint(equalToConstant: 72),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
        ])
        // The figure: over the image orb, with room around it for its glow and its particles.
        figure.translatesAutoresizingMaskIntoConstraints = false
        addSubview(figure)
        NSLayoutConstraint.activate([
            figure.centerXAnchor.constraint(equalTo: orb.centerXAnchor), figure.centerYAnchor.constraint(equalTo: orb.centerYAnchor),
            figure.widthAnchor.constraint(equalToConstant: 168), figure.heightAnchor.constraint(equalToConstant: 168),
        ])
        figure.onReady = { [weak self] in
            self?.figureLive = true
            self?.orb.alphaValue = 0
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { nil }

    // The window's own background colour, as it is in light or dark mode now.
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    /// Shows `title` (and `detail`), a spinner while `busy`, and buttons whose first is the default (Return). VoiceOver says the new text.
    func show(_ titleText: String, _ detail: String = "", busy: Bool, buttons list: [(String, () -> Void)] = []) {
        title.stringValue = titleText
        text.stringValue = detail
        text.isHidden = detail.isEmpty
        busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        // Hidden, not only stopped: a stopped spinner still takes its room in the stack, a gap between the title and the text.
        spinner.isHidden = !busy
        spinner.setAccessibilityLabel(titleText)
        for v in buttons.arrangedSubviews { buttons.removeArrangedSubview(v); v.removeFromSuperview() }
        actions = list.map { $0.1 }
        for (i, b) in list.enumerated() {
            let button = NSButton(title: b.0, target: self, action: #selector(pressed(_:)))
            button.bezelStyle = .rounded
            button.controlSize = .large
            button.tag = i
            if i == 0 { button.keyEquivalent = "\r" }
            buttons.addArrangedSubview(button)
        }
        buttons.isHidden = list.isEmpty
        setAccessibilityLabel(detail.isEmpty ? titleText : "\(titleText). \(detail)")
        // The orb breathes while Pako starts, as the panel's does (the figure does it itself, once it has drawn; amber for a problem).
        pulse?.invalidate()
        figure.set(busy ? "idle" : "error")
        orb.alphaValue = figureLive ? 0 : 1
        if busy && !figureLive {
            pulse = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let o = self?.orb, self?.figureLive == false else { return }
                    NSAnimationContext.runAnimationGroup { c in c.duration = 0.85; o.animator().alphaValue = o.alphaValue < 0.9 ? 1 : 0.65 }
                }
            }
        }
        isHidden = false
        NSAccessibility.post(element: self, notification: .announcementRequested,
                             userInfo: [.announcement: accessibilityLabel() ?? titleText, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        if let first = buttons.arrangedSubviews.first { window?.makeFirstResponder(first) }
    }

    func hide() {
        pulse?.invalidate()
        pulse = nil
        spinner.stopAnimation(nil)
        isHidden = true
    }

    @objc private func pressed(_ b: NSButton) {
        guard b.tag < actions.count else { return }
        actions[b.tag]()
    }
}

/// Pako Settings (Cmd+,): Start with this Mac, Claude, notifications, updates and the Quit question. What each control does is
/// the app's (App.swift); this window only lays them out and says how things are.
@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let autostart = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    let claudeText = NSTextField(wrappingLabelWithString: "")
    let claudeButton = NSButton(title: "", target: nil, action: nil)
    let notifyText = NSTextField(wrappingLabelWithString: "")
    let notifyButton = NSButton(title: "", target: nil, action: nil)
    let autoUpdates = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    let checkNow = NSButton(title: "", target: nil, action: nil)
    let updateText = NSTextField(wrappingLabelWithString: "")
    let askQuit = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private var labels: [NSTextField] = []

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.delegate = self
        for b in [claudeButton, notifyButton, checkNow] { b.bezelStyle = .rounded }
        for l in [claudeText, notifyText, updateText] {
            l.textColor = .secondaryLabelColor
            l.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            l.preferredMaxLayoutWidth = 340
        }
        labels = (0..<4).map { _ in
            let l = NSTextField(labelWithString: "")
            l.alignment = .right
            l.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
            return l
        }
        let col = { (views: [NSView]) -> NSStackView in
            let s = NSStackView(views: views)
            s.orientation = .vertical
            s.alignment = .leading
            s.spacing = 6
            return s
        }
        let grid = NSGridView(views: [
            [labels[0], col([autostart, askQuit])],
            [labels[1], col([claudeText, claudeButton])],
            [labels[2], col([notifyText, notifyButton])],
            [labels[3], col([autoUpdates, checkNow, updateText])],
        ])
        grid.rowSpacing = 18
        grid.columnSpacing = 14
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        grid.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -22),
        ])
        window.contentView = content
    }

    /// Puts the texts in place.
    func apply(_ t: Texts) {
        window.title = t.settingsTitle
        for (l, s) in zip(labels, [t.general, t.claudeLabel, t.notificationsLabel, t.updatesLabel]) {
            l.stringValue = s + ":"
        }
        autostart.title = t.autostart
        askQuit.title = t.askBeforeQuit
        autoUpdates.title = t.autoUpdates
        checkNow.title = t.checkNow
        window.contentView?.layoutSubtreeIfNeeded()
        if let size = window.contentView?.fittingSize { window.setContentSize(size) }
    }

    func snapshotPNG() -> Data? { window.contentView.flatMap(viewSnapshotPNG) }
}

/// A small sheet with one main button, for a step the person goes through: installing an update (its offer, its progress, why it failed) and
/// the first run's Connect your things. What it says and what the buttons do are the app's (App.swift); this only lays it out.
@MainActor
final class StepSheet: NSObject {
    struct Content: Equatable {
        var title: String
        /// A small line above the title ("Step 2 of 5"), or nil.
        var count: String?
        var text: String
        /// A short state under the text ("Connected"), green when `good`.
        var state: String?
        var good = false
        /// nil: no bar; a negative number: a bar that only moves; 0 to 1: how far along.
        var progress: Double?
        /// A line under the bar (or an error, orange when `problem`).
        var status: String?
        var problem = false
        var primary: String?
        var secondary: String?
        /// A link-style button on the left ("What's New", "Finish Later").
        var tertiary: String?
    }

    let panel: NSPanel
    private let countLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(wrappingLabelWithString: "")
    private let textLabel = NSTextField(wrappingLabelWithString: "")
    private let stateLabel = NSTextField(labelWithString: "")
    private let bar = NSProgressIndicator()
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let primary = NSButton(title: "", target: nil, action: nil)
    private let secondary = NSButton(title: "", target: nil, action: nil)
    private let tertiary = NSButton(title: "", target: nil, action: nil)
    private var lastAnnounced = ""
    private(set) var shown: Content?
    var onPrimary: () -> Void = {}
    var onSecondary: () -> Void = {}
    var onTertiary: () -> Void = {}

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 220), styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        countLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        countLabel.textColor = .secondaryLabelColor
        titleLabel.font = .boldSystemFont(ofSize: 15)
        textLabel.isSelectable = true
        stateLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        bar.style = .bar
        bar.minValue = 0
        bar.maxValue = 1
        for (b, sel) in [(primary, #selector(primaryPressed)), (secondary, #selector(secondaryPressed)), (tertiary, #selector(tertiaryPressed))] {
            b.target = self
            b.action = sel
            b.bezelStyle = .rounded
        }
        primary.keyEquivalent = "\r"
        secondary.keyEquivalent = "\u{1b}"
        tertiary.isBordered = false
        tertiary.contentTintColor = .linkColor
        let buttons = NSStackView(views: [tertiary, NSView(), secondary, primary])
        buttons.distribution = .fill
        let stack = NSStackView(views: [countLabel, titleLabel, textLabel, stateLabel, bar, statusLabel, buttons])
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
            stack.widthAnchor.constraint(equalToConstant: 480),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -44),
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -44),
        ])
        for l in [titleLabel, textLabel, statusLabel] { l.preferredMaxLayoutWidth = 436 }
        panel.contentView = content
    }

    func show(_ c: Content) {
        shown = c
        countLabel.stringValue = c.count ?? ""
        countLabel.isHidden = c.count == nil
        titleLabel.stringValue = c.title
        textLabel.stringValue = c.text
        textLabel.isHidden = c.text.isEmpty
        stateLabel.stringValue = c.state ?? ""
        stateLabel.textColor = c.good ? .systemGreen : .secondaryLabelColor
        stateLabel.isHidden = c.state == nil
        if let p = c.progress {
            bar.isHidden = false
            bar.isIndeterminate = p < 0
            if p < 0 { bar.startAnimation(nil) } else { bar.stopAnimation(nil); bar.doubleValue = min(1, p) }
        } else {
            bar.stopAnimation(nil)
            bar.isHidden = true
        }
        statusLabel.stringValue = c.status ?? ""
        statusLabel.textColor = c.problem ? .systemOrange : .secondaryLabelColor
        statusLabel.isHidden = c.status == nil
        for (b, title) in [(primary, c.primary), (secondary, c.secondary), (tertiary, c.tertiary)] {
            b.title = title ?? ""
            b.isHidden = title == nil
        }
        panel.contentView?.layoutSubtreeIfNeeded()
        if let size = panel.contentView?.fittingSize { panel.setContentSize(size) }
        // VoiceOver hears each new step (the offer, Downloading…, an error), not only what the focus is on; not every byte of the download.
        let say = [c.title, c.problem ? c.status : nil].compactMap { $0 }.joined(separator: ". ")
        if say != lastAnnounced {
            lastAnnounced = say
            NSAccessibility.post(element: panel, notification: .announcementRequested,
                                 userInfo: [.announcement: say, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
    }

    func snapshotPNG() -> Data? { panel.contentView.flatMap(viewSnapshotPNG) }

    @objc private func primaryPressed() { onPrimary() }
    @objc private func secondaryPressed() { onSecondary() }
    @objc private func tertiaryPressed() { onTertiary() }
}
