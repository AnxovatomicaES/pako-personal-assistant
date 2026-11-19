// The app itself: one window with the panel in it (a WKWebView) under a native page for starting and problems, a menu-bar item, the
// standard menus and Settings. It keeps the Pako it started running (restarted after a crash, with a pause that grows), tells the person
// about what Pako writes by itself (a notification and the Dock badge), in English like all of Pako's fixed texts. Closing the window keeps Pako in
// the menu bar; Quit stops only a Pako this app started.

import AppKit
import Security
import ServiceManagement
import UniformTypeIdentifiers
import UserNotifications
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSMenuDelegate,
    NSWindowDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private let runner = PakoRunner()
    private let work = DispatchQueue(label: "io.github.anxovatomicaes.pako.work")
    /// The notices are asked on their own queue: a start or a health wait on `work` never holds them up, nor they it.
    private let noticeWork = DispatchQueue(label: "io.github.anxovatomicaes.pako.notices")
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: StatusView!
    private var statusItem: NSStatusItem!
    private let pauseItem = NSMenuItem()
    private let autostartItem = NSMenuItem()
    private let stateItem = NSMenuItem()
    /// The port of the Pako whose panel is (or is being) shown.
    private var port: Int?
    private var signedIn = false
    /// Sign-in links asked for this opening: a panel that keeps answering with its sign-in page must not be asked for ever.
    private var linkTries = 0
    private var busy = false
    private var lastConnect = Date.distantPast
    private var paused: Bool?
    private var autostartOn: Bool?
    private var quitting = false
    // Claude (Claude.swift, Connect.swift): how it is, the window that connects it, and the menu line and title-bar button that open it.
    private lazy var helper = ClaudeHelper(runner: runner)
    private let claudeWork = DispatchQueue(label: "io.github.anxovatomicaes.pako.claude")
    /// The sign-in's code, written while claudeWork waits on that sign-in.
    private let claudeSend = DispatchQueue(label: "io.github.anxovatomicaes.pako.claude-code")
    private let connectItem = NSMenuItem()
    private var claudeState: ClaudeState?
    private var claudeAuth: ClaudeAuthStatus?
    private var claudeBin: String?
    private var keySource: String?
    private var claudeNote: String?
    /// What the running Pako last said (GET /panel/api/claude): its `claude` word, to open the window when it turns to "not signed in".
    private var serverClaude: String?
    private var connectWindow: ConnectWindow?
    private var step: ConnectStep = .checking
    private var connecting = false
    private var connectShownThisLaunch = false
    /// The first run's Connect window, waiting for the welcome's first step (it is not opened over a welcome that has not said hello).
    private var connectPending = false
    private var claudeTimer: Timer?
    private let titleButton = NSTitlebarAccessoryViewController()
    private var titleButtonView: NSButton?
    // The self-contained app: started by its login item, and the release feed's newer version (shown in the menus until it is installed).
    private var atLogin = false
    private var update: UpdateInfo?
    private let updateItem = NSMenuItem()
    private let appUpdateItem = NSMenuItem()
    private var updateTimer: Timer?
    /// The install under way (Update.swift), its sheet, and the queue it runs on.
    private var updater: Updater?
    private var updateSheet: StepSheet?
    private var updatePhase: UpdatePhase = .offer
    private let updateWork = DispatchQueue(label: "io.github.anxovatomicaes.pako.update")
    // Connect your things (the first run's step after Connect Claude): the five, and the one shown.
    private var thingsSheet: StepSheet?
    private var things: [ThingItem] = []
    private var thingIndex = 0
    private let thingsItem = NSMenuItem()
    private let appThingsItem = NSMenuItem()
    // Keeping Pako running: crashes in a row of the Pako this app started, and whether it is stopped now (the menu bar's orb is hollow).
    private var failures = 0
    private var stopped = false
    private var webCrashes: [Date] = []
    // What Pako wrote by itself: how many are unread (the Dock badge, the orb's dot), whether the chat drawer is open.
    private var unread = 0
    private var chatOpen = false
    private var noticeBusy = false
    private var noticeTimer: Timer?
    private var housekeeping: Timer?
    private var notifiedCount = 0
    private var noticePolls = 0
    private var settingsWindow: SettingsWindow?
    /// When the dashboard's refresh last asked for the calendars' events (see .calendarPush).
    private var lastCalendarPush = Date.distantPast
    // Discovery (Discovery.swift): what this Mac has, read only when the panel asks and the person said yes; a check-only run reads no
    // Calendars, Contacts or Mail. The chosen calendars' events go to Pako every ten minutes and when they change.
    private lazy var sources: any PakoSources = AppDelegate.fakeSources.flatMap { FileSources(path: $0, userHome: runner.userHome) }
        ?? MacSources(userHome: runner.userHome, live: !AppDelegate.headless && AppDelegate.report == nil)
    private let discoverWork = DispatchQueue(label: "io.github.anxovatomicaes.pako.discover")
    private var discovering = false
    private lazy var calendarFeed: CalendarFeed = {
        let f = CalendarFeed(sources: sources, ids: runner.defaults.stringArray(forKey: "calendarIDs") ?? []) { [runner] ids in
            runner.defaults.set(ids, forKey: "calendarIDs")
        }
        f.post = { [weak self] body, done in
            guard let self = self, self.signedIn else { return done(false) }
            self.panelSend(self.webView, "POST", "/panel/api/calendar/local", body) { ok, _ in done(ok) }
        }
        f.exchange = { [weak self] results, done in
            guard let self = self, self.signedIn else { return done(nil) }
            self.panelSend(self.webView, "POST", "/panel/api/calendar/writes", ["results": results]) { ok, body in
                done(ok ? (body?["writes"] as? [[String: Any]] ?? []) : nil)
            }
        }
        return f
    }()
    private var sigterm: DispatchSourceSignal?

    private let texts = Texts()

    func applicationWillFinishLaunching(_ note: Notification) {
        atLogin = AppDelegate.launchedAsLoginItem()
        // Quit from outside (logout, shutdown, the Dock, an update): AppKit's own handler answers "User canceled" while the Connect Claude
        // sheet is open (checked: the app and its Pako kept running), and the first launch of a new user opens that sheet. Ours closes it first.
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleQuit(_:reply:)),
                                                     forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEQuitApplication))
        runner.defaults.register(defaults: ["updatesAuto": true, "pageZoom": 1.0])
    }

    @objc private func handleQuit(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) { terminateNow() }

    /// Quit Pako (Cmd+Q, both menus): first, once, a word that quitting stops Pako, when that matters (see askBeforeQuit).
    @objc private func quitApp() {
        if keepInsteadOfQuit() { return }
        terminateNow()
    }

    /// A sheet still open on any window would make AppKit refuse to end (the Settings window shows the page's confirm() as one), so every
    /// window's is closed first (a confirm then answers no); an app-modal alert is ended too, or the terminate below would wait for an answer.
    /// Asked from the run loop, not from inside a block of the main queue (a signal handler, a callback): terminate waits in a nested event
    /// loop for the reply below, which comes on the main queue, and the main queue cannot run while one of its own blocks waits (checked:
    /// SIGTERM hung the app that way).
    private func terminateNow() {
        for w in NSApp.windows { while let sheet = w.attachedSheet { w.endSheet(sheet) } }
        if NSApp.modalWindow != nil { NSApp.abortModal() }
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        if focusOtherInstance() { return }
        atLogin = atLogin || AppDelegate.launchedAsLoginItem() || AppDelegate.headless
        NSApp.mainMenu = mainMenu()
        makeWindow()
        makeStatusItem()
        watchSystem()
        runner.onChildExit = { [weak self] status, signal, ranFor in
            DispatchQueue.main.async { self?.childExited(status: status, signal: signal, ranFor: ranFor) }
        }
        if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = self }
        // A release build opened from the disk image or a translocated copy: offered a move first, before a server runs from there.
        if runner.bundle != nil, needsMoveToApplications(Bundle.main.bundlePath), offerMove() { return }
        if runner.bundle != nil { offerLegacyAgentRemoval(stale: true) }
        // Started by its login item: Pako runs, in the menu bar, with no window in the person's face.
        openPako(show: !atLogin)
        if CommandLine.arguments.contains("--updated") { runner.log("Pako.app updated: now \(appVersion) (build \(appBuild.map(String.init) ?? "?"))") }
        cleanUpdateLeftovers()
        scheduleUpdateCheck()
        noticeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.pollNotices() } }
        housekeeping = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.work.async { [runner = self?.runner] in runner?.rotateLogs() } }
        }
    }

    /// SIGTERM (a `kill`, a test, launchd at logout for some setups) quits as Quit does, stopping the Pako this app started, instead of
    /// ending the app at once; and the Mac waking up re-checks the Pako behind the panel.
    private func watchSystem() {
        signal(SIGTERM, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        s.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.terminateNow() } }
        s.resume()
        sigterm = s
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { MainActor.assumeIsolated { self?.recheckAfterWake() } }
        }
    }

    /// The login item opens the app with this mark on its open event (as for any login item).
    private static func launchedAsLoginItem() -> Bool {
        guard let e = NSAppleEventManager.shared().currentAppleEvent, e.eventID == kAEOpenApplication else { return false }
        return e.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    /// One Pako.app at a time (a copy in Applications and one still on the disk image would both start and stop the same Pako): another
    /// instance is brought forward and this one ends. A copy just moved to Applications (--moved) or just updated (--updated) waits for the
    /// one that moved or installed it to quit.
    /// A run with its own PAKO_HOME (a test, a second home) is let be: it is not the same Pako.
    private func focusOtherInstance() -> Bool {
        guard let id = Bundle.main.bundleIdentifier, (runner.env["PAKO_HOME"] ?? "").isEmpty else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        let until = Date().addingTimeInterval(CommandLine.arguments.contains("--moved") || CommandLine.arguments.contains("--updated") ? 10 : 0)
        while true {
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { $0.processIdentifier != me && !$0.isTerminated }
            guard let other = others.first else { return false }
            if Date() >= until {
                other.activate(options: [])
                exit(0)
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openPako(show: true)
        return true
    }

    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        writeFinal(now: true)
        helper.cancel()
        // An install not yet at its swap stops there (the app in place is left as it was); one past it finishes on its own queue first.
        updater?.cancel()
        noticeTimer?.invalidate()
        NSApp.dockTile.badgeLabel = nil
        // A start under way ends now (not after its minute), and starts nothing more: else a Pako started just after this would outlive the app.
        runner.cancelled = true
        // Stopped at once on a queue of its own (not behind a start or a health wait on the work queue), five seconds at most, then the app
        // ends: Quit never hangs, and logout is never held up by Pako.
        DispatchQueue.global(qos: .userInitiated).async { [runner] in
            runner.stopChild(wait: 5)
            // On the run loop in the modes terminate's wait runs in, whatever started the quit.
            RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
                MainActor.assumeIsolated { NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
        return .terminateLater
    }

    /// Quitting stops the Pako this app started: its reminders and routines then do not happen. Said once, with a way to keep it running
    /// (the window closes, Pako stays in the menu bar), unless the person said not to ask, or it starts with the Mac anyway. True: keep it.
    private func keepInsteadOfQuit() -> Bool {
        guard runner.childRunning, !runner.defaults.bool(forKey: "quitDontAsk") else { return false }
        if runner.bundle != nil, SMAppService.mainApp.status == .enabled { return false }
        let t = texts
        let a = NSAlert()
        a.messageText = t.quitTitle
        a.informativeText = t.quitText
        a.addButton(withTitle: t.keepRunning)
        a.addButton(withTitle: t.quitAnyway)
        a.showsSuppressionButton = true
        a.suppressionButton?.title = t.dontAskAgain
        NSApp.activate(ignoringOtherApps: true)
        let answer = a.runModal()
        if a.suppressionButton?.state == .on { runner.defaults.set(true, forKey: "quitDontAsk") }
        guard answer == .alertFirstButtonReturn else { return false }
        window.orderOut(nil)
        return true
    }

    // MARK: window and menus

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        // The default store keeps the panel's session cookie (30 days): opening the app again needs no new link. A run with its own
        // PAKO_HOME (a test) keeps none: its cookie must not take the place of the person's own Pako's, on the same address.
        config.websiteDataStore = runner.separateHome ? .nonPersistent() : .default()
        // A page's script opens no window by itself: only a click on a link with target="_blank" (then the default browser, below).
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The panel tells the app how its welcome goes (its first step passed, done) as it happens: window.webkit.messageHandlers.pako (app.js).
        config.userContentController.add(self, name: "pako")
        if AppDelegate.report != nil {
            // For PAKO_APP_REPORT only: the page's script errors are kept, for the report to say whether the panel ran cleanly.
            let keep = "window.__pakoErrors = []; addEventListener('error', e => window.__pakoErrors.push(String(e.message)));"
                + " addEventListener('unhandledrejection', e => window.__pakoErrors.push(String(e.reason)));"
            config.userContentController.addUserScript(WKUserScript(source: keep, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let frame = NSRect(x: 0, y: 0, width: 1240, height: 820)
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.autoresizingMask = [.width, .height]
        // No white before the panel's first paint: the window's own colour shows through until the page draws.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .windowBackgroundColor
        webView.pageZoom = CGFloat(runner.defaults.double(forKey: "pageZoom"))
        statusView = StatusView(frame: frame)
        statusView.autoresizingMask = [.width, .height]
        let content = NSView(frame: frame)
        content.addSubview(webView)
        content.addSubview(statusView)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pako"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 480, height: 400)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.tabbingMode = .disallowed
        window.contentView = content
        window.delegate = self
        window.center()
        if !runner.separateHome { window.setFrameAutosaveName("PakoMain") }
        window.backgroundColor = .windowBackgroundColor
        statusView.show(texts.starting, busy: true)
        // "Connect Claude…" in the title bar while Claude is not ready (installed and signed in): the chat's banner says so too.
        let b = NSButton(title: texts.connectMenu, target: self, action: #selector(showConnect))
        b.bezelStyle = .rounded
        b.controlSize = .small
        titleButtonView = b
        let holder = NSView(frame: NSRect(x: 0, y: 0, width: 160, height: 28))
        holder.addSubview(b)
        titleButton.view = holder
        titleButton.layoutAttribute = .trailing
        titleButton.isHidden = true
        layoutTitleButton()
        window.addTitlebarAccessoryViewController(titleButton)
    }

    private func layoutTitleButton() {
        guard let b = titleButtonView, let holder = titleButton.view as NSView? else { return }
        b.title = texts.connectMenu
        b.frame.size = b.fittingSize
        b.frame.origin = NSPoint(x: 0, y: (28 - b.fittingSize.height) / 2)
        holder.frame.size = NSSize(width: b.fittingSize.width + 12, height: 28)
    }

    func windowDidBecomeKey(_ note: Notification) {
        // Shown again after a while: a page whose content process is gone (url nil) is loaded anew.
        if !busy, !quitting, webView.url == nil, signedIn { connect() }
        refreshChatOpen()
    }

    private func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = target
        return i
    }

    private func mainMenu() -> NSMenu {
        let t = texts
        let bar = NSMenu()
        let appMenu = NSMenu(title: "Pako")
        appMenu.addItem(item(t.about, #selector(showAbout), target: self))
        appUpdateItem.action = #selector(openUpdate)
        appUpdateItem.target = self
        // Should the menus be made anew, this item lives on: AppKit throws (and the app crashes) when an
        // item still in the old menu is added to another, so it leaves the old one first.
        appUpdateItem.menu?.removeItem(appUpdateItem)
        appMenu.addItem(appUpdateItem)
        appMenu.addItem(item(t.checkUpdates, #selector(checkUpdatesNow), target: self))
        updateUpdateItems()
        appMenu.addItem(.separator())
        appMenu.addItem(item(t.settings, #selector(showPanelSettings), ",", target: self))
        appMenu.addItem(item(t.appSettings, #selector(showSettings), ",", [.command, .option], target: self))
        appThingsItem.menu?.removeItem(appThingsItem)
        appThingsItem.title = t.thingsMenu
        appThingsItem.action = #selector(showThingsAction)
        appThingsItem.target = self
        appMenu.addItem(appThingsItem)
        appMenu.addItem(.separator())
        let services = NSMenu(title: t.services)
        let servicesItem = NSMenuItem(title: t.services, action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        NSApp.servicesMenu = services
        appMenu.addItem(servicesItem)
        appMenu.addItem(.separator())
        appMenu.addItem(item(t.hide, #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item(t.hideOthers, #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(item(t.showAll, #selector(NSApplication.unhideAllApplications(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item(t.quit, #selector(quitApp), "q", target: self))
        let edit = NSMenu(title: t.edit)
        edit.addItem(item(t.undo, Selector(("undo:")), "z"))
        edit.addItem(item(t.redo, Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item(t.cut, #selector(NSText.cut(_:)), "x"))
        edit.addItem(item(t.copy, #selector(NSText.copy(_:)), "c"))
        edit.addItem(item(t.paste, #selector(NSText.paste(_:)), "v"))
        edit.addItem(item(t.selectAll, #selector(NSText.selectAll(_:)), "a"))
        let view = NSMenu(title: t.view)
        view.addItem(item(t.reload, #selector(reloadPanel), "r", target: self))
        view.addItem(.separator())
        view.addItem(item(t.actualSize, #selector(zoomReset), "0", target: self))
        view.addItem(item(t.zoomIn, #selector(zoomInAction), "=", target: self))
        view.addItem(item(t.zoomOut, #selector(zoomOutAction), "-", target: self))
        view.addItem(.separator())
        view.addItem(item(t.fullScreen, #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        let win = NSMenu(title: t.window)
        win.addItem(item(t.minimize, #selector(NSWindow.performMiniaturize(_:)), "m"))
        win.addItem(item(t.zoom, #selector(NSWindow.performZoom(_:))))
        // Cmd+W closes the window, which only hides it: Pako goes on in the menu bar, and the Dock icon brings it back.
        win.addItem(item(t.close, #selector(NSWindow.performClose(_:)), "w"))
        win.addItem(.separator())
        win.addItem(item(t.bringAll, #selector(NSApplication.arrangeInFront(_:))))
        let help = NSMenu(title: t.help)
        help.addItem(item(t.pakoHelp, #selector(openHelp), "?", target: self))
        help.addItem(item(t.reportProblem, #selector(reportProblem), target: self))
        for m in [appMenu, edit, view, win, help] {
            let top = NSMenuItem(title: m.title, action: nil, keyEquivalent: "")
            top.submenu = m
            bar.addItem(top)
        }
        NSApp.windowsMenu = win
        NSApp.helpMenu = help
        return bar
    }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [.credits: NSAttributedString(string: texts.aboutCredits, attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor,
        ])])
    }

    @objc private func zoomReset() { setZoom(1) }
    @objc private func zoomInAction() { setZoom(min(3, webView.pageZoom + 0.1)) }
    @objc private func zoomOutAction() { setZoom(max(0.5, webView.pageZoom - 0.1)) }
    private func setZoom(_ z: CGFloat) {
        webView.pageZoom = (z * 10).rounded() / 10
        runner.defaults.set(Double(webView.pageZoom), forKey: "pageZoom")
    }

    /// The docs for people (Info.plist PakoHelpURL, https only), in the browser.
    @objc private func openHelp() {
        let s = Bundle.main.object(forInfoDictionaryKey: "PakoHelpURL") as? String ?? ""
        guard let u = URL(string: s), u.scheme == "https" else { return }
        NSWorkspace.shared.open(u)
    }

    @objc private func reportProblem() {
        let a = NSAlert()
        a.messageText = texts.reportProblem.replacingOccurrences(of: "…", with: "")
        a.informativeText = texts.reportText
        a.addButton(withTitle: texts.openLogs)
        a.addButton(withTitle: texts.cancel)
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn { openLogs() }
    }

    private func makeStatusItem() {
        // Headless (a test): nothing in the person's menu bar.
        if AppDelegate.headless { return }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.toolTip = "Pako"
        updateStatusIcon()
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem?.menu = menu
        fillStatusMenu(menu)
    }

    /// The menu-bar orb: hollow while Pako is stopped, with a dot while something Pako wrote is unread; VoiceOver hears the same.
    private func updateStatusIcon() {
        guard let b = statusItem?.button else { return }
        b.image = Orb.menuBar(unread: unread > 0, stopped: stopped)
        let label = texts.statusLabel(unread: unread, stopped: stopped)
        b.image?.accessibilityDescription = label
        b.setAccessibilityLabel(label)
        b.toolTip = label
    }

    private func fillStatusMenu(_ menu: NSMenu) {
        let t = texts
        menu.removeAllItems()
        stateItem.title = stopped ? (busy ? t.stoppedMenu : t.stoppedForGood) : ""
        stateItem.isEnabled = false
        stateItem.isHidden = !stopped
        menu.addItem(stateItem)
        updateItem.action = #selector(openUpdate)
        updateItem.target = self
        menu.addItem(updateItem)
        updateUpdateItems()
        let open = NSMenuItem(title: t.open, action: #selector(openPakoAction), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let dash = NSMenuItem(title: t.dashboard, action: #selector(showDashboard), keyEquivalent: "")
        dash.target = self
        menu.addItem(dash)
        connectItem.action = #selector(showConnect)
        connectItem.target = self
        updateConnectItem()
        menu.addItem(connectItem)
        thingsItem.title = t.thingsMenu
        thingsItem.action = #selector(showThingsAction)
        thingsItem.target = self
        thingsItem.isHidden = !signedIn
        menu.addItem(thingsItem)
        menu.addItem(.separator())
        pauseItem.title = paused == true ? t.resume : t.pause
        pauseItem.action = #selector(togglePause)
        pauseItem.target = self
        // Only with the panel signed in: the switch is the panel's own (its cookie and its x-pako header).
        pauseItem.isHidden = !signedIn
        pauseItem.isEnabled = paused != nil
        menu.addItem(pauseItem)
        autostartItem.title = t.autostart
        autostartItem.action = #selector(toggleAutostart)
        autostartItem.target = self
        autostartItem.state = autostartOn == true ? .on : .off
        autostartItem.isEnabled = autostartOn != nil
        menu.addItem(autostartItem)
        let settings = NSMenuItem(title: t.settings, action: #selector(showPanelSettings), keyEquivalent: "")
        settings.target = self
        menu.addItem(settings)
        let logs = NSMenuItem(title: t.logs, action: #selector(openLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: t.quit, action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    func menuWillOpen(_ menu: NSMenu) {
        fillStatusMenu(menu)
        refreshPause(menu)
        checkClaude(fresh: false)
        refreshAutostart()
    }

    private func refreshAutostart(then: (() -> Void)? = nil) {
        if runner.bundle != nil {
            // The app's own login item (SMAppService), not a LaunchAgent: read at once, nothing to run.
            autostartOn = SMAppService.mainApp.status == .enabled
            autostartItem.state = autostartOn == true ? .on : .off
            autostartItem.isEnabled = true
            then?()
            return
        }
        guard runner.node != nil else { return }
        work.async { [runner] in
            let on = runner.autostart("status")?.code == 0
            DispatchQueue.main.async {
                self.autostartOn = on
                self.autostartItem.state = on ? .on : .off
                self.autostartItem.isEnabled = true
                then?()
            }
        }
    }

    // MARK: opening the panel

    @objc private func openPakoAction() { openPako(show: true) }

    func openPako(show: Bool = true) {
        if show {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        if busy { return }
        // Shown as it is only when the panel itself is in the window (its web content may have been closed by macOS meanwhile).
        if signedIn, let p = port, runner.liveLock()?.port == p, let u = webView.url, isPanelURL(u, port: p) { return }
        connect()
    }

    private func panelURL(_ port: Int) -> URL? { URL(string: "http://127.0.0.1:\(port)/panel") }

    /// The whole panel (overview, agenda, mail, reminders, lists, memory, connections, system): the chat drawer closed and the top of the page.
    /// Not signed in yet: the same as Open Pako, which ends there.
    @objc private func showDashboard() {
        // On Settings (or another page of the panel) in the main window: back to the dashboard in the same window.
        if signedIn, let p = port, let url = webView.url, isPanelURL(url, port: p), url.path != "/panel", let dash = panelURL(p) {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            webView.load(URLRequest(url: dash))
            return
        }
        guard signedIn, let url = webView.url, isPanelURL(url, port: port), url.path == "/panel" else { return openPako() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let js = "const c = document.getElementById('chat'); if (c && !c.hidden) document.getElementById('chat-close')?.click();"
            + " window.scrollTo(0, 0);"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Through connect(), never a plain reload: the port is checked to be this Pako's own again (ensureRunning, owned) before the panel's
    /// cookie is sent to it; one that died and whose port another account took gets nothing. The kept cookie still signs in at once.
    @objc private func reloadPanel() {
        if !busy { connect() }
    }

    private func connect() {
        guard !quitting else { return }
        busy = true
        signedIn = false
        linkTries = 0
        lastConnect = Date()
        showStatus(texts.starting)
        work.async { [runner] in
            if runner.repo == nil && runner.findRepo() == nil {
                DispatchQueue.main.async { self.busy = false; self.askForRepo() }
                return
            }
            if runner.node == nil, case let .failure(p) = runner.findNode() {
                DispatchQueue.main.async { self.busy = false; self.showProblem(p) }
                return
            }
            let r = runner.ensureRunning { what in
                DispatchQueue.main.async { self.showStatus(what == "launchd" ? self.texts.startingLaunchd : self.texts.starting) }
            }
            DispatchQueue.main.async {
                self.busy = false
                switch r {
                case let .success(port):
                    self.port = port
                    // The cookie kept from before may still be good: the panel itself first, a new link only if it asks to sign in.
                    if let url = self.panelURL(port) { self.webView.load(URLRequest(url: url)) }
                case let .failure(p):
                    self.showProblem(p)
                }
            }
        }
    }

    private func askForRepo() {
        let t = texts
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.title = t.chooseTitle
        panel.message = t.chooseMessage
        panel.beginSheetModal(for: window) { answer in
            if answer == .OK, let dir = panel.url?.path, PakoRunner.isPakoFolder(dir) {
                self.runner.remember(repo: dir)
                self.connect()
            } else {
                self.showProblem(.noRepo)
            }
        }
    }

    private func newLink() {
        guard let port = port else { return }
        linkTries += 1
        showStatus(texts.signingIn)
        work.async { [runner] in
            let r = runner.signInLink(port: port)
            DispatchQueue.main.async {
                switch r {
                case let .success(link): if let url = URL(string: link) { self.webView.load(URLRequest(url: url)) }
                case let .failure(p): self.showProblem(p)
                }
            }
        }
    }

    // MARK: the window's own page (starting, problems): native, over the web view

    private func showStatus(_ text: String) {
        statusView.show(text, busy: true)
        reportLoading()
    }

    private func showProblem(_ p: PakoProblem) {
        signedIn = false
        let t = texts
        let (title, text) = t.problem(p)
        var buttons: [(String, () -> Void)] = [(t.retry, { [weak self] in self?.retry() })]
        switch p {
        case .noRepo: buttons = [(t.choose, { [weak self] in self?.askForRepo() })]
        case .notStarted(_, .held), .staleLock, .broken, .olderPako:
            buttons = [(t.restartPako, { [weak self] in self?.restartStuck() }), (t.openLogs, { [weak self] in self?.openLogs() })]
        case .notStarted, .keepsStopping: buttons.append((t.openLogs, { [weak self] in self?.openLogs() }))
        default: break
        }
        statusView.show(title, text, busy: false, buttons: buttons)
        // PAKO_APP_REPORT: the problem page as shown (<path>-problem.png).
        if let base = AppDelegate.report {
            if let a = ProcessInfo.processInfo.environment["PAKO_APP_APPEARANCE"] { NSApp.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let png = AppDelegate.viewPNG(self.statusView) { try? png.write(to: URL(fileURLWithPath: base + "-problem.png")) }
            }
        }
    }

    private func retry() {
        failures = 0
        webCrashes = []
        connect()
    }

    /// "Restart Pako": a Pako that holds the data but does not answer (or a lock left by one that was killed) is stopped, then started again.
    private func restartStuck() {
        busy = true
        showStatus(texts.starting)
        work.async { [runner] in
            _ = runner.restartStuck()
            DispatchQueue.main.async { self.busy = false; self.retry() }
        }
    }

    // MARK: keeping Pako running

    /// The Pako this app started ended by itself (a crash, a kill, out of memory): said in app.log, shown in the window and the menu bar, and
    /// started again after 1, 2 then 4 seconds; a fourth time in a row (each ran less than five minutes), the window says it keeps stopping.
    private func childExited(status: Int32, signal: Bool, ranFor: TimeInterval) {
        guard !quitting else { return }
        runner.log("Pako stopped by itself (\(signal ? "signal" : "exit code") \(status), after \(Int(ranFor)) s)")
        if ranFor >= 300 { failures = 0 }
        failures += 1
        signedIn = false
        stopped = true
        updateStatusIcon()
        guard let delay = restartDelay(failures: failures) else {
            runner.log("it keeps stopping: not started again until Try again")
            return showProblem(.keepsStopping(log: runner.logsDir))
        }
        runner.log("starting it again in \(Int(delay)) s")
        busy = true
        statusView.show(texts.restarting(Int(delay)), busy: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.busy = false
            if !self.quitting { self.connect() }
        }
    }

    /// After sleep: the Pako behind the panel is asked; gone, it is found or started again, else the panel refreshes what it shows.
    private func recheckAfterWake() {
        guard !quitting, !busy, let p = port else { return }
        work.async { [runner] in
            let alive = runner.liveLock()?.port == p
            DispatchQueue.main.async {
                if !alive { return self.connect() }
                // The panel reloads its data on this event when what it shows is older than 30 seconds (app.js).
                self.webView.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))", completionHandler: nil)
            }
        }
    }

    // MARK: the web view

    func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        switch panelNavigation(url, port: port, mainFrame: action.targetFrame?.isMainFrame ?? true, clicked: action.navigationType == .linkActivated) {
        case .allow: decisionHandler(action.shouldPerformDownload ? .download : .allow)
        case .browser:
            // Another site: the default browser, never this window.
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
        case .refuse: decisionHandler(.cancel)
        }
    }

    func webView(_ wv: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ wv: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = wv.url, isPanelURL(url, port: port) else { return }
        // The panel's sign-in page (a link that was used or is old, or no cookie yet): a new link. The page a good link answers with moves on
        // by itself (its meta refresh), so it is left alone.
        let check = "document.body ? document.body.classList.contains('signin') && !document.querySelector('meta[http-equiv=\"refresh\"]') : false"
        wv.evaluateJavaScript(check) { result, _ in
            let signinPage = (result as? Bool) == true
            if signinPage {
                self.signedIn = false
                if self.linkTries < 2 { self.newLink() } else if let p = self.port { self.showProblem(.broken(port: p, why: "sign-in")) }
            } else if url.path == "/panel" {
                self.signedIn = true
                self.linkTries = 0
                self.stopped = false
                self.updateStatusIcon()
                self.statusView.hide()
                self.firstRunDashboard()
                self.writeReport()
                self.startClaudeWatch()
                self.pollNotices()
                self.resumeThings()
                self.calendarFeed.start()
                self.calendarFeed.push()
                self.reportDiscovery()
                self.walkConnections()
            }
        }
    }

    private func pakoGone(_ error: Error) {
        // The Pako behind the panel has gone (stopped, or restarting): find or start one again, but not in a loop. Only for that: a download
        // (the data export) or a navigation stopped on purpose also ends here, and must not reload the whole panel.
        let e = error as NSError
        let gone = [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet]
        guard e.domain == NSURLErrorDomain, gone.contains(e.code) else { return }
        guard !busy, !quitting, Date().timeIntervalSince(lastConnect) > 5 else { return }
        connect()
    }

    func webView(_ wv: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { pakoGone(error) }
    func webView(_ wv: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { pakoGone(error) }

    /// macOS closed the page's web content (memory pressure, a WebKit crash): the window would stay blank. The panel is loaded again (its
    /// cookie is kept), or Pako is found again; more than three times in a minute, the window says so instead of looping.
    func webViewWebContentProcessDidTerminate(_ wv: WKWebView) {
        webCrashes = webCrashes.filter { Date().timeIntervalSince($0) < 60 } + [Date()]
        reportWebCrash()
        if webCrashes.count > 3 { return showProblem(.webGone) }
        // Through connect() (the port checked to be this Pako's own again), never a load of the old address with the cookie.
        if !busy { connect() }
    }

    func webView(_ wv: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank" (a click: no page opens a window by itself here): the panel's own pages in this window, other sites in the
        // default browser, nothing else (no blob:, data:, file: or about: window).
        if let url = action.request.url {
            if isPanelURL(url, port: port) { wv.load(action.request) }
            else if panelNavigation(url, port: port, mainFrame: true, clicked: true) == .browser { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// The chat's paperclip (<input type=file>): WKWebView shows no file chooser unless asked here. Only for the panel itself, only the
    /// kinds the chat takes (papers.js), as a sheet on the window. This is the only way a file reaches the page (dropping one is refused).
    func webView(_ wv: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let o = frame.securityOrigin
        guard isPanelOrigin(protocol: o.protocol, host: o.host, port: o.port, port: port) else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.jpeg, .png, .webP, .pdf]
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: texts.ok)
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: texts.ok)
        a.addButton(withTitle: texts.cancel)
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    // The panel's data export (privacy) is a download: saved in ~/Downloads and shown in the Finder.
    func webView(_ wv: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ wv: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory())
        let name = (suggestedFilename as NSString).lastPathComponent
        var dest = dir.appendingPathComponent(name.isEmpty ? "pako-download" : name)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            n += 1
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        downloaded = dest
        completionHandler(dest)
    }

    private var downloaded: URL?
    func downloadDidFinish(_ download: WKDownload) {
        if let d = downloaded { NSWorkspace.shared.activateFileViewerSelecting([d]) }
    }

    /// The panel's word (app.js tellApp): {lang: "en"} when the welcome's first step is passed, {welcomed: true} at its end. Only from the
    /// panel itself; nothing in it is trusted beyond a moment to show the Connect window. The lang field is no choice any more (Pako's
    /// texts are English only): an older panel may still send "es", and it changes nothing.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let o = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, isPanelOrigin(protocol: o.protocol, host: o.host, port: o.port, port: port),
              let body = message.body as? [String: Any], let msg = parsePakoMessage(body) else { return }
        guard msg == .panelWord else { return handle(msg, from: message.webView) }
        if connectPending {
            connectPending = false
            if !(claudeState?.ready ?? false) { showConnect() }
        }
        if body["welcomed"] as? Bool == true, claudeState?.ready == true { maybeOfferThings() }
    }

    // MARK: discovery (Discovery.swift): the panel's typed messages

    /// The panel's ask, already checked (parsePakoMessage). Answers go back to the page that asked: window.pakoDiscovered(result),
    /// window.pakoCalendarSynced({events}) and window.pakoImported({people}) (null on failure), each only when the page defines it.
    private func handle(_ msg: PakoMessage, from wv: WKWebView?) {
        switch msg {
        case let .discover(what, openMail): discover(what, openMail: openMail, from: wv)
        case let .calendarSelect(ids):
            calendarFeed.select(ids) { n in self.answer(wv, "pakoCalendarSynced", n.map { ["events": $0, "calendars": ids.count] }) }
        case .contactsImport: importContacts(from: wv)
        case let .openURL(url): NSWorkspace.shared.open(url)
        // A page from before Settings moved into the main window still asks for "a window": it gets the main window on that page, the one
        // place Settings opens now.
        case .openSettingsWindow: showPanelSettings()
        case .calendarPush:
            // The dashboard's refresh: a new invitation reaches Pako now. Rate-limited, a page cannot make the app read EventKit in a loop.
            if Date().timeIntervalSince(lastCalendarPush) >= 30 {
                lastCalendarPush = Date()
                calendarFeed.push()
            }
        case let .openWindow(path):
            openPanelSettings(path)
            answer(wv, "pakoOpened", true)
        case let .use(what, ids): use(what, ids: ids, from: wv)
        case .panelWord: break
        }
    }

    /// The connections page's "use this": the calendars' events go to Pako from now on, the contacts are imported, or Zoom's recordings
    /// (already found by the look; Pako reads their transcripts from the folder the discovery names). Answered pakoUsed({what, ok, count}); for
    /// the contacts with what Pako's import did too ({added, merged, count}: count is how many people Pako knows from this Mac now).
    private func use(_ what: String, ids: [String], from wv: WKWebView?) {
        let used = { (ok: Bool, n: Int, extra: [String: Any]?) in
            var out: [String: Any] = ["what": what, "ok": ok, "count": n]
            for k in ["added", "merged", "count"] { if let v = extra?[k] as? Int { out[k] = v } }
            self.answer(wv, "pakoUsed", out)
        }
        switch what {
        case "calendars":
            calendarFeed.select(ids) { n in
                self.answer(wv, "pakoCalendarSynced", n.map { ["events": $0, "calendars": ids.count] })
                used(n != nil, n ?? 0, nil)
            }
        case "contacts": importContacts(from: wv, used: used)
        default:
            let s = sources
            discoverWork.async {
                let n = s.zoomFolders().map(zoomRecordingCount)
                DispatchQueue.main.async { used(n != nil, n ?? 0, nil) }
            }
        }
    }

    /// Calls the page's own function (in the page's world, where the panel defined it) with one JSON-like argument.
    private func answer(_ wv: WKWebView?, _ fn: String, _ value: Any?) {
        guard let wv = wv, let url = wv.url, isPanelURL(url, port: port) else { return }
        wv.callAsyncJavaScript("if (typeof window[fn] === 'function') window[fn](value);", arguments: ["fn": fn, "value": value ?? NSNull()],
                               in: nil, in: .page, completionHandler: nil)
    }

    /// A request to the panel's own route, made by the panel itself (its cookie, the x-pako header every change needs) in the app's own
    /// script world: the page's scripts can neither see nor change it. Only the routes of the contract.
    private func panelSend(_ wv: WKWebView, _ method: String, _ path: String, _ body: [String: Any]?, done: @escaping (Bool, [String: Any]?) -> Void) {
        let routes = ["/panel/api/discovery", "/panel/api/calendar/local", "/panel/api/calendar/writes", "/panel/api/people/import"]
        guard routes.contains(path), let url = wv.url, isPanelURL(url, port: port) else { return done(false, nil) }
        let js = "try { const r = await fetch(path, {method: method, credentials: 'same-origin', cache: 'no-store',"
            + " headers: {'content-type': 'application/json', 'x-pako': '1'}, body: body === null ? undefined : JSON.stringify(body)});"
            + " let j = null; try { j = await r.json(); } catch (e) {} return {ok: r.ok, body: j}; } catch (e) { return {ok: false, body: null}; }"
        wv.callAsyncJavaScript(js, arguments: ["path": path, "method": method, "body": body ?? NSNull()], in: nil, in: .defaultClient) { r in
            guard case let .success(v) = r, let d = v as? [String: Any] else { return done(false, nil) }
            done(d["ok"] as? Bool == true, d["body"] as? [String: Any])
        }
    }

    /// One look (the person said yes in the panel), on its own queue: a macOS prompt may wait for them there. What Pako keeps is read first
    /// and this look put on top of it (mergeDiscovery), then posted, then given to the page.
    private func discover(_ what: [String], openMail: Bool, from wv: WKWebView?) {
        guard let wv = wv, !discovering else { return }
        discovering = true
        let s = sources
        discoverWork.async {
            let fresh = runDiscovery(what: what, openMail: openMail, sources: s, now: Date())
            DispatchQueue.main.async {
                self.panelSend(wv, "GET", "/panel/api/discovery", nil) { _, kept in
                    let all = mergeDiscovery(kept: kept ?? [:], fresh: fresh)
                    self.panelSend(wv, "POST", "/panel/api/discovery", all) { _, _ in
                        self.discovering = false
                        self.answer(wv, "pakoDiscovered", all)
                    }
                }
            }
        }
    }

    /// The contacts, after the person confirmed the import in the panel: read (macOS asks first, if it never did), shaped and posted.
    private func importContacts(from wv: WKWebView?, used: ((Bool, Int, [String: Any]?) -> Void)? = nil) {
        guard let wv = wv else { return }
        let s = sources
        discoverWork.async {
            if s.contactsPermission() == "notAsked" { _ = s.requestContacts() }
            let people = shapePeople(s.people())
            DispatchQueue.main.async {
                guard s.contactsPermission() == "granted" else {
                    used?(false, 0, nil)
                    return self.answer(wv, "pakoImported", nil)
                }
                // The person confirmed the import in the panel ("Importar N personas"): written now (the route's preview is for a page that
                // asks first).
                self.panelSend(wv, "POST", "/panel/api/people/import", ["people": people, "confirm": true]) { ok, body in
                    self.answer(wv, "pakoImported", ok ? (body ?? ["people": people.count]) : nil)
                    used?(ok, people.count, body)
                }
            }
        }
    }

    // MARK: the first time

    /// The first time the panel opens in the app, the dashboard shows first: the panel opens its chat drawer on a wide window (and on its own
    /// first visit), so it is closed once, as soon as it opens. Later the panel does as it always does.
    private func firstRunDashboard() {
        let key = "dashboardShownFirst"
        guard !runner.defaults.bool(forKey: key) else { return }
        let js = "return await new Promise(done => { const t0 = Date.now(); const tick = () => {"
            + " const c = document.getElementById('chat');"
            + " if (c && c.classList.contains('open')) { document.getElementById('chat-close')?.click(); window.scrollTo(0, 0); return done(true); }"
            + " if (Date.now() - t0 > 15000) return done(false); setTimeout(tick, 150); }; tick(); });"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
            // Once, whichever way it went (the drawer closed, or this panel has none): never fought over again.
            if case .success = r { self.runner.defaults.set(true, forKey: key) }
        }
    }

    // MARK: what Pako wrote by itself: notifications, the Dock badge

    /// Every five seconds while a Pako runs: what it wrote by itself since the last look (GET /panel/api/notices, the bridge token). New
    /// ones become notifications, unless the person has the chat open in front of them; those after the last time they did are the badge.
    /// The very first look only sets the marks: what was written before the app ever looked is not announced.
    private func pollNotices() {
        guard let p = port, !noticeBusy, !quitting, signedIn || runner.childRunning else { return }
        noticeBusy = true
        let d = runner.defaults
        let notified = d.double(forKey: "noticesNotifiedAt"), read = d.double(forKey: "noticesReadAt")
        let first = notified == 0 || read == 0
        noticeWork.async { [runner] in
            let r = runner.notices(port: p, after: first ? 0 : min(notified, read))
            DispatchQueue.main.async {
                self.noticeBusy = false
                guard let r = r else { return }
                self.noticePolls += 1
                if first {
                    self.runner.defaults.set(r.now, forKey: "noticesNotifiedAt")
                    self.runner.defaults.set(r.now, forKey: "noticesReadAt")
                    return self.setUnread(0)
                }
                let (fresh, unread) = noticeCounts(r.notices, notifiedAt: notified, readAt: read)
                if let newest = fresh.map(\.at).max() { self.runner.defaults.set(newest, forKey: "noticesNotifiedAt") }
                if self.inFrontWithChat() {
                    self.runner.defaults.set(r.now, forKey: "noticesReadAt")
                    self.setUnread(0)
                } else {
                    if !fresh.isEmpty { self.notify(fresh) }
                    self.setUnread(unread)
                }
                self.refreshChatOpen()
            }
        }
    }

    private func inFrontWithChat() -> Bool { NSApp.isActive && window.isKeyWindow && window.isVisible && chatOpen && signedIn }

    /// Whether the panel's chat drawer is open, read in the app's own script world (the page's scripts cannot answer for it); when it is,
    /// and the window is in front, everything is read.
    private func refreshChatOpen() {
        guard signedIn else { chatOpen = false; return }
        webView.callAsyncJavaScript("return !!document.getElementById('chat')?.classList.contains('open');", arguments: [:], in: nil,
                                    in: .defaultClient) { r in
            if case let .success(v) = r { self.chatOpen = (v as? Bool) == true }
            if self.inFrontWithChat(), self.unread > 0 {
                self.runner.defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "noticesReadAt")
                self.setUnread(0)
            }
        }
    }

    private func setUnread(_ n: Int) {
        guard n != unread || (n == 0 && NSApp.dockTile.badgeLabel != nil) else { return }
        unread = n
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        updateStatusIcon()
    }

    /// One notification per new message (the newest three; more are said in a fourth), in English. Posted only where the person
    /// allowed it; a click opens the window with the chat on them.
    private func notify(_ fresh: [Notice]) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let t = texts
        let shown = Array(fresh.suffix(3))
        let more = fresh.count - shown.count
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            for n in shown {
                let c = UNMutableNotificationContent()
                c.title = "Pako"
                c.body = n.secret || n.text.isEmpty ? t.secretNotice : n.text
                c.sound = .default
                c.threadIdentifier = "pako-notices"
                center.add(UNNotificationRequest(identifier: "pako-\(n.n)-\(Int(n.at))", content: c, trigger: nil))
            }
            if more > 0 {
                let c = UNMutableNotificationContent()
                c.title = "Pako"
                c.body = t.moreNotices(more)
                c.threadIdentifier = "pako-notices"
                center.add(UNNotificationRequest(identifier: "pako-more-\(Int(fresh.last?.at ?? 0))", content: c, trigger: nil))
            }
        }
        notifiedCount += fresh.count
    }

    /// Asked once, and only once Claude is connected (Pako can then write by itself): never at the first launch, when it means nothing yet.
    /// A run with its own PAKO_HOME (a test) never asks.
    private func askNotificationsOnce() {
        guard !runner.separateHome, Bundle.main.bundleIdentifier != nil, !runner.defaults.bool(forKey: "notificationsAsked") else { return }
        runner.defaults.set(true, forKey: "notificationsAsked")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            DispatchQueue.main.async { self.refreshSettings() }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { done(self.inFrontWithChat() ? [] : [.banner, .sound, .list]) }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.openPako(show: true)
                self.openChat()
                done()
            }
        }
    }

    /// The chat drawer opened (as the panel's own button does), then everything counts as read.
    private func openChat() {
        guard signedIn else { return }
        let js = "const c = document.getElementById('chat'); if (!c || !c.classList.contains('open')) document.getElementById('chat-fab')?.click();"
        webView.evaluateJavaScript(js) { _, _ in
            self.chatOpen = true
            self.runner.defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "noticesReadAt")
            self.setUnread(0)
        }
    }

    // MARK: a report for checking a build

    /// PAKO_APP_REPORT=<path>, a check-only setting, honoured only by a build that is not Developer ID signed (a release from the owner
    /// ignores it: no other program can make it write pictures of someone's data). Once the panel is open the app writes <path>.json and
    /// pictures: -loading.png (the native page while Pako starts), .png, -dashboard.png and -bottom.png (the panel), -panel-settings.png (the
    /// panel's Settings, opened as Cmd+, opens them: in the main window), -settings.png (the app's own Settings window),
    /// -about.png and -connect.png (the native windows). They show the person's data (agenda, mail, chat): only for checking on your own Mac.
    /// PAKO_APP_APPEARANCE=dark|light shows the app in that appearance; PAKO_APP_SELFTEST=webcrash then closes the page's web content as
    /// macOS would, and -final.json says whether the panel came back. Unset (or blank), all of it is inert.
    private static let report: String? = {
        let v = (ProcessInfo.processInfo.environment["PAKO_APP_REPORT"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty || developerIDSigned() ? nil : v
    }()
    /// PAKO_APP_SELFTEST=headless (test/mac-app.test.ts, same rule as the report: never in a Developer ID build): the app runs its whole
    /// life with no window shown, no Dock icon and no menu-bar item, so the lifecycle tests can start, crash and quit it on a person's Mac.
    /// PAKO_APP_SELFTEST=update (same rule) is headless too, and installs the update the feed offers as if Update had been pressed, writing
    /// each step to app.log (test/mac-app.test.ts: two builds, a local feed).
    static let headless: Bool = ["headless", "update"].contains(ProcessInfo.processInfo.environment["PAKO_APP_SELFTEST"] ?? "") && !developerIDSigned()
    static let selfTestUpdate: Bool = ProcessInfo.processInfo.environment["PAKO_APP_SELFTEST"] == "update" && !developerIDSigned()
    /// PAKO_APP_UPDATE_FEED (check-only, same rule): a feed to use instead of the build's, which may also be plain http on this Mac's own
    /// address (a local test server), for it and for the dmg it names. Anything else, or a Developer ID build: ignored.
    /// PAKO_APP_FAKE_SOURCES=<file.json> (check-only, same rule): made-up calendars, contacts and Mail accounts in place of this Mac's
    /// (FileSources in Discovery.swift), so nothing real is asked or read. PAKO_APP_WALK=<path> (same rule) then walks the connections page
    /// once the panel is open, as a person would press it: its window, the look, a calendar chosen, the contacts imported, then the agenda;
    /// a picture of each step (<path>-1-settings.png … -5-agenda.png) and what Pako then holds (<path>-walk.json).
    static let fakeSources: String? = checkOnly("PAKO_APP_FAKE_SOURCES")
    static let walk: String? = checkOnly("PAKO_APP_WALK")
    private static func checkOnly(_ name: String) -> String? {
        let v = (ProcessInfo.processInfo.environment[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty || developerIDSigned() ? nil : v
    }
    static let feedOverride: URL? = {
        let v = (ProcessInfo.processInfo.environment["PAKO_APP_UPDATE_FEED"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty, !developerIDSigned(), let u = URL(string: v), isUpdateURL(u, loopback: true) else { return nil }
        return u
    }()
    private var reported = false
    private var loadingReported = false
    private var webCrashTested = false
    private var webCrashSeen = false
    private var reloadedAfterCrash = false

    /// Whether this app carries a Developer ID signature (a team): then it is a release, and the check-only settings are ignored.
    nonisolated private static func developerIDSigned() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let c = code else { return false }
        var stat: SecStaticCode?
        guard SecCodeCopyStaticCode(c, [], &stat) == errSecSuccess, let s = stat else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(s, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let d = info as? [String: Any] else { return false }
        return d[kSecCodeInfoTeamIdentifier as String] != nil
    }

    private func reportLoading() {
        guard let base = AppDelegate.report, !loadingReported else { return }
        loadingReported = true
        if let a = ProcessInfo.processInfo.environment["PAKO_APP_APPEARANCE"] {
            NSApp.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            if let png = AppDelegate.viewPNG(self.statusView) { try? png.write(to: URL(fileURLWithPath: base + "-loading.png")) }
        }
    }

    private static func viewPNG(_ v: NSView) -> Data? { viewSnapshotPNG(v) }

    private func writeReport() {
        if webCrashSeen, !reloadedAfterCrash { reloadedAfterCrash = true; writeFinal() }
        guard let base = AppDelegate.report, !reported else { return }
        reported = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            let js = "const r = await fetch('/panel/api/overview', {credentials: 'same-origin'});"
                + " const cards = [...document.querySelectorAll('section.card')];"
                + " return {overview: r.status, url: location.pathname, signin: document.body.classList.contains('signin'),"
                + " cards: cards.length, shown: cards.filter(c => !c.hidden && c.offsetHeight > 0).map(c => c.className),"
                + " lang: document.documentElement.lang, chat: !!document.getElementById('chat'), errors: window.__pakoErrors || [],"
                + " dark: matchMedia('(prefers-color-scheme: dark)').matches, origin: location.origin};"
            self.webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                var out: [String: Any] = [:]
                switch r {
                case let .success(v): out = (v as? [String: Any]) ?? ["value": String(describing: v)]
                case let .failure(e): out = ["error": e.localizedDescription]
                }
                out["menus"] = NSApp.mainMenu?.items.map { [$0.title] + ($0.submenu?.items.filter { !$0.isSeparatorItem && !$0.isHidden && !$0.isAlternate }
                    .map(\.title) ?? []) } ?? []
                out["appLang"] = "en"
                out["port"] = self.port ?? 0
                out["windowMin"] = [self.window.minSize.width, self.window.minSize.height]
                out["fullScreenCapable"] = self.window.collectionBehavior.contains(.fullScreenPrimary)
                out["statusItemLabel"] = (self.statusItem?.button?.accessibilityLabel() ?? "")
                if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
                    try? data.write(to: URL(fileURLWithPath: base + ".json"))
                }
            }
            // As it opened; then as the Dashboard item shows it (the chat drawer closed); then scrolled to its last cards; then the native windows.
            self.snapshot(base + ".png") {
                self.showDashboard()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    self.snapshot(base + "-dashboard.png") {
                        self.webView.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)", completionHandler: nil)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.snapshot(base + "-bottom.png") {
                            // Settings as Cmd+, opens them: in the main window, then its Back to the dashboard in the same window.
                            self.showPanelSettings()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.snapshot(base + "-panel-settings.png") {
                                self.showDashboard()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.reportWindows(base) }
                            } }
                        } }
                    }
                }
            }
        }
    }

    /// PAKO_APP_REPORT: one discovery as the panel's yes would ask it, in this check-only run (no Calendars, Contacts or Mail are asked or
    /// read: they say notAsked), posted to the panel's route and written to <path>-discovery.json with whether the route took it.
    private func reportDiscovery() {
        guard let base = AppDelegate.report, !discoveryReported else { return }
        discoveryReported = true
        let s = sources
        discoverWork.async {
            let fresh = runDiscovery(what: discoverKinds, openMail: false, sources: s, now: Date())
            DispatchQueue.main.async {
                self.panelSend(self.webView, "POST", "/panel/api/discovery", mergeDiscovery(kept: [:], fresh: fresh)) { ok, _ in
                    self.panelSend(self.webView, "GET", "/panel/api/discovery", nil) { _, kept in
                        let out: [String: Any] = ["result": fresh, "posted": ok, "kept": kept ?? NSNull()]
                        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
                            try? data.write(to: URL(fileURLWithPath: base + "-discovery.json"))
                        }
                    }
                }
            }
        }
    }
    private var discoveryReported = false

    /// PAKO_APP_WALK: the connections page pressed through, step by step, in its own window (see `walk`).
    private func walkConnections() {
        guard let base = AppDelegate.walk, !walked else { return }
        walked = true
        let steps: [(name: String, js: String, wait: Double)] = [
            // The page ready first (a Pako restarting while it loaded: loaded again).
            ("0-ready", "for (let i = 0; i < 40 && !document.body?.classList.contains('ready'); i++) {"
                + " await new Promise(r => setTimeout(r, 500)); if (i === 20) location.reload(); }", 1),
            ("1-settings", "", 4),
            ("2-discovered", "document.querySelector('#discover .step-actions .btn.primary')?.click();", 6),
            ("3-calendar-pick", "location.hash = 'calendar'; await new Promise(r => setTimeout(r, 800));"
                + " document.querySelector('#slot-calendar .choice')?.click();", 3),
            ("4-calendar-connected", "document.querySelector('#slot-calendar .step-actions .btn.primary')?.click();", 8),
            ("5-contacts", "location.hash = 'contacts'; await new Promise(r => setTimeout(r, 800));"
                + " document.querySelector('#slot-contacts .step-actions .btn.primary')?.click();", 6),
        ]
        openPanelSettings("/panel/settings")
        // Settings open in the main window (openPanelSettings): every step is pressed and pictured there.
        let wv: WKWebView = webView
        func step(_ i: Int) {
            guard i < steps.count else { return finish() }
            let s = steps[i]
            wv.callAsyncJavaScript(s.js.isEmpty ? "return true;" : s.js + " return true;", arguments: [:], in: nil, in: .page) { _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + s.wait) {
                    let into = ["2-discovered": "#discover", "3-calendar-pick": "#slot-calendar", "4-calendar-connected": "#slot-calendar",
                                "5-contacts": "#slot-contacts"][s.name] ?? ""
                    // Each entrance animation ended first: a window macOS does not draw (a screen asleep) holds them at their first frame.
                    let js = "for (const a of document.getAnimations()) { try { a.finish(); } catch (e) {} }"
                        + " if (q) document.querySelector(q)?.scrollIntoView({block: 'start'}); await new Promise(r => setTimeout(r, 300));"
                    wv.callAsyncJavaScript(js, arguments: ["q": into], in: nil, in: .page) { _ in
                    wv.takeSnapshot(with: nil) { image, _ in
                        if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: "\(base)-\(s.name).png"))
                        }
                        step(i + 1)
                    }
                    }
                }
            }
        }
        func finish() {
            window.makeKeyAndOrderFront(nil)
            if let p = port, let dash = panelURL(p) { webView.load(URLRequest(url: dash)) } else { webView.reload() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                self.snapshot("\(base)-6-agenda.png") {
                    let js = "const get = async (p) => { const r = await fetch(p, {credentials: 'same-origin', cache: 'no-store'});"
                        + " return r.ok ? r.json() : r.status; }; return {discovery: await get('/panel/api/discovery'),"
                        + " calendar: await get('/panel/api/calendar/local'), people: await get('/panel/api/people/imported'),"
                        + " status: await get('/panel/api/connections/status'), agenda: await get('/panel/api/overview')};"
                    self.webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .defaultClient) { r in
                        let held: Any = (try? r.get()) ?? NSNull()
                        if let data = try? JSONSerialization.data(withJSONObject: ["held": held], options: [.prettyPrinted, .sortedKeys]) {
                            try? data.write(to: URL(fileURLWithPath: base + "-walk.json"))
                        }
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { step(0) }
    }
    private var walked = false

    private func reportWindows(_ base: String) {
        showSettings()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if let s = self.settingsWindow, let png = s.snapshotPNG() { try? png.write(to: URL(fileURLWithPath: base + "-settings.png")) }
            self.settingsWindow?.window.orderOut(nil)
            self.showAbout()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                let about = NSApp.windows.first { $0.isVisible && $0 !== self.window && $0 !== self.settingsWindow?.window
                    && $0 !== self.connectWindow?.panel && $0.frame.width > 200 && $0.frame.height > 150 }
                if let v = about?.contentView, let png = AppDelegate.viewPNG(v) { try? png.write(to: URL(fileURLWithPath: base + "-about.png")) }
                about?.orderOut(nil)
                self.window.makeKeyAndOrderFront(nil)
                self.reportSheets(base) { self.selfTest() }
            }
        }
    }

    /// The Update sheet (when the feed offers a release) and Connect your things (when the panel has a Connections card), drawn off screen
    /// as they would show: <path>-update.png and <path>-things.png.
    private func reportSheets(_ base: String, then: @escaping () -> Void) {
        if let u = update {
            let s = StepSheet()
            updatePhase = .offer
            s.show(updateSheetContent(u))
            if let png = s.snapshotPNG() { try? png.write(to: URL(fileURLWithPath: base + "-update.png")) }
        }
        loadThings { items in
            if let items = items {
                self.things = items
                self.thingIndex = 0
                let s = StepSheet()
                s.show(self.thingsContent())
                if let png = s.snapshotPNG() { try? png.write(to: URL(fileURLWithPath: base + "-things.png")) }
            }
            then()
        }
    }

    /// PAKO_APP_SELFTEST=webcrash: the page's web content process is closed as macOS does under memory pressure (WebKit's own test hook),
    /// to check that the window comes back by itself.
    private func selfTest() {
        guard AppDelegate.report != nil, ProcessInfo.processInfo.environment["PAKO_APP_SELFTEST"] == "webcrash", !webCrashTested else {
            return writeFinal()
        }
        webCrashTested = true
        // Killed from outside, as the system does (WebKit's own _killWebContentProcess counts as asked for, and tells no delegate).
        if let pid = webView.value(forKey: "_webProcessIdentifier") as? Int32, pid > 0 { Darwin.kill(pid, SIGKILL) } else { writeFinal() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.writeFinal() }
    }

    private func reportWebCrash() { webCrashSeen = true }

    private var finalWritten = false
    /// Once the checks are done; and again as the app quits (what happened meanwhile: a notice, the badge), at once.
    private func writeFinal(now: Bool = false) {
        guard let base = AppDelegate.report, !finalWritten || now else { return }
        finalWritten = true
        let write = {
            let out: [String: Any] = ["webCrashSeen": self.webCrashSeen, "panelBackAfterCrash": self.reloadedAfterCrash && self.signedIn,
                                      "noticePolls": self.noticePolls, "unread": self.unread, "dockBadge": NSApp.dockTile.badgeLabel ?? "",
                                      "notified": self.notifiedCount, "statusItemLabel": (self.statusItem?.button?.accessibilityLabel() ?? ""),
                                      "url": self.webView.url?.absoluteString ?? "", "lang": "en"]
            if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: base + "-final.json"))
            }
        }
        if now { write() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { write() } }
    }

    private func snapshot(_ path: String, then: @escaping () -> Void) {
        webView.takeSnapshot(with: nil) { image, _ in
            if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
            then()
        }
    }

    // MARK: menu-bar actions

    /// Asked of the panel itself, with its cookie, in the app's own script world (the page's scripts cannot answer for it): the same answer
    /// the panel's STOP switch shows.
    private func refreshPause(_ menu: NSMenu?) {
        guard signedIn else { return }
        let js = "const r = await fetch('/panel/api/overview', {credentials: 'same-origin'}); if (!r.ok) return null;"
            + " const j = await r.json(); return j.paused === null || j.paused === undefined ? 'no' : 'yes';"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .defaultClient) { r in
            guard case let .success(v) = r, let s = v as? String else { return }
            self.paused = s == "yes"
            self.pauseItem.title = self.paused == true ? self.texts.resume : self.texts.pause
            self.pauseItem.isEnabled = true
        }
    }

    @objc private func togglePause() {
        guard signedIn, let now = paused else { return }
        let on = !now
        if on {
            let a = NSAlert()
            a.messageText = texts.pauseConfirm
            a.addButton(withTitle: texts.pause)
            a.addButton(withTitle: texts.cancel)
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() != .alertFirstButtonReturn { return }
        }
        // The panel's own route, with its cookie and the x-pako header it asks of every change; then the panel shows the new state.
        let js = "const r = await fetch('/panel/api/pause', {method: 'POST', credentials: 'same-origin',"
            + " headers: {'content-type': 'application/json', 'x-pako': '1'}, body: JSON.stringify({on: on})}); return r.ok;"
        webView.callAsyncJavaScript(js, arguments: ["on": on], in: nil, in: .defaultClient) { r in
            if case let .success(v) = r, (v as? Bool) == true {
                self.paused = on
                self.webView.reload()
            }
        }
    }

    @objc private func toggleAutostart() {
        if runner.bundle != nil { toggleLoginItem(); return refreshSettings() }
        guard let now = autostartOn else { return }
        autostartItem.isEnabled = false
        work.async { [runner] in
            let r = runner.autostart(now ? "off" : "on")
            let on = runner.autostart("status")?.code == 0
            DispatchQueue.main.async {
                self.autostartOn = on
                let a = NSAlert()
                a.messageText = self.texts.autostart
                a.informativeText = (r?.out ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                a.addButton(withTitle: self.texts.ok)
                NSApp.activate(ignoringOtherApps: true)
                a.runModal()
                self.refreshSettings()
                // Turning it off also stops the background Pako: if that was the one shown, one of this app's own takes its place.
                if !on && runner.child?.isRunning != true && runner.liveLock() == nil { self.connect() }
            }
        }
    }

    // MARK: Settings

    /// Pako > Settings… (Cmd+,), the menu bar's Settings… and the panel's gear: the panel's own Settings IN THE MAIN WINDOW, brought forward.
    /// A second window for Settings was one more thing to find and close; the page's Back returns to the dashboard in the same window. Before
    /// the panel is open (no Pako yet, or not signed in) the app's own Settings instead, which are always under App Settings… (Cmd+Option+,).
    @objc private func showPanelSettings() { openPanelSettings("/panel/settings") }

    /// The connections page in the main window, on `path` (isSettingsPath: maybe one card, /panel/settings#calendar). Already there: only
    /// the card changes (the page opens it when its hash changes), so a wizard half filled is not lost to a reload.
    private func openPanelSettings(_ path: String) {
        guard signedIn, let p = port else { return showSettings() }
        let target = isSettingsPath(path) ? path : "/panel/settings"
        let hash = target.firstIndex(of: "#").map { String(target[target.index(after: $0)...]) } ?? ""
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let u = webView.url, isPanelURL(u, port: p), u.path == "/panel/settings" {
            if !hash.isEmpty { webView.callAsyncJavaScript("location.hash = h;", arguments: ["h": hash], in: nil, in: .page, completionHandler: nil) }
            return
        }
        if let url = URL(string: "http://127.0.0.1:\(p)\(target)") { webView.load(URLRequest(url: url)) }
    }

    @objc private func showSettings() {
        let s = settingsWindow ?? makeSettings()
        s.apply(texts)
        refreshSettings()
        refreshAutostart { self.refreshSettings() }
        if !s.window.isVisible { s.window.center() }
        s.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeSettings() -> SettingsWindow {
        let s = SettingsWindow()
        s.autostart.target = self
        s.autostart.action = #selector(toggleAutostart)
        s.askQuit.target = self
        s.askQuit.action = #selector(askQuitChanged)
        s.claudeButton.target = self
        s.claudeButton.action = #selector(showConnectFromSettings)
        s.notifyButton.target = self
        s.notifyButton.action = #selector(notificationsButton)
        s.autoUpdates.target = self
        s.autoUpdates.action = #selector(autoUpdatesChanged)
        s.checkNow.target = self
        s.checkNow.action = #selector(checkUpdatesFromSettings)
        settingsWindow = s
        return s
    }

    /// The window's controls as things are now (the login item, Claude, notifications, updates).
    private func refreshSettings() {
        guard let s = settingsWindow else { return }
        let t = texts
        s.autostart.state = autostartOn == true ? .on : .off
        s.autostart.isEnabled = autostartOn != nil
        s.askQuit.state = runner.defaults.bool(forKey: "quitDontAsk") ? .off : .on
        s.claudeText.stringValue = claudeState.map { $0 == .plan ? t.connectedMenu(claudeAuth?.email ?? claudeAuth?.plan) : t.claude($0).title } ?? t.step(.checking).title
        s.claudeButton.title = t.connectMenu
        let feed = updateFeed()
        s.autoUpdates.state = runner.defaults.bool(forKey: "updatesAuto") ? .on : .off
        s.autoUpdates.isEnabled = feed != nil
        s.checkNow.isEnabled = feed != nil
        if feed == nil { s.updateText.stringValue = t.noFeed }
        s.notifyButton.title = t.allowNotifications
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async {
                switch status {
                case .authorized, .provisional:
                    s.notifyText.stringValue = t.notificationsOn
                    s.notifyButton.title = t.openNotificationSettings
                case .notDetermined:
                    s.notifyText.stringValue = t.notificationsAsk
                    s.notifyButton.title = t.allowNotifications
                    s.notifyButton.isEnabled = !self.runner.separateHome
                default:
                    s.notifyText.stringValue = t.notificationsOff
                    s.notifyButton.title = t.openNotificationSettings
                }
                s.window.contentView?.layoutSubtreeIfNeeded()
                if let size = s.window.contentView?.fittingSize { s.window.setContentSize(size) }
            }
        }
    }

    @objc private func askQuitChanged() { runner.defaults.set(settingsWindow?.askQuit.state != .on, forKey: "quitDontAsk") }
    @objc private func autoUpdatesChanged() { runner.defaults.set(settingsWindow?.autoUpdates.state == .on, forKey: "updatesAuto") }

    @objc private func showConnectFromSettings() {
        settingsWindow?.window.orderOut(nil)
        showConnect()
    }

    @objc private func notificationsButton() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async {
                if status == .notDetermined {
                    self.runner.defaults.set(true, forKey: "notificationsAsked")
                    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                        DispatchQueue.main.async { self.refreshSettings() }
                    }
                } else if let u = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")") {
                    NSWorkspace.shared.open(u)
                }
            }
        }
    }

    // MARK: the self-contained app: its login item, an older LaunchAgent, where it runs from, its updates

    /// "Start with this Mac" for a release build: the app itself as a login item (SMAppService.mainApp, macOS 13+). It follows the app when
    /// it is moved or updated, goes away with it, and shows as Pako (not as node) in System Settings > General > Login Items. At login the
    /// app opens in the menu bar and starts its server, as when it is opened by hand.
    private func toggleLoginItem() {
        let t = texts
        let service = SMAppService.mainApp
        let on = service.status == .enabled
        var message = ""
        if on {
            do { try service.unregister(); message = t.autostartOffText } catch { message = t.autostartFailed(error.localizedDescription) }
        } else if needsMoveToApplications(Bundle.main.bundlePath) {
            // A login item for a path that vanishes after an eject or a restart would fail at every login.
            message = t.autostartNeedsMove
        } else if !offerLegacyAgentRemoval(stale: false) {
            return
        } else {
            do {
                try service.register()
                message = service.status == .requiresApproval ? t.autostartApproval : t.autostartOnText
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            } catch {
                message = t.autostartFailed(error.localizedDescription)
            }
        }
        autostartOn = service.status == .enabled
        autostartItem.state = autostartOn == true ? .on : .off
        let a = NSAlert()
        a.messageText = t.autostart
        a.informativeText = message
        a.addButton(withTitle: t.ok)
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    private var legacyAgentFile: String { (runner.userHome as NSString).appendingPathComponent("Library/LaunchAgents/local.pako.plist") }

    /// An older "Start with this Mac" (a LaunchAgent from `npm run autostart` or a developer build) next to the app's login item would start
    /// a second, older Pako. Never removed without asking. At launch (stale true): only one that can only fail, and asked about once. When the
    /// login item is turned on (stale false): any, since both would start at login. False: the person kept it, and the login item stays off.
    @discardableResult
    private func offerLegacyAgentRemoval(stale: Bool) -> Bool {
        let file = legacyAgentFile
        guard let data = FileManager.default.contents(atPath: file) else { return true }
        let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
        let args = plist?["ProgramArguments"] as? [String] ?? []
        let isStale = legacyAgentIsStale(programArguments: args, exists: { FileManager.default.fileExists(atPath: $0) })
        if stale && (!isStale || runner.defaults.bool(forKey: "legacyAgentAsked")) { return true }
        let t = texts
        let a = NSAlert()
        a.messageText = t.legacyTitle
        a.informativeText = t.legacyText(file, stale: isStale)
        a.addButton(withTitle: t.removeIt)
        a.addButton(withTitle: stale ? t.keepIt : t.cancel)
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else {
            if stale { runner.defaults.set(true, forKey: "legacyAgentAsked") }
            return false
        }
        // To the Trash, not deleted: it can be put back. A job whose program is gone is also unloaded (it would retry every 30 seconds until
        // logout); one that may be running now (another Pako this app could be showing) is left until logout.
        if isStale, args.contains(where: { $0.hasPrefix("/") && !FileManager.default.fileExists(atPath: $0) }) {
            run("/bin/launchctl", ["bootout", "gui/\(getuid())/local.pako"], timeout: 10)
        }
        do {
            try FileManager.default.trashItem(at: URL(fileURLWithPath: file), resultingItemURL: nil)
        } catch {
            let e = NSAlert()
            e.messageText = t.autostartFailed(error.localizedDescription)
            e.addButton(withTitle: t.ok)
            e.runModal()
            return false
        }
        return true
    }

    /// Opened from the disk image or translocated (Downloads, quarantined): one question, Move to Applications. True: the move is under way
    /// and this copy quits once the moved one is opened, so nothing is started here.
    private func offerMove() -> Bool {
        let t = texts
        let a = NSAlert()
        a.messageText = t.moveTitle
        a.informativeText = t.moveText
        a.addButton(withTitle: t.moveButton)
        a.addButton(withTitle: t.notNow)
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return false }
        window.makeKeyAndOrderFront(nil)
        showStatus(t.moving)
        busy = true
        let source = Bundle.main.bundleURL
        work.async { [runner] in
            let dest = AppDelegate.copyToApplications(source, userHome: runner.userHome)
            DispatchQueue.main.async {
                guard let dest = dest else {
                    self.busy = false
                    let e = NSAlert()
                    e.messageText = t.moveFailed
                    e.addButton(withTitle: t.ok)
                    e.runModal()
                    self.openPako(show: true)
                    return
                }
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.createsNewApplicationInstance = true
                cfg.arguments = ["--moved"]
                NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { _, err in
                    DispatchQueue.main.async {
                        if err == nil { self.terminateNow() } else { self.busy = false; self.openPako(show: true) }
                    }
                }
            }
        }
        return true
    }

    /// Copies the app (ditto: signature, links and permissions exactly) to /Applications, or ~/Applications when /Applications is not
    /// writable for this user; a Pako already there goes to the Trash first. The copy's quarantine mark is removed: macOS already checked this
    /// app when it opened, and with the mark the copy would be translocated again (only a move in the Finder clears it otherwise).
    nonisolated private static func copyToApplications(_ source: URL, userHome: String) -> URL? {
        let fm = FileManager.default
        for dir in ["/Applications", (userHome as NSString).appendingPathComponent("Applications")] {
            if dir != "/Applications" { try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true) }
            guard fm.isWritableFile(atPath: dir) else { continue }
            let dest = URL(fileURLWithPath: dir).appendingPathComponent("Pako.app")
            if dest.standardizedFileURL == source.standardizedFileURL { return nil }
            if fm.fileExists(atPath: dest.path) {
                guard (try? fm.trashItem(at: dest, resultingItemURL: nil)) != nil else { continue }
            }
            guard run("/usr/bin/ditto", [source.path, dest.path], timeout: 300)?.code == 0 else {
                try? fm.removeItem(at: dest)
                continue
            }
            run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dest.path], timeout: 60)
            return dest
        }
        return nil
    }

    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    private var appBuild: Int? { Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") }

    private func updateFeed() -> URL? {
        if let o = AppDelegate.feedOverride { return o }
        let feed = (Bundle.main.object(forInfoDictionaryKey: "PakoUpdateFeed") as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: feed), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    /// The release feed (Info.plist PakoUpdateFeed; empty: never checked): https only, at most once a day (unless the person turned that
    /// off in Settings), a plain request with no cookie, no cache and a User-Agent of just "Pako" (nothing that tells one person from
    /// another). A newer version shows one quiet menu item; it opens the Update sheet (a feed with a dmg and its SHA-256) or, for a feed
    /// with no checksum, the release page in the browser. Nothing is downloaded or installed until the person presses Update.
    private func scheduleUpdateCheck() {
        guard let url = updateFeed() else { return }
        // What a check found before stays offered until this version is the newer one.
        if let d = runner.defaults.data(forKey: "updateFound"), let u = parseUpdateFeed(d, loopback: AppDelegate.feedOverride != nil),
           isNewerRelease(version: u.version, build: u.build, than: appVersion, currentBuild: appBuild) {
            update = u
            updateUpdateItems()
        }
        checkForUpdate(url, force: false)
        updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkForUpdate(url, force: false) }
        }
    }

    /// `force`: asked by the person (the menu, Settings): now, whatever the daily limit or the automatic setting. `done` hears the outcome:
    /// the newer version, nil (up to date), or false when the feed could not be read.
    private func checkForUpdate(_ url: URL, force: Bool, done: ((UpdateInfo?, Bool) -> Void)? = nil) {
        let now = Date().timeIntervalSince1970
        if !force {
            guard runner.defaults.bool(forKey: "updatesAuto"), now - runner.defaults.double(forKey: "updateCheckedAt") >= 86_400 else { return }
        }
        runner.defaults.set(now, forKey: "updateCheckedAt")
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCache = nil
        let session = URLSession(configuration: config)
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("Pako", forHTTPHeaderField: "User-Agent")
        let current = appVersion
        let currentBuild = appBuild
        let loopback = AppDelegate.feedOverride != nil
        session.dataTask(with: req) { data, resp, _ in
            session.finishTasksAndInvalidate()
            guard let h = resp as? HTTPURLResponse, h.statusCode == 200, isUpdateURL(h.url, loopback: loopback), let data = data,
                  let u = parseUpdateFeed(data, loopback: loopback) else { DispatchQueue.main.async { done?(nil, false) }; return }
            let newer = isNewerRelease(version: u.version, build: u.build, than: current, currentBuild: currentBuild)
            DispatchQueue.main.async {
                // An install under way keeps the release it started with.
                if self.updater == nil { self.update = newer ? u : nil }
                if newer { self.runner.defaults.set(data, forKey: "updateFound") } else { self.runner.defaults.removeObject(forKey: "updateFound") }
                self.updateUpdateItems()
                done?(newer ? u : nil, true)
                if newer, AppDelegate.selfTestUpdate, u.installable {
                    self.runner.log("update: Pako \(u.version) offered by the feed (self-test: Update pressed)")
                    self.startInstall(u)
                }
            }
        }.resume()
    }

    @objc private func checkUpdatesNow() {
        let t = texts
        let say = { (text: String) in
            let a = NSAlert()
            a.messageText = t.checkUpdates.replacingOccurrences(of: "…", with: "")
            a.informativeText = text
            a.addButton(withTitle: t.ok)
            NSApp.activate(ignoringOtherApps: true)
            a.runModal()
        }
        guard let url = updateFeed() else { return say(t.noFeed) }
        checkForUpdate(url, force: true) { u, ok in
            if u != nil { self.openUpdate() } else { say(ok ? t.upToDate(self.appVersion) : t.updateFailed) }
        }
    }

    @objc private func checkUpdatesFromSettings() {
        guard let url = updateFeed(), let s = settingsWindow else { return }
        let t = texts
        s.updateText.stringValue = t.checkingUpdates
        checkForUpdate(url, force: true) { u, ok in
            s.updateText.stringValue = u.map { t.updateAvailable($0.version) } ?? (ok ? t.upToDate(self.appVersion) : t.updateFailed)
        }
    }

    private func updateUpdateItems() {
        for i in [updateItem, appUpdateItem] {
            i.isHidden = update == nil
            i.title = update.map { texts.updateAvailable($0.version) } ?? ""
            i.toolTip = update?.notes
        }
    }

    /// The menu's Update available item: the Update sheet for a release the app can install itself, else its page in the browser.
    @objc private func openUpdate() {
        guard let u = update else { return }
        if u.installable { return showUpdateSheet() }
        if let page = u.page ?? (u.url.scheme == "https" ? u.url : nil) { NSWorkspace.shared.open(page) }
    }

    // MARK: installing an update (Update.swift): asked, never silent; its progress; a failure leaves this app as it was

    enum UpdatePhase: Equatable {
        case offer, tooOld, working(UpdateStage), failed(UpdateFailure), restarting, restartByHand
    }

    private func showUpdateSheet() {
        guard update != nil, !AppDelegate.headless else { return }
        if updater == nil, updatePhase != .restarting {
            let tooOld = update?.minimumMacOS.map { !macOSAtLeast($0, current: ProcessInfo.processInfo.operatingSystemVersion) } ?? false
            updatePhase = tooOld ? .tooOld : .offer
        }
        renderUpdateSheet()
        guard let s = updateSheet, !s.panel.isVisible else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // One sheet at a time: one already open (Connect Claude, Connect your things) is closed first; it can be opened again from its menu.
        if let other = window.attachedSheet { window.endSheet(other) }
        window.beginSheet(s.panel)
    }

    private func updateSheetContent(_ u: UpdateInfo) -> StepSheet.Content {
        let t = texts
        let notes = u.notes.isEmpty ? "" : u.notes + "\n\n"
        var c = StepSheet.Content(title: t.updateTitle(u.version), text: notes + t.updateOffer(appVersion))
        c.tertiary = u.page != nil ? t.whatsNew : nil
        switch updatePhase {
        case .offer:
            c.primary = t.updateNow
            c.secondary = t.later
        case .tooOld:
            c.text = notes + t.needsMacOS(u.minimumMacOS ?? "")
            c.primary = t.close
        case let .working(stage):
            c.secondary = stage == .installing ? nil : t.cancel
            switch stage {
            case let .downloading(done, total):
                c.progress = total > 0 ? Double(done) / Double(total) : -1
                c.status = t.downloading(done, total)
            case .verifying: c.progress = -1; c.status = t.verifyingUpdate
            case .installing: c.progress = -1; c.status = t.installingUpdate
            }
        case let .failed(f):
            c.title = t.updateFailedTitle
            c.text = t.updateFailure(f) + " " + t.keepsRunning
            c.problem = true
            switch f {
            case .cannotReplace, .mustMove, .notNewer, .needsMacOS, .team, .signature, .notTheSameApp:
                // Trying again would fail the same way: the release's page (or the dmg itself) to do it by hand, or nothing.
                c.primary = u.page != nil || u.url.scheme == "https" ? t.openDownloadPage : nil
            default:
                c.primary = t.retry
            }
            c.secondary = t.close
        case .restarting:
            c.progress = -1
            c.status = t.restartingUpdate
        case .restartByHand:
            c.status = t.restartByHand
            c.primary = t.quit
        }
        return c
    }

    private func renderUpdateSheet() {
        guard let u = update else { return }
        let s = updateSheet ?? makeUpdateSheet()
        s.show(updateSheetContent(u))
    }

    private func makeUpdateSheet() -> StepSheet {
        let s = StepSheet()
        s.onPrimary = { [weak self] in self?.updatePrimary() }
        s.onSecondary = { [weak self] in
            guard let self = self else { return }
            if case .working = self.updatePhase { self.updater?.cancel() } else { self.closeUpdateSheet() }
        }
        s.onTertiary = { [weak self] in if let p = self?.update?.page { NSWorkspace.shared.open(p) } }
        updateSheet = s
        return s
    }

    private func closeUpdateSheet() {
        guard let s = updateSheet, s.panel.isVisible else { return }
        window.endSheet(s.panel)
    }

    private func updatePrimary() {
        guard let u = update else { return }
        switch updatePhase {
        case .offer: startInstall(u)
        case .failed(let f):
            switch f {
            case .cannotReplace, .mustMove, .notNewer, .needsMacOS, .team, .signature, .notTheSameApp:
                closeUpdateSheet()
                if let page = u.page ?? (u.url.scheme == "https" ? u.url : nil) { NSWorkspace.shared.open(page) }
            default: startInstall(u)
            }
        case .tooOld: closeUpdateSheet()
        case .restartByHand: terminateNow()
        case .working, .restarting: break
        }
    }

    private func setUpdatePhase(_ p: UpdatePhase) {
        updatePhase = p
        if updateSheet?.panel.isVisible == true { renderUpdateSheet() }
    }

    /// Pressed Update (or the self-test did): the install runs on its own queue; the old app stays as it is until the new one is in place,
    /// then quits (stopping the Pako it started) and the new one is opened.
    private func startInstall(_ u: UpdateInfo) {
        guard updater == nil, u.installable else { return }
        let me = Bundle.main.bundleURL
        let current = InstalledApp(url: me, bundleID: Bundle.main.bundleIdentifier ?? "", version: appVersion, build: appBuild,
                                   team: signingTeam(me), os: ProcessInfo.processInfo.operatingSystemVersion, userHome: runner.userHome)
        let up = Updater(info: u, current: current, loopback: AppDelegate.feedOverride != nil) { [weak self] stage in
            DispatchQueue.main.async {
                guard let self = self, self.updater != nil else { return }
                if case .downloading = stage {} else { self.runner.log("update: \(stage == .verifying ? "checking the download" : "installing")") }
                self.setUpdatePhase(.working(stage))
            }
        }
        updater = up
        runner.log("update: downloading Pako \(u.version)\(u.build.map { " (build \($0))" } ?? "")")
        setUpdatePhase(.working(.downloading(done: 0, total: 0)))
        updateWork.async { [runner] in
            let r = up.install()
            DispatchQueue.main.async {
                self.updater = nil
                switch r {
                case let .success(app):
                    let team = current.team.map { ", team \($0)" } ?? ""
                    runner.log("update: installed Pako \(u.version) (SHA-256 and signature checked\(team)); restarting")
                    self.setUpdatePhase(.restarting)
                    self.relaunch(app)
                case .failure(.cancelled):
                    runner.log("update: cancelled")
                    self.updatePhase = .offer
                    self.closeUpdateSheet()
                case let .failure(f):
                    runner.log("update failed: \(f.code) (this version keeps running)")
                    self.setUpdatePhase(.failed(f))
                }
            }
        }
    }

    /// The new app is in place: a small shell waits for this process to end, then opens it (with Launch Services, as the Finder would; a
    /// run with its own PAKO_HOME, a test, runs its program directly so it keeps that environment). This app then quits as Quit does.
    private func relaunch(_ app: URL) {
        let script = "i=0; while /bin/kill -0 \"$1\" 2>/dev/null && [ $i -lt 600 ]; do /bin/sleep 0.1; i=$((i+1)); done;"
            + " if [ \"$3\" = direct ]; then exec \"$2/Contents/MacOS/Pako\" --updated; else exec /usr/bin/open \"$2\" --args --updated; fi"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "pako-relaunch", String(getpid()), app.path, runner.separateHome ? "direct" : "open"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            runner.log("update: installed, but Pako could not open the new version by itself: \(error.localizedDescription)")
            setUpdatePhase(.restartByHand)
            if AppDelegate.headless { terminateNow() } else { showUpdateSheet() }
            return
        }
        terminateNow()
    }

    /// What an install stopped half way may have left next to the app (it is hidden: a name starting with a dot): removed at the next start.
    private func cleanUpdateLeftovers() {
        let dir = Bundle.main.bundleURL.deletingLastPathComponent()
        guard !needsMoveToApplications(dir.path) else { return }
        updateWork.async {
            let fm = FileManager.default
            for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
            where (name.hasPrefix(".Pako-update-") || name.hasPrefix(".Pako-old-")) && name.hasSuffix(".app") {
                try? fm.removeItem(at: dir.appendingPathComponent(name))
            }
        }
    }

    // MARK: Connect your things: the first run's step after Connect Claude (Telegram first, then Calendar, Mail, Slack, Zoom)

    /// The five as the panel's Connections card says them now (GET /panel/api/connections and /panel/api/telegram, asked by the panel itself
    /// with its cookie); nil when the panel is not open or has no such card (a server's).
    private func loadThings(_ then: @escaping ([ThingItem]?) -> Void) {
        guard signedIn, let url = webView.url, isPanelURL(url, port: port) else { return then(nil) }
        let js = "const get = async (p) => { try { const r = await fetch(p, {credentials: 'same-origin', cache: 'no-store'});"
            + " return r.ok ? await r.json() : null; } catch (e) { return null; } };"
            + " return {connections: await get('/panel/api/connections'), telegram: await get('/panel/api/telegram')};"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .defaultClient) { r in
            guard case let .success(v) = r, let d = v as? [String: Any] else { return then(nil) }
            then(parseThings(connections: d["connections"], telegram: d["telegram"]))
        }
    }

    /// Once, the first time Claude is ready with the panel open (and its welcome done): the step, unless everything is connected already.
    private func maybeOfferThings() {
        guard !AppDelegate.headless, signedIn, !runner.defaults.bool(forKey: "thingsOffered"), window.attachedSheet == nil else { return }
        webView.callAsyncJavaScript("return !!document.getElementById('welcome')?.open;", arguments: [:], in: nil, in: .defaultClient) { r in
            if case let .success(v) = r, (v as? Bool) == true { return }
            self.loadThings { items in
                guard let items = items, self.window.attachedSheet == nil, !self.runner.defaults.bool(forKey: "thingsOffered") else { return }
                self.runner.defaults.set(true, forKey: "thingsOffered")
                guard items.contains(where: { $0.state != "on" }) else { return }
                self.showThings(items, at: 0)
            }
        }
    }

    /// The panel loaded again after Connect in the panel (saving a connection restarts Pako, and the page reloads): the step comes back on the
    /// same item, now showing whether it is connected.
    private func resumeThings() {
        guard !AppDelegate.headless, runner.defaults.bool(forKey: "thingsResume"), window.attachedSheet == nil else { return }
        runner.defaults.set(false, forKey: "thingsResume")
        loadThings { items in
            guard let items = items, self.window.attachedSheet == nil else { return }
            self.showThings(items, at: self.runner.defaults.integer(forKey: "thingsNext"))
        }
    }

    /// The menus' Connect Your Things…: the step again, where it was left.
    @objc private func showThingsAction() {
        openPako(show: true)
        loadThings { items in
            guard let items = items else { return }
            self.showThings(items, at: self.runner.defaults.integer(forKey: "thingsNext"))
        }
    }

    private func showThings(_ items: [ThingItem], at i: Int) {
        guard !items.isEmpty else { return }
        things = items
        thingIndex = max(0, min(i, items.count - 1))
        let s = thingsSheet ?? makeThingsSheet()
        s.show(thingsContent())
        guard !s.panel.isVisible else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let other = window.attachedSheet { window.endSheet(other) }
        window.beginSheet(s.panel)
    }

    private func thingsContent() -> StepSheet.Content {
        let t = texts
        let item = things[thingIndex]
        let last = thingIndex == things.count - 1
        let steps = item.id == "telegram" ? t.telegramSteps : item.how
        var c = StepSheet.Content(title: item.id == "telegram" ? t.telegramName : item.name, count: t.thingsCount(thingIndex + 1, things.count),
                                  text: thingIndex == 0 ? t.thingsLead + "\n\n" + steps : steps)
        c.state = item.state == "on" ? t.thingConnected : item.state == "partial" ? t.thingHalf : t.thingNotConnected
        c.good = item.state == "on"
        if item.state == "on" {
            c.primary = last ? t.done : t.next
        } else {
            c.primary = t.connectInPanel
            c.secondary = last ? t.close : t.skip
        }
        c.tertiary = last ? nil : t.finishLater
        return c
    }

    private func makeThingsSheet() -> StepSheet {
        let s = StepSheet()
        s.onPrimary = { [weak self] in
            guard let self = self, !self.things.isEmpty else { return }
            let item = self.things[self.thingIndex]
            if item.state == "on" { return self.nextThing() }
            // Back on this item when the panel loads again (a saved connection restarts Pako), to show it connected.
            self.runner.defaults.set(self.thingIndex, forKey: "thingsNext")
            self.runner.defaults.set(true, forKey: "thingsResume")
            self.closeThings()
            self.openConnectionsCard(item.id)
        }
        s.onSecondary = { [weak self] in self?.nextThing() }
        s.onTertiary = { [weak self] in
            guard let self = self else { return }
            self.runner.defaults.set(self.thingIndex, forKey: "thingsNext")
            self.closeThings()
        }
        thingsSheet = s
        return s
    }

    private func nextThing() {
        if thingIndex + 1 >= things.count {
            runner.defaults.set(0, forKey: "thingsNext")
            return closeThings()
        }
        thingIndex += 1
        runner.defaults.set(thingIndex, forKey: "thingsNext")
        thingsSheet?.show(thingsContent())
    }

    private func closeThings() {
        guard let s = thingsSheet, s.panel.isVisible else { return }
        window.endSheet(s.panel)
    }

    @objc func openLogs() {
        let dir = runner.logsDir
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    // MARK: Claude: the Connect Claude window

    private func updateConnectItem() {
        let t = texts
        if claudeState == .plan {
            connectItem.title = t.connectedMenu(claudeAuth?.email ?? claudeAuth?.plan)
            connectItem.state = .on
        } else {
            connectItem.title = t.connectMenu
            connectItem.state = .off
        }
        titleButton.isHidden = claudeState.map { $0.ready } ?? true
    }

    /// Once the panel is open: a look now, then the running Pako's word every 20 seconds (cheap: no command is run for it), which opens the
    /// window when Claude turns to not signed in. On the first run, while Claude is not ready, the window opens by itself, but not over the
    /// panel's welcome before it has said hello: then it waits for the welcome's word (userContentController).
    private func startClaudeWatch() {
        if claudeTimer == nil {
            checkClaude(fresh: false) { state in
                if state.ready { self.maybeOfferThings() }
                let firstRun = !self.runner.defaults.bool(forKey: "claudeConnectedOnce")
                guard firstRun, !self.connectShownThisLaunch, state == .notInstalled || state == .notSignedIn else { return }
                self.webView.callAsyncJavaScript("return !!document.getElementById('welcome')?.open;", arguments: [:], in: nil, in: .defaultClient) { r in
                    if case let .success(v) = r, (v as? Bool) == true { self.connectPending = true } else { self.showConnect() }
                }
            }
            claudeTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.watchServer() }
            }
        }
    }

    private func watchServer() {
        guard signedIn, !connecting else { return }
        serverStatus(fresh: false) { status in
            let now = status?["claude"] as? String
            let was = self.serverClaude
            self.serverClaude = now
            // Pako says Claude is not signed in (or gone) where it was fine: the app looks itself, and opens the window for it.
            guard let now = now, now == "login" || now == "missing", was != nil, was != now else { return }
            self.checkClaude(fresh: true) { state in
                if state == .notSignedIn || state == .notInstalled { self.showConnect() }
            }
        }
    }

    /// The running Pako's word on Claude, asked by the panel itself (its cookie) in the app's own script world: nil when the panel is not
    /// open or the Pako has no such route.
    private func serverStatus(fresh: Bool, then: @escaping ([String: Any]?) -> Void) {
        guard signedIn, let url = webView.url, isPanelURL(url, port: port) else { return then(nil) }
        let js = "const r = await fetch('/panel/api/claude' + (fresh ? '?fresh=1' : ''), {credentials: 'same-origin'});"
            + " if (!r.ok) return null; const j = await r.json(); return j.status || null;"
        webView.callAsyncJavaScript(js, arguments: ["fresh": fresh], in: nil, in: .defaultClient) { r in
            if case let .success(v) = r, let d = v as? [String: Any] { then(d) } else { then(nil) }
        }
    }

    /// The app's own look (the command, found anew; `claude auth status`) with the running Pako's word: the state the window and the menu show.
    private func checkClaude(fresh: Bool, then: ((ClaudeState) -> Void)? = nil) {
        claudeWork.async { [helper] in
            let found = helper.locate()
            let auth = found.bin.flatMap { helper.authStatus($0) }
            let origin = found.bin.map { helper.origin($0) }
            DispatchQueue.main.async {
                if found.restart { self.restartOwnPako() }
                self.serverStatus(fresh: fresh) { server in
                    if let c = server?["claude"] as? String { self.serverClaude = c }
                    self.claudeBin = found.bin
                    self.claudeAuth = auth
                    self.keySource = apiKeySource(appEnv: self.runner.env, server: server)
                    self.claudeNote = origin == .script ? self.texts.scriptClaude : origin == .given ? self.texts.givenClaude : nil
                    let state = Pako.claudeState(binary: found.bin != nil, auth: auth, server: server)
                    self.claudeState = state
                    if state == .plan {
                        self.runner.defaults.set(true, forKey: "claudeConnectedOnce")
                        self.askNotificationsOnce()
                    }
                    self.updateConnectItem()
                    self.refreshSettings()
                    if !self.connecting, let w = self.connectWindow, w.panel.isVisible {
                        self.step = .idle(state)
                        w.show(self.step, keySource: self.keySource, texts: self.texts, note: self.claudeNote, account: self.claudeAuth)
                        self.reportConnect()
                    }
                    then?(state)
                }
            }
        }
    }

    /// The Pako this app started, started again so it gets the PATH where `claude` now is. Never a Pako it did not start.
    private func restartOwnPako() {
        guard runner.child?.isRunning == true, !busy else { return }
        busy = true
        work.async { [runner] in
            runner.stopChild()
            DispatchQueue.main.async { self.busy = false; self.connect() }
        }
    }

    @objc private func showConnect() {
        if AppDelegate.headless { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        connectShownThisLaunch = true
        connectPending = false
        let w = connectWindow ?? makeConnectWindow()
        if !w.panel.isVisible {
            if !connecting { step = claudeState.map { .idle($0) } ?? .checking }
            w.show(step, keySource: keySource, texts: texts, note: claudeNote, account: claudeAuth)
            window.beginSheet(w.panel)
        }
        if !connecting { checkClaude(fresh: true) }
    }

    private func makeConnectWindow() -> ConnectWindow {
        let w = ConnectWindow()
        w.onPrimary = { [weak self] in self?.connectPrimary() }
        w.onSecondary = { [weak self] in
            guard let self = self else { return }
            if self.connecting { self.helper.cancel() } else { self.closeConnect() }
        }
        w.onOpenAgain = { [weak self] in
            if case .idle(.needsPlan) = self?.step, let u = URL(string: claudeUpgradeURL) { NSWorkspace.shared.open(u); return }
            if case let .signingIn(page?, _, _, _) = self?.step, loginPageURL(page.absoluteString) != nil { NSWorkspace.shared.open(page) }
        }
        w.onCode = { [weak self] pasted in
            // The code goes from the field to the sign-in's stdin, off the main thread; it is not kept, logged or shown anywhere.
            guard let self = self, case .signingIn = self.step, let code = cleanLoginCode(pasted) else { return }
            self.claudeSend.async { [helper = self.helper] in _ = helper.sendCode(code) }
        }
        w.onConnections = { [weak self] in
            self?.closeConnect()
            self?.openConnectionsCard()
        }
        connectWindow = w
        return w
    }

    private func closeConnect() {
        guard let w = connectWindow, w.panel.isVisible else { return }
        window.endSheet(w.panel)
    }

    private func setStep(_ s: ConnectStep) {
        step = s
        connectWindow?.show(s, keySource: keySource, texts: texts, note: claudeNote, account: claudeAuth)
    }

    private func connectPrimary() {
        // The failure the window shows decides what Try again does: an old or foreign `claude` gets Anthropic's installer again.
        var reinstall = false
        switch step {
        case .connected: return closeConnect()
        case let .idle(state) where state.ready: return closeConnect()
        case .idle(.unknown), .idle(.needsPlan): setStep(.checking); return checkClaude(fresh: true)
        case let .installFailed(tail), let .signInFailed(tail):
            reinstall = [.oldVersion, .notAnthropic].contains(connectFailure(tail))
        default: break
        }
        guard !connecting else { return }
        connecting = true
        // A Cancel from here on holds, even one pressed while Claude is still being looked for (before the installer or the sign-in starts):
        // the window is busy at once, so its second button reads Cancel.
        helper.cancelled = false
        setStep(.checking)
        // The owner's address for Claude's page: this Mac's Me card (only when the contacts are already shared), else what the running Pako
        // knows (its mail settings, GET /panel/api/claude/connect).
        serverEmailHint { hint in self.connectWork(reinstall: reinstall, email: meCardEmail() ?? hint) }
    }

    /// What Pako knows of the owner's address (the connect route's emailHint), or nil without a panel or an older Pako.
    private func serverEmailHint(_ then: @escaping (String?) -> Void) {
        guard signedIn, let url = webView.url, isPanelURL(url, port: port) else { return then(nil) }
        let js = "const r = await fetch('/panel/api/claude/connect', {credentials: 'same-origin'}); if (!r.ok) return null; return (await r.json()).emailHint || null;"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .defaultClient) { r in
            if case let .success(v) = r, let s = v as? String, !s.isEmpty { then(s) } else { then(nil) }
        }
    }

    private func connectWork(reinstall: Bool, email: String?) {
        claudeWork.async { [helper] in
            let say = { (s: ConnectStep) in DispatchQueue.main.async { self.setStep(s) } }
            var found = helper.locate()
            if helper.cancelled { return self.connectEnded(nil) }
            if found.bin == nil || reinstall || (found.bin.map { !helper.recentEnough($0) } ?? false) {
                if let err = helper.install(step: say) { return self.connectEnded(.installFailed(tail: err)) }
                if helper.cancelled { return self.connectEnded(nil) }
                found = helper.locate()
            }
            if found.restart { DispatchQueue.main.async { self.restartOwnPako() } }
            guard let bin = found.bin else { return self.connectEnded(.installFailed(tail: "claude not found")) }
            // Never handed the person's sign-in unless it is Anthropic's (a script from npm, or CLAUDE_BIN, is let through and said so).
            if helper.origin(bin) == .foreign { return self.connectEnded(.signInFailed(tail: "notAnthropic")) }
            // Signed in already (in a terminal, or a moment ago): no browser page for nothing.
            if helper.authStatus(bin, withKey: false)?.loggedIn == true { return self.connectEnded(.connected) }
            if helper.cancelled { return self.connectEnded(nil) }
            if let err = helper.signIn(bin, email: email, step: say) {
                return self.connectEnded(err.isEmpty ? nil : .signInFailed(tail: err))
            }
            self.connectEnded(.connected)
        }
    }

    /// Back on the main thread: the outcome (nil: cancelled, the window shows how things are now). Connected: the running Pako is asked to look
    /// again at once (it would within 15 seconds by itself, and its waiting messages are tried again then), and the window closes a moment later.
    nonisolated private func connectEnded(_ s: ConnectStep?) {
        DispatchQueue.main.async {
            self.connecting = false
            guard let s = s else { self.setStep(.checking); return self.checkClaude(fresh: true) }
            self.setStep(s)
            guard s == .connected else { return }
            self.runner.defaults.set(true, forKey: "claudeConnectedOnce")
            // The plan check: a free plan cannot run Claude Code, so the window stays and says what to do instead of closing.
            self.checkClaude(fresh: true) { state in
                if state == .needsPlan { self.setStep(.idle(.needsPlan)) } else if case .connected = self.step { self.setStep(.connected) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                guard self.step == .connected else { return }
                self.closeConnect()
                self.maybeOfferThings()
            }
        }
    }

    /// The panel's Connections card, at connection `id` (Claude's API key, the advanced way, by default): the chat drawer closed and the
    /// Settings drawer opened on it (connections.js pakoOpenConnection), or Telegram's own card in view.
    private func openConnectionsCard(_ id: String = "claude") {
        guard signedIn else { return openPako() }
        // Settings already in the window: that card, on the same page.
        if let u = webView.url, isPanelURL(u, port: port), u.path == "/panel/settings" { return openPanelSettings("/panel/settings#\(id)") }
        let js = "const c = document.getElementById('chat'); if (c && c.classList.contains('open')) document.getElementById('chat-close')?.click();"
            + " if (typeof window.pakoOpenConnection === 'function' && window.pakoOpenConnection(id)) return true;"
            + " document.getElementById('cx-card')?.scrollIntoView({behavior: 'smooth', block: 'start'}); return false;"
        window.makeKeyAndOrderFront(nil)
        webView.callAsyncJavaScript(js, arguments: ["id": id], in: nil, in: .page, completionHandler: nil)
    }

    /// PAKO_APP_REPORT: the Connect Claude window as shown, once it has settled on a state: <path>-connect.png and <path>-connect.json (the
    /// state, whether the command was found and where a key is set; never an address or a token).
    private var connectReported = false
    private func reportConnect() {
        guard let base = AppDelegate.report, !connectReported, case let .idle(state) = step else { return }
        connectReported = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if let png = self.connectWindow?.snapshotPNG() { try? png.write(to: URL(fileURLWithPath: base + "-connect.png")) }
            let out: [String: Any] = ["state": state.rawValue, "binary": self.claudeBin != nil, "keySource": self.keySource ?? NSNull(),
                                      "text": self.texts.claude(state).text, "lang": "en"]
            if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: base + "-connect.json"))
            }
        }
    }
}
