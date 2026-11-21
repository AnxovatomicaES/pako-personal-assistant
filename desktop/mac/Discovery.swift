// The Mac's side of the panel's connections (docs/desktop-mac.md, "Discovery"): what it finds on this Mac when the person says yes in the
// panel (installed apps, calendars, Mail's accounts, how many contacts, Zoom's local recordings), the chosen calendars' events sent to this
// computer's Pako every ten minutes and when they change, and the contacts import. The rules are in DiscoveryCore.swift; here only the
// reading, behind macOS's own prompts. A check-only run (PAKO_APP_REPORT, PAKO_APP_SELFTEST) never asks for nor reads Calendars, Contacts
// or Mail: `live` is false there, and those say "notAsked".

import AppKit
import Contacts
import CoreServices
import EventKit

/// A value set from another thread's callback and read after the wait.
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ v: T) { value = v }
}

/// What the app reads from: the Mac itself (MacSources) or, in a check-only build, a file of made-up data (FileSources).
protocol PakoSources: DiscoverySources, AnyObject, Sendable {
    /// False in a check-only run: nothing is asked or read.
    var live: Bool { get }
    func events(ids: [String], from: Date, to: Date) -> [LocalEvent]
    func people() -> [LocalPerson]
    /// One calendar change the person said yes to in Pako (POST /panel/api/calendar/writes): done, and what was there before.
    func applyCalendarWrite(_ w: [String: Any]) -> [String: Any]
}

extension PakoSources {
    func applyCalendarWrite(_ w: [String: Any]) -> [String: Any] { ["id": w["id"] as? String ?? "", "ok": false, "error": "this app cannot change the calendar"] }
}

/// Milliseconds since 1970, as Pako sends times.
private func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

/// The Mac itself as DiscoverySources. Its calls may block (a prompt waits for the person): they run on a work queue, never the main thread.
final class MacSources: PakoSources, @unchecked Sendable {
    private let lock = NSLock()
    private var _store = EKEventStore()
    /// Made anew once access is given: a store made before may not see the calendars.
    var store: EKEventStore {
        lock.lock(); defer { lock.unlock() }
        return _store
    }
    let userHome: String
    let live: Bool

    init(userHome: String, live: Bool) {
        self.userHome = userHome
        self.live = live
    }

    func installed(_ bundleID: String) -> Bool { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil }

    // MARK: calendars (EventKit)

    func calendarPermission() -> String {
        guard live else { return "notAsked" }
        // 3 is .authorized up to macOS 13 and .fullAccess from 14; 4 (.writeOnly) cannot read, so it counts as refused.
        switch EKEventStore.authorizationStatus(for: .event).rawValue {
        case 0: return "notAsked"
        case 3: return "granted"
        default: return "denied"
        }
    }

    func requestCalendars() -> Bool {
        guard live else { return false }
        let ok = Box(false), sem = DispatchSemaphore(value: 0)
        let done: EKEventStoreRequestAccessCompletionHandler = { granted, _ in ok.value = granted; sem.signal() }
        if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: done) } else { store.requestAccess(to: .event, completion: done) }
        sem.wait()
        if ok.value {
            lock.lock(); _store = EKEventStore(); lock.unlock()
        }
        return ok.value
    }

    func calendars() -> [LocalCalendar] {
        guard calendarPermission() == "granted" else { return [] }
        return store.calendars(for: .event).map { c in
            let rgb = c.color.usingColorSpace(.sRGB)
            return LocalCalendar(id: c.calendarIdentifier, title: c.title, source: c.source?.title ?? "",
                                 color: rgb.map { hexColor(Double($0.redComponent), Double($0.greenComponent), Double($0.blueComponent)) } ?? "#888888",
                                 writable: c.allowsContentModifications)
        }
    }

    /// The events of these calendars between the two dates (each occurrence of a repeating one on its own).
    func events(ids: [String], from: Date, to: Date) -> [LocalEvent] {
        guard calendarPermission() == "granted" else { return [] }
        let s = store
        let cals = s.calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
        guard !cals.isEmpty else { return [] }
        let found = s.events(matching: s.predicateForEvents(withStart: from, end: to, calendars: cals))
        return found.map { e in
            let people = (e.attendees ?? []).map { p -> String in
                let mail = p.url.absoluteString.lowercased().hasPrefix("mailto:") ? String(p.url.absoluteString.dropFirst(7)) : ""
                return [p.name, mail.isEmpty ? nil : "<\(mail)>"].compactMap { $0 }.joined(separator: " ")
            }
            return LocalEvent(id: e.eventIdentifier ?? e.calendarItemIdentifier, calendarId: e.calendar.calendarIdentifier, title: e.title ?? "",
                              start: e.startDate, end: e.endDate, allDay: e.isAllDay, location: e.location, notes: e.notes,
                              url: e.url?.absoluteString, attendees: people, uid: e.calendarItemExternalIdentifier,
                              response: myResponse(e), organizer: e.organizer?.isCurrentUser == true ? nil : e.organizer?.name,
                              cancelled: e.status == .canceled)
        }
    }

    /// What each write found before it changed anything, kept on this Mac by the write's id from the first try: a move sent again after a
    /// restart (the event already at its new times) or a delete sent again (the event gone) still answers with the original, so Undo works.
    private static let beforeKey = "calendarWriteBefore"
    private func rememberedBefore(_ id: String) -> [String: Any]? {
        (UserDefaults.standard.dictionary(forKey: Self.beforeKey)?[id] as? [String: Any]).map { $0.filter { $0.key != "keptAt" } }
    }
    private func rememberBefore(_ id: String, _ before: [String: Any]) {
        let now = Date().timeIntervalSince1970
        var all = UserDefaults.standard.dictionary(forKey: Self.beforeKey) ?? [:]
        // A week is longer than any write waits (the server keeps them as long); fifty is more than are ever in flight.
        func keptAt(_ v: Any) -> Double { (v as? [String: Any])?["keptAt"] as? Double ?? 0 }
        all = all.filter { keptAt($0.value) > now - 7 * 24 * 3600 }
        if all.count >= 50, let oldest = all.min(by: { keptAt($0.value) < keptAt($1.value) }) { all.removeValue(forKey: oldest.key) }
        var b = before
        b["keptAt"] = now
        all[id] = b
        UserDefaults.standard.set(all, forKey: Self.beforeKey)
        UserDefaults.standard.synchronize()
    }

    /// One change, done once: a move (the occurrence that starts at "at"), a new event (marked with the write's id, so a write sent again finds
    /// it instead of making another), or a deletion (with what it was, so Undo can make it again). Nothing is sent to anyone invited.
    func applyCalendarWrite(_ w: [String: Any]) -> [String: Any] {
        let id = w["id"] as? String ?? ""
        func fail(_ why: String) -> [String: Any] { ["id": id, "ok": false, "error": why] }
        guard calendarPermission() == "granted" else { return fail("Pako may not change this Mac's calendars (System Settings > Privacy & Security > Calendars)") }
        let s = store
        func date(_ k: String) -> Date? { (w[k] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } }
        /// That event's occurrences that start within a minute of `t` (a repeating event shares its identifier).
        func occurrences(_ eid: String, at t: Date) -> [EKEvent] {
            s.events(matching: s.predicateForEvents(withStart: t.addingTimeInterval(-60), end: t.addingTimeInterval(24 * 3600), calendars: nil))
                .filter { $0.eventIdentifier == eid && abs($0.startDate.timeIntervalSince(t)) < 60 }
        }
        /// The occurrence meant: that identifier at that start; else the event itself only when it does not repeat (calendarWriteTarget).
        func find() -> EKEvent? {
            guard let eid = w["eventId"] as? String else { return nil }
            let at = date("at")
            return calendarWriteTarget(at: at, near: at.map { occurrences(eid, at: $0) } ?? [], byID: s.event(withIdentifier: eid),
                                       start: { $0.startDate }, repeats: { $0.hasRecurrenceRules })
        }
        do {
            switch w["op"] as? String {
            case "move":
                guard let start = date("start"), let end = date("end") else { return fail("the event is no longer on the calendar") }
                guard let e = find() else {
                    // Moved by this write's first try (the app restarted before saying so): that occurrence is at its new start already.
                    if let before = rememberedBefore(id), let eid = w["eventId"] as? String, let moved = occurrences(eid, at: start).first {
                        return ["id": id, "ok": true, "eventId": moved.eventIdentifier ?? eid, "before": before]
                    }
                    return fail("the event is no longer on the calendar")
                }
                guard e.calendar.allowsContentModifications else { return fail("that calendar cannot be changed from this Mac") }
                let before: [String: Any] = rememberedBefore(id) ?? ["start": ms(e.startDate), "end": ms(e.endDate)]
                rememberBefore(id, before)
                e.startDate = start
                e.endDate = end
                try s.save(e, span: .thisEvent, commit: true)
                return ["id": id, "ok": true, "eventId": e.eventIdentifier ?? "", "before": before]
            case "create":
                guard let start = date("start"), let end = date("end"), let title = w["title"] as? String, !title.isEmpty else { return fail("the new event was not complete") }
                let mark = URL(string: "pako://write/\(id)")
                let near = s.events(matching: s.predicateForEvents(withStart: start.addingTimeInterval(-60), end: end.addingTimeInterval(60), calendars: nil))
                if let made = near.first(where: { $0.url == mark }) { return ["id": id, "ok": true, "eventId": made.eventIdentifier ?? ""] }
                let e = EKEvent(eventStore: s)
                e.title = title
                e.startDate = start
                e.endDate = end
                e.url = mark
                if let place = w["location"] as? String, !place.isEmpty { e.location = place }
                if let cid = w["calendarId"] as? String, let cal = s.calendar(withIdentifier: cid), cal.allowsContentModifications { e.calendar = cal }
                else { e.calendar = s.defaultCalendarForNewEvents }
                guard e.calendar != nil else { return fail("there is no calendar to add it to") }
                try s.save(e, span: .thisEvent, commit: true)
                return ["id": id, "ok": true, "eventId": e.eventIdentifier ?? ""]
            case "delete":
                guard let e = find() else {
                    // Deleted by this write's first try (the app restarted before saying so): done, with what Undo brings back. Else it was
                    // not there to delete: said so, never "deleted".
                    if let before = rememberedBefore(id) { return ["id": id, "ok": true, "before": before] }
                    return ["id": id, "ok": false, "notFound": true, "error": "it wasn't found on this Mac's calendars"]
                }
                guard e.calendar.allowsContentModifications else { return fail("that calendar cannot be changed from this Mac") }
                var before: [String: Any] = ["start": ms(e.startDate), "end": ms(e.endDate), "title": e.title ?? "", "calendarId": e.calendar.calendarIdentifier]
                if let place = e.location { before["location"] = place }
                rememberBefore(id, before)
                try s.remove(e, span: .thisEvent, commit: true)
                return ["id": id, "ok": true, "before": before]
            default:
                return fail("not a change this app makes")
            }
        } catch {
            return fail(error.localizedDescription)
        }
    }

    // MARK: contacts (Contacts)

    func contactsPermission() -> String {
        guard live else { return "notAsked" }
        // 3 is .authorized; 4 (.limited, newer systems) reads the contacts the person chose.
        switch CNContactStore.authorizationStatus(for: .contacts).rawValue {
        case 0: return "notAsked"
        case 3, 4: return "granted"
        default: return "denied"
        }
    }

    func requestContacts() -> Bool {
        guard live else { return false }
        let ok = Box(false), sem = DispatchSemaphore(value: 0)
        CNContactStore().requestAccess(for: .contacts) { granted, _ in ok.value = granted; sem.signal() }
        sem.wait()
        return ok.value
    }

    /// How many contacts there are: no field of any of them is read.
    func contactsCount() -> Int {
        guard contactsPermission() == "granted" else { return 0 }
        var n = 0
        try? CNContactStore().enumerateContacts(with: CNContactFetchRequest(keysToFetch: [])) { _, _ in n += 1 }
        return n
    }

    /// Names, emails, phones and the company: nothing else of a card (no note, address, birthday or picture).
    func people() -> [LocalPerson] {
        guard contactsPermission() == "granted" else { return [] }
        let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactOrganizationNameKey as CNKeyDescriptor,
                                       CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor]
        var out: [LocalPerson] = []
        try? CNContactStore().enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c, stop in
            out.append(LocalPerson(name: CNContactFormatter.string(from: c, style: .fullName) ?? "", emails: c.emailAddresses.map { $0.value as String },
                                   phones: c.phoneNumbers.map { $0.value.stringValue }, org: c.organizationName))
            if out.count >= 20000 { stop.pointee = true }
        }
        return out
    }

    // MARK: Mail (its accounts' addresses, through Apple events: macOS asks the person first)

    static let mailID = "com.apple.mail"
    /// Each account's name, addresses and type, one per line: nothing else of Mail is asked (no mailbox, no message).
    static let mailScript = """
        tell application id "com.apple.mail"
            set out to ""
            repeat with a in every account
                set addrs to ""
                repeat with e in (email addresses of a)
                    set addrs to addrs & (e as text) & ","
                end repeat
                set out to out & (name of a as text) & tab & addrs & tab & ((account type of a) as text) & linefeed
            end repeat
            return out
        end tell
        """

    func mailRunning() -> Bool {
        live && !NSRunningApplication.runningApplications(withBundleIdentifier: MacSources.mailID).isEmpty
    }

    func mailPermission() -> String {
        guard live, mailRunning() else { return "notAsked" }
        let target = NSAppleEventDescriptor(bundleIdentifier: MacSources.mailID)
        return automationPermission(AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false))
    }

    /// Asks Mail (opening it when it is not running: only called then when the person pressed the button). osascript runs as this app's
    /// child, so macOS's Automation prompt names Pako; it waits up to two minutes for the answer.
    func mailAccounts() -> String? {
        guard live, let r = run("/usr/bin/osascript", ["-e", MacSources.mailScript], timeout: 120), r.code == 0 else { return nil }
        return r.out
    }

    // MARK: the other mail apps (their accounts' addresses only)

    static let outlookID = "com.microsoft.Outlook"
    /// The classic Outlook's accounts, in Mail's line shape: name, address, type. The new Outlook keeps no accounts in its AppleScript
    /// dictionary, so this fails there and the person types their address instead (the panel says so).
    static let outlookScript = """
        tell application id "com.microsoft.Outlook"
            set out to ""
            repeat with a in (every exchange account)
                set out to out & (name of a as text) & tab & (email address of a as text) & tab & "ews" & linefeed
            end repeat
            repeat with a in (every imap account)
                set out to out & (name of a as text) & tab & (email address of a as text) & tab & "imap" & linefeed
            end repeat
            repeat with a in (every pop account)
                set out to out & (name of a as text) & tab & (email address of a as text) & tab & "pop" & linefeed
            end repeat
            return out
        end tell
        """

    func outlookRunning() -> Bool {
        live && !NSRunningApplication.runningApplications(withBundleIdentifier: MacSources.outlookID).isEmpty
    }

    func outlookAccounts() -> String? {
        guard live, let r = run("/usr/bin/osascript", ["-e", MacSources.outlookScript], timeout: 120), r.code == 0 else { return nil }
        return r.out
    }

    /// eM Client's database files: its folder in Application Support, a plain folder of this user (eM Client is not sandboxed), so reading
    /// it shows no prompt. Only its .dat files directly inside, the account list among them; emClientAddresses reads addresses only.
    func emClientFiles() -> [String] {
        guard live else { return [] }
        let dir = (userHome as NSString).appendingPathComponent("Library/Application Support/eM Client")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        // accounts.dat holds the accounts; without one (another version), the few .dat files at the top are looked at instead.
        let dats = names.filter { $0.lowercased().hasSuffix(".dat") }.sorted()
        let pick = dats.first { $0.lowercased() == "accounts.dat" }.map { [$0] } ?? Array(dats.prefix(3))
        return pick.map { (dir as NSString).appendingPathComponent($0) }
    }

    /// Thunderbird's prefs.js in each profile (plain files of this user).
    func thunderbirdPrefs() -> [String] {
        guard live else { return [] }
        let dir = (userHome as NSString).appendingPathComponent("Library/Thunderbird/Profiles")
        let profiles = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        return profiles.prefix(10).compactMap { p in
            let f = ((dir as NSString).appendingPathComponent(p) as NSString).appendingPathComponent("prefs.js")
            guard let d = FileManager.default.contents(atPath: f), d.count < 4_000_000 else { return nil }
            return String(decoding: d, as: UTF8.self)
        }
    }

    /// The Apple IDs signed in on this Mac, from an ordinary preferences file of this user (no prompt: it is not in a protected folder).
    func mobileMeAccounts() -> Data? {
        guard live else { return nil }
        return FileManager.default.contents(atPath: (userHome as NSString).appendingPathComponent("Library/Preferences/MobileMeAccounts.plist"))
    }

    /// The "Me" card's addresses: Contacts' own idea of who the person is. Only called once Contacts said yes.
    func meCardEmails() -> [String] {
        guard live, CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return [] }
        let me = try? CNContactStore().unifiedMeContactWithKeys(toFetch: [CNContactEmailAddressesKey as CNKeyDescriptor])
        return me?.emailAddresses.map { $0.value as String } ?? []
    }

    // MARK: Zoom's local recordings (folder and file names only)

    var zoomFolder: String { (userHome as NSString).appendingPathComponent("Documents/Zoom") }

    func zoomFolders() -> [String: [String]]? {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: zoomFolder, isDirectory: &isDir), isDir.boolValue,
              let names = try? fm.contentsOfDirectory(atPath: zoomFolder) else { return nil }
        var out: [String: [String]] = [:]
        for n in names.prefix(2000) where !n.hasPrefix(".") {
            let p = (zoomFolder as NSString).appendingPathComponent(n)
            var d: ObjCBool = false
            if fm.fileExists(atPath: p, isDirectory: &d), d.boolValue { out[n] = (try? fm.contentsOfDirectory(atPath: p)) ?? [] }
        }
        return out
    }
}

/// PAKO_APP_FAKE_SOURCES=<file.json> (check-only, never in a Developer ID build): made-up calendars, events, contacts and Mail accounts,
/// so a test build can walk the connections end to end without macOS asking anything and without any real data. Every permission is what
/// the file says ("granted" by default). The file: {installed: [bundle ids], calendarList: [{id, title, source, color, writable}],
/// events: [{id, calendarId, title, inMinutes, minutes, allDay?, location?, url?}] (times from now), people: [{name, emails, phones, org?}],
/// mailRunning, mailOutput (Mail's account lines), zoom: {folder: [file names]} | null, calendars/contacts/mail: a permission}.
/// The first address on this Mac's Me card, for Claude's sign-in page (`--email`): only when the person already let Pako read the contacts;
/// it never asks for that here. nil otherwise.
func meCardEmail() -> String? {
    let st = CNContactStore.authorizationStatus(for: .contacts).rawValue
    guard st == 3 || st == 4,
          let me = try? CNContactStore().unifiedMeContactWithKeys(toFetch: [CNContactEmailAddressesKey as CNKeyDescriptor]) else { return nil }
    return me.emailAddresses.first.map { $0.value as String }
}

final class FileSources: PakoSources, @unchecked Sendable {
    private let d: [String: Any]
    let live = true
    let zoomFolder: String

    init?(path: String, userHome: String) {
        guard let data = FileManager.default.contents(atPath: path),
              let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        self.d = d
        zoomFolder = (userHome as NSString).appendingPathComponent("Documents/Zoom")
    }

    private func perm(_ k: String) -> String { d[k] as? String ?? "granted" }
    func installed(_ bundleID: String) -> Bool { (d["installed"] as? [String] ?? []).contains(bundleID) }
    func calendarPermission() -> String { perm("calendars") }
    func requestCalendars() -> Bool { perm("calendars") == "granted" }
    func calendars() -> [LocalCalendar] {
        (d["calendarList"] as? [[String: Any]] ?? []).map {
            LocalCalendar(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", source: $0["source"] as? String ?? "",
                          color: $0["color"] as? String ?? "#888888", writable: $0["writable"] as? Bool ?? false)
        }
    }
    func events(ids: [String], from: Date, to: Date) -> [LocalEvent] {
        let now = Date()
        return (d["events"] as? [[String: Any]] ?? []).compactMap { e in
            guard let cal = e["calendarId"] as? String, ids.contains(cal) else { return nil }
            let start = now.addingTimeInterval(((e["inMinutes"] as? Double) ?? 60) * 60)
            return LocalEvent(id: e["id"] as? String ?? UUID().uuidString, calendarId: cal, title: e["title"] as? String ?? "",
                              start: start, end: start.addingTimeInterval(((e["minutes"] as? Double) ?? 30) * 60),
                              allDay: e["allDay"] as? Bool ?? false, location: e["location"] as? String, notes: nil,
                              url: e["url"] as? String, attendees: e["attendees"] as? [String] ?? [])
        }
    }
    func contactsPermission() -> String { perm("contacts") }
    func requestContacts() -> Bool { perm("contacts") == "granted" }
    func contactsCount() -> Int { people().count }
    func people() -> [LocalPerson] {
        (d["people"] as? [[String: Any]] ?? []).map {
            LocalPerson(name: $0["name"] as? String ?? "", emails: $0["emails"] as? [String] ?? [], phones: $0["phones"] as? [String] ?? [],
                        org: $0["org"] as? String)
        }
    }
    func mailRunning() -> Bool { d["mailRunning"] as? Bool ?? true }
    func mailPermission() -> String { perm("mail") }
    func mailAccounts() -> String? { perm("mail") == "granted" ? d["mailOutput"] as? String : nil }
    func zoomFolders() -> [String: [String]]? { d["zoom"] as? [String: [String]] }
}

/// The chosen calendars' events, sent to this computer's Pako (POST /panel/api/calendar/local, by `post`): when chosen, every ten minutes,
/// and a few seconds after the calendars change (EKEventStoreChanged); only while some are chosen and macOS lets Pako read them. Choosing
/// none sends the empty list once, so Pako forgets them, and stops.
@MainActor
final class CalendarFeed {
    private let sources: any PakoSources
    private let work = DispatchQueue(label: "io.github.anxovatomicaes.pako.calendar")
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private var soon: DispatchWorkItem?
    private(set) var ids: [String]
    /// One more at each choice in the panel: a push that read its events before the choice changed is not posted after it (turning the
    /// calendars off must be the last thing Pako hears, not an older read that was still on its way).
    private var choice = 0
    private let save: ([String]) -> Void
    /// Posts a body to the panel's route; says whether it was taken.
    var post: ((_ body: [String: Any], _ done: @escaping (Bool) -> Void) -> Void)?
    /// The calendar changes' round (POST /panel/api/calendar/writes): what was done goes, the changes to make now come back (nil: no answer).
    var exchange: ((_ results: [[String: Any]], _ done: @escaping ([[String: Any]]?) -> Void) -> Void)?
    private var writesTimer: Timer?
    /// Done and not yet told: kept until the panel has them, so a change is never reported lost (Pako would then say it failed).
    private var results: [[String: Any]] = []
    private var exchanging = false

    init(sources: any PakoSources, ids: [String], save: @escaping ([String]) -> Void) {
        self.sources = sources
        self.ids = ids
        self.save = save
    }

    /// The person chose these calendars in the panel: kept, sent now, then kept up to date. `done` hears how many events went (nil: none
    /// could be sent, macOS refused or the panel did not take them).
    func select(_ chosen: [String], done: ((Int?) -> Void)? = nil) {
        ids = chosen
        choice += 1
        save(chosen)
        if chosen.isEmpty {
            stop()
            post?(["calendars": [String](), "events": [Any]()]) { ok in done?(ok ? 0 : nil) }
            return
        }
        let s = sources
        work.async {
            if s.calendarPermission() == "notAsked" { _ = s.requestCalendars() }
            DispatchQueue.main.async {
                self.start()
                self.push(done: done)
            }
        }
    }

    /// From the app's start (or a panel signed in again): the timer and the change watch, when calendars were chosen before.
    func start() {
        guard !ids.isEmpty, sources.live else { return }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in MainActor.assumeIsolated { self.push() } }
        }
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { self.changed() }
            }
        }
        // The changes the person said yes to in Pako: looked for every fifteen seconds, made here with EventKit.
        if writesTimer == nil {
            writesTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in MainActor.assumeIsolated { self.pollWrites() } }
        }
    }

    /// One round: tells what was done, makes what came back (on the work queue), and tells that at once.
    func pollWrites() {
        guard !exchanging, let ex = exchange, sources.live else { return }
        exchanging = true
        let sent = results
        ex(sent) { writes in
            MainActor.assumeIsolated {
                if writes != nil { self.results.removeFirst(min(sent.count, self.results.count)) }
                let todo = writes ?? []
                guard !todo.isEmpty else { self.exchanging = false; return }
                let s = self.sources
                self.work.async {
                    let done = todo.map { s.applyCalendarWrite($0) }
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            self.results.append(contentsOf: done)
                            self.exchanging = false
                            self.pollWrites()
                        }
                    }
                }
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        writesTimer?.invalidate()
        writesTimer = nil
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
        soon?.cancel()
    }

    /// Calendars change in bursts (a sync brings many): one send, five seconds after the last.
    private func changed() {
        soon?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.push() } }
        soon = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: item)
    }

    func push(done: ((Int?) -> Void)? = nil) {
        let chosen = ids, s = sources, asked = choice
        guard !chosen.isEmpty, let post = post else { done?(nil); return }
        work.async {
            guard s.calendarPermission() == "granted" else { DispatchQueue.main.async { done?(nil) }; return }
            let now = Date(), w = eventWindow(now: now)
            let body = calendarPayload(ids: chosen, events: s.events(ids: chosen, from: w.from, to: w.to), now: now)
            let n = (body["events"] as? [Any])?.count ?? 0
            DispatchQueue.main.async {
                guard self.choice == asked else { done?(nil); return }
                post(body) { ok in done?(ok ? n : nil) }
            }
        }
    }
}

/// The person's own answer to an invitation in EventKit: their attendee entry's status. Accepted (or an event of their own) says nothing.
func myResponse(_ e: EKEvent) -> String? {
    guard let me = (e.attendees ?? []).first(where: { $0.isCurrentUser }) else { return nil }
    switch me.participantStatus {
    case .pending: return "needs"
    case .tentative: return "tentative"
    case .declined: return "declined"
    default: return nil
    }
}
