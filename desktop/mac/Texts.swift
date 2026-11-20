// The app's few words, English like all of Pako's fixed texts (the owner's decision of 2026-11-18).

import Foundation

struct Texts {
    var open: String { "Open Pako" }
    var dashboard: String { "Dashboard" }
    var pause: String { "Pause everything (STOP)" }
    var resume: String { "Resume" }
    var pauseConfirm: String { "Stop everything? Pako does nothing on its own until you resume." }
    var autostart: String { "Start with this Mac" }
    var logs: String { "Logs" }
    var quit: String { "Quit Pako" }
    var about: String { "About Pako" }
    var hide: String { "Hide Pako" }
    var hideOthers: String { "Hide Others" }
    var showAll: String { "Show All" }
    var edit: String { "Edit" }
    var undo: String { "Undo" }
    var redo: String { "Redo" }
    var cut: String { "Cut" }
    var copy: String { "Copy" }
    var paste: String { "Paste" }
    var selectAll: String { "Select All" }
    var view: String { "View" }
    var reload: String { "Reload" }
    var window: String { "Window" }
    var minimize: String { "Minimize" }
    var close: String { "Close" }
    var ok: String { "OK" }
    var cancel: String { "Cancel" }
    var retry: String { "Try again" }
    var openLogs: String { "Open logs" }
    var choose: String { "Choose the Pako folder…" }
    var chooseTitle: String { "Where is Pako?" }
    var chooseMessage: String { "Choose the folder where you installed Pako (the one with package.json and src/server.ts)." }
    var starting: String { "Starting Pako…" }
    var startingLaunchd: String { "Starting the background Pako (autostart)…" }
    var signingIn: String { "Opening the panel…" }
    var downloaded: String { "Saved in Downloads" }

    // The self-contained app: where it runs from, its login item, an older LaunchAgent, its updates.
    var moveTitle: String { "Move Pako to Applications?" }
    var moveText: String { "Pako is open from the disk image or from Downloads. In Applications it keeps working after you eject the disk, and it can start with your Mac. A Pako already there goes to the Trash." }
    var moveButton: String { "Move to Applications" }
    var notNow: String { "Not now" }
    var moving: String { "Moving Pako to Applications…" }
    var moveFailed: String { "I couldn't move it. In the Finder, drag Pako to the Applications folder and open it from there." }
    var autostartNeedsMove: String { "To start with this Mac, Pako has to be in Applications: it is open from the disk image or from Downloads now." }
    var autostartOnText: String { "Pako will open by itself, in the menu bar, every time you log in." }
    var autostartOffText: String { "Pako won't open by itself when you log in any more." }
    var autostartApproval: String { "macOS asks for your permission: turn it on in System Settings > General > Login Items." }
    func autostartFailed(_ why: String) -> String { "I couldn't change it (\(why))." }
    var legacyTitle: String { "An older start-at-login is set up" }
    func legacyText(_ file: String, stale: Bool) -> String {
        stale ? "The file \(file) starts a Pako that is no longer there, and fails at every login. Remove it? It goes to the Trash."
              : "The file \(file) starts a Pako from a folder (npm run autostart). Pako for Mac replaces it: remove it? It goes to the Trash; a Pako already running keeps going until you log out."
    }
    var removeIt: String { "Remove it" }
    var keepIt: String { "Keep it" }
    func updateAvailable(_ version: String) -> String { "Update available: Pako \(version)…" }

    // The Connect Claude window (Claude.swift, Connect.swift) and its menu line.
    var connectMenu: String { "Connect Claude…" }
    func connectedMenu(_ detail: String?) -> String {
        let base = "Connected to your Claude plan"
        return detail.map { "\(base) (\($0))" } ?? base
    }
    var connectTitle: String { "Connect your Claude account" }
    var connectLead: String { "Use your Claude subscription. No API key." }
    /// The Connect window's other way in: the panel's demo week (src/demo.ts), invented data, nothing sent.
    var tryDemo: String { "Try the demo week" }
    var connect: String { connectTitle }
    func planWord(_ plan: String) -> String { "\(plan) plan" }
    var upgrade: String { "Upgrade your plan" }
    var apiBilling: String { "Connected (API billing)" }
    var checkAgain: String { "Check again" }
    var done: String { "Done" }
    var continueCode: String { "Continue" }
    var codePlaceholder: String { "Code from Claude's page" }
    var openAgain: String { "Open the sign-in page again" }
    var openConnections: String { "Open Connections" }
    var useKey: String { "API key (advanced)" }

    func step(_ s: ConnectStep) -> (title: String, text: String) {
        switch s {
        case .checking: return ("Checking Claude…", "")
        case let .idle(state): return claude(state)
        case .downloading: return ("Installing Claude Code…", "From Anthropic (claude.ai).")
        case let .installing(_, s): return ("Installing Claude Code… \(s) s",
                                            "About 100 MB, in your user folder. It takes a minute or two.")
        case .installFailed: return ("The installation did not finish", "This is the last thing it said:")
        case let .signingIn(_, code, _, _):
            return ("Finish signing in in your browser…",
                    code ? "Sign in in your browser. If it shows a code, paste it here:"
                         : "Sign in with your Claude account (Pro or Max) on Claude's page, then come back: this window carries on by itself.")
        case .signInFailed: return ("The sign-in didn't finish",
                                    "No problem: press Try again whenever you like.")
        case .connected: return ("Connected", "Pako now uses your Claude plan.")
        }
    }

    func claude(_ s: ClaudeState) -> (title: String, text: String) {
        switch s {
        case .notInstalled: return (connectTitle, "Pako installs Claude Code (from Anthropic) in your user folder and opens Claude's sign-in page in your browser.")
        case .notSignedIn: return (connectTitle, "Claude's sign-in page opens in your browser. Sign in and come back: this window carries on by itself.")
        case .needsPlan: return ("Claude Code needs a Pro, Max or Team plan",
                                 "This account is on the free plan. Upgrade it, then press Check again.")
        case .plan: return ("Connected", "")
        case .apiKey: return (apiBilling, "Not your Claude plan: the key is paid by use.")
        case .limit: return ("Usage limit reached", "Your Claude plan has reached its limit for now: Pako tries again by itself.")
        case .unknown: return (connectTitle, "Pako could not tell whether Claude is ready.")
        }
    }

    /// ANTHROPIC_API_KEY wins over the plan (https://code.claude.com/docs/en/iam): where it is set, and what to do.
    func keyWarning(_ source: String) -> String {
        let where_: String
        switch source {
        case "connections": where_ = "in Pako's Connections card"
        case "app": where_ = "in this app's environment"
        default: where_ = "in Pako's settings (your shell, ~/.pako/.env or the Pako folder's .env)"
        }
        return "ANTHROPIC_API_KEY is set \(where_): it wins over your plan and is paid by use. Remove it to use your plan."
    }

    func problem(_ p: PakoProblem) -> (title: String, text: String) {
        switch p {
        // A developer build only (a release runs the server and Node.js inside it): these may name folders and commands.
        case .noRepo:
            return ("Pako not found",
                    "Choose the folder where you installed it. If you do not have it yet, see docs/install.md.")
        case .noNode:
            return ("Node.js is missing",
                    "Pako needs Node.js 22.18 or newer. Install it from nodejs.org (or with brew install node), then press Try again.")
        case let .oldNode(found, path):
            return ("Node.js is too old",
                    "Found \(found) at \(path); Pako needs 22.18 or newer. Update it (nodejs.org, brew upgrade node or nvm install 22), then press Try again.")
        case let .notStarted(_, why):
            switch why {
            case let .portInUse(port):
                let which = port > 0 ? " \(port)" : ""
                return ("Pako couldn't start",
                        "Another program is using the port\(which) Pako needed. Press Try again: Pako will look for a free one.")
            case .settings:
                return ("A setting is written wrong",
                        "Pako won't start because of a setting in its .env file. Press Open logs: the last line says which one.")
            case .held:
                return ("Pako is already running",
                        "Another Pako is using your data right now and isn't answering this app. Press Restart Pako to stop it and start again.")
            case .unknown:
                return ("Pako couldn't start",
                        "Press Try again. If it happens again, press Open logs and send the file app.log to whoever helps you.")
            }
        case .keepsStopping:
            return ("Pako keeps stopping",
                    "I started it three times and it stopped again. Press Try again, or Open logs and send app.log to whoever helps you.")
        case .webGone:
            return ("The window stopped responding",
                    "macOS closed Pako's page several times (usually for lack of memory). Pako is still running: press Try again.")
        case let .olderPako(pid):
            return ("An older Pako is running",
                    "The running Pako (process \(pid)) is from an older version. Press Restart Pako to stop it and start this one.")
        case let .otherHome(port, home):
            return ("Another Pako",
                    "The Pako on port \(port) does not use the folder \(home): it was started with another one (PAKO_HOME).")
        case .tooManyLinks:
            return ("Too many tries",
                    "Too many links in a row: wait a few minutes, then press Try again.")
        case .staleLock:
            return ("Pako isn't answering",
                    "A trace of an earlier Pako was left behind (it closed abruptly). Press Restart Pako and I'll fix it.")
        case let .broken(_, why):
            let what = ["no answer": "it doesn't answer", "sign-in": "the sign-in link is not accepted",
                        "secrets.json": "its key is missing"][why] ?? why
            return ("Pako isn't answering properly",
                    "It is running, but \(what). Press Restart Pako to stop it and start it again.")
        }
    }

    // Keeping Pako running: a crash of the Pako the app started, restarted by itself.
    var restartPako: String { "Restart Pako" }
    func restarting(_ seconds: Int) -> String { "Pako stopped. Starting it again in \(seconds) s…" }
    var stoppedMenu: String { "Pako stopped: starting it again…" }
    var stoppedForGood: String { "Pako is stopped" }

    // Menus and windows of a Mac app.
    var settings: String { "Settings…" }
    var settingsTitle: String { "Pako Settings" }
    var appSettings: String { "App Settings…" }
    var panelSettingsTitle: String { "Settings" }
    var checkUpdates: String { "Check for Updates…" }
    var services: String { "Services" }
    var actualSize: String { "Actual Size" }
    var zoomIn: String { "Zoom In" }
    var zoomOut: String { "Zoom Out" }
    var fullScreen: String { "Enter Full Screen" }
    var zoom: String { "Zoom" }
    var bringAll: String { "Bring All to Front" }
    var help: String { "Help" }
    var pakoHelp: String { "Pako Help" }
    var reportProblem: String { "Report a Problem…" }
    var reportText: String { "Pako's logs folder opens. Send the file app.log to whoever helps you: it may quote one of your messages, so only send it to someone you trust." }
    var aboutCredits: String { "Your personal assistant, on your Mac. It uses your own Claude plan." }
    func statusLabel(unread: Int, stopped: Bool) -> String {
        let base = stopped ? "Pako (stopped)" : "Pako"
        return unread > 0 ? base + ", \(unread) unread" : base
    }

    // Settings.
    var claudeLabel: String { "Claude" }
    var notificationsLabel: String { "Notifications" }
    var notificationsOn: String { "Pako tells you about what it writes on its own (reminders, routines)." }
    var notificationsOff: String { "Notifications are turned off for Pako." }
    var notificationsAsk: String { "Pako hasn't asked to notify you yet." }
    var allowNotifications: String { "Allow Notifications…" }
    var openNotificationSettings: String { "Notification Settings…" }
    var updatesLabel: String { "Updates" }
    var autoUpdates: String { "Check for updates automatically" }
    var checkNow: String { "Check Now" }
    var noFeed: String { "This copy of Pako has no update address." }
    var checkingUpdates: String { "Checking…" }
    func upToDate(_ v: String) -> String { "You have the latest version (\(v))." }
    var updateFailed: String { "I couldn't check right now. Try again later." }
    var askBeforeQuit: String { "Ask before quitting" }
    var general: String { "General" }

    // Quitting stops the Pako the app started.
    var quitTitle: String { "Quit Pako?" }
    var quitText: String { "If you quit, Pako stops: your reminders and routines won't run until you open it again. Closing the window keeps it in the menu bar." }
    var keepRunning: String { "Keep Pako Running" }
    var quitAnyway: String { "Quit Anyway" }
    var dontAskAgain: String { "Don't ask again" }

    // Notifications of what Pako wrote by itself.
    var secretNotice: String { "Pako sent you a code: open it to see it." }
    func moreNotices(_ n: Int) -> String { "And \(n) more messages from Pako." }

    // Connect Claude: what went wrong, in plain words, with a way out; the code being checked; whose `claude` it is.
    /// A code refused while the sign-in still waits for one: pasted again in the same field (no Try again button then).
    var codeRefused: String {
        "That code isn't valid. Copy the whole code from Claude's page and paste it again."
    }
    var checkingCode: String { "Checking the code…" }
    var details: String { "Details" }
    var codeFieldLabel: String { "Claude sign-in code" }
    var updateClaude: String { "Update Claude" }
    func connectFailure(_ f: ConnectFailure) -> String {
        switch f {
        case .timeout: return "It took too long. Press Try again whenever you like."
        case .cancelled: return "The sign-in on Claude's page didn't finish. No problem: press Try again whenever you like."
        case .network: return "Anthropic can't be reached. Check your internet connection, then press Try again."
        case .invalidCode: return "That code isn't valid (or has expired). Press Try again to get a new one."
        case .oldVersion: return "Your Claude Code is old. Press Update Claude: Pako installs the new version."
        case .notFound: return "The installation finished but Claude can't be found. Press Try again."
        case .notAnthropic: return "The \"claude\" program on this Mac isn't signed by Anthropic, so it doesn't get your account. Remove it, or press Try again to install Anthropic's."
        case .other: return "Something went wrong. Press Try again; the details say what happened."
        }
    }
    var scriptClaude: String { "This Claude Code was installed with npm and carries no Anthropic signature: make sure it is yours." }
    var givenClaude: String { "Pako uses the Claude in CLAUDE_BIN, chosen in its settings." }
    // Installing an update (Update.swift): asked, never silent; its progress; why it failed (the app in use keeps running).
    func updateTitle(_ v: String) -> String { "Pako \(v) is available" }
    func updateOffer(_ current: String) -> String {
        "You have \(current). Pako downloads it, checks that it is genuine, installs it and restarts; your data (~/.pako) is not touched. The version you have goes to the Trash."
    }
    var updateNow: String { "Update" }
    var later: String { "Later" }
    var whatsNew: String { "What's New" }
    var openDownloadPage: String { "Open the Download Page" }
    func downloading(_ done: Int64, _ total: Int64) -> String {
        let mb = { (n: Int64) in String(format: "%.1f", Double(n) / 1_000_000) }
        return total > 0 ? "Downloading… \(mb(done)) of \(mb(total)) MB"
            : "Downloading… \(mb(done)) MB"
    }
    var verifyingUpdate: String { "Checking that the download is genuine…" }
    var installingUpdate: String { "Installing…" }
    var restartingUpdate: String { "Installed. Restarting Pako…" }
    var restartByHand: String { "Installed, but I couldn't open it myself. Quit Pako and open it again." }
    var updateFailedTitle: String { "The update wasn't installed" }
    var keepsRunning: String { "Pako keeps running the version you have." }
    func needsMacOS(_ minimum: String) -> String {
        "This version needs macOS \(minimum) or later. Update macOS (System Settings > General > Software Update), then try again."
    }
    func updateFailure(_ f: UpdateFailure) -> String {
        switch f {
        case let .cannotReplace(folder):
            return "I don't have permission to replace Pako in \(folder). Download the new version from its page and drag it to Applications yourself."
        case .mustMove: return "Pako is running from its install disk. Move it to Applications first."
        case .download: return "I couldn't download it. Check the internet connection and try again."
        case .tooLarge: return "The download is far larger than expected, so I won't install it."
        case .checksum: return "The download doesn't match the one Pako announced (its SHA-256 differs), so I won't install it. Try again later."
        case .feedSignature: return "The update announcement isn't signed with Pako's release key, so I won't install it."
        case .mount: return "I couldn't open the downloaded disk image."
        case .noApp: return "The disk image doesn't contain Pako."
        case .notTheSameApp: return "The downloaded app isn't the announced version, so I won't install it."
        case .notNewer: return "The downloaded version isn't newer than yours."
        case let .needsMacOS(m): return needsMacOS(m)
        case .architecture: return "This version doesn't run on this Mac's processor, so I won't install it. Your version keeps working."
        case .signature: return "The downloaded app's signature isn't valid, so I won't install it."
        case .team: return "The downloaded app isn't signed by Pako's developer, so I won't install it."
        case .noSpace: return "There's no room left on the disk to install it. Free some space and try again."
        case .install: return "Something went wrong while installing it. Try again; the logs say what happened."
        case .cancelled: return "Update cancelled."
        }
    }

    // Connect your things: the first run's step after Connect Claude (Connect.swift ThingsWindow), each one skippable.
    var thingsMenu: String { "Connect Your Things…" }
    var thingsTitle: String { "Connect your things" }
    var thingsLead: String {
        "Pako already works. This is optional and you can do it any time (Settings, the panel's gear): every step can be skipped."
    }
    func thingsCount(_ n: Int, _ of: Int) -> String { "Step \(n) of \(of)" }
    var thingConnected: String { "Connected" }
    var thingNotConnected: String { "Not connected" }
    var thingHalf: String { "Half set" }
    var telegramName: String { "Telegram (the chat on your phone)" }
    var telegramSteps: String {
        "The one chat that works with no server: you talk to Pako from your phone while this Mac is on.\n1) In Telegram, open @BotFather and send /newbot; pick a name.\n2) Copy the token it gives you.\n3) Press Connect in the Panel: paste the token in the Telegram card and scan its QR code with your phone."
    }
    var connectInPanel: String { "Connect in the Panel" }
    var skip: String { "Skip" }
    var next: String { "Next" }
    var finishLater: String { "Finish Later" }
}
