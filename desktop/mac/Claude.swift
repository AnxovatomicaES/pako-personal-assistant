// Claude for Pako, set up from the app: the person connects the Claude account they already use (Claude Desktop, claude.ai: a Pro, Max, Team or
// Enterprise plan) in two clicks, without a terminal and without having to know that Pako runs Claude Code underneath.
//
// Pako's brain is the `claude` command (Claude Code). Claude Desktop alone does not give one a third-party app may use: its sign-in is its own,
// and nothing here reads it (nor any credential, Keychain item or file of Claude's). So the app does, at the person's click, what Anthropic's
// docs tell a person to do in a terminal (https://code.claude.com/docs/en/setup, https://code.claude.com/docs/en/iam):
//   1. installs Claude Code with the official installer (https://claude.ai/install.sh: into ~/.local/bin, no administrator rights);
//   2. runs `claude auth login --claudeai`, Claude's own sign-in, which opens the browser on Claude's site: the password and the token never
//      pass through the app. When Claude's page shows a code to paste back (Claude Code 2.1.325 does), the window has a field for it and the
//      code goes straight to the sign-in's stdin, never logged nor kept;
//   3. asks `claude auth status` every two seconds until it says signed in.
// Everything here may wait (a download, a sign-in of up to ten minutes): it runs off the main thread; AppKit only hears the outcome.

import Foundation

/// A program run with its output read as it comes (the installer's progress), stopped by `stop()` or when it outlives its time. With `input`,
/// its stdin is a pipe kept open for `send` (the sign-in's code); its error output is also kept apart (`errors`).
final class Streamed: @unchecked Sendable {
    let process = Process()
    private let lock = NSLock()
    private var data = Data()
    private var errData = Data()
    private var errDropped = 0
    private let done = DispatchSemaphore(value: 0)
    private var input: FileHandle?

    init(_ exe: String, _ args: [String], cwd: String, env: [String: String], input wantsInput: Bool = false) {
        process.executableURL = URL(fileURLWithPath: exe)
        process.arguments = args
        process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        process.environment = env
        // No terminal: neither the installer nor `claude auth login` needs one. Checked with Claude Code 2.1.325: `claude auth login` with stdin
        // a pipe and no TTY prints the page's address and "Paste code here if prompted > ", and reads the code from that pipe ("invalid-test-code"
        // written there: "Invalid code. Please make sure the full code was copied." on stderr, and it waits for another).
        if wantsInput {
            let inPipe = Pipe()
            process.standardInput = inPipe
            input = inPipe.fileHandleForWriting
        } else {
            process.standardInput = FileHandle.nullDevice
        }
        let pipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = pipe
        process.standardError = errPipe
        for (h, isErr) in [(pipe.fileHandleForReading, false), (errPipe.fileHandleForReading, true)] {
            h.readabilityHandler = { [weak self] h in
                let chunk = h.availableData
                guard let self = self else { return }
                if chunk.isEmpty { h.readabilityHandler = nil; return }
                self.lock.lock()
                self.data.append(chunk)
                if isErr { self.errData.append(chunk) }
                // The end is what counts (the last line, the error): the start of a long output is let go.
                if self.data.count > 400_000 { self.data.removeFirst(self.data.count - 200_000) }
                if self.errData.count > 400_000 {
                    let n = self.errData.count - 200_000
                    self.errData.removeFirst(n)
                    self.errDropped += n
                }
                self.lock.unlock()
            }
        }
        process.terminationHandler = { [weak self] _ in self?.done.signal() }
    }

    func start() -> Bool { (try? process.run()) != nil }
    var output: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    /// What it wrote on stderr since `errorCount` was `mark` (counted from its start, not from what is still kept).
    func errors(from mark: Int) -> String {
        lock.lock(); defer { lock.unlock() }
        let skip = max(0, mark - errDropped)
        return skip >= errData.count ? "" : String(decoding: errData.suffix(from: errData.startIndex + skip), as: UTF8.self)
    }
    var errorCount: Int { lock.lock(); defer { lock.unlock() }; return errDropped + errData.count }

    /// Writes `text` to its stdin (a pipe it was started with). false when it cannot (no pipe, or it has ended: the app ignores SIGPIPE, so
    /// that is an error here, never the app's end). What is written is never kept here.
    func send(_ text: String) -> Bool {
        lock.lock(); let h = input; lock.unlock()
        guard let h = h, process.isRunning else { return false }
        do { try h.write(contentsOf: Data(text.utf8)); return true } catch { return false }
    }
    var running: Bool { process.isRunning }

    /// Waits up to `seconds` for it to end: true when it has.
    func wait(_ seconds: Double) -> Bool {
        guard done.wait(timeout: .now() + seconds) == .success else { return false }
        // Signalled again: every later wait sees it has ended too.
        done.signal()
        return true
    }

    func stop() {
        lock.lock(); let h = input; input = nil; lock.unlock()
        try? h?.close()
        guard process.isRunning else { return }
        process.terminate()
        if !wait(3), process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
}

/// What the window shows while it works; each step says itself (Texts) and the app's window follows it.
enum ConnectStep: Equatable {
    case checking
    case idle(ClaudeState)
    case downloading
    case installing(last: String, seconds: Int)
    case installFailed(tail: String)
    /// `code`: it asks for the code Claude's page shows (the window offers a field for it); `error`: its last error line since the last code sent;
    /// `sent`: how many codes were sent so far, so that the same refusal of a second code is still a new step (the window opens its field again).
    case signingIn(page: URL?, code: Bool, error: String, sent: Int)
    case signInFailed(tail: String)
    case connected
}

final class ClaudeHelper: @unchecked Sendable {
    let runner: PakoRunner
    private let lock = NSLock()
    private var current: Streamed?
    private var signing: Streamed?
    private var errorMark = 0
    private var codesSent = 0
    private var _cancelled = false
    var cancelled: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _cancelled }
        set { lock.lock(); _cancelled = newValue; lock.unlock() }
    }

    init(runner: PakoRunner) { self.runner = runner }

    /// Stops what is under way (the installer, the sign-in) at once: Cancel, the window closed, the app quitting.
    func cancel() {
        cancelled = true
        lock.lock(); let c = current; lock.unlock()
        c?.stop()
    }

    private func use(_ s: Streamed?) { lock.lock(); current = s; lock.unlock() }

    // MARK: finding it

    /// CLAUDE_BIN as Pako reads it (this app's environment, then the Pako home's .env, then the Pako folder's .env): when set, that one or none.
    private var givenBin: String? {
        if let v = runner.env["CLAUDE_BIN"] { return v }
        let names = ["CLAUDE_BIN"]
        if let v = readEnvFile((runner.home as NSString).appendingPathComponent(".env"), names: names)["CLAUDE_BIN"] { return v }
        if let repo = runner.repo, let v = readEnvFile((repo as NSString).appendingPathComponent(".env"), names: names)["CLAUDE_BIN"] { return v }
        return nil
    }

    /// The `claude` command, looked for anew each time (the login shell's PATH read again, then the installers' folders), so one installed a
    /// moment ago is found without restarting anything. The second value: the Pako this app started must be started again to find it.
    func locate() -> (bin: String?, restart: Bool) {
        let exec = { (p: String) in FileManager.default.isExecutableFile(atPath: p) }
        // Where Claude Code's installers put it first: no login shell (slow with heavy startup files, which may also touch folders macOS then
        // asks about on Pako's behalf). Only when it is in none of them is the login shell's PATH read (a custom install, a version manager).
        var bin = findClaude(given: givenBin, dirs: claudeDirs(loginPath: "", home: runner.userHome), isExecutable: exec)
        if bin == nil, (givenBin ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            bin = findClaude(given: nil, dirs: claudeDirs(loginPath: runner.loginPath(), home: runner.userHome), isExecutable: exec)
        }
        guard let bin = bin else { return (nil, false) }
        return (bin, runner.addToPath((bin as NSString).deletingLastPathComponent))
    }

    /// Whose `claude` this is, before it is given the person's sign-in (and later every message): Anthropic's signed program (its real file,
    /// links followed, checked with codesign against Anthropic's team), a script (an npm install of Claude Code: it cannot carry a signature,
    /// so the window says so), CLAUDE_BIN (the person's own choice, also said), or a program signed by anyone else or by no one: refused.
    enum Origin { case anthropic, script, given, foreign }
    func origin(_ bin: String) -> Origin {
        if !(givenBin ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return .given }
        let real = URL(fileURLWithPath: bin).resolvingSymlinksInPath().path
        guard isMachO(real) else { return .script }
        let r = run("/usr/bin/codesign", ["--verify", "--strict", "-R", anthropicRequirement, real], timeout: 30)
        return r?.code == 0 ? .anthropic : .foreign
    }

    private func env(withKey: Bool) -> [String: String] {
        var e = runner.env
        e["HOME"] = runner.userHome
        e["PATH"] = runner.path.isEmpty ? "/usr/bin:/bin:/usr/sbin:/sbin" : runner.path
        e["NO_COLOR"] = "1"
        // A sign-in is the plan's: a key in the app's environment would only confuse it (it still wins later, and the window says so).
        if !withKey { e["ANTHROPIC_API_KEY"] = nil; e["ANTHROPIC_AUTH_TOKEN"] = nil }
        return e
    }

    /// `claude auth status` (JSON by default, https://code.claude.com/docs/en/cli-reference), read for the few fields parseAuthStatus keeps.
    /// `withKey` false: as the sign-in sees it (an API key in this app's environment would otherwise count as signed in).
    func authStatus(_ bin: String, withKey: Bool = true) -> ClaudeAuthStatus? {
        guard recentEnough(bin) else { return nil }
        guard let r = run(bin, ["auth", "status"], cwd: runner.userHome, env: env(withKey: withKey), timeout: 15) else { return nil }
        return parseAuthStatus(code: r.code, out: r.out)
    }

    /// `claude --version` is 2.1.268 or newer (hasAuthCommands): asked once per path and kept while it answers so.
    private var recent: Set<String> = []
    func recentEnough(_ bin: String) -> Bool {
        lock.lock(); let known = recent.contains(bin); lock.unlock()
        if known { return true }
        guard let r = run(bin, ["--version"], cwd: runner.userHome, env: env(withKey: true), timeout: 15), r.code == 0, hasAuthCommands(r.out) else { return false }
        lock.lock(); recent.insert(bin); lock.unlock()
        return true
    }

    // MARK: installing it

    /// Anthropic's installer, fetched now (never kept), checked to be that (https on claude.ai or downloads.claude.ai, a bash script of a sane
    /// size) and run with /bin/bash as a program of its own: no shell command line, no terminal, no administrator rights (it refuses sudo
    /// itself). It installs Claude Code into ~/.local/bin and checks what it downloads (SHA-256). nil when done; else what it said last.
    /// A Cancel pressed before it starts holds (the app clears `cancelled` when Connect is pressed, not here).
    func install(step: @escaping (ConnectStep) -> Void) -> String? {
        if cancelled { return nil }
        step(.downloading)
        let fm = FileManager.default
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("pako-claude-\(UUID().uuidString)")
        do { try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch {
            return error.localizedDescription
        }
        defer { try? fm.removeItem(atPath: dir) }
        guard let url = URL(string: claudeInstallerURL) else { return "bad address" }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        req.httpMethod = "GET"
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        let got = DispatchSemaphore(value: 0)
        var answer: (Data?, URLResponse?, Error?)
        session.dataTask(with: req) { d, r, e in answer = (d, r, e); got.signal() }.resume()
        if got.wait(timeout: .now() + 45) == .timedOut { session.invalidateAndCancel(); return "\(claudeInstallerURL): no answer" }
        if cancelled { return nil }
        if let e = answer.2 { return "\(claudeInstallerURL): \(e.localizedDescription)" }
        guard let http = answer.1 as? HTTPURLResponse, http.statusCode == 200, isInstallerURL(http.url),
              let data = answer.0, data.count > 20, data.count < 2_000_000, data.starts(with: Data("#!/bin/bash".utf8)) || data.starts(with: Data("#!/usr/bin/env bash".utf8))
        else { return "\(claudeInstallerURL): \((answer.1 as? HTTPURLResponse).map { "HTTP \($0.statusCode)" } ?? "?"), not the installer" }
        let script = (dir as NSString).appendingPathComponent("install.sh")
        guard fm.createFile(atPath: script, contents: data, attributes: [.posixPermissions: 0o600]) else { return "could not save the installer" }
        var e = env(withKey: false)
        // Plain bash on the system's own tools (curl, shasum): nothing from the person's shell setup.
        e["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        e["SUDO_USER"] = nil
        let p = Streamed("/bin/bash", [script], cwd: runner.userHome, env: e)
        guard p.start() else { return "could not start /bin/bash" }
        use(p)
        defer { use(nil) }
        let began = Date()
        let until = began.addingTimeInterval(15 * 60)
        while !p.wait(0.5) {
            if cancelled || Date() > until { p.stop(); return cancelled ? nil : outputTail(p.output, count: 8) + "\n(15 min)" }
            step(.installing(last: outputTail(p.output, count: 1), seconds: Int(Date().timeIntervalSince(began))))
        }
        if cancelled { return nil }
        let tail = outputTail(p.output, count: 8)
        guard p.process.terminationStatus == 0 else { return tail.isEmpty ? "exit \(p.process.terminationStatus)" : tail }
        return locate().bin == nil ? (tail.isEmpty ? "claude not found after installing" : tail) : nil
    }

    // MARK: signing in

    /// Claude's own sign-in (`claude auth login --claudeai`: the Claude subscription, https://code.claude.com/docs/en/cli-reference), which opens
    /// the browser on Claude's site. Claude Code 2.1.325's page then shows a code to paste back ("Paste code here if prompted > "): the window
    /// takes it and `sendCode` writes it to the sign-in's stdin, a pipe kept open for that. Meanwhile `claude auth status` every two seconds, for
    /// up to ten minutes, until it says signed in. `email`: the owner's address, filled in on Claude's page (`--email`), when the app knows it. Its output is only read for the page's address (an "open it again" button), whether it asks
    /// for the code, and its last error line; nothing of it is kept or written. nil when signed in; else what it said last ("" when cancelled).
    /// A Cancel pressed before it starts holds: no browser page opens (the app clears `cancelled` when Connect is pressed, not here).
    func signIn(_ bin: String, email: String? = nil, step: @escaping (ConnectStep) -> Void) -> String? {
        if cancelled { return "" }
        guard recentEnough(bin) else { return "Claude Code at \(bin) is older than 2.1.268: update it (claude update), then try again." }
        let hint = email.flatMap(cleanEmailHint).map { ["--email", $0] } ?? []
        let p = Streamed(bin, ["auth", "login", "--claudeai"] + hint, cwd: runner.userHome, env: env(withKey: false), input: true)
        guard p.start() else { return "could not start \(bin)" }
        use(p)
        lock.lock(); signing = p; errorMark = 0; codesSent = 0; lock.unlock()
        defer { p.stop(); use(nil); lock.lock(); signing = nil; lock.unlock() }
        var shown = ConnectStep.signingIn(page: nil, code: false, error: "", sent: 0)
        step(shown)
        let until = Date().addingTimeInterval(10 * 60)
        var page: URL?
        while Date() < until {
            if cancelled { return "" }
            if page == nil { page = loginPageURL(p.output) }
            lock.lock(); let mark = errorMark; let sent = codesSent; lock.unlock()
            let fresh = p.errors(from: mark)
            let now = ConnectStep.signingIn(page: page, code: loginAsksForCode(p.output), error: outputTail(scrubURLs(fresh), count: 1), sent: sent)
            if now != shown { shown = now; step(now) }
            if let s = authStatus(bin, withKey: false), s.loggedIn {
                // It ends by itself once signed in; a moment for that, then stopped either way (defer).
                _ = p.wait(3)
                return nil
            }
            if !p.running {
                // It ended without a sign-in (a code refused, an error, or the person closed it): one more look, as its last write may have
                // just landed.
                if let s = authStatus(bin, withKey: false), s.loggedIn { return nil }
                return outputTail(scrubURLs(p.output), count: 4)
            }
            for _ in 0..<4 where !cancelled { Thread.sleep(forTimeInterval: 0.5) }
        }
        return "5 min"
    }

    /// The code the person pasted, sent to the sign-in under way (with the newline it waits for). Never logged nor kept: it goes from the
    /// window's field to the pipe. The error shown so far is cleared: what comes next is about this code. false when no sign-in can take it.
    func sendCode(_ code: String) -> Bool {
        lock.lock(); let p = signing; lock.unlock()
        guard let p = p else { return false }
        lock.lock(); errorMark = p.errorCount; codesSent += 1; lock.unlock()
        return p.send(code + "\n")
    }

    private func scrubURLs(_ s: String) -> String { s.replacingOccurrences(of: #"https://\S+"#, with: "…", options: .regularExpression) }
}
