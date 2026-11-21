// What the app finds on this Mac for the panel's connections (docs/desktop-mac.md, "Discovery"), as rules free of AppKit, EventKit and
// Contacts: which messages the panel may send, which links it may open, how a mail address names its provider, how calendar events and
// contacts are shaped before they go to the Pako on this computer, and the whole discovery run over sources that are handed in. The test
// program (test/fixtures/mac-core/main.swift) runs them with fake sources: no test ever reads a real calendar, contact or mail account.
//
// Privacy, as the panel promises it: nothing is looked at before the person says yes in the panel (that yes is the "discover" message);
// macOS's own prompts are the real gate (Calendars, Contacts, Automation for Mail); only what is needed is read (account addresses, calendar
// names and their events in a window, contact names, emails and phones; never a mail's body); and everything goes only to this computer's Pako.

import Foundation
import SQLite3

// MARK: the panel's messages (window.webkit.messageHandlers.pako)

/// Calendar ids as the panel sends them: up to 200 short strings, each once; nil when anything else.
func calendarIDs(_ v: Any?) -> [String]? {
    guard let list = v as? [Any], list.count <= 200 else { return nil }
    var ids: [String] = []
    for v in list {
        guard let s = v as? String, !s.isEmpty, s.count <= 256, !s.contains(where: { $0.isNewline }) else { return nil }
        if !ids.contains(s) { ids.append(s) }
    }
    return ids
}

/// The connections page, maybe on one card: "/panel/settings" or "/panel/settings#calendar" (a lower-case name of up to 20 letters).
func isSettingsPath(_ p: String) -> Bool {
    guard p.hasPrefix("/panel/settings") else { return false }
    let rest = p.dropFirst("/panel/settings".count)
    if rest.isEmpty { return true }
    guard rest.first == "#" else { return false }
    let name = rest.dropFirst()
    return (1...20).contains(name.count) && name.allSatisfy { ("a"..."z").contains(String($0)) }
}

/// What may be discovered, in the contract's words.
let discoverKinds = ["apps", "calendars", "mail", "contacts", "zoom"]

enum PakoMessage: Equatable {
    /// Look now (the person said yes in the panel). `openMail`: they pressed the button that may open Mail when it is not running.
    case discover(what: [String], openMail: Bool)
    /// The calendars whose events Pako gets from now on (none: stop, and Pako forgets the ones it had).
    case calendarSelect([String])
    /// Import the contacts (the person confirmed it in the panel).
    case contactsImport
    case openURL(URL)
    case openSettingsWindow
    /// The dashboard's refresh: the chosen calendars' events pushed now, not at the next ten-minute tick (at most once every 30 seconds).
    case calendarPush
    /// An older connections page asks for itself in a window of its own: /panel/settings, maybe on one card (#calendar). It opens in the
    /// main window now (App.swift openPanelSettings). Answered pakoOpened().
    case openWindow(String)
    /// The connections page's "use this": calendars (with their ids), contacts or zoomRecordings. Answered pakoUsed({what, ok, count?}).
    case use(what: String, ids: [String])
    /// Apple Reminders (src/reminders-local.ts): on (macOS asks first, then Pako's lists are kept in step) or off. On again: in step now.
    /// Answered pakoReminders({ok, on, access, error?}).
    case reminders(on: Bool)
    /// The welcome's word, older than the typed messages: {lang} and {welcomed}.
    case panelWord
}

/// The panel's message as the app understands it, or nil (then it is ignored): a dictionary with a known `type` and well-formed values.
func parsePakoMessage(_ body: Any) -> PakoMessage? {
    guard let d = body as? [String: Any] else { return nil }
    guard let type = d["type"] else { return d["lang"] is String || d["welcomed"] is Bool || d["demo"] is Bool ? .panelWord : nil }
    switch type as? String {
    case "discover":
        guard let list = d["what"] as? [Any], !list.isEmpty, list.count <= 10 else { return nil }
        var what: [String] = []
        for w in list {
            // The page names Zoom's recordings as the contract's field does (zoomRecordings): the same look as "zoom".
            guard let raw = w as? String else { return nil }
            let s = raw == "zoomRecordings" ? "zoom" : raw
            guard discoverKinds.contains(s) else { return nil }
            if !what.contains(s) { what.append(s) }
        }
        let open = d["openMail"]
        if open != nil, !(open is Bool) { return nil }
        return .discover(what: what, openMail: open as? Bool ?? false)
    case "calendarSelect":
        return calendarIDs(d["ids"] ?? d["calendars"]).map { .calendarSelect($0) }
    case "contactsImport": return .contactsImport
    case "openURL": return (d["url"] as? String).flatMap(allowedOpenURL).map { .openURL($0) }
    case "openSettingsWindow": return .openSettingsWindow
    case "calendarPush": return .calendarPush
    case "reminders": return (d["on"] as? Bool).map { .reminders(on: $0) }
    case "openWindow":
        guard let path = d["path"] as? String, isSettingsPath(path) else { return nil }
        return .openWindow(path)
    case "use":
        switch d["what"] as? String {
        case "calendars": return calendarIDs(d["ids"]).map { .use(what: "calendars", ids: $0) }
        case "contacts": return .use(what: "contacts", ids: [])
        case "zoomRecordings": return .use(what: "zoomRecordings", ids: [])
        default: return nil
        }
    default: return nil
    }
}

/// The app schemes the panel may open (the person's own Slack, Telegram and Zoom apps).
let openableSchemes = ["slack", "tg", "zoommtg"]
/// The panes of System Settings the panel may open: Privacy & Security's Calendars, Reminders, Contacts, Automation and Files ones, by both names
/// macOS has had for them (System Preferences before Ventura, System Settings after).
let openablePanes = ["com.apple.preference.security", "com.apple.settings.PrivacySecurity.extension"]
let openablePrivacy = ["Privacy_Calendars", "Privacy_Reminders", "Privacy_Contacts", "Privacy_Automation", "Privacy_FilesAndFolders", "Privacy_AllFiles"]

/// A link the panel asked to open, when it may be: https to any site, the three apps' schemes, or one of the privacy panes. Nothing else
/// (no file:, no http:, no other app's scheme, no other System Settings pane).
func allowedOpenURL(_ s: String) -> URL? {
    guard s.count <= 2048, !s.contains(where: { $0.isWhitespace || $0.isNewline }), let u = URL(string: s),
          let scheme = u.scheme?.lowercased() else { return nil }
    if scheme == "https" {
        guard let host = u.host, !host.isEmpty, u.user == nil, u.password == nil else { return nil }
        return u
    }
    if openableSchemes.contains(scheme) { return u }
    if scheme == "x-apple.systempreferences" {
        let rest = String(s.dropFirst("x-apple.systempreferences:".count))
        let parts = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        guard openablePanes.contains(parts[0]) else { return nil }
        if parts.count == 1 { return u }
        return openablePrivacy.contains(parts[1]) ? u : nil
    }
    return nil
}

// MARK: installed apps

/// The apps the panel's connections care about, by bundle identifier (no permission is needed to ask whether one is installed).
let appBundleIDs: [(key: String, ids: [String])] = [
    ("zoom", ["us.zoom.xos"]), ("slack", ["com.tinyspeck.slackmacgap"]), ("telegram", ["ru.keepcoder.Telegram", "org.telegram.desktop"]),
    ("whatsapp", ["net.whatsapp.WhatsApp"]), ("mail", ["com.apple.mail"]), ("outlook", ["com.microsoft.Outlook"]),
    ("teams", ["com.microsoft.teams2"]),
]

func installedApps(has: (String) -> Bool) -> [String: Bool] {
    var out: [String: Bool] = [:]
    for (key, ids) in appBundleIDs { out[key] = ids.contains(where: has) }
    return out
}

// MARK: mail accounts

/// The provider an address belongs to, from its domain (and Mail's account type: an iCloud account with an address of its own domain is
/// still iCloud). "other" for everything else, the person's own domain included.
func mailProvider(_ address: String, accountType: String = "") -> String {
    if accountType.lowercased() == "icloud" { return "icloud" }
    let domain = address.split(separator: "@").last.map { $0.lowercased() } ?? ""
    guard address.contains("@"), !domain.isEmpty else { return "other" }
    if ["icloud.com", "me.com", "mac.com"].contains(domain) { return "icloud" }
    if ["gmail.com", "googlemail.com"].contains(domain) { return "google" }
    if ["outlook.com", "msn.com", "passport.com"].contains(domain) { return "microsoft" }
    let first = domain.split(separator: ".").first.map(String.init) ?? ""
    if ["hotmail", "live", "outlook"].contains(first) { return "microsoft" }
    if ["yahoo", "ymail", "rocketmail"].contains(first) { return "yahoo" }
    return "other"
}

/// Mail's account type (`account type as text`: imap, pop, smtp, iCloud, ews, unknown) in the contract's words.
func mailKind(_ type: String) -> String {
    switch type.lowercased() {
    case "imap", "icloud": return "imap"
    case "ews", "exchange", "exchange web services": return "exchange"
    default: return "other"
    }
}

/// The script's answer (Discovery.swift asks Mail with osascript): one line per account, "name<TAB>address,address<TAB>type". Each address
/// is one account entry, lower case, said once; anything that is not an address is left out, and so is an account with none.
func parseMailAccounts(_ out: String) -> [[String: Any]] {
    var seen = Set<String>()
    var list: [[String: Any]] = []
    for line in out.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
        let f = line.split(separator: "\t", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard f.count >= 3 else { continue }
        let name = String(f[0].prefix(200)), type = f[f.count - 1]
        for raw in f[1].split(separator: ",") {
            let a = raw.trimmingCharacters(in: .whitespaces).lowercased()
            guard isMailAddress(a), !seen.contains(a), list.count < 50 else { continue }
            seen.insert(a)
            list.append(["address": a, "name": name, "provider": mailProvider(a, accountType: type), "kind": mailKind(type)])
        }
    }
    return list
}

func isMailAddress(_ a: String) -> Bool {
    let parts = a.split(separator: "@", omittingEmptySubsequences: false)
    guard a.count <= 254, parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix(".") else { return false }
    return !a.contains(where: { $0.isWhitespace || $0 == "," || $0 == "<" || $0 == ">" || $0 == "\"" })
}

// MARK: the other places a Mac keeps the person's addresses (addresses only: never a message, never a password)

/// Thunderbird's prefs.js: each identity's `user_pref("mail.identity.<id>.useremail", "ana@example.com");`. Only those lines are looked at.
func parseThunderbirdPrefs(_ text: String) -> [String] {
    var out: [String] = []
    for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) where line.hasPrefix("user_pref(\"mail.identity.") && line.contains(".useremail\"") {
        let parts = line.split(separator: "\"")
        // user_pref( " mail.identity.id1.useremail " , " ana@example.com " );
        guard parts.count >= 4 else { continue }
        let a = parts[3].trimmingCharacters(in: .whitespaces).lowercased()
        if isMailAddress(a), !out.contains(a) { out.append(a) }
    }
    return Array(out.prefix(50))
}

/// iCloud, from ~/Library/Preferences/MobileMeAccounts.plist: each Apple ID signed in on this Mac (AccountID), and whether its iCloud Mail is
/// on (a service named MAIL_AND_NOTES, or with ServiceID com.apple.Dataclass.Mail, not turned off), with that service's own address. Only
/// these keys are read.
func parseMobileMeAccounts(_ data: Data) -> [(address: String, name: String, mail: Bool)] {
    guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let accounts = plist["Accounts"] as? [[String: Any]] else { return [] }
    var out: [(address: String, name: String, mail: Bool)] = []
    for a in accounts.prefix(10) {
        let services = a["Services"] as? [[String: Any]] ?? []
        let mail = services.first { s in
            (s["Name"] as? String == "MAIL_AND_NOTES" || s["ServiceID"] as? String == "com.apple.Dataclass.Mail") && (s["Enabled"] as? Bool ?? true)
        }
        let name = clip(a["DisplayName"] as? String ?? "", 100)
        for raw in [mail?["EmailAddress"] as? String, a["AccountID"] as? String] {
            guard let r = raw else { continue }
            let address = r.trimmingCharacters(in: .whitespaces).lowercased()
            guard isMailAddress(address), !out.contains(where: { $0.address == address }) else { continue }
            // The Apple ID itself may be any address (a Gmail one, say): iCloud Mail is that address only when it is the service's own.
            let itsMail = mail != nil && (address == (mail?["EmailAddress"] as? String)?.lowercased() || mailProvider(address) == "icloud")
            out.append((address, name, itsMail))
        }
    }
    return out
}

/// eM Client's account list, from the SQLite files it keeps under ~/Library/Application Support/eM Client: only text that is an email address,
/// only from columns whose name says address, email, login or user (never one that says password or token), opened read-only. Its layout is
/// not documented, so the columns are found by name rather than assumed; a file that is not SQLite, or is locked, gives nothing.
func emClientColumns(_ columns: [String]) -> [String] {
    columns.filter { c in
        let l = c.lowercased()
        return ["address", "email", "login", "user", "account"].contains { l.contains($0) } && !["pass", "token", "secret", "key", "cred"].contains { l.contains($0) }
    }
}

/// The addresses in one eM Client SQLite file, read as emClientColumns says. Opened read-only and immutable (no lock taken, no journal
/// written, so eM Client running at the same time is not disturbed), each table's matching columns asked for distinct text, at most 50.
func emClientAddresses(path: String) -> [String] {
    var db: OpaquePointer?
    let uri = "file:\(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)?mode=ro&immutable=1"
    guard sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let db else { sqlite3_close(db); return [] }
    defer { sqlite3_close(db) }
    func rows(_ sql: String) -> [[String]] {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { sqlite3_finalize(st); return [] }
        defer { sqlite3_finalize(st) }
        var out: [[String]] = []
        while sqlite3_step(st) == SQLITE_ROW, out.count < 500 {
            out.append((0..<sqlite3_column_count(st)).map { i in sqlite3_column_text(st, i).map { String(cString: $0) } ?? "" })
        }
        return out
    }
    let quote = { (s: String) in "\"\(s.replacingOccurrences(of: "\"", with: "\"\""))\"" }
    var found: [String] = []
    for t in rows("SELECT name FROM sqlite_master WHERE type = 'table'").map({ $0[0] }).prefix(100) {
        for c in emClientColumns(rows("PRAGMA table_info(\(quote(t)))").map { $0.count > 1 ? $0[1] : "" }) {
            for r in rows("SELECT DISTINCT \(quote(c)) FROM \(quote(t)) WHERE typeof(\(quote(c))) = 'text' LIMIT 200") {
                let a = r[0].trimmingCharacters(in: .whitespaces).lowercased()
                if isMailAddress(a), !found.contains(a) { found.append(a) }
            }
        }
    }
    return Array(found.prefix(50))
}

/// One place's addresses, before merging: where they came from (mail, outlook, emclient, thunderbird, icloud, contacts) and how.
struct FoundAddress {
    var address: String
    var name: String
    var provider: String
    var kind: String
    var app: String
    /// iCloud only: the Apple ID's iCloud Mail is on, so iCloud Mail can be connected for this address.
    var icloudMail = false
}

/// Every place's addresses as one list: each address once, in the order first found (Mail's first), with every app it was found in and the
/// provider its domain or account says. At most 50.
func mergeAddresses(_ found: [FoundAddress]) -> [[String: Any]] {
    var order: [String] = []
    var by: [String: [String: Any]] = [:]
    for f in found where isMailAddress(f.address) {
        if var e = by[f.address] {
            var apps = e["apps"] as? [String] ?? []
            if !apps.contains(f.app) { apps.append(f.app) }
            e["apps"] = apps
            if (e["name"] as? String ?? "").isEmpty, !f.name.isEmpty { e["name"] = f.name }
            if f.icloudMail { e["icloudMail"] = true }
            by[f.address] = e
        } else {
            guard order.count < 50 else { continue }
            order.append(f.address)
            var e: [String: Any] = ["address": f.address, "name": f.name, "provider": f.provider, "kind": f.kind, "apps": [f.app]]
            if f.icloudMail { e["icloudMail"] = true }
            by[f.address] = e
        }
    }
    return order.compactMap { by[$0] }
}

/// What the panel says about Mail: "found" (accounts read), "empty" (Mail answered with none: it is not set up on this Mac), "closed" (not
/// running and the person did not press the button that opens it), "denied" (Automation refused: System Settings › Privacy & Security ›
/// Automation › Pako › Mail), or "failed" (Mail did not answer).
func mailLookState(asked: Bool, output: String?, permission: String) -> String {
    if permission == "denied" { return "denied" }
    if !asked { return "closed" }
    guard let o = output else { return "failed" }
    return parseMailAccounts(o).isEmpty ? "empty" : "found"
}

/// What AEDeterminePermissionToAutomateTarget said about Mail: allowed, refused, or not asked yet (also: Mail not running, so not known).
func automationPermission(_ status: Int32) -> String {
    switch status {
    case 0: return "granted"
    case -1743: return "denied"  // errAEEventNotPermitted
    default: return "notAsked"  // errAEEventWouldRequireUserConsent (-1744), procNotFound (-600)
    }
}

// MARK: calendars

struct LocalCalendar {
    var id: String
    var title: String
    var source: String
    var color: String
    var writable: Bool
}

struct LocalEvent {
    /// EventKit's identifier: the same for every occurrence of a repeating event (the shaped id adds the occurrence's start).
    var id: String
    var calendarId: String
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String?
    var notes: String?
    var url: String?
    var attendees: [String]
    /// The event's iCalendar UID (EventKit's external identifier): the same meeting from a private link too is told once by it.
    var uid: String? = nil
    /// The person's own answer to an invitation: "needs" (not answered yet), "tentative", "declined"; nil for accepted or their own event.
    var response: String? = nil
    /// Who invited them (the organizer's name), for "Ana invited you to …".
    var organizer: String? = nil
    /// Called off (EventKit's status .canceled): Exchange keeps such a meeting on the calendar ("Canceled: …") until it is removed by hand.
    var cancelled: Bool = false
}

/// One attendee as EventKit's line gives it ("Ana Garcia <ana@example.com>", or just a name): its address and a short name. An attendee
/// with no address is left out: People matches by address, never by a bare name.
func attendeeEntry(_ line: String) -> [String: String]? {
    guard let open = line.lastIndex(of: "<"), let close = line.lastIndex(of: ">"), open < close else { return nil }
    let mail = String(line[line.index(after: open)..<close]).trimmingCharacters(in: .whitespaces).lowercased()
    guard isMailAddress(mail) else { return nil }
    let name = clip(String(line[..<open]).trimmingCharacters(in: .whitespaces), 80)
    return name.isEmpty ? ["email": mail] : ["email": mail, "name": name]
}

/// The events Pako gets: from two days ago to fourteen days ahead.
func eventWindow(now: Date) -> (from: Date, to: Date) { (now.addingTimeInterval(-2 * 86400), now.addingTimeInterval(14 * 86400)) }

/// A colour as #rrggbb from its sRGB components (0...1).
func hexColor(_ r: Double, _ g: Double, _ b: Double) -> String {
    let c = { (v: Double) in Int((min(1, max(0, v)) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", c(r), c(g), c(b))
}

func shapeCalendars(_ cals: [LocalCalendar]) -> [[String: Any]] {
    cals.prefix(200).filter { !$0.id.isEmpty }.map {
        ["id": String($0.id.prefix(256)), "title": clip($0.title, 200), "source": clip($0.source, 200), "color": $0.color, "writable": $0.writable]
    }
}

/// A date as ISO 8601 with this Mac's offset (2026-11-16T09:30:00+01:00): JavaScript reads it, and an all-day event keeps its own day.
func isoDate(_ d: Date, zone: TimeZone = .current) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = zone
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: d)
}

/// The events of the chosen calendars inside the window, in time order, each occurrence with its own id, texts cut to a sane length, a link
/// only when it is http(s), at most 2000 events. Of the notes only their http(s) links are sent. The attendees go too (name and address, at
/// most 30 for a meeting, none for one with more than 40 people, an all-hands that says nothing about who the owner works with): Pako's
/// People and meeting prep need to know who the owner meets. The whole push stays well under the route's 4 MB (src/calendar-local.ts).
func shapeEvents(_ events: [LocalEvent], calendars: Set<String>, from: Date, to: Date, zone: TimeZone = .current) -> [[String: Any]] {
    // A cancelled meeting is not on the person's day: left out, as the other sources leave it out (no agenda line, no reminder).
    let kept = events.filter { !$0.cancelled && calendars.contains($0.calendarId) && $0.end >= from && $0.start <= to && $0.end >= $0.start }
        .sorted { $0.start < $1.start }
    var seen = Set<String>()
    var out: [[String: Any]] = []
    for e in kept {
        let id = "\(e.id.prefix(200))@\(Int64(e.start.timeIntervalSince1970))"
        guard !e.id.isEmpty, !seen.contains(id), out.count < 2000 else { continue }
        seen.insert(id)
        var d: [String: Any] = ["id": id, "calendarId": e.calendarId, "title": clip(e.title, 300), "start": isoDate(e.start, zone: zone),
                                "end": isoDate(e.end, zone: zone), "allDay": e.allDay]
        if let l = e.location.map({ clip($0, 300) }), !l.isEmpty { d["location"] = l }
        if let n = e.notes.map(notesLinks), !n.isEmpty { d["notes"] = n }
        if let u = e.url, let url = URL(string: u), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), u.count <= 2048 { d["url"] = u }
        if let u = e.uid, !u.isEmpty, u.count <= 300 { d["uid"] = u }
        if let r = e.response, ["needs", "tentative", "declined"].contains(r) { d["response"] = r }
        if let o = e.organizer.map({ clip($0, 100) }), !o.isEmpty { d["organizer"] = o }
        if e.attendees.count <= 40 {
            // The 30 places go to attendees with an address (a room or a bare name is dropped first, not counted).
            let people = e.attendees.compactMap(attendeeEntry).prefix(30).map { $0 }
            if !people.isEmpty { d["attendees"] = people }
        }
        out.append(d)
    }
    return out
}

/// The http(s) links in an event's notes (where a Zoom, Meet or Teams invite puts its link), at most five of 600 characters each.
func notesLinks(_ notes: String) -> String {
    let re = try! NSRegularExpression(pattern: "https?://[^\\s\"'<>)\\]]+", options: [.caseInsensitive])
    let links = re.matches(in: notes, range: NSRange(notes.startIndex..., in: notes)).compactMap { Range($0.range, in: notes).map { String(notes[$0]) } }
    return links.filter { $0.count <= 600 }.prefix(5).joined(separator: " ")
}

/// The event a calendar write means (Discovery.swift, applyCalendarWrite): the occurrence of its event that starts at `at` (`near`: that
/// event's occurrences around then), within a minute. None there: the event by its identifier (`byID`), only when it does not repeat. For a
/// repeating event EventKit answers the series' first occurrence, never the one meant: moving or deleting it would change another day.
func calendarWriteTarget<E>(at: Date?, near: [E], byID: E?, start: (E) -> Date, repeats: (E) -> Bool) -> E? {
    guard let at = at else { return byID }
    if let e = near.first(where: { abs(start($0).timeIntervalSince(at)) < 60 }) { return e }
    guard let e = byID, !repeats(e) else { return nil }
    return e
}

/// What is posted to /panel/api/calendar/local: the chosen calendars and their events.
func calendarPayload(ids: [String], events: [LocalEvent], now: Date, zone: TimeZone = .current) -> [String: Any] {
    let w = eventWindow(now: now)
    // "writes": this app makes the calendar changes the person says yes to (src/calendar-writes.ts): Pako then asks before each one.
    return ["calendars": ids, "events": shapeEvents(events, calendars: Set(ids), from: w.from, to: w.to, zone: zone), "writes": true]
}

// MARK: contacts

struct LocalPerson {
    var name: String
    var emails: [String]
    var phones: [String]
    var org: String?
}

/// The contacts as /panel/api/people/import takes them: a name (the company's when there is no person's name), addresses in lower case,
/// phones as written; one entry per person, merged when two cards share an address or a phone; nobody without a name or a way to reach them.
func shapePeople(_ people: [LocalPerson]) -> [[String: Any]] {
    var out: [(name: String, emails: [String], phones: [String], org: String?)] = []
    var byKey: [String: Int] = [:]
    for p in people {
        let org = p.org.map { clip($0, 200) }.flatMap { $0.isEmpty ? nil : $0 }
        let name = clip(p.name, 200).isEmpty ? (org ?? "") : clip(p.name, 200)
        let emails = unique(p.emails.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter(isMailAddress)).prefix(10)
        let phones = unique(p.phones.map { clip($0, 40) }.filter { $0.contains(where: \.isNumber) }).prefix(10)
        guard !name.isEmpty, !emails.isEmpty || !phones.isEmpty else { continue }
        let keys = emails.map { "e:\($0)" } + phones.map { "p:" + $0.filter { $0.isNumber || $0 == "+" } }
        if let i = keys.lazy.compactMap({ byKey[$0] }).first {
            out[i].emails = unique(out[i].emails + emails)
            out[i].phones = unique(out[i].phones + phones)
            if out[i].org == nil { out[i].org = org }
            for k in keys { byKey[k] = i }
            continue
        }
        guard out.count < 5000 else { break }
        for k in keys { byKey[k] = out.count }
        out.append((name, Array(emails), Array(phones), org))
    }
    return out.map { p in
        var d: [String: Any] = ["name": p.name, "emails": p.emails, "phones": p.phones]
        if let o = p.org { d["org"] = o }
        return d
    }
}

// MARK: Zoom's local recordings

/// How many of Zoom's recording folders (~/Documents/Zoom/<meeting>/) have a transcript (*.vtt) or are a recording Zoom has not
/// converted yet (recording.conf). Only the file names are looked at, never what is in them.
func zoomRecordingCount(_ folders: [String: [String]]) -> Int {
    folders.values.filter { files in files.contains { $0.lowercased().hasSuffix(".vtt") || $0 == "recording.conf" } }.count
}

// MARK: the whole look

/// Where the look reads from: the Mac itself (Discovery.swift) or a fake (the test program). The request calls may show macOS's prompt
/// and wait for the answer; they are only made for what the person asked to discover.
protocol DiscoverySources {
    func installed(_ bundleID: String) -> Bool
    func calendarPermission() -> String
    func requestCalendars() -> Bool
    func calendars() -> [LocalCalendar]
    func contactsPermission() -> String
    func requestContacts() -> Bool
    func contactsCount() -> Int
    func mailRunning() -> Bool
    func mailPermission() -> String
    /// Mail's accounts (the script's output, parseMailAccounts), nil when Mail refused or failed. Asks Mail, so it may open it.
    func mailAccounts() -> String?
    var zoomFolder: String { get }
    /// The recording folders and their file names; nil when there is no Zoom folder.
    func zoomFolders() -> [String: [String]]?
    /// Microsoft Outlook: running, and its accounts' lines (the same shape as Mail's), nil when it refused, failed or has no AppleScript
    /// accounts (the new Outlook). Asks Outlook through Apple events, so macOS shows its Automation prompt first, and it may open Outlook.
    func outlookRunning() -> Bool
    func outlookAccounts() -> String?
    /// eM Client's SQLite files (paths), Thunderbird's prefs.js texts, the iCloud accounts file: nothing when the app is not there.
    func emClientFiles() -> [String]
    func thunderbirdPrefs() -> [String]
    func mobileMeAccounts() -> Data?
    /// The Contacts "Me" card's addresses (only asked once Contacts said yes).
    func meCardEmails() -> [String]
}

/// Sources that know nothing of the other mail apps (a check-only file): none of them is there.
extension DiscoverySources {
    func outlookRunning() -> Bool { false }
    func outlookAccounts() -> String? { nil }
    func emClientFiles() -> [String] { [] }
    func thunderbirdPrefs() -> [String] { [] }
    func mobileMeAccounts() -> Data? { nil }
    func meCardEmails() -> [String] { [] }
}

/// Every address this Mac knows for the person, from each place that keeps them. Mail is asked as before (running, or on the button), and
/// says its state; Outlook the same way (asking may open it, so only when it runs or on the button); eM Client, Thunderbird and iCloud from
/// their own files (plain files of this user, read only, no prompt); the Contacts Me card only when Contacts already said yes.
func lookForAddresses(openMail: Bool, sources s: DiscoverySources) -> (accounts: [[String: Any]], mailState: String) {
    var found: [FoundAddress] = []
    let asked = (s.mailRunning() || openMail) && s.mailPermission() != "denied"
    let output = asked ? s.mailAccounts() : nil
    for m in parseMailAccounts(output ?? "") {
        found.append(FoundAddress(address: m["address"] as? String ?? "", name: m["name"] as? String ?? "", provider: m["provider"] as? String ?? "other",
                                  kind: m["kind"] as? String ?? "other", app: "mail"))
    }
    let state = mailLookState(asked: asked, output: output, permission: s.mailPermission())
    if s.installed("com.microsoft.Outlook"), s.outlookRunning() || openMail, let o = s.outlookAccounts() {
        for m in parseMailAccounts(o) {
            found.append(FoundAddress(address: m["address"] as? String ?? "", name: m["name"] as? String ?? "", provider: m["provider"] as? String ?? "other",
                                      kind: m["kind"] as? String ?? "other", app: "outlook"))
        }
    }
    for f in s.emClientFiles().prefix(10) {
        for a in emClientAddresses(path: f) { found.append(FoundAddress(address: a, name: "", provider: mailProvider(a), kind: "other", app: "emclient")) }
    }
    for text in s.thunderbirdPrefs().prefix(10) {
        for a in parseThunderbirdPrefs(text) { found.append(FoundAddress(address: a, name: "", provider: mailProvider(a), kind: "imap", app: "thunderbird")) }
    }
    if let data = s.mobileMeAccounts() {
        for a in parseMobileMeAccounts(data) {
            found.append(FoundAddress(address: a.address, name: a.name, provider: a.mail ? "icloud" : mailProvider(a.address), kind: a.mail ? "imap" : "other",
                                      app: "icloud", icloudMail: a.mail))
        }
    }
    if s.contactsPermission() == "granted" {
        for raw in s.meCardEmails().prefix(20) {
            let a = raw.trimmingCharacters(in: .whitespaces).lowercased()
            found.append(FoundAddress(address: a, name: "", provider: mailProvider(a), kind: "other", app: "contacts"))
        }
    }
    return (mergeAddresses(found), state)
}

/// One look, for what was asked only: macOS's prompt is shown (by a request) only when it was never answered, and nothing is read without
/// its yes. Mail is asked only when it is running, or when the person pressed the button that opens it. The answer has the contract's
/// fields for what was looked at, and the three permissions always (reading them shows no prompt and reads no data).
func runDiscovery(what: [String], openMail: Bool, sources s: DiscoverySources, now: Date) -> [String: Any] {
    var out: [String: Any] = ["at": isoDate(now, zone: TimeZone(identifier: "UTC")!)]
    if what.contains("apps") { out["apps"] = installedApps(has: s.installed) }
    if what.contains("calendars") {
        var ok = s.calendarPermission() == "granted"
        if !ok, s.calendarPermission() == "notAsked" { ok = s.requestCalendars() }
        out["calendars"] = ok ? shapeCalendars(s.calendars()) : []
    }
    if what.contains("contacts") {
        var ok = s.contactsPermission() == "granted"
        if !ok, s.contactsPermission() == "notAsked" { ok = s.requestContacts() }
        out["contacts"] = ["count": ok ? s.contactsCount() : 0]
    }
    if what.contains("mail") {
        let r = lookForAddresses(openMail: openMail, sources: s)
        out["mailAccounts"] = r.accounts
        out["mailState"] = r.mailState
    }
    if what.contains("zoom") {
        out["zoomRecordings"] = s.zoomFolders().map { ["folder": s.zoomFolder, "count": zoomRecordingCount($0)] } ?? NSNull()
    }
    out["permissions"] = ["calendars": s.calendarPermission(), "contacts": s.contactsPermission(), "mail": s.mailPermission()]
    return out
}

/// The discovery Pako keeps (GET /panel/api/discovery) with this look on top: what was looked at now replaces what was kept, the rest stays,
/// and every field of the contract is there (empty when it was never looked at).
func mergeDiscovery(kept: [String: Any], fresh: [String: Any]) -> [String: Any] {
    var out: [String: Any] = ["apps": installedApps(has: { _ in false }), "calendars": [Any](), "mailAccounts": [Any](), "contacts": ["count": 0],
                              "zoomRecordings": NSNull(), "permissions": ["calendars": "notAsked", "contacts": "notAsked", "mail": "notAsked"]]
    for k in ["at", "apps", "calendars", "mailAccounts", "mailState", "contacts", "zoomRecordings", "permissions"] {
        if let v = kept[k] { out[k] = v }
    }
    for (k, v) in fresh { out[k] = v }
    return out
}

// MARK: small helpers

func clip(_ s: String, _ n: Int) -> String {
    String(s.trimmingCharacters(in: .whitespacesAndNewlines).filter { !$0.isASCII || $0.asciiValue! >= 32 || $0 == "\n" || $0 == "\t" }.prefix(n))
}

func unique<S: Sequence>(_ s: S) -> [String] where S.Element == String {
    var seen = Set<String>()
    return s.filter { seen.insert($0).inserted }
}
