// Test only (test/mac-app.test.ts): runs the app's shared rules (desktop/mac/Core.swift) on what it is given and prints them as JSON, for the
// test to compare with bin/panel.cjs on the same files.
//   env <file> <name>...                 readEnvFile
//   home <repo> <userHome> [PAKO_HOME]   pakoHome (PAKO_HOME absent when not given; "-" gives it empty)
//   lock <home> <upSeconds>              readLock
//   listens <pid> <port>                 processListens
//   nav <url> <port|-> <main> <clicked>  panelNavigation
//   path <shell output>                 loginPathFrom
//   node <version>                      nodeVersion and nodeIsRecentEnough
//   link <url> <port>                    isLocalPanelLink
//   version <claude --version output>    hasAuthCommands
//   auth <code> <output>                 parseAuthStatus
//   state <binary 1|0> <code|-> <output|-> <server JSON|->   claudeState (the auth status from that code and output)
//   keysrc <ANTHROPIC_API_KEY|-> <server JSON|->             apiKeySource
//   find <CLAUDE_BIN|-> <login PATH> <home> <executable,...>  claudeDirs then findClaude (only the listed paths count as executable)
//   merge <PATH> <PATH>...               mergePathDirs
//   installer <url>                      isInstallerURL
//   loginurl <output>                    loginPageURL
//   tail <output> <count>                outputTail
//   asks <output>                        loginAsksForCode
//   code <pasted>                        cleanLoginCode
//   bundled <resources> <files,...>      bundledServer (only the listed paths exist; a folder counts when its src/server.ts is listed)
//   move <bundle path>                   needsMoveToApplications
//   agent <existing,...> <arg>...        legacyAgentIsStale
//   newer <candidate> <current>          isNewerVersion
//   feed <json> [loopback]               parseUpdateFeed (with loopback http allowed when a second argument is given; the release key:
//                                        PAKO_TEST_FEED_KEY)
//   release <version> <build|-> <current> <current build|->   isNewerRelease
//   macos <minimum> <x.y.z>              macOSAtLeast
//   things <connections JSON|-> <telegram JSON|->             parseThings
//   delays                               restartDelay for 0 to 5 failures in a row
//   why <log tail>                       startFailure
//   free <port>                          loopbackPortIsFree, and a port freeLoopbackPort chose (then free too)
//   rotate <log> <limit>                 rotateLog (three generations)
//   counts <notices JSON> <notifiedAt> <readAt>   parseNotices then noticeCounts
//   failure <tail>                       connectFailure
//   macho <path>                         isMachO
//   started <pid>                        processStartTime and processPath
//   hash <text>                          stableHash
//   msg <JSON>                           parsePakoMessage, said as {type, ...} (null: ignored)
//   openurl <url>                        allowedOpenURL
//   apps <bundle id,...>                 installedApps (only the listed ones are installed)
//   provider <address> [account type]    mailProvider
//   mailparse <script output>            parseMailAccounts
//   tbprefs <prefs.js text>              parseThunderbirdPrefs
//   mobileme <plist path>                parseMobileMeAccounts
//   emclient <SQLite path>               emClientAddresses
//   mailstate <asked 1|0> <output|-> <permission>   mailLookState
//   events <events JSON> <ids,...> <now ms> <zone>   calendarPayload (dates as ms since 1970)
//   calendars <calendars JSON>           shapeCalendars
//   people <people JSON>                 shapePeople
//   zoom <{folder: [file names]} JSON>   zoomRecordingCount
//   discover <what,...> <openMail 1|0> <fake JSON>   runDiscovery over FakeSources: {result, calls} (calls: what the fake was asked)
//   dmerge <kept JSON> <fresh JSON>      mergeDiscovery
//   rloop <url|-> <notes|->              reminderLoopID
//   rdue <components JSON|-> <zone>      reminderDueValue ({year, month, day, hour?, minute?, zone?})
//   rcomp <ms> <zone>                    reminderDueComponents, back as {year, month, day, hour, minute, zone}
//   rpayload <on 1|0> <lists JSON> <reminders JSON> <zone>   remindersPayload (reminders as rdue's components and modified in ms)
//   rops <ops JSON> <existing reminders JSON>                reminderOpsToMake, each op said as JSON
//   rallowed <op JSON> <target reminder JSON|->              parseReminderOp then reminderOpAllowed (null: not an op)
//   wtarget <at ms|-> <near JSON> <byID JSON|->              calendarWriteTarget over made-up events {name, start (ms), repeats}: its name
//   roff                                 RemindersFeed (made-up Reminders, settings in memory): a round under way when the switch is turned
//                                        off: {posts: the "on" of each body posted, applied: how many changes were made, on}

import Foundation

/// Sources that answer from JSON and note every call: what a discovery asked of them is checked (the test never reads a real calendar,
/// contact or Mail account). {calendars, contacts, mail: "granted"|"denied"|"notAsked"; grant: [kinds a request is answered yes for];
/// installed: [bundle ids]; calendarList: [...]; contactsCount; mailRunning; mailOutput (null: Mail refused); zoom: {folder: [files]}|null}
final class FakeSources: DiscoverySources {
    var d: [String: Any]
    var calls: [String] = []
    init(_ d: [String: Any]) { self.d = d }
    private func perm(_ k: String) -> String { d[k] as? String ?? "notAsked" }
    private func request(_ k: String) -> Bool {
        calls.append("request:\(k)")
        let yes = (d["grant"] as? [String] ?? []).contains(k)
        d[k] = yes ? "granted" : "denied"
        return yes
    }
    func installed(_ bundleID: String) -> Bool { (d["installed"] as? [String] ?? []).contains(bundleID) }
    func calendarPermission() -> String { perm("calendars") }
    func requestCalendars() -> Bool { request("calendars") }
    func calendars() -> [LocalCalendar] {
        calls.append("read:calendars")
        return (d["calendarList"] as? [[String: Any]] ?? []).map {
            LocalCalendar(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", source: $0["source"] as? String ?? "",
                          color: $0["color"] as? String ?? "", writable: $0["writable"] as? Bool ?? false)
        }
    }
    func contactsPermission() -> String { perm("contacts") }
    func requestContacts() -> Bool { request("contacts") }
    func contactsCount() -> Int { calls.append("read:contacts"); return d["contactsCount"] as? Int ?? 0 }
    func mailRunning() -> Bool { d["mailRunning"] as? Bool ?? false }
    func mailPermission() -> String { perm("mail") }
    func mailAccounts() -> String? {
        calls.append(mailRunning() ? "ask:mail" : "open:mail")
        if perm("mail") == "notAsked" { _ = request("mail") }
        return perm("mail") == "granted" ? d["mailOutput"] as? String : nil
    }
    var zoomFolder: String { "/Users/test/Documents/Zoom" }
    func zoomFolders() -> [String: [String]]? { calls.append("read:zoom"); return d["zoom"] as? [String: [String]] }
    func outlookRunning() -> Bool { d["outlookRunning"] as? Bool ?? false }
    func outlookAccounts() -> String? { calls.append("ask:outlook"); return d["outlookOutput"] as? String }
    func emClientFiles() -> [String] { d["emClientFiles"] as? [String] ?? [] }
    func thunderbirdPrefs() -> [String] { d["thunderbird"] as? [String] ?? [] }
    func mobileMeAccounts() -> Data? { (d["mobileMe"] as? String).flatMap { FileManager.default.contents(atPath: $0) } }
    func meCardEmails() -> [String] { calls.append("read:me"); return d["meCard"] as? [String] ?? [] }
}

/// Reminders as the tests make them up (never EventKit: the person's own lists are never read or written): access given, Pako's list there
/// and empty; the changes made are counted.
final class FakeReminders: RemindersStore, @unchecked Sendable {
    private let lock = NSLock()
    private var made = 0
    var applied: Int { lock.lock(); defer { lock.unlock() }; return made }
    func access() -> String { "granted" }
    func request() -> String { "granted" }
    func lists(create: Set<String>) -> [String: String] { ["owe": "list-1"] }
    func read(_ lists: [String: String]) -> [LocalReminder] { [] }
    func apply(_ ops: [ReminderOp], lists: [String: String], zone: TimeZone) { lock.lock(); made += ops.count; lock.unlock() }
}

/// Settings kept in memory only: nothing of a test lands in the person's preferences.
final class MemoryDefaults: UserDefaults {
    private var d: [String: Any] = [:]
    init() { super.init(suiteName: "pako-test-memory")! }
    override func object(forKey k: String) -> Any? { d[k] }
    override func set(_ v: Any?, forKey k: String) { d[k] = v }
    override func set(_ v: Bool, forKey k: String) { d[k] = v }
    override func removeObject(forKey k: String) { d[k] = nil }
    override func bool(forKey k: String) -> Bool { d[k] as? Bool ?? false }
    override func string(forKey k: String) -> String? { d[k] as? String }
    override func dictionary(forKey k: String) -> [String: Any]? { d[k] as? [String: Any] }
}

final class Posts: @unchecked Sendable { var on: [Bool] = [] }

func jsonArg(_ s: String) -> Any? { try? JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed]) }

/// A due date as the tests write it: {year, month, day, hour?, minute?, zone?}.
func components(_ v: Any?) -> DateComponents? {
    guard let d = v as? [String: Any] else { return nil }
    var c = DateComponents(year: d["year"] as? Int, month: d["month"] as? Int, day: d["day"] as? Int, hour: d["hour"] as? Int, minute: d["minute"] as? Int)
    if let z = d["zone"] as? String { c.timeZone = TimeZone(identifier: z) }
    return c
}

/// A reminder as the tests write it: {id, list, title, url?, notes?, due? (as components), completed?, modified? (ms)}.
func reminder(_ v: Any) -> LocalReminder? {
    guard let d = v as? [String: Any] else { return nil }
    return LocalReminder(id: d["id"] as? String ?? "", list: d["list"] as? String ?? "", title: d["title"] as? String ?? "", url: d["url"] as? String,
                         notes: d["notes"] as? String, due: components(d["due"]), completed: d["completed"] as? Bool ?? false,
                         modified: (d["modified"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) })
}

/// One op as the server wrote it (due: absent, null or ms).
func said(_ op: ReminderOp) -> [String: Any] {
    switch op {
    case let .create(loop, list, title, due, notes):
        return ["op": "create", "loop": loop, "list": list, "title": title, "due": due ?? NSNull(), "notes": notes]
    case let .update(id, loop, title, due, notes, completed):
        var d: [String: Any] = ["op": "update", "id": id, "loop": loop]
        if let t = title { d["title"] = t }
        if let x = due { d["due"] = x ?? NSNull() }
        if let n = notes { d["notes"] = n }
        if let c = completed { d["completed"] = c }
        return d
    case let .remove(id, loop):
        return ["op": "remove", "id": id, "loop": loop]
    }
}

let a = Array(CommandLine.arguments.dropFirst())
var out: Any = NSNull()
switch a.first ?? "" {
case "env":
    out = readEnvFile(a[1], names: Array(a.dropFirst(2)))
case "home":
    var env: [String: String] = [:]
    if a.count > 3 { env["PAKO_HOME"] = a[3] == "-" ? "" : a[3] }
    out = pakoHome(env: env, repo: a[1], userHome: a[2])
case "lock":
    if let l = readLock(home: a[1], upSeconds: Double(a[2]) ?? 0) { out = ["pid": l.pid, "port": l.port, "alive": l.alive] }
case "listens":
    out = processListens(pid: Int(a[1]) ?? 0, port: Int(a[2]) ?? 0)
case "nav":
    // nav <url> <port or -> <main 1|0> <clicked 1|0>
    out = URL(string: a[1]).map { panelNavigation($0, port: Int(a[2]), mainFrame: a[3] == "1", clicked: a[4] == "1").rawValue } ?? "bad"
case "origin":
    // origin <protocol> <host> <origin port> <panel port or ->
    out = isPanelOrigin(protocol: a[1], host: a[2], port: Int(a[3]) ?? 0, port: Int(a[4]))
case "path":
    out = loginPathFrom(a[1])
case "node":
    if let v = nodeVersion(a[1]) { out = ["v": [v.0, v.1, v.2], "ok": nodeIsRecentEnough(v)] }
case "link":
    out = isLocalPanelLink(a[1], port: Int(a[2]) ?? 0)
case "version":
    out = hasAuthCommands(a[1])
case "auth":
    if let st = parseAuthStatus(code: Int32(a[1]) ?? -1, out: a[2]) {
        out = ["loggedIn": st.loggedIn, "method": st.method, "email": st.email ?? NSNull(), "plan": st.plan ?? NSNull()]
    }
case "state":
    let auth = a[2] == "-" ? nil : parseAuthStatus(code: Int32(a[2]) ?? -1, out: a[3])
    let server = a[4] == "-" ? nil : (try? JSONSerialization.jsonObject(with: Data(a[4].utf8))) as? [String: Any]
    out = claudeState(binary: a[1] == "1", auth: auth, server: server).rawValue
case "keysrc":
    let server = a[2] == "-" ? nil : (try? JSONSerialization.jsonObject(with: Data(a[2].utf8))) as? [String: Any]
    out = apiKeySource(appEnv: a[1] == "-" ? [:] : ["ANTHROPIC_API_KEY": a[1]], server: server) ?? NSNull()
case "find":
    let exec = Set(a[4].split(separator: ",").map(String.init))
    out = findClaude(given: a[1] == "-" ? nil : a[1], dirs: claudeDirs(loginPath: a[2], home: a[3]), isExecutable: { exec.contains($0) }) ?? NSNull()
case "merge":
    out = mergePathDirs(a.dropFirst().map { $0.split(separator: ":", omittingEmptySubsequences: false).map(String.init) }).joined(separator: ":")
case "installer":
    out = isInstallerURL(URL(string: a[1]))
case "loginurl":
    out = loginPageURL(a[1])?.absoluteString ?? NSNull()
case "tail":
    out = outputTail(a[1], count: Int(a[2]) ?? 1)
case "asks":
    out = loginAsksForCode(a[1])
case "code":
    out = cleanLoginCode(a[1]) ?? NSNull()
case "bundled":
    let files = Set(a[2].split(separator: ",").map(String.init))
    let b = bundledServer(resources: a[1], isPakoFolder: { files.contains(($0 as NSString).appendingPathComponent("src/server.ts")) },
                          isExecutable: { files.contains($0) })
    out = b.map { ["repo": $0.repo, "node": $0.node] } ?? NSNull()
case "move":
    out = needsMoveToApplications(a[1])
case "agent":
    let there = Set(a[1].split(separator: ",").map(String.init))
    out = legacyAgentIsStale(programArguments: Array(a.dropFirst(2)), exists: { there.contains($0) })
case "newer":
    out = isNewerVersion(a[1], than: a[2])
case "feed":
    let key = ProcessInfo.processInfo.environment["PAKO_TEST_FEED_KEY"]
    out = parseUpdateFeed(Data(a[1].utf8), loopback: a.count > 2, publicKey: key).map { u -> [String: Any] in
        ["version": u.version, "url": u.url.absoluteString, "notes": u.notes, "build": u.build ?? NSNull(), "sha256": u.sha256 ?? NSNull(),
         "minimumMacOS": u.minimumMacOS ?? NSNull(), "page": u.page?.absoluteString ?? NSNull(), "installable": u.installable, "signed": u.signed]
    } ?? NSNull()
case "release":
    out = isNewerRelease(version: a[1], build: Int(a[2]), than: a[3], currentBuild: Int(a[4]))
case "macos":
    let v = nodeVersion(a[2]) ?? (0, 0, 0)
    out = macOSAtLeast(a[1], current: OperatingSystemVersion(majorVersion: v.0, minorVersion: v.1, patchVersion: v.2))
case "things":
    let json = { (s: String) -> Any? in s == "-" ? nil : try? JSONSerialization.jsonObject(with: Data(s.utf8)) }
    out = parseThings(connections: json(a[1]), telegram: json(a[2]))
        .map { $0.map { ["id": $0.id, "name": $0.name, "how": $0.how, "state": $0.state] } } ?? NSNull()
case "delays":
    out = (0...5).map { restartDelay(failures: $0) ?? -1 }
case "why":
    switch startFailure(logTail: a[1]) {
    case let .portInUse(p): out = ["port": p]
    case .settings: out = "settings"
    case .held: out = "held"
    case .unknown: out = "unknown"
    }
case "free":
    let p = freeLoopbackPort() ?? 0
    out = ["given": loopbackPortIsFree(Int(a[1]) ?? 0), "chosen": p > 1024, "chosenFree": loopbackPortIsFree(p)]
case "rotate":
    out = rotateLog(a[1], limit: Int(a[2]) ?? 0)
case "counts":
    if let (now, list) = parseNotices(Data(a[1].utf8)) {
        let c = noticeCounts(list, notifiedAt: Double(a[2]) ?? 0, readAt: Double(a[3]) ?? 0)
        out = ["now": now, "fresh": c.fresh.map(\.n), "unread": c.unread, "secret": list.filter(\.secret).map(\.n)]
    }
case "failure":
    out = connectFailure(a[1]).rawValue
case "macho":
    out = isMachO(a[1])
case "started":
    let pid = Int(a[1]) ?? 0
    out = ["start": processStartTime(pid) ?? -1, "path": processPath(pid) ?? ""]
case "hash":
    out = stableHash(a[1])
case "msg":
    switch jsonArg(a[1]).flatMap(parsePakoMessage) {
    case nil: out = NSNull()
    case let .discover(what, openMail)?: out = ["type": "discover", "what": what, "openMail": openMail]
    case let .calendarSelect(ids)?: out = ["type": "calendarSelect", "ids": ids]
    case .contactsImport?: out = ["type": "contactsImport"]
    case let .openURL(u)?: out = ["type": "openURL", "url": u.absoluteString]
    case .openSettingsWindow?: out = ["type": "openSettingsWindow"]
    case .calendarPush?: out = ["type": "calendarPush"]
    case let .openWindow(path)?: out = ["type": "openWindow", "path": path]
    case let .use(what, ids)?: out = ["type": "use", "what": what, "ids": ids]
    case let .reminders(on)?: out = ["type": "reminders", "on": on]
    case .panelWord?: out = ["type": "panelWord"]
    }
case "openurl":
    out = allowedOpenURL(a[1])?.absoluteString ?? NSNull()
case "apps":
    let there = Set(a[1].split(separator: ",").map(String.init))
    out = installedApps(has: { there.contains($0) })
case "provider":
    out = mailProvider(a[1], accountType: a.count > 2 ? a[2] : "")
case "mailparse":
    out = parseMailAccounts(a[1])
case "tbprefs":
    out = parseThunderbirdPrefs(a[1])
case "mobileme":
    out = parseMobileMeAccounts(FileManager.default.contents(atPath: a[1]) ?? Data()).map { ["address": $0.address, "name": $0.name, "mail": $0.mail] }
case "emclient":
    out = emClientAddresses(path: a[1])
case "mailstate":
    out = mailLookState(asked: a[1] == "1", output: a[2] == "-" ? nil : a[2], permission: a[3])
case "events":
    let list = (jsonArg(a[1]) as? [[String: Any]] ?? []).map { e -> LocalEvent in
        let ms = { (k: String) in Date(timeIntervalSince1970: (e[k] as? Double ?? 0) / 1000) }
        return LocalEvent(id: e["id"] as? String ?? "", calendarId: e["calendarId"] as? String ?? "", title: e["title"] as? String ?? "",
                          start: ms("start"), end: ms("end"), allDay: e["allDay"] as? Bool ?? false, location: e["location"] as? String,
                          notes: e["notes"] as? String, url: e["url"] as? String, attendees: e["attendees"] as? [String] ?? [],
                          cancelled: e["cancelled"] as? Bool ?? false)
    }
    out = calendarPayload(ids: a[2].split(separator: ",").map(String.init), events: list,
                          now: Date(timeIntervalSince1970: (Double(a[3]) ?? 0) / 1000), zone: TimeZone(identifier: a[4]) ?? .current)
case "calendars":
    out = shapeCalendars((jsonArg(a[1]) as? [[String: Any]] ?? []).map {
        LocalCalendar(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", source: $0["source"] as? String ?? "",
                      color: $0["color"] as? String ?? "", writable: $0["writable"] as? Bool ?? false)
    })
case "people":
    out = shapePeople((jsonArg(a[1]) as? [[String: Any]] ?? []).map {
        LocalPerson(name: $0["name"] as? String ?? "", emails: $0["emails"] as? [String] ?? [], phones: $0["phones"] as? [String] ?? [],
                    org: $0["org"] as? String)
    })
case "zoom":
    out = zoomRecordingCount(jsonArg(a[1]) as? [String: [String]] ?? [:])
case "discover":
    let fake = FakeSources(jsonArg(a[3]) as? [String: Any] ?? [:])
    let r = runDiscovery(what: a[1].split(separator: ",").map(String.init), openMail: a[2] == "1", sources: fake,
                         now: Date(timeIntervalSince1970: 1_800_000_000))
    out = ["result": r, "calls": fake.calls]
case "dmerge":
    out = mergeDiscovery(kept: jsonArg(a[1]) as? [String: Any] ?? [:], fresh: jsonArg(a[2]) as? [String: Any] ?? [:])
case "rloop":
    out = reminderLoopID(url: a[1] == "-" ? nil : a[1], notes: a[2] == "-" ? nil : a[2]) ?? NSNull()
case "rdue":
    out = reminderDueValue(components(jsonArg(a[1])), zone: TimeZone(identifier: a[2]) ?? .current) ?? NSNull()
case "rcomp":
    let c = reminderDueComponents(ms: Double(a[1]) ?? 0, zone: TimeZone(identifier: a[2]) ?? .current)
    out = ["year": c.year ?? -1, "month": c.month ?? -1, "day": c.day ?? -1, "hour": c.hour ?? -1, "minute": c.minute ?? -1, "zone": c.timeZone?.identifier ?? ""]
case "rpayload":
    out = remindersPayload(on: a[1] == "1", access: "granted", lists: jsonArg(a[2]) as? [String: String] ?? [:],
                           reminders: (jsonArg(a[3]) as? [Any] ?? []).compactMap(reminder), zone: TimeZone(identifier: a[4]) ?? .current)
case "rops":
    out = reminderOpsToMake(jsonArg(a[1]) as? [Any] ?? [], existing: (jsonArg(a[2]) as? [Any] ?? []).compactMap(reminder)).map(said)
case "rallowed":
    if let op = jsonArg(a[1]).flatMap(parseReminderOp) { out = reminderOpAllowed(op, target: a[2] == "-" ? nil : jsonArg(a[2]).flatMap(reminder)) }
case "roff":
    let fake = FakeReminders(), d = MemoryDefaults(), posts = Posts()
    d.set(true, forKey: "remindersOn")
    MainActor.assumeIsolated {
        let feed = RemindersFeed(defaults: d, live: true, store: fake)
        feed.post = { body, done in
            posts.on.append(body["on"] as? Bool ?? false)
            done(["ops": [["op": "create", "loop": "0123456789", "list": "owe", "title": "Send the deck"]]])
        }
        feed.sync()
        // The panel's switch turned off while that round reads Reminders.
        feed.setOn(false) { _ in }
        let until = Date().addingTimeInterval(2)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }
    out = ["posts": posts.on, "applied": fake.applied, "on": d.bool(forKey: "remindersOn")]
case "wtarget":
    typealias Made = (name: String, start: Date, repeats: Bool)
    let made = { (v: Any?) -> Made? in
        guard let d = v as? [String: Any] else { return nil }
        return (d["name"] as? String ?? "", Date(timeIntervalSince1970: (d["start"] as? Double ?? 0) / 1000), d["repeats"] as? Bool ?? false)
    }
    let near = (jsonArg(a[2]) as? [Any] ?? []).compactMap(made)
    out = calendarWriteTarget(at: Double(a[1]).map { Date(timeIntervalSince1970: $0 / 1000) }, near: near, byID: a[3] == "-" ? nil : made(jsonArg(a[3])),
                              start: { $0.start }, repeats: { $0.repeats })?.name ?? NSNull()
default:
    exit(2)
}
let data = try JSONSerialization.data(withJSONObject: ["r": out], options: [.sortedKeys, .fragmentsAllowed])
print(String(decoding: data, as: UTF8.self))
