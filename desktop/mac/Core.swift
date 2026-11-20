// The rules the app shares with the rest of Pako, kept free of AppKit so a small test program (test/fixtures/mac-core/main.swift, compiled by
// test/mac-app.test.ts) can check them against bin/panel.cjs on the same files. Each one is a line-by-line copy of its JavaScript twin:
// if one changes, the other must too, or the app would look for Pako in another folder than `npm run panel` does.

import CryptoKit
import Darwin
import Foundation

/// JavaScript's parseInt(s, 10) for what a lock file holds: leading blanks, an optional sign, then as many digits as there are; nil for none.
func jsParseInt(_ s: String) -> Int? {
    var rest = Substring(s).drop(while: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
    var sign = 1
    if let c = rest.first, c == "-" || c == "+" {
        if c == "-" { sign = -1 }
        rest = rest.dropFirst()
    }
    let digits = rest.prefix(while: { $0.isASCII && $0.isNumber })
    guard !digits.isEmpty, let n = Int(digits.prefix(18)) else { return nil }
    return sign * n
}

private func firstMatch(_ pattern: String, _ text: String) -> [String?]? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = text as NSString
    guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (0..<m.numberOfRanges).map { i in
        let r = m.range(at: i)
        return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
}

/// bin/panel.cjs readEnvFile: the NAME=value lines of a .env file for the names asked, as Node's process.loadEnvFile reads them.
func readEnvFile(_ path: String, names: [String]) -> [String: String] {
    var out: [String: String] = [:]
    guard let data = FileManager.default.contents(atPath: path), let text = String(data: data, encoding: .utf8) else { return out }
    for line in text.components(separatedBy: "\n") {
        let l = line.hasSuffix("\r") ? String(line.dropLast()) : line
        guard let m = firstMatch(#"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$"#, l), let name = m[1], names.contains(name) else {
            continue
        }
        let value = (m[2] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let q = firstMatch(#"^(["'`])(.*?)\1(?:\s*#.*)?$"#, value) {
            out[name] = q[2] ?? ""
        } else {
            let cut = value.range(of: "#").map { String(value[..<$0.lowerBound]) } ?? value
            out[name] = cut.trimmingCharacters(in: .whitespaces)
        }
    }
    return out
}

/// bin/panel.cjs pakoHome: this process's PAKO_HOME, then the one in the home folder's .env, then the one in the Pako folder's .env; ~/.pako.
func pakoHome(env: [String: String], repo: String, userHome: String) -> String {
    let trimmed = { (s: String?) in (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    let first = trimmed(env["PAKO_HOME"]).isEmpty ? (userHome as NSString).appendingPathComponent(".pako") : trimmed(env["PAKO_HOME"])
    let inHome = readEnvFile((first as NSString).appendingPathComponent(".env"), names: ["PAKO_HOME"])
    let inRepo = readEnvFile((repo as NSString).appendingPathComponent(".env"), names: ["PAKO_HOME"])
    let given = env["PAKO_HOME"] ?? inHome["PAKO_HOME"] ?? inRepo["PAKO_HOME"]
    return trimmed(given).isEmpty ? first : trimmed(given)
}

struct PakoLock: Equatable {
    var pid: Int
    /// 0 when a Pako from before the port was written holds it.
    var port: Int
    var alive: Bool
}

/// bin/panel.cjs readLock (src/local.ts lockHome writes it): its process, its port and whether it still holds the folder; nil with no lock.
/// `isRunning` is kill(pid, 0) as Node does it: alive, or alive but someone else's (EPERM). As src/local.ts lockHolder (not panel.cjs, which
/// only reads), a lock that says when its process started (its fifth line) holds only while that process number still started then:
/// otherwise the number came round again to another program after a crash, and the lock is taken over instead of asking anyone to delete it.
func readLock(home: String, upSeconds: Double, isRunning: (Int) -> Bool = processExists, startOf: (Int) -> Int? = processStartTime) -> PakoLock? {
    guard let data = FileManager.default.contents(atPath: (home as NSString).appendingPathComponent(".lock")),
          let text = String(data: data, encoding: .utf8) else { return nil }
    let lines = text.components(separatedBy: "\n")
    guard let pid = jsParseInt(lines[0]), pid > 0 else { return nil }
    let port = lines.count > 1 ? (jsParseInt(lines[1]) ?? 0) : 0
    let up = lines.count > 2 ? lines[2] : ""
    // A lock from before the computer last restarted: that process number may be any program's now.
    let restarted = !up.isEmpty && up.allSatisfy({ $0.isASCII && $0.isNumber }) && upSeconds < (Double(up) ?? 0)
    var alive = !restarted && isRunning(pid)
    let started = lines.count > 4 ? lines[4] : ""
    if alive, !started.isEmpty, started.allSatisfy({ $0.isASCII && $0.isNumber }), let want = Int(started), let actual = startOf(pid) {
        alive = abs(actual - want) <= 2
    }
    return PakoLock(pid: pid, port: port > 0 && port < 65536 ? port : 0, alive: alive)
}

/// When process `pid` started, in whole seconds since 1970 (the kernel's own record, which an in-place restart with execve keeps); nil when
/// it cannot be told (gone, or another user's).
func processStartTime(_ pid: Int) -> Int? {
    guard pid > 0, pid <= Int(Int32.max) else { return nil }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid_t(pid), PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return Int(info.pbi_start_tvsec)
}

/// The full path of process `pid`'s program, or nil (gone, or another user's).
func processPath(_ pid: Int) -> String? {
    guard pid > 0, pid <= Int(Int32.max) else { return nil }
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let n = proc_pidpath(pid_t(pid), &buf, UInt32(buf.count))
    return n > 0 ? String(cString: buf) : nil
}

func processExists(_ pid: Int) -> Bool {
    guard pid > 0 && pid <= Int(Int32.max) else { return false }
    return kill(pid_t(pid), 0) == 0 || errno == EPERM
}

/// Whether process `pid` itself has a TCP socket listening on `port` (on any address). A live lock only says its process number exists: a
/// Pako that was killed leaves its lock, that number may be any program's later, and its port anyone's. Nothing is sent to a lock's port
/// (the bridge token, the panel's cookie) unless the lock's own process is the one listening there. False when it cannot be told (another
/// user's process): then nothing is sent either.
func processListens(pid: Int, port: Int) -> Bool {
    guard pid > 0, pid <= Int(Int32.max), port > 0, port < 65536 else { return false }
    let p = pid_t(pid)
    let stride = MemoryLayout<proc_fdinfo>.stride
    let size = proc_pidinfo(p, PROC_PIDLISTFDS, 0, nil, 0)
    guard size > 0 else { return false }
    // Room for a few more opened in between.
    var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(size) / stride + 32)
    let got = fds.withUnsafeMutableBytes { proc_pidinfo(p, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
    guard got > 0 else { return false }
    for fd in fds.prefix(Int(got) / stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
        var info = socket_fdinfo()
        let want = Int32(MemoryLayout<socket_fdinfo>.size)
        guard proc_pidfdinfo(p, fd.proc_fd, PROC_PIDFDSOCKETINFO, &info, want) == want, info.psi.soi_kind == SOCKINFO_TCP else { continue }
        let tcp = info.psi.soi_proto.pri_tcp
        // insi_lport holds the port in network byte order.
        if tcp.tcpsi_state == TSI_S_LISTEN, Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: tcp.tcpsi_ini.insi_lport))) == port { return true }
    }
    return false
}

/// How long the computer has been up, as Node's os.uptime() counts it on a Mac (since boot, sleep included): the lock holds that number.
func systemUptime() -> Double {
    var boot = timeval()
    var size = MemoryLayout<timeval>.size
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &boot, &size, nil, 0) == 0 else { return ProcessInfo.processInfo.systemUptime }
    return Date().timeIntervalSince1970 - (Double(boot.tv_sec) + Double(boot.tv_usec) / 1_000_000)
}

/// "v22.18.0" as (22, 18, 0); nil for anything that is not a version.
func nodeVersion(_ s: String) -> (Int, Int, Int)? {
    guard let m = firstMatch(#"^v?(\d+)\.(\d+)\.(\d+)"#, s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    return (Int(m[1] ?? "") ?? 0, Int(m[2] ?? "") ?? 0, Int(m[3] ?? "") ?? 0)
}

/// package.json's engines: node >= 22.18 (type stripping without a flag).
func nodeIsRecentEnough(_ v: (Int, Int, Int)) -> Bool {
    return v.0 > 22 || (v.0 == 22 && v.1 >= 18)
}

/// Only a sign-in link on this computer's own address is ever opened in the app (the server's answer is checked, not trusted).
func isLocalPanelLink(_ s: String, port: Int) -> Bool {
    guard let u = URL(string: s), isPanelURL(u, port: port) else { return false }
    return u.path.hasPrefix("/panel/")
}

/// A page of the Pako on `port`: plain http on 127.0.0.1 and that very port, the exact origin the app loads. No port known yet: nothing is.
/// Never "localhost" or [::1]: Pako listens on 127.0.0.1 only, and another account on this Mac can bind [::1] on the same port (a separate
/// socket) and answer "localhost" with a page that would then pass for the panel.
func isPanelURL(_ u: URL, port: Int?) -> Bool {
    guard let port = port, port > 0, u.scheme?.lowercased() == "http", u.host?.lowercased() == "127.0.0.1" else { return false }
    return u.port == port
}

/// The same for a frame's security origin (the message handler, the file chooser): http, 127.0.0.1, the panel's port.
func isPanelOrigin(protocol proto: String, host: String, port originPort: Int, port: Int?) -> Bool {
    guard let port = port, port > 0 else { return false }
    return proto.lowercased() == "http" && host == "127.0.0.1" && originPort == port
}

enum PanelNavigation: String { case allow, browser, refuse }

/// Where a navigation in the app's window goes: the panel's own pages (and the app's own about:blank pages, and a blob: the panel made)
/// stay; a link the person clicked to a website, a mail address, a phone number or an email in Apple Mail opens in the default browser or app; anything else
/// (file:, javascript:, data:, another port, a page's script or a frame moving on by itself) is refused.
func panelNavigation(_ u: URL, port: Int?, mainFrame: Bool, clicked: Bool) -> PanelNavigation {
    let scheme = u.scheme?.lowercased() ?? ""
    if scheme == "about" {
        let what = u.absoluteString.lowercased().dropFirst(6).prefix(while: { $0 != "?" && $0 != "#" })
        return what == "blank" || what == "srcdoc" ? .allow : .refuse
    }
    if isPanelURL(u, port: port) { return .allow }
    if scheme == "blob", let inner = URL(string: String(u.absoluteString.dropFirst(5))), isPanelURL(inner, port: port) { return .allow }
    // message: is Apple Mail's own link to one email (the panel's "Open in Apple Mail"): NSWorkspace hands it to Mail.app.
    if ["http", "https", "mailto", "tel", "message"].contains(scheme), mainFrame, clicked { return .browser }
    return .refuse
}

/// The PATH a login shell printed after the marker: what else its startup files print (on either stream) is left out.
let loginPathMarker = "__PAKO_PATH__"
func loginPathFrom(_ out: String) -> String {
    guard let r = out.range(of: loginPathMarker, options: .backwards) else { return "" }
    return String(out[r.upperBound...].prefix(while: { $0 != "\n" && $0 != "\r" }))
}

// MARK: Claude (the Connect Claude window, Claude.swift)

/// What `claude auth status --json` says (https://code.claude.com/docs/en/cli-reference): JSON, exit code 0 when signed in and 1 when not, its
/// `authMethod` one of none, claude.ai, oauth_token, api_key, api_key_helper or third_party. Read for these fields only; `email` and
/// `subscriptionType` are shown in the menu when there, never written anywhere.
struct ClaudeAuthStatus: Equatable {
    var loggedIn: Bool
    var method: String
    var email: String?
    var plan: String?
}

/// nil for anything that is not that answer (an older Claude Code without the command, an error, another exit code).
func parseAuthStatus(code: Int32, out: String) -> ClaudeAuthStatus? {
    guard code == 0 || code == 1 else { return nil }
    // Only the JSON object: a line a wrapper may print before it is left out.
    guard let start = out.firstIndex(of: "{"), let end = out.lastIndex(of: "}"), start < end,
          let obj = try? JSONSerialization.jsonObject(with: Data(out[start...end].utf8)) as? [String: Any] else { return nil }
    let method = obj["authMethod"] as? String
    let logged = obj["loggedIn"] as? Bool
    guard method != nil || logged != nil else { return nil }
    let text = { (k: String) -> String? in
        guard let s = (obj[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, s.count <= 200 else { return nil }
        return s
    }
    // The exit code is the documented word on being signed in; the fields only say how.
    let isIn = code == 0 && logged != false && method != "none"
    return ClaudeAuthStatus(loggedIn: isIn, method: isIn ? (method ?? "") : "none", email: isIn ? text("email") : nil,
                            plan: isIn ? text("subscriptionType") : nil)
}

/// Whether `claude --version` names a Claude Code that has `claude auth` (2.1.268 or newer, the first version the docs name for the JSON of
/// `claude auth status`). An older one might take "auth status" or "auth login" for a question to Claude and run it: it is never asked.
func hasAuthCommands(_ versionOut: String) -> Bool {
    guard let v = nodeVersion(versionOut.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    return v.0 > 2 || (v.0 == 2 && (v.1 > 1 || (v.1 == 1 && v.2 >= 268)))
}

/// How Claude is for Pako, as the window and the menu say it.
enum ClaudeState: String {
    /// needsPlan: signed in on the free plan, which cannot run Claude Code (it needs Pro, Max or Team).
    case notInstalled, notSignedIn, needsPlan, plan, apiKey, limit, unknown
    /// Ready: nothing to ask of the person (a key is their choice; the window still warns that it wins over the plan).
    var ready: Bool { self == .plan || self == .apiKey || self == .limit }
}

/// The app's own look (is the command there, what `claude auth status` says) with the running Pako's word (GET /panel/api/claude: its
/// `claude` and `auth`, and `key` when an API key is set for it). The app's own look wins on install and sign-in: it is fresher.
func claudeState(binary: Bool, auth: ClaudeAuthStatus?, server: [String: Any]?) -> ClaudeState {
    guard binary else { return .notInstalled }
    let said = server?["claude"] as? String
    if said == "limit" { return .limit }
    // An API key set for Pako wins over the plan in `claude -p` (https://code.claude.com/docs/en/iam, "Authentication precedence").
    if server?["key"] is String || server?["auth"] as? String == "key" { return .apiKey }
    if let a = auth {
        if !a.loggedIn { return .notSignedIn }
        switch a.method {
        case "claude.ai", "oauth_token": return a.plan?.lowercased() == "free" ? .needsPlan : .plan
        case "api_key", "api_key_helper", "third_party": return .apiKey
        default: return .unknown
        }
    }
    switch said {
    case "login": return .notSignedIn
    case "ok": return server?["auth"] as? String == "plan" ? .plan : .unknown
    default: return .unknown
    }
}

/// Where the API key that wins over the plan is set, for the window's warning: Pako's Connections card, Pako's environment (the shell, its
/// .env files), or this app's own environment (passed on to a Pako it starts). Only whether it is set: the value is never read.
func apiKeySource(appEnv: [String: String], server: [String: Any]?) -> String? {
    if let k = server?["key"] as? String, k == "connections" || k == "environment" { return k }
    let set = { (n: String) in !(appEnv[n] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN") ? "app" : nil
}

/// The folders to look in for `claude`, in order: the login shell's PATH, then where Claude Code's installers put it (the native installer's
/// ~/.local/bin, the older local install's ~/.claude/local, Homebrew's casks).
func claudeDirs(loginPath: String, home: String) -> [String] {
    mergePathDirs([loginPath.split(separator: ":").map(String.init),
                   [home + "/.local/bin", home + "/.claude/local", "/opt/homebrew/bin", "/usr/local/bin"]])
}

/// The `claude` to use: CLAUDE_BIN when it is set (as Pako does: that one or none), else the first executable `claude` in `dirs`.
func findClaude(given: String?, dirs: [String], isExecutable: (String) -> Bool) -> String? {
    let g = (given ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !g.isEmpty { return g.hasPrefix("/") && isExecutable(g) ? g : nil }
    for d in dirs where d.hasPrefix("/") {
        let p = (d as NSString).appendingPathComponent("claude")
        if isExecutable(p) { return p }
    }
    return nil
}

/// Folders in order, each once, empty and relative ones left out (a relative folder in a PATH means the current one: never wanted here).
func mergePathDirs(_ lists: [[String]]) -> [String] {
    var out: [String] = []
    for d in lists.joined() where d.hasPrefix("/") && !out.contains(d) { out.append(d) }
    return out
}

/// "ana@example.com · Pro plan" (or the plan alone, or the address alone): who is connected, for the window's Connected line.
func claudeAccountLine(_ a: ClaudeAuthStatus?, planWord: (String) -> String) -> String {
    guard let a = a, a.loggedIn else { return "" }
    let plan = (a.plan ?? "").isEmpty ? nil : planWord(a.plan!.prefix(1).uppercased() + a.plan!.dropFirst())
    return [a.email, plan].compactMap { $0 }.joined(separator: " · ")
}

/// An address for `claude auth login --email`: a plain one only (never anything that reads as a flag), else nil.
func cleanEmailHint(_ s: String) -> String? {
    let e = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard e.count <= 254, !e.hasPrefix("-"), e.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil else { return nil }
    return e
}

/// Where a free account picks a plan that includes Claude Code.
let claudeUpgradeURL = "https://claude.ai/upgrade"

/// Only Anthropic's installer, over https, from the documented address or where it moves to (https://code.claude.com/docs/en/setup).
let claudeInstallerURL = "https://claude.ai/install.sh"
func isInstallerURL(_ u: URL?) -> Bool {
    guard let u = u, u.scheme == "https", let host = u.host?.lowercased(), u.user == nil, u.password == nil else { return false }
    return host == "claude.ai" || host == "downloads.claude.ai"
}

/// The sign-in page `claude auth login` prints ("If the browser didn't open, visit: …"), for an "Open it again" button: https on Claude's own
/// sites only; nil when there is none.
func loginPageURL(_ out: String) -> URL? {
    guard let re = try? NSRegularExpression(pattern: #"https://[^\s"'<>]+"#) else { return nil }
    let ns = out as NSString
    for m in re.matches(in: out, range: NSRange(location: 0, length: ns.length)).reversed() {
        guard let u = URL(string: ns.substring(with: m.range)), u.scheme == "https", u.user == nil, let host = u.host?.lowercased() else { continue }
        if ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"].contains(host) || host.hasSuffix(".claude.com")
            || host.hasSuffix(".claude.ai") { return u }
    }
    return nil
}

/// The last lines a program printed, for the window: terminal colour codes and carriage-return progress dropped, at most `count` lines.
func outputTail(_ out: String, count: Int) -> String {
    let plain = out.replacingOccurrences(of: #"\u001B\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
    let lines = plain.components(separatedBy: "\n").map { l -> String in
        let last = l.components(separatedBy: "\r").last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? ""
        return last.trimmingCharacters(in: .whitespaces)
    }.filter { !$0.isEmpty }
    return lines.suffix(count).map { $0.count > 160 ? String($0.prefix(160)) + "…" : $0 }.joined(separator: "\n")
}

/// `claude auth login` asks for the code its sign-in page shows ("Paste code here if prompted > ", Claude Code 2.1.325: the page's redirect is
/// platform.claude.com/oauth/code/callback, which shows a code instead of handing it back by itself). Said without a newline, so it is looked
/// for anywhere in what it printed.
func loginAsksForCode(_ out: String) -> Bool {
    out.range(of: "paste code", options: .caseInsensitive) != nil || out.range(of: "paste the code", options: .caseInsensitive) != nil
}

/// The code as pasted, made ready to send: spaces, tabs and line breaks dropped wherever they are (a code copied across a line break, a
/// trailing newline). nil when nothing is left, or when it cannot be a code (control characters, or longer than any code).
func cleanLoginCode(_ pasted: String) -> String? {
    let code = String(String.UnicodeScalarView(pasted.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }))
    guard !code.isEmpty, code.count <= 2000, !code.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
    return code
}

// MARK: the self-contained app (a release build): its own Node.js and server, where it runs from, its updates

/// The server and Node.js inside the app (desktop/mac/package.sh puts them there): Contents/Resources/pako and Contents/Resources/node/bin/node.
/// nil for a developer build, which has neither and runs a Pako folder with the Mac's own node.
func bundledServer(resources: String?, isPakoFolder: (String) -> Bool, isExecutable: (String) -> Bool) -> (repo: String, node: String)? {
    guard let res = resources, res.hasPrefix("/") else { return nil }
    let repo = (res as NSString).appendingPathComponent("pako")
    let node = (res as NSString).appendingPathComponent("node/bin/node")
    return isPakoFolder(repo) && isExecutable(node) ? (repo, node) : nil
}

/// The app runs from where it cannot stay: the disk image (/Volumes/…, gone when ejected) or a randomized read-only copy macOS made of an app
/// opened from Downloads (App Translocation, …/AppTranslocation/…, gone after a restart). A login item or a server started from there breaks.
func needsMoveToApplications(_ bundlePath: String) -> Bool {
    bundlePath.contains("/AppTranslocation/") || bundlePath.hasPrefix("/Volumes/")
}

/// An older "Start with this Mac" (~/Library/LaunchAgents/local.pako.plist, written by `npm run autostart` or an older app) that can only
/// fail: the node or the server.ts it runs is gone, or it runs something inside an app bundle (which moves, is replaced or is deleted).
func legacyAgentIsStale(programArguments args: [String], exists: (String) -> Bool) -> Bool {
    let paths = args.filter { $0.hasPrefix("/") }
    guard !paths.isEmpty else { return true }
    return paths.contains { !exists($0) || $0.contains(".app/Contents/") }
}

/// "1.10.0" is newer than "1.9.3": dotted whole numbers compared one by one (missing parts are 0). Anything else is never newer, so a feed
/// with a malformed version offers nothing.
func isNewerVersion(_ candidate: String, than current: String) -> Bool {
    func parts(_ s: String) -> [Int]? {
        let p = s.trimmingCharacters(in: .whitespaces).split(separator: ".", omittingEmptySubsequences: false)
        guard !p.isEmpty, p.count <= 4 else { return nil }
        let n = p.map { $0.allSatisfy { $0.isASCII && $0.isNumber } && !$0.isEmpty && $0.count <= 9 ? Int($0) : nil }
        return n.contains { $0 == nil } ? nil : n.map { $0! }
    }
    guard let a = parts(candidate), let b = parts(current) else { return false }
    for i in 0..<max(a.count, b.count) {
        let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
        if x != y { return x > y }
    }
    return false
}

/// A release the feed names. `url` is the dmg to install (with `sha256`), or, in a feed with no checksum (the first format), a page to open
/// in the browser. `build` is the new app's CFBundleVersion, `minimumMacOS` its LSMinimumSystemVersion, `page` its release notes page.
struct UpdateInfo: Equatable {
    let version: String
    let build: Int?
    let url: URL
    let sha256: String?
    let minimumMacOS: String?
    let notes: String
    let page: URL?
    /// The feed's Ed25519 signature verifies against the public key this app carries (feedSignatureValid). The app offers nothing else.
    var signed: Bool = false
    /// The app can download, check and install it itself: a signed feed naming a dmg with its SHA-256. Otherwise only its page is opened.
    var installable: Bool { sha256 != nil && signed }
}

/// The fields a feed's signature covers, one per line in a fixed order (desktop/mac/feed-sign.ts, feedMessage, makes the same bytes): an
/// absent field is empty; one that is not a string (build: not a whole number) or holds a line break cannot be signed, and nil is answered.
func feedSignedMessage(_ obj: [String: Any]) -> Data? {
    var text = "pako-feed-v1\n"
    for k in ["version", "build", "url", "sha256", "minimumMacOS", "notes", "page"] {
        var s = ""
        if let v = obj[k] {
            if k == "build" {
                guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(),
                      n.doubleValue >= 1, n.doubleValue <= 1_000_000_000 else { return nil }
                s = String(n.intValue)
            } else {
                guard let str = v as? String else { return nil }
                s = str
            }
        }
        if s.contains("\n") || s.contains("\r") { return nil }
        text += "\(k)=\(s)\n"
    }
    return Data(text.utf8)
}

/// Whether the feed's "signature" (base64, 64 bytes) is a valid Ed25519 signature of feedSignedMessage by `publicKey` (base64 of the raw 32
/// bytes, Info.plist PakoFeedPublicKey, from desktop/mac/feed-key.pub). No key, no signature, or anything malformed: false. The SHA-256 in
/// the feed comes from the same place as the dmg; this signature is what ties both to the owner's key.
func feedSignatureValid(_ obj: [String: Any], publicKey: String?) -> Bool {
    guard let k = publicKey?.trimmingCharacters(in: .whitespacesAndNewlines), let raw = Data(base64Encoded: k), raw.count == 32,
          let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw), let s = obj["signature"] as? String,
          let sig = Data(base64Encoded: s), sig.count == 64, let msg = feedSignedMessage(obj) else { return false }
    return key.isValidSignature(sig, for: msg)
}

/// Where the app may fetch the feed or the dmg from: https anywhere, or (`loopback`: a check-only feed on this Mac, PAKO_APP_UPDATE_FEED in a
/// build that is not Developer ID signed) plain http on this computer's own address. Never a password in the address.
func isUpdateURL(_ u: URL?, loopback: Bool = false) -> Bool {
    guard let u = u, let host = u.host?.lowercased(), !host.isEmpty, u.user == nil, u.password == nil else { return false }
    if u.scheme?.lowercased() == "https" { return true }
    return loopback && u.scheme?.lowercased() == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)
}

/// The release feed (Info.plist PakoUpdateFeed, made by desktop/mac/feed.sh): JSON {"version", "build", "url" (the dmg), "sha256",
/// "minimumMacOS", "notes", "page"}; only "version" and "url" are required (the first format had only those and "notes"). A field that is
/// there but wrong (a checksum that is not 64 hex digits, a build that is not a whole number, a minimum that is not a version) refuses the
/// whole feed: a feed half understood offers nothing. Notes are cut to a line's worth. nil for anything else. `signed`: its "signature"
/// verifies against `publicKey` (the app offers only such a feed: App.swift).
func parseUpdateFeed(_ data: Data, loopback: Bool = false, publicKey: String? = nil) -> UpdateInfo? {
    guard data.count <= 64_000, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let v = obj["version"] as? String, isNewerVersion(v, than: "0"), let u = obj["url"] as? String,
          let url = URL(string: u), isUpdateURL(url, loopback: loopback) else { return nil }
    var sha: String?
    if let s = obj["sha256"] {
        guard let s = s as? String, s.count == 64, s.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        sha = s.lowercased()
    }
    var build: Int?
    if let b = obj["build"] {
        // JSON numbers come as NSNumber: a whole one only (1.5 or true is not a build number).
        guard let n = b as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(),
              n.doubleValue >= 1, n.doubleValue <= 1_000_000_000 else { return nil }
        build = n.intValue
    }
    var minimum: String?
    if let m = obj["minimumMacOS"] {
        guard let m = m as? String, isNewerVersion(m, than: "0") else { return nil }
        minimum = m.trimmingCharacters(in: .whitespaces)
    }
    let page = (obj["page"] as? String).flatMap { URL(string: $0) }.flatMap { isUpdateURL($0) ? $0 : nil }
    let notes = (obj["notes"] as? String ?? "").replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    return UpdateInfo(version: v.trimmingCharacters(in: .whitespaces), build: build, url: url, sha256: sha, minimumMacOS: minimum,
                      notes: String(notes.prefix(300)), page: page, signed: feedSignatureValid(obj, publicKey: publicKey))
}

/// Whether a release is newer than the running app: a newer version, or the same version with a higher build number (two builds of one
/// version). An older version is never newer, whatever its build.
func isNewerRelease(version: String, build: Int?, than current: String, currentBuild: Int?) -> Bool {
    if isNewerVersion(version, than: current) { return true }
    if isNewerVersion(current, than: version) { return false }
    // The same version (or one that is not a plain version: then isNewerVersion said no both ways, and it is not offered).
    guard isNewerVersion(version, than: "0"), let b = build, let c = currentBuild else { return false }
    return b > c
}

/// Whether this Mac's macOS (`current`, as ProcessInfo gives it) is at least `minimum` ("13.0", "14.2.1"); an unreadable minimum is not met.
func macOSAtLeast(_ minimum: String, current: OperatingSystemVersion) -> Bool {
    guard isNewerVersion(minimum, than: "0") else { return false }
    let now = "\(current.majorVersion).\(current.minorVersion).\(current.patchVersion)"
    return !isNewerVersion(minimum, than: now)
}


// MARK: Connect your things (the first run's step after Connect Claude, Connect.swift ThingsWindow)

/// One thing the step offers: the Connections card's id, name and steps (in the panel's language), and "on", "partial" or "off".
struct ThingItem: Equatable {
    let id: String
    let name: String
    let how: String
    let state: String
}

/// The order: Telegram first (the one chat that works with no server of your own), then Calendar, Mail, Slack and Zoom.
let thingOrder = ["telegram", "calendar", "mail", "slack", "zoom"]

/// What the panel answered (GET /panel/api/connections; GET /panel/api/telegram's state, nil when it did not answer): the five in order, with
/// the card's own words, Telegram "on" once a phone is paired and "partial" with a bot but no phone. nil when there is no Connections card (a
/// server's panel answers 404) or the answer is not one: then the step is not offered.
func parseThings(connections: Any?, telegram: Any?) -> [ThingItem]? {
    guard let list = (connections as? [String: Any])?["connections"] as? [[String: Any]] else { return nil }
    let text = { (d: [String: Any], k: String) -> String in String((d[k] as? String ?? "").prefix(1200)) }
    var out: [ThingItem] = []
    for id in thingOrder {
        guard let d = list.first(where: { $0["id"] as? String == id }) else { continue }
        var state = ["on", "partial", "off"].contains(d["state"] as? String ?? "") ? d["state"] as! String : "off"
        if id == "telegram" {
            let t = (telegram as? [String: Any])?["state"] as? String
            state = t == "paired" ? "on" : t == "unpaired" ? "partial" : "off"
        }
        out.append(ThingItem(id: id, name: text(d, "name"), how: text(d, "how"), state: state))
    }
    return out.isEmpty ? nil : out
}

// MARK: keeping Pako running (App.swift supervises the Pako it started)

/// How long to wait before starting again a Pako that stopped by itself, the `failures`-th time in a row (a run of five minutes or more
/// starts the count again): 1, 2 then 4 seconds; nil from the fourth, when it keeps stopping and the window says so instead (with its log).
func restartDelay(failures: Int) -> Double? {
    guard failures >= 1, failures <= 3 else { return nil }
    return min(60, pow(2, Double(failures - 1)))
}

/// Why a Pako did not start, read from the end of its log (src/server.ts and src/local.ts say these in plain words): the port taken, a wrong
/// setting in a .env file, the folder held by another Pako, or nothing known.
enum StartFailure: Equatable {
    case portInUse(Int)
    case settings
    case held
    case unknown
}

func startFailure(logTail: String) -> StartFailure {
    if let m = logTail.range(of: #"Port (\d{1,5}) is already in use"#, options: .regularExpression) {
        let digits = logTail[m].filter { $0.isASCII && $0.isNumber }
        return .portInUse(Int(digits) ?? 0)
    }
    if logTail.contains("EADDRINUSE") { return .portInUse(0) }
    if logTail.contains("Pako cannot start: a setting") || logTail.contains("could not read") && logTail.contains(".env") { return .settings }
    if logTail.contains("Pako is already running for this folder") || logTail.contains("Pako is already starting for this folder") { return .held }
    return .unknown
}

/// Whether nothing listens on 127.0.0.1:`port` now (a bind that is let go at once; SO_REUSEADDR as Node sets it, so a connection that has
/// just closed does not count as taken).
func loopbackPortIsFree(_ port: Int) -> Bool {
    guard port > 0, port < 65536 else { return false }
    return bindLoopback(port) != nil
}

/// A port nothing listens on, chosen by the system (bind to port 0), or nil.
func freeLoopbackPort() -> Int? { bindLoopback(0) }

private func bindLoopback(_ port: Int) -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard ok == 0 else { return nil }
    var got = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &got) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
    let p = Int(UInt16(bigEndian: got.sin_port))
    return p > 0 ? p : nil
}

/// Rotates a log that has grown past `limit` bytes: <log>.2 becomes .3 (the old .3 goes), .1 becomes .2, and the log's contents go to .1;
/// the log itself is then emptied in place, not replaced, so a Pako still writing to it (opened for appending) goes on in the same file.
/// Files keep mode 600 (they may quote a message). True when it rotated.
@discardableResult
func rotateLog(_ path: String, limit: Int, keep: Int = 3) -> Bool {
    let fm = FileManager.default
    guard let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? Int, size > limit, keep >= 1 else { return false }
    try? fm.removeItem(atPath: "\(path).\(keep)")
    if keep > 1 { for i in stride(from: keep - 1, through: 1, by: -1) { try? fm.moveItem(atPath: "\(path).\(i)", toPath: "\(path).\(i + 1)") } }
    guard (try? fm.copyItem(atPath: path, toPath: "\(path).1")) != nil else { return false }
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: "\(path).1")
    return truncate(path, 0) == 0
}

/// The last `bytes` of a file as text (a log's end), "" when it cannot be read.
func fileTail(_ path: String, bytes: Int) -> String {
    guard let h = FileHandle(forReadingAtPath: path) else { return "" }
    defer { try? h.close() }
    let end = h.seekToEndOfFile()
    h.seek(toFileOffset: end > UInt64(bytes) ? end - UInt64(bytes) : 0)
    return String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
}

// MARK: what Pako wrote by itself (GET /panel/api/notices): notifications and the Dock badge

struct Notice: Equatable {
    let n: Int
    let at: Double
    let text: String
    let secret: Bool
}

/// The server's answer: its clock (ms) and the notices; nil for anything else.
func parseNotices(_ data: Data) -> (now: Double, notices: [Notice])? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let now = obj["now"] as? Double,
          let list = obj["notices"] as? [[String: Any]] else { return nil }
    let notices = list.compactMap { d -> Notice? in
        guard let n = d["n"] as? Int, let at = d["at"] as? Double else { return nil }
        return Notice(n: n, at: at, text: d["text"] as? String ?? "", secret: d["secret"] as? Bool ?? false)
    }
    return (now, notices)
}

/// From the notices after the older of the two marks: the ones not notified yet (newer than `notifiedAt`) and how many are unread (newer
/// than `readAt`, the last time the person had the chat open in front of them).
func noticeCounts(_ notices: [Notice], notifiedAt: Double, readAt: Double) -> (fresh: [Notice], unread: Int) {
    (notices.filter { $0.at > notifiedAt }, notices.filter { $0.at > readAt }.count)
}

// MARK: Connect Claude: what went wrong, in the person's words; and whose `claude` it is

/// What a failed install or sign-in said, sorted into the cases the window explains (Texts.connectFailure) with its own way out.
enum ConnectFailure: String {
    case timeout, network, invalidCode, oldVersion, notFound, notAnthropic, cancelled, other
}

func connectFailure(_ tail: String) -> ConnectFailure {
    let t = tail.lowercased()
    if t == "notanthropic" { return .notAnthropic }
    if t.contains("older than") || t.contains("claude update") { return .oldVersion }
    if t.contains("invalid code") || t.contains("invalid authorization code") || t.contains("code expired") { return .invalidCode }
    if t.contains("(15 min)") || t.hasSuffix(" 5 min") || t == "5 min" || t.hasSuffix("10 min") || t.contains("timed out") { return .timeout }
    // Claude Code 2.1.327 says this when the person cancels (or closes) Claude's page: a calm retry, not an error.
    if t.contains("no authorization code") { return .cancelled }
    if t.contains("not found") { return .notFound }
    for word in ["could not resolve", "no answer", "offline", "network", "internet", "connection", "curl: (6)", "curl: (7)", "ssl"] where t.contains(word) {
        return .network
    }
    return .other
}

/// Anthropic's Developer ID team: Claude Code's native binary is signed by it (checked: 2.1.325 in ~/.local/share/claude/versions).
let anthropicTeamID = "Q6L2SF6YDW"
/// The code requirement `codesign --verify -R` checks a `claude` against before the app hands it the person's sign-in.
let anthropicRequirement = "=anchor apple generic and certificate leaf[subject.OU] = \"\(anthropicTeamID)\""

/// Whether the file starts like a Mach-O program (thin or universal); a script (an npm install's cli.js) does not.
func isMachO(_ path: String) -> Bool {
    guard let h = FileHandle(forReadingAtPath: path) else { return false }
    defer { try? h.close() }
    let d = h.readData(ofLength: 4)
    guard d.count == 4 else { return false }
    let magic = d.withUnsafeBytes { $0.load(as: UInt32.self) }
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].contains(magic)
}

/// FNV-1a (64 bits) of a text, in hex: the same in every run (Swift's own hashValue changes at each launch), for naming the settings of a
/// run with its own PAKO_HOME (Pako.swift) so a later run with that home finds them again.
func stableHash(_ s: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    return String(h, radix: 16)
}
