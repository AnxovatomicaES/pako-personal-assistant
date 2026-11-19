// The Connect Claude window (Connect.swift) in each state the one-button flow shows, drawn by the real ConnectWindow with the app's own words
// (Texts): one line per state with its title, text and visible buttons, and with a folder as the first argument, a PNG of each (the app's
// own snapshot, as PAKO_APP_REPORT writes -connect.png). No `claude` is run: the states are given, as App.swift's setStep gives them.
import AppKit

MainActor.assumeIsolated {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let shots = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
    let texts = Texts()
    let pro = ClaudeAuthStatus(loggedIn: true, method: "claude.ai", email: "ana@example.com", plan: "pro")
    let free = ClaudeAuthStatus(loggedIn: true, method: "claude.ai", email: "ana@example.com", plan: "free")
    let states: [(String, ConnectStep, ClaudeAuthStatus?)] = [
        ("not-installed", .idle(.notInstalled), nil),
        ("signed-out", .idle(.notSignedIn), nil),
        ("installing", .installing(last: "Downloading Claude Code 2.1.327…", seconds: 20), nil),
        ("signing-in", .signingIn(page: URL(string: "https://claude.com/cai/oauth/authorize"), code: false, error: "", sent: 0), nil),
        ("connected", .connected, pro),
        ("already-connected", .idle(.plan), pro),
        ("api-billing", .idle(.apiKey), nil),
        ("needs-plan", .idle(.needsPlan), free),
        ("install-failed", .installFailed(tail: "curl: (6) Could not resolve host: downloads.claude.ai"), nil),
        ("cancelled", .signInFailed(tail: "Couldn't log in: No authorization code received"), nil),
    ]
    func fields(_ v: NSView) -> [NSTextField] { v.subviews.flatMap { (($0 as? NSTextField).map { [$0] } ?? []) + fields($0) } }
    func buttons(_ v: NSView) -> [NSButton] { v.subviews.flatMap { (($0 as? NSButton).map { [$0] } ?? []) + buttons($0) } }
    for (name, step, account) in states {
        let w = ConnectWindow()
        w.show(step, keySource: nil, texts: texts, account: account)
        let root = w.panel.contentView!
        let shown = fields(root).filter { !$0.isHidden && !$0.isEditable && !$0.stringValue.isEmpty }.map(\.stringValue)
        let pressable = buttons(root).filter { !$0.isHidden && !$0.title.isEmpty }.map(\.title)
        print("STATE \(name) | \(shown.joined(separator: " / ")) | buttons: \(pressable.joined(separator: ", "))")
        if let dir = shots, let png = w.snapshotPNG() {
            try? png.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("claude-connect-\(name).png")))
        }
    }
    exit(0)
}
