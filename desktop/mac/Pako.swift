// Finding and running Pako for the app: the server and Node.js inside the app (a release build; a developer build uses a Pako folder and the
// Mac's own Node.js), the Pako already running (by its lock) or one started here, and a sign-in link for the panel. Everything here may wait (a shell, a start of up to a minute): it runs off the main thread, and AppKit
// only hears the outcome.

import Foundation

/// What can stop the app from showing the panel; each has its own words and its own way out (App.swift, Texts).
enum PakoProblem: Error {
    case noRepo
    case noNode
    case oldNode(found: String, path: String)
    case notStarted(log: String, why: StartFailure)
    /// The Pako this app started stopped by itself several times in a row (App.swift gave up starting it again).
    case keepsStopping(log: String)
    /// The window's web content stopped again and again (WebKit), so it is not reloaded in a loop.
    case webGone
    case olderPako(pid: Int)
    case otherHome(port: Int, home: String)
    case tooManyLinks
    case broken(port: Int, why: String)
    /// The lock's process is not the one listening on its port (a lock left behind, its process number now another program's).
    case staleLock(port: Int, lock: String)
}

/// Runs a program and gives its exit code and output (both streams), or nil when it could not start or ran past `timeout` (then it is killed).
@discardableResult
func run(_ exe: String, _ args: [String], cwd: String? = nil, env: [String: String]? = nil, timeout: TimeInterval = 20) -> (code: Int32, out: String)? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd = cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let env = env { p.environment = env }
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    var data = Data()
    let lock = NSLock()
    let eof = DispatchSemaphore(value: 0)
    pipe.fileHandleForReading.readabilityHandler = { h in
        let chunk = h.availableData
        if chunk.isEmpty { h.readabilityHandler = nil; eof.signal(); return }
        lock.lock(); if data.count < 200_000 { data.append(chunk) }; lock.unlock()
    }
    let done = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in done.signal() }
    do { try p.run() } catch { pipe.fileHandleForReading.readabilityHandler = nil; return nil }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        p.terminate()
        if done.wait(timeout: .now() + 2) == .timedOut { kill(p.processIdentifier, SIGKILL) }
        pipe.fileHandleForReading.readabilityHandler = nil
        return nil
    }
    // The rest of what it wrote, but never waited for without end: something it left running in the background (a login shell's startup
    // files may) can hold the pipe open long after it has ended.
    _ = eof.wait(timeout: .now() + 2)
    pipe.fileHandleForReading.readabilityHandler = nil
    lock.lock(); defer { lock.unlock() }
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// Used from the app's one work queue (finding, starting, stopping) and read from the main thread (the lock, the home): what the main thread
/// reads is set once, before, so the two never race on the same value.
final class PakoRunner: @unchecked Sendable {
    /// This app's own environment: PAKO_HOME and PAKO_REPO given to it count (and go on to a Pako it starts, with PORT and the rest).
    let env = ProcessInfo.processInfo.environment
    /// The home folder as Pako's own Node finds it (os.homedir(): HOME when it is set), so the app and the Pako it starts look in the same
    /// places (~/.pako, ~/.local/bin/claude).
    let userHome: String = {
        let h = (ProcessInfo.processInfo.environment["HOME"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return h.hasPrefix("/") ? h : NSHomeDirectory()
    }()
    /// The app's settings. A run given its own PAKO_HOME (a test, a second home) keeps its own, apart from the person's app: its port, its
    /// window, what it was told about notices are not the real Pako's (cfprefsd keys settings by the real account, whatever HOME says).
    let defaults: UserDefaults = {
        let given = (ProcessInfo.processInfo.environment["PAKO_HOME"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !given.isEmpty, let id = Bundle.main.bundleIdentifier else { return .standard }
        return UserDefaults(suiteName: "\(id).home-\(stableHash(given))") ?? .standard
    }()
    /// True when this run has its own PAKO_HOME (above): it also keeps no cookie between runs and asks for no notification permission.
    var separateHome: Bool { defaults !== UserDefaults.standard }
    private(set) var repo: String?
    private(set) var node: String?
    /// The server and Node.js inside this app (desktop/mac/package.sh), or nil for a developer build. Fixed for the app's life.
    let bundle = bundledServer(resources: Bundle.main.resourcePath, isPakoFolder: PakoRunner.isPakoFolder,
                               isExecutable: { FileManager.default.isExecutableFile(atPath: $0) })
    /// True once findRepo chose the server inside the app (not a folder named by PAKO_REPO).
    private(set) var bundled = false
    private let pathLock = NSLock()
    private var _path = ""
    /// The PATH a Pako started here gets (set by findNode, widened by addToPath).
    var path: String {
        get { pathLock.lock(); defer { pathLock.unlock() }; return _path }
        set { pathLock.lock(); _path = newValue; pathLock.unlock() }
    }
    /// The PATH the Pako this app started was given: when the `claude` command turns up in a folder not in it, that Pako is started again.
    private(set) var childPath = ""
    private let childLock = NSLock()
    private var _child: Process?
    /// The Pako this app started itself: the only one it ever stops. Read from the main thread too (Quit), so behind a lock.
    var child: Process? {
        get { childLock.lock(); defer { childLock.unlock() }; return _child }
        set { childLock.lock(); _child = newValue; childLock.unlock() }
    }
    /// Whether that child is running now.
    var childRunning: Bool { child?.isRunning == true }
    private var childStarted = Date.distantPast
    // The child's state, behind childLock: the termination handler runs on a thread of its own, the start on the work queue, Quit on the main
    // thread. True once the child answered: only then is its end a crash (before, ensureRunning says why it did not start).
    private var childUp = false
    /// The child started last has ended (set by its termination handler): a start that sees it no longer takes it as up.
    private var childEnded = false
    /// Set by stopChild: the end that follows is wanted, not a crash.
    private var stopping = false
    /// Which start the state is about: the handler of a child started before (stopped, then another started) changes nothing.
    private var childGen = 0
    private func withChildState<T>(_ f: () -> T) -> T { childLock.lock(); defer { childLock.unlock() }; return f() }
    /// Called (on some thread) when the child this app started ends by itself after it was up: its exit code or signal and how long it ran.
    var onChildExit: ((_ status: Int32, _ signal: Bool, _ ranFor: TimeInterval) -> Void)?
    /// The port a Pako started here listens on (PORT given to the app, or one chosen and kept, see choosePort).
    private(set) var chosenPort = 8787
    private let cancelLock = NSLock()
    private var _cancelled = false
    /// Set by Quit (from the main thread): a start or a wait under way ends now instead of after its minute, and nothing new is started.
    var cancelled: Bool {
        get { cancelLock.lock(); defer { cancelLock.unlock() }; return _cancelled }
        set { cancelLock.lock(); _cancelled = newValue; cancelLock.unlock() }
    }
    var home: String { pakoHome(env: env, repo: repo ?? userHome, userHome: userHome) }
    var logsDir: String { (home as NSString).appendingPathComponent("logs") }

    // MARK: the Pako folder

    static func isPakoFolder(_ dir: String) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: (dir as NSString).appendingPathComponent("src/server.ts"))
            && fm.fileExists(atPath: (dir as NSString).appendingPathComponent("package.json"))
    }

    /// PAKO_REPO (a developer's explicit choice) when it is a Pako folder; then the server inside the app, which is all a release build ever
    /// runs: no folder from an earlier developer build, no ~/pako, no folder picker, nothing outside its signed bundle. Only a developer
    /// build (no server inside) goes on: the folder chosen before, the folder it was built from, ~/pako (install.sh's default); nil: ask.
    func findRepo() -> String? {
        let given = (env["PAKO_REPO"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let dev = (given as NSString).expandingTildeInPath
        if !given.isEmpty, PakoRunner.isPakoFolder(dev) {
            repo = dev
            bundled = false
            return repo
        }
        if let b = bundle {
            // A folder remembered by a developer build of the same app must never be run instead of the signed server.
            defaults.removeObject(forKey: "repo")
            repo = b.repo
            bundled = true
            return repo
        }
        let saved = defaults.string(forKey: "repo")
        let baked = Bundle.main.object(forInfoDictionaryKey: "PakoRepoPath") as? String
        let candidates = [saved, baked, (userHome as NSString).appendingPathComponent("pako")]
        repo = candidates.compactMap { $0 }.map { ($0 as NSString).expandingTildeInPath }.first(where: PakoRunner.isPakoFolder)
        return repo
    }

    func remember(repo dir: String) {
        defaults.set(dir, forKey: "repo")
        repo = dir
    }

    // MARK: Node.js

    /// The login shell's PATH: an app opened from the Finder gets only /usr/bin:/bin, and Pako needs the `claude` command the terminal finds.
    func loginPath() -> String {
        let shell = env["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
        // After a marker: what the startup files print (both streams come back together) is not taken for folders.
        let r = run(shell, ["-lc", "printf '\\n\(loginPathMarker)%s\\n' \"$PATH\""], timeout: 10)
        return r?.code == 0 ? loginPathFrom(r?.out ?? "") : ""
    }

    /// The node to run Pako with: the login shell's, Homebrew's, /usr/local's, then nvm's newest. The first recent enough wins; when none is,
    /// the problem says which one was found (too old) or that there is none.
    func findNode() -> Result<String, PakoProblem> {
        if bundled, let b = bundle {
            // The app's own Node.js: no login shell to ask (slow with heavy startup files, and they may touch folders macOS then asks about).
            // The PATH holds where Claude Code is usually installed; one found elsewhere is added by addToPath (Claude.swift).
            node = b.node
            path = [(b.node as NSString).deletingLastPathComponent, userHome + "/.local/bin", userHome + "/.claude/local", "/opt/homebrew/bin",
                    "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
            return .success(b.node)
        }
        let lp = loginPath()
        var seen: [String] = []
        for dir in lp.split(separator: ":").map(String.init) {
            let p = (dir as NSString).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: p) { seen.append(p); break }
        }
        seen += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        let nvm = (userHome as NSString).appendingPathComponent(".nvm/versions/node")
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm)) ?? []).compactMap { v -> (String, (Int, Int, Int))? in
            nodeVersion(v).map { (v, $0) }
        }.sorted { a, b in a.1 > b.1 }
        seen += versions.map { "\(nvm)/\($0.0)/bin/node" }
        var tooOld: (String, String)?
        for p in seen where FileManager.default.isExecutableFile(atPath: p) {
            guard let r = run(p, ["--version"], timeout: 10), r.code == 0, let v = nodeVersion(r.out) else { continue }
            if nodeIsRecentEnough(v) {
                node = p
                // The node found goes first, then what the terminal has, then the usual places of the `claude` command.
                var extra: [String] = [(p as NSString).deletingLastPathComponent]
                extra += lp.split(separator: ":").map(String.init)
                extra += [userHome + "/.local/bin", userHome + "/.claude/local", "/opt/homebrew/bin", "/usr/local/bin"]
                extra += ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
                var unique: [String] = []
                for d in extra where !d.isEmpty && !unique.contains(d) { unique.append(d) }
                path = unique.joined(separator: ":")
                return .success(p)
            }
            if tooOld == nil { tooOld = (r.out.trimmingCharacters(in: .whitespacesAndNewlines), p) }
        }
        if let (v, p) = tooOld { return .failure(.oldNode(found: v, path: p)) }
        return .failure(.noNode)
    }

    private var childEnv: [String: String] {
        var e = env
        e["PATH"] = path
        // The app shows the panel itself: no browser tab as well.
        e["PAKO_NO_OPEN"] = "1"
        // The server inside the app: its panel leaves "start with this computer" to the app's own login item (a LaunchAgent written from
        // here would point inside the bundle, which moves, is replaced or is deleted).
        if bundled { e["PAKO_APP_BUNDLE"] = "1" } else { e.removeValue(forKey: "PAKO_APP_BUNDLE") }
        // The server stops by itself when this app is gone without stopping it (Force Quit, a crash: src/server.ts watchParent), and makes
        // no sign-in link at start (the app asks for its own; one in app.log would be a key to the panel for whoever gets the log).
        e["PAKO_APP_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        e["PORT"] = String(chosenPort)
        return e
    }

    /// `node src/server.ts --autostart <arg>` in the Pako folder: its exit code and what it said (no secret is ever in it).
    func autostart(_ arg: String) -> (code: Int32, out: String)? {
        guard let node = node, let repo = repo else { return nil }
        return run(node, ["--disable-warning=ExperimentalWarning", "src/server.ts", "--autostart", arg], cwd: repo, env: childEnv, timeout: 30)
    }

    // MARK: the running Pako

    func liveLock() -> PakoLock? {
        guard let l = readLock(home: home, upSeconds: systemUptime()), l.alive else { return nil }
        return l
    }

    private func healthy(_ port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        req.httpMethod = "GET"
        return send(req).answer?.status == 200
    }

    /// One request, waited for (this runs off the main thread): the answer, or nil and whether the connection was refused.
    func send(_ req: URLRequest) -> (answer: (status: Int, body: Data)?, refused: Bool) {
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        let lock = NSLock()
        var out: (Int, Data)?
        var refused = false
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { data, resp, err in
            lock.lock()
            if let h = resp as? HTTPURLResponse { out = (h.statusCode, data ?? Data()) }
            refused = (err as? URLError)?.code == .cannotConnectToHost
            lock.unlock()
            done.signal()
        }.resume()
        if done.wait(timeout: .now() + req.timeoutInterval + 2) == .timedOut { session.invalidateAndCancel() }
        lock.lock(); defer { lock.unlock() }
        return (out, refused)
    }

    /// The port of a running Pako, started now if needed: by launchd when autostart is on (so it stays the background one), else as this
    /// app's own child. `status` is told what is happening, for the window.
    func ensureRunning(status: (String) -> Void) -> Result<Int, PakoProblem> {
        if let l = liveLock() {
            if l.port == 0 { return .failure(.olderPako(pid: l.pid)) }
            if waitHealthy(l.port, seconds: 20) { return owned(l) }
            // Holding the folder but not answering: a second Pako would only stop on the same lock.
            if liveLock() != nil { return .failure(.broken(port: l.port, why: "no answer")) }
        }
        // An older LaunchAgent runs a Pako folder's code: the app's own server never hands over to it (App.swift offers to remove it).
        if !bundled, child?.isRunning != true, autostart("status")?.code == 0 {
            status("launchd")
            let job = "gui/\(getuid())/local.pako"
            if run("/bin/launchctl", ["kickstart", job], timeout: 10)?.code != 0 {
                let plist = (userHome as NSString).appendingPathComponent("Library/LaunchAgents/local.pako.plist")
                run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", plist], timeout: 10)
            }
            if let l = waitForLock(seconds: 30, child: nil) { return owned(l) }
        }
        if cancelled { return .failure(.notStarted(log: logFile, why: .unknown)) }
        var retried = false
        var endedEarly = false
        while true {
            if child?.isRunning != true {
                status("start")
                choosePort()
                if let err = startChild() { return .failure(err) }
            }
            if let l = waitForLock(seconds: 90, child: child) {
                guard let c = child, l.pid == c.processIdentifier.toInt else { return owned(l) }
                // Up, unless it ended in the moment since it answered: the handler and this decide under one lock, so its end is either
                // a crash the app restarts (onChildExit) or seen here, never lost between the two.
                let ended = withChildState { () -> Bool in
                    if !childEnded { childUp = true }
                    return childEnded
                }
                if !ended {
                    log("Pako is up (process \(l.pid), port \(l.port))")
                    return owned(l)
                }
                log("Pako stopped by itself just after it answered")
                if !endedEarly, !cancelled { endedEarly = true; continue }
                return .failure(.notStarted(log: logFile, why: startFailure(logTail: lastStartLog())))
            }
            if let l = liveLock(), l.port == 0 { return .failure(.olderPako(pid: l.pid)) }
            let why = startFailure(logTail: lastStartLog())
            // Taken between the check and the start (or by a program that binds only now): once more, on a port free this moment.
            if case .portInUse = why, !retried, !cancelled, child?.isRunning != true {
                retried = true
                choosePort(avoid: chosenPort)
                continue
            }
            // Ended by a signal while starting (a kill, a crash of node itself), not by an error of its own (those exit with a code the log
            // explains): started once more, as a crash after it was up would be.
            if let c = child, !c.isRunning, c.terminationReason == .uncaughtSignal, !endedEarly, !cancelled {
                endedEarly = true
                log("Pako stopped by itself while starting (signal \(c.terminationStatus))")
                continue
            }
            return .failure(.notStarted(log: logFile, why: why))
        }
    }

    /// The lock's port only when the lock's own process listens on it: a stale lock (its process number now another program's) may point
    /// at another program's port, which must get neither the bridge token nor the panel's cookie.
    private func owned(_ l: PakoLock) -> Result<Int, PakoProblem> {
        processListens(pid: l.pid, port: l.port) ? .success(l.port) : .failure(.staleLock(port: l.port, lock: lockFile))
    }

    private var lockFile: String { (home as NSString).appendingPathComponent(".lock") }
    private var logFile: String { (logsDir as NSString).appendingPathComponent("app.log") }

    /// The port for a Pako started here: PORT when the person gave one; else the one kept from before (8787 the first time) while nothing
    /// else listens there, or a free one, kept from then on (the panel's address, and so its cookie, stay the same). 8787 is also other
    /// programs' default (Cloudflare's wrangler), and another account on this Mac running Pako has it too: then Pako just uses another.
    func choosePort(avoid: Int? = nil) {
        if let given = Int((env["PORT"] ?? "").trimmingCharacters(in: .whitespaces)), given > 0, given < 65536 {
            chosenPort = given
            return
        }
        let kept = defaults.integer(forKey: "port")
        let want = kept > 1024 && kept < 65536 ? kept : 8787
        if want != avoid, loopbackPortIsFree(want) {
            chosenPort = want
        } else if let free = freeLoopbackPort() {
            chosenPort = free
        }
        defaults.set(chosenPort, forKey: "port")
    }

    /// Writes a line of the app's own into app.log (a crash of the Pako it started, a restart), so the log tells the whole story.
    func log(_ line: String) {
        guard let fd = openLog() else { return }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        h.write(Data("--- \(ISO8601DateFormatter().string(from: Date())) \(line) ---\n".utf8))
    }

    /// app.log opened for appending (O_APPEND: when it is emptied by rotateLog while the child writes, the child goes on at its new end, not
    /// at its old offset), created with mode 600; nil when it cannot be.
    private func openLog() -> Int32? {
        try? FileManager.default.createDirectory(atPath: logsDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(logFile, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        return fd >= 0 ? fd : nil
    }

    /// app.log past 5 MB: rotated (three generations kept). At each start, and every hour while the app runs (App.swift).
    func rotateLogs() { rotateLog(logFile, limit: 5_000_000) }

    /// The end of app.log since the last start, for saying why a start failed.
    func lastStartLog() -> String {
        let tail = fileTail(logFile, bytes: 8000)
        guard let r = tail.range(of: "started by Pako.app", options: .backwards) else { return tail }
        return String(tail[r.upperBound...])
    }

    private func startChild() -> PakoProblem? {
        guard let node = node, let repo = repo else { return .noNode }
        if cancelled { return .notStarted(log: logFile, why: .unknown) }
        rotateLogs()
        guard let fd = openLog() else { return .notStarted(log: logFile, why: .unknown) }
        let out = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        out.write("\n--- \(ISO8601DateFormatter().string(from: Date())) started by Pako.app (port \(chosenPort)) ---\n".data(using: .utf8)!)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--disable-warning=ExperimentalWarning", "src/server.ts"]
        p.currentDirectoryURL = URL(fileURLWithPath: repo)
        p.environment = childEnv
        childPath = path
        p.standardOutput = out
        p.standardError = out
        p.standardInput = FileHandle.nullDevice
        // The child has its own copy of the log file; this one is closed either way, or each start would leave one open here.
        defer { try? out.close() }
        let gen = withChildState { () -> Int in
            childUp = false; childEnded = false; stopping = false; childGen += 1
            return childGen
        }
        p.terminationHandler = { [weak self] proc in
            guard let self = self else { return }
            let up = self.withChildState { () -> Bool in
                guard gen == self.childGen else { return false }
                self.childEnded = true
                return self.childUp && !self.stopping
            }
            let ranFor = Date().timeIntervalSince(self.childStarted)
            if up { self.onChildExit?(proc.terminationStatus, proc.terminationReason == .uncaughtSignal, ranFor) }
        }
        do { try p.run() } catch { return .notStarted(log: logFile, why: .unknown) }
        childStarted = Date()
        child = p
        // Quit came while it was being started: it does not outlive the app.
        if cancelled { p.terminate() }
        return nil
    }

    private func waitHealthy(_ port: Int, seconds: Double) -> Bool {
        let until = Date().addingTimeInterval(seconds)
        repeat {
            if cancelled { return false }
            if healthy(port) { return true }
            if liveLock() == nil { return false }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < until
        return false
    }

    /// Until a live lock with a port answers /health; nil when time runs out or the child started here has ended (its log says why).
    private func waitForLock(seconds: Double, child: Process?) -> PakoLock? {
        let until = Date().addingTimeInterval(seconds)
        repeat {
            if cancelled { return nil }
            if let l = liveLock(), l.port > 0, healthy(l.port) { return l }
            if let c = child, !c.isRunning, liveLock() == nil { return nil }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < until
        return nil
    }

    /// Puts `dir` (where the `claude` command was found) at the end of the PATH a Pako started here gets. True when the Pako this app started
    /// is running without it: then it is started again (App.swift), so it finds the command as the app does. Never a Pako it did not start.
    func addToPath(_ dir: String) -> Bool {
        guard dir.hasPrefix("/"), !path.isEmpty else { return false }
        path = mergePathDirs([path.split(separator: ":").map(String.init), [dir]]).joined(separator: ":")
        guard let c = child, c.isRunning else { return false }
        return !childPath.split(separator: ":").map(String.init).contains(dir)
    }

    /// Stops the Pako this app started (SIGTERM, as Ctrl+C: its last write and its lock), and waits for it up to `wait` seconds, then
    /// SIGKILL (its bridge follows it by itself: assistant/run.ts watches its parent, and stops Claude runs under way); never another one.
    /// Safe from any thread: Quit calls it at once, not behind whatever the work queue is doing.
    func stopChild(wait: Double = 12) {
        guard let c = child, c.isRunning else { child = nil; return }
        withChildState { stopping = true }
        c.terminate()
        let until = Date().addingTimeInterval(wait)
        while c.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.1) }
        if c.isRunning { kill(c.processIdentifier, SIGKILL) }
        child = nil
    }

    /// "Restart Pako" for a Pako that holds the folder but does not answer (or whose lock is another program's now): the lock's process is
    /// stopped only when it is this user's `node` running Pako's server.ts (its path and its arguments say so), SIGTERM then SIGKILL; a lock
    /// whose process is anything else is just a leftover and goes. Then the caller starts Pako again. False when it would not touch it.
    func restartStuck() -> Bool {
        guard let l = readLock(home: home, upSeconds: systemUptime()) else { return true }
        let lockPath = lockFile
        if l.pid == child?.processIdentifier.toInt { stopChild(wait: 5); return true }
        let exe = processPath(l.pid) ?? ""
        let args = run("/bin/ps", ["-o", "args=", "-p", String(l.pid)], timeout: 5)?.out ?? ""
        let isPako = (exe as NSString).lastPathComponent == "node" && args.contains("src/server.ts")
        if !isPako || !processExists(l.pid) {
            try? FileManager.default.removeItem(atPath: lockPath)
            return true
        }
        guard kill(pid_t(l.pid), SIGTERM) == 0 else { return false }
        let until = Date().addingTimeInterval(8)
        while processExists(l.pid) && Date() < until { Thread.sleep(forTimeInterval: 0.2) }
        if processExists(l.pid) { kill(pid_t(l.pid), SIGKILL); Thread.sleep(forTimeInterval: 0.5) }
        return !processExists(l.pid)
    }

    /// What Pako wrote by itself after `after` (ms), asked with the bridge token as the sign-in link is (GET /panel/api/notices): only to
    /// a lock whose own process listens on `port`. nil when it cannot be asked now.
    func notices(port: Int, after: Double) -> (now: Double, notices: [Notice])? {
        guard let l = liveLock(), l.port == port, processListens(pid: l.pid, port: port), let token = bridgeToken(),
              let url = URL(string: "http://127.0.0.1:\(port)/panel/api/notices?after=\(Int64(max(0, after)))") else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let a = send(req).answer, a.status == 200 else { return nil }
        return parseNotices(a.body)
    }

    /// The last token read from the keychain, with the marker it was read under: notices ask every 5 s, and the keychain is read again
    /// only when Pako has written its marker anew.
    private var keychainToken: (marker: Data, token: String)?
    private let keychainLock = NSLock()

    func bridgeToken() -> String? {
        let secrets = (home as NSString).appendingPathComponent("secrets.json")
        guard let data = FileManager.default.contents(atPath: secrets), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        guard obj["_store"] != nil else {
            guard let token = obj["bridgeToken"] as? String, !token.isEmpty else { return nil }
            return token
        }
        // The secrets are in the login keychain (src/secrets.ts): secrets.json names the service and the account. Read with
        // /usr/bin/security, as Pako reads them: the item trusts that tool, so no dialog is shown, and the token comes back on a pipe.
        guard obj["_store"] as? String == "keychain", let service = obj["_service"] as? String, let account = obj["_account"] as? String
        else { return nil }
        keychainLock.lock()
        let cached = keychainToken
        keychainLock.unlock()
        if let c = cached, c.marker == data { return c.token }
        guard let r = run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", "\(account):bridgeToken", "-w"], timeout: 5),
              r.code == 0,
              let value = r.out.trimmingCharacters(in: .newlines).data(using: .utf8),
              let token = try? JSONSerialization.jsonObject(with: value, options: .fragmentsAllowed) as? String, !token.isEmpty
        else { return nil }
        keychainLock.lock()
        keychainToken = (data, token)
        keychainLock.unlock()
        return token
    }

    // MARK: signing in

    /// A one-time sign-in link, asked as `npm run panel` asks (bin/panel.cjs): the bridge token from the home's secrets.json, only to this
    /// computer's own address. The token is read here, sent once and never written or shown anywhere.
    func signInLink(port: Int) -> Result<String, PakoProblem> {
        // Asked again now, not trusted from when the panel was opened: the Pako may have stopped or moved since, and its old port be anyone's.
        guard let l = liveLock(), l.port == port else { return .failure(.broken(port: port, why: "no answer")) }
        guard processListens(pid: l.pid, port: port) else { return .failure(.staleLock(port: port, lock: lockFile)) }
        guard let token = bridgeToken() else { return .failure(.broken(port: port, why: "secrets.json")) }
        // 127.0.0.1 only, as npm run panel: never [::1] when it refuses. processListens checks the port, not the address, and another account
        // on this Mac can listen on [::1] at the same port (a separate socket) and take the bridge token.
        guard let url = URL(string: "http://127.0.0.1:\(port)/panel/api/link") else { return .failure(.broken(port: port, why: "no answer")) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("0", forHTTPHeaderField: "Content-Length")
        guard let a = send(req).answer else { return .failure(.broken(port: port, why: "no answer")) }
        switch a.status {
        case 401: return .failure(.otherHome(port: port, home: home))
        case 404: return .failure(.broken(port: port, why: "HTTP 404"))
        case 429: return .failure(.tooManyLinks)
        default: break
        }
        var link = (try? JSONSerialization.jsonObject(with: a.body) as? [String: Any])?["link"] as? String ?? ""
        // An older Pako names itself "localhost": the same server at its literal address, which no other program on [::1] can answer for.
        link = link.replacingOccurrences(of: "http://localhost:\(port)/", with: "http://127.0.0.1:\(port)/")
        guard a.status == 200, isLocalPanelLink(link, port: port) else { return .failure(.broken(port: port, why: "HTTP \(a.status)")) }
        return .success(link)
    }
}

extension Int32 {
    var toInt: Int { Int(self) }
}
