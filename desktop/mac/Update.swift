// Installing an update, once the person pressed Update (App.swift asks; nothing here runs by itself): the dmg the feed names is downloaded to
// a temporary folder, its SHA-256 checked against the feed's, mounted read-only, and the Pako.app on it checked (the same app, the version and
// build the feed promised, newer than this one, a macOS this Mac has, a program and a Node.js inside that run on this Mac's processor, a valid
// signature on every architecture, and, when this app is signed with a Developer ID, the same team). Only then is it copied next to the
// running app, checked again there, and swapped in at once (renamex_np RENAME_SWAP: there is never a moment with no Pako.app); the old one
// goes to the Trash. Any failure before the swap leaves the running app exactly as it was, and says why. Kept free of AppKit:
// test/fixtures/mac-update/main.swift runs it (test/mac-update.test.ts).

import CryptoKit
import Darwin
import Foundation
import Security

/// What an install is doing now, for the window's progress.
enum UpdateStage: Equatable {
    /// Bytes so far and in all (0 when the server does not say).
    case downloading(done: Int64, total: Int64)
    case verifying
    case installing
}

/// Why an update was not installed: the window says each in the person's words (Texts.updateFailure), app.log says the code.
enum UpdateFailure: Error, Equatable {
    /// The app's folder (or the app) cannot be written by this user: the folder.
    case cannotReplace(String)
    /// Running from the disk image or a translocated copy: it must be moved to Applications first.
    case mustMove
    case download(String)
    case tooLarge
    case checksum
    case mount
    case noApp
    /// The app on the disk is not the one the feed promised: which part differs (identifier, version, build).
    case notTheSameApp(String)
    case notNewer
    case needsMacOS(String)
    /// The app's program (or the Node.js inside it) has no slice for this Mac's processor: it would not start ("bad CPU type").
    case architecture
    case signature
    /// Not signed by this app's team: the team expected.
    case team(String)
    case noSpace
    case install(String)
    case cancelled

    /// A short word for app.log and the tests (never anything personal: no path, no address).
    var code: String {
        switch self {
        case .cannotReplace: return "cannot-replace"
        case .mustMove: return "must-move"
        case .download: return "download"
        case .tooLarge: return "too-large"
        case .checksum: return "checksum"
        case .mount: return "mount"
        case .noApp: return "no-app"
        case let .notTheSameApp(what): return "not-the-same-app:\(what)"
        case .notNewer: return "not-newer"
        case .needsMacOS: return "needs-macos"
        case .architecture: return "architecture"
        case .signature: return "signature"
        case .team: return "team"
        case .noSpace: return "no-space"
        case .install: return "install"
        case .cancelled: return "cancelled"
        }
    }
}

/// The running app, as the install compares the new one with it.
struct InstalledApp {
    /// Its bundle (…/Pako.app): the one replaced.
    let url: URL
    let bundleID: String
    let version: String
    let build: Int?
    /// Its Developer ID team, nil for an ad-hoc build (then any valid signature is taken: the feed's SHA-256 is the check).
    let team: String?
    let os: OperatingSystemVersion
    /// HOME as Pako's own Node reads it: the old app goes to its Trash (a test's fake HOME keeps it out of the person's).
    let userHome: String
}

/// The team (Developer ID) a bundle or program is signed by, nil for ad hoc, unsigned or unreadable.
func signingTeam(_ url: URL) -> String? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let c = code else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(c, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let d = info as? [String: Any] else { return nil }
    return d[kSecCodeInfoTeamIdentifier as String] as? String
}

/// Checks a bundle's signature as `codesign --verify --deep --strict` does, on every architecture it has (an Intel Mac checks the arm64
/// slice too, which it cannot run); with `team`, it must also be Apple-anchored and signed by that team (as `codesign -dv` names it).
func checkSignature(_ url: URL, team: String?) -> UpdateFailure? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let c = code else { return .signature }
    var req: SecRequirement?
    if let t = team {
        // A team identifier is ten letters and digits: nothing else can go into the requirement's text.
        guard t.count == 10, t.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }),
              SecRequirementCreateWithString("anchor apple generic and certificate leaf[subject.OU] = \"\(t)\"" as CFString, [], &req) == errSecSuccess
        else { return .team(t) }
    }
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
    let status = SecStaticCodeCheckValidityWithErrors(c, flags, req, nil)
    if let t = team, status == errSecCSReqFailed { return .team(t) }
    guard status == errSecSuccess else { return .signature }
    if let t = team, signingTeam(url) != t { return .team(t) }
    return nil
}

/// The CPU types a Mach-O program holds (each slice of a universal one), nil when the file is not one or cannot be read.
func machOCPUTypes(_ url: URL) -> Set<Int32>? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    guard let data = try? h.read(upToCount: 4096), data.count >= 8 else { return nil }
    let b = [UInt8](data)
    let be = { (o: Int) -> UInt32 in
        o + 4 <= b.count ? UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3]) : 0
    }
    let le = { (o: Int) -> UInt32 in
        o + 4 <= b.count ? UInt32(b[o + 3]) << 24 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 1]) << 8 | UInt32(b[o]) : 0
    }
    // Universal (FAT_MAGIC, FAT_MAGIC_64: big-endian headers, 20 or 32 bytes per slice), else one architecture (MH_MAGIC, MH_MAGIC_64).
    let fat = be(0)
    if fat == 0xcafebabe || fat == 0xcafebabf {
        let n = Int(be(4))
        let size = fat == 0xcafebabe ? 20 : 32
        guard n > 0, n <= 16, 8 + n * size <= b.count else { return nil }
        return Set((0..<n).map { Int32(bitPattern: be(8 + $0 * size)) })
    }
    let thin = le(0)
    if thin == 0xfeedface || thin == 0xfeedfacf { return [Int32(bitPattern: le(4))] }
    return nil
}

/// The processor this app runs on, as a Mach-O CPU type (the slice the new app must have to start here).
let runningCPUType: Int32 = {
    #if arch(arm64)
    return 0x0100_000C // CPU_TYPE_ARM64
    #else
    return 0x0100_0007 // CPU_TYPE_X86_64
    #endif
}()

/// The programs of an app that must start on this Mac: its own, and the Node.js inside it when it has one (a developer build has none).
func appProgramsRunHere(_ app: URL, executable: String, cpu: Int32 = runningCPUType) -> Bool {
    let main = app.appendingPathComponent("Contents/MacOS/\(executable)")
    guard let types = machOCPUTypes(main), types.contains(cpu) else { return false }
    let node = app.appendingPathComponent("Contents/Resources/node/bin/node")
    if FileManager.default.fileExists(atPath: node.path) {
        guard let n = machOCPUTypes(node), n.contains(cpu) else { return false }
    }
    return true
}

/// The SHA-256 of a file in hex, read a megabyte at a time; nil when it cannot be read.
func fileSHA256(_ url: URL) -> String? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while true {
        // read(upToCount:) answers nil (not empty data) at the end of the file, and throws on a read error.
        let chunk: Data?
        do { chunk = try h.read(upToCount: 1 << 20) } catch { return nil }
        guard let c = chunk, !c.isEmpty else { break }
        hasher.update(data: c)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

final class Updater: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    /// A dmg larger than this is refused (a release is about 80 MB).
    static let maxBytes: Int64 = 1_500_000_000
    let info: UpdateInfo
    let current: InstalledApp
    /// A check-only feed on this Mac (PAKO_APP_UPDATE_FEED): plain http to 127.0.0.1 is let through, for the download and its redirects.
    let loopback: Bool
    private let progress: (UpdateStage) -> Void
    private let lock = NSLock()
    private var _cancelled = false
    private var task: URLSessionDownloadTask?
    private var downloadedTo: URL?
    private var downloadError: UpdateFailure?
    private let downloadDone = DispatchSemaphore(value: 0)
    private var lastReported = Date.distantPast
    private var work: URL?

    init(info: UpdateInfo, current: InstalledApp, loopback: Bool = false, progress: @escaping (UpdateStage) -> Void = { _ in }) {
        self.info = info
        self.current = current
        self.loopback = loopback
        self.progress = progress
    }

    var cancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return _cancelled
    }

    /// Stops the install if it has not reached the swap (after it, it finishes: the new app is in place).
    func cancel() {
        lock.lock()
        _cancelled = true
        let t = task
        lock.unlock()
        t?.cancel()
    }

    /// Runs on the calling thread (never the main one) to its end: the installed app (at the running app's place), or why nothing changed.
    func install() -> Result<URL, UpdateFailure> {
        guard let want = info.sha256, info.installable else { return .failure(.download("no checksum")) }
        let app = current.url.standardizedFileURL
        let dir = app.deletingLastPathComponent()
        if needsMoveToApplications(app.path) { return .failure(.mustMove) }
        if let m = info.minimumMacOS, !macOSAtLeast(m, current: current.os) { return .failure(.needsMacOS(m)) }
        guard isNewerRelease(version: info.version, build: info.build, than: current.version, currentBuild: current.build) else {
            return .failure(.notNewer)
        }
        // The swap renames inside the app's folder, and the old app then moves to the Trash (its own ".." changes): both must be writable.
        guard access(dir.path, W_OK) == 0, access(app.path, W_OK) == 0 else { return .failure(.cannotReplace(dir.path)) }
        guard let tmp = makeWorkFolder() else { return .failure(.install("no temporary folder")) }
        work = tmp
        defer { try? FileManager.default.removeItem(at: tmp) }

        // ---- the download ----
        let dmg: URL
        switch download(to: tmp.appendingPathComponent("Pako.dmg")) {
        case let .failure(f): return .failure(f)
        case let .success(u): dmg = u
        }
        if cancelled { return .failure(.cancelled) }
        progress(.verifying)
        guard fileSHA256(dmg) == want else { return .failure(.checksum) }

        // ---- the disk, read-only ----
        let mnt = tmp.appendingPathComponent("mnt")
        try? FileManager.default.createDirectory(at: mnt, withIntermediateDirectories: true)
        guard run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint", mnt.path, dmg.path],
                  timeout: 300)?.code == 0 else { return .failure(.mount) }
        defer { Updater.detach(mnt) }
        guard let newApp = Updater.appOnDisk(mnt) else { return .failure(.noApp) }
        if let f = check(newApp) { return .failure(f) }
        if cancelled { return .failure(.cancelled) }

        // ---- next to the running app, checked again there, then swapped in ----
        progress(.installing)
        let staged = dir.appendingPathComponent(".Pako-update-\(UUID().uuidString).app")
        guard let copied = run("/usr/bin/ditto", [newApp.path, staged.path], timeout: 900) else {
            try? FileManager.default.removeItem(at: staged)
            return .failure(.install("ditto did not finish"))
        }
        guard copied.code == 0 else {
            try? FileManager.default.removeItem(at: staged)
            return .failure(copied.out.contains("No space left") ? .noSpace : .install(String(copied.out.suffix(300))))
        }
        // ditto copies extended attributes: a quarantine mark must not follow (the app would be translocated at its next start).
        run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged.path], timeout: 60)
        if let f = checkSignature(staged, team: current.team) {
            try? FileManager.default.removeItem(at: staged)
            return .failure(f)
        }
        if cancelled {
            try? FileManager.default.removeItem(at: staged)
            return .failure(.cancelled)
        }
        guard let old = Updater.swap(staged: staged, into: app) else {
            try? FileManager.default.removeItem(at: staged)
            return .failure(.install("swap"))
        }
        Updater.trash(old, userHome: current.userHome, name: "Pako \(current.version).app")
        return .success(app)
    }

    /// The new app against the running one and the feed: the same identifier, exactly the promised version and build, newer, a macOS this
    /// Mac has, a valid signature (of this app's team, when it has one), and programs for this Mac's processor.
    func check(_ newApp: URL) -> UpdateFailure? {
        guard let plist = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist")) as? [String: Any] else {
            return .noApp
        }
        guard plist["CFBundleIdentifier"] as? String == current.bundleID else { return .notTheSameApp("identifier") }
        let version = plist["CFBundleShortVersionString"] as? String ?? ""
        guard version == info.version else { return .notTheSameApp("version") }
        let build = Int(plist["CFBundleVersion"] as? String ?? "")
        if let b = info.build, build != b { return .notTheSameApp("build") }
        guard isNewerRelease(version: version, build: build, than: current.version, currentBuild: current.build) else { return .notNewer }
        if let m = plist["LSMinimumSystemVersion"] as? String, !macOSAtLeast(m, current: current.os) { return .needsMacOS(m) }
        guard let exe = plist["CFBundleExecutable"] as? String,
              FileManager.default.isExecutableFile(atPath: newApp.appendingPathComponent("Contents/MacOS/\(exe)").path) else { return .noApp }
        if let f = checkSignature(newApp, team: current.team) { return f }
        // A release with no slice for this processor (arm64 only on an Intel Mac, say) passes every other check and would not start after
        // the swap: refused here, while the running app is untouched.
        return appProgramsRunHere(newApp, executable: exe) ? nil : .architecture
    }

    private func makeWorkFolder() -> URL? {
        var template = Array((NSTemporaryDirectory() as NSString).appendingPathComponent("pako-update.XXXXXX").utf8CString)
        guard mkdtemp(&template) != nil else { return nil }
        return URL(fileURLWithPath: String(cString: template), isDirectory: true)
    }

    /// Pako.app on the disk (or, failing that, its only app): a real folder, never a link to somewhere else.
    static func appOnDisk(_ mnt: URL) -> URL? {
        let fm = FileManager.default
        let isApp = { (u: URL) -> Bool in
            var st = stat()
            return lstat(u.path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
        }
        let pako = mnt.appendingPathComponent("Pako.app")
        if isApp(pako) { return pako }
        let apps = ((try? fm.contentsOfDirectory(atPath: mnt.path)) ?? []).filter { $0.hasSuffix(".app") }.map { mnt.appendingPathComponent($0) }
            .filter(isApp)
        return apps.count == 1 ? apps[0] : nil
    }

    static func detach(_ mnt: URL) {
        if run("/usr/bin/hdiutil", ["detach", "-quiet", mnt.path], timeout: 60)?.code != 0 {
            run("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mnt.path], timeout: 60)
        }
    }

    /// The staged app takes the running app's place in one step; the old app is then where the staged one was (returned). Where the volume
    /// cannot swap (not APFS or HFS+), two renames, the first undone if the second fails. nil: nothing changed.
    static func swap(staged: URL, into app: URL) -> URL? {
        if renamex_np(staged.path, app.path, UInt32(RENAME_SWAP)) == 0 { return staged }
        let aside = app.deletingLastPathComponent().appendingPathComponent(".Pako-old-\(UUID().uuidString).app")
        guard rename(app.path, aside.path) == 0 else { return nil }
        guard rename(staged.path, app.path) == 0 else {
            _ = rename(aside.path, app.path)
            return nil
        }
        return aside
    }

    /// The old app to the Trash, named after its version (it can be put back by hand); deleted when there is no Trash to put it in. With a
    /// HOME other than the account's own (a test), its .Trash folder is used instead, never the person's.
    static func trash(_ old: URL, userHome: String, name: String) {
        let fm = FileManager.default
        let mine = (userHome as NSString).standardizingPath == (NSHomeDirectory() as NSString).standardizingPath
        if mine {
            var res: NSURL?
            if (try? fm.trashItem(at: old, resultingItemURL: &res)) != nil {
                if let r = res as URL? {
                    let named = r.deletingLastPathComponent().appendingPathComponent(name)
                    if !fm.fileExists(atPath: named.path) { try? fm.moveItem(at: r, to: named) }
                }
                return
            }
        } else {
            let bin = URL(fileURLWithPath: userHome).appendingPathComponent(".Trash")
            try? fm.createDirectory(at: bin, withIntermediateDirectories: true)
            var dest = bin.appendingPathComponent(name)
            if fm.fileExists(atPath: dest.path) { dest = bin.appendingPathComponent("\(UUID().uuidString.prefix(8)) \(name)") }
            if (try? fm.moveItem(at: old, to: dest)) != nil { return }
        }
        try? fm.removeItem(at: old)
    }

    // MARK: the download

    private func download(to dest: URL) -> Result<URL, UpdateFailure> {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var req = URLRequest(url: info.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        // Nothing that tells one person from another, as the feed check.
        req.setValue("Pako", forHTTPHeaderField: "User-Agent")
        lock.lock()
        if _cancelled { lock.unlock(); return .failure(.cancelled) }
        let t = session.downloadTask(with: req)
        task = t
        downloadedTo = dest
        lock.unlock()
        progress(.downloading(done: 0, total: 0))
        t.resume()
        downloadDone.wait()
        lock.lock(); defer { lock.unlock() }
        task = nil
        if let e = downloadError { return .failure(e) }
        return FileManager.default.fileExists(atPath: dest.path) ? .success(dest) : .failure(.download("nothing downloaded"))
    }

    private func fail(_ f: UpdateFailure) {
        lock.lock()
        if downloadError == nil { downloadError = f }
        let t = task
        lock.unlock()
        t?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // GitHub sends a release's asset on from github.com to its storage, over https; a redirect anywhere else is not followed.
        completionHandler(isUpdateURL(request.url, loopback: loopback) ? request : nil)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > Updater.maxBytes || totalBytesExpectedToWrite > Updater.maxBytes { return fail(.tooLarge) }
        let now = Date()
        guard now.timeIntervalSince(lastReported) >= 0.2 else { return }
        lastReported = now
        progress(.downloading(done: totalBytesWritten, total: max(0, totalBytesExpectedToWrite)))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file at `location` is gone once this returns: moved now, after the answer is checked.
        guard let h = downloadTask.response as? HTTPURLResponse, h.statusCode == 200, isUpdateURL(h.url, loopback: loopback) else {
            let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
            return fail(.download("HTTP \(code)"))
        }
        lock.lock()
        let dest = downloadedTo
        lock.unlock()
        guard let d = dest else { return fail(.download("no destination")) }
        do {
            try? FileManager.default.removeItem(at: d)
            try FileManager.default.moveItem(at: location, to: d)
        } catch {
            fail(.download("could not keep the file"))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let e = error as NSError? {
            lock.lock()
            let wasCancelled = _cancelled
            lock.unlock()
            fail(wasCancelled && e.code == NSURLErrorCancelled ? .cancelled : .download(e.localizedDescription))
        }
        downloadDone.signal()
    }
}
