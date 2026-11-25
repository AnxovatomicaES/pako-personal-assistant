// What the panel asks of this Mac, answered the same way by the Mac app (App.swift, through its web view) and by the helper (Helper.swift,
// through Pako's relay, src/mac-helper.ts, for a Pako run from the Terminal): a look, the calendars chosen, the contacts imported, Apple
// Reminders on or off. `send` calls one of Pako's own routes; the `answer` given with each ask calls the asking page's function
// (pakoDiscovered, pakoCalendarSynced, pakoImported, pakoUsed, pakoReminders), or tells the relay.

import AppKit

@MainActor
final class MacAsks {
    typealias Send = (_ method: String, _ path: String, _ body: [String: Any]?, _ done: @escaping (Bool, [String: Any]?) -> Void) -> Void
    typealias Answer = (_ fn: String, _ value: Any?) -> Void

    let sources: any PakoSources
    let calendars: CalendarFeed
    let reminders: RemindersFeed
    /// Discovery's own queue: a macOS prompt may wait for the person there.
    let work = DispatchQueue(label: "io.github.anxovatomicaes.pako.discover")
    private var discovering = false
    /// When the dashboard's refresh last asked for the calendars' events (see .calendarPush).
    private var lastPush = Date.distantPast
    private let send: Send

    init(sources: any PakoSources, calendars: CalendarFeed, reminders: RemindersFeed, send: @escaping Send) {
        self.sources = sources
        self.calendars = calendars
        self.reminders = reminders
        self.send = send
        calendars.post = { body, done in send("POST", "/panel/api/calendar/local", body) { ok, _ in done(ok) } }
        calendars.exchange = { results, done in
            send("POST", "/panel/api/calendar/writes", ["results": results]) { ok, body in done(ok ? (body?["writes"] as? [[String: Any]] ?? []) : nil) }
        }
        reminders.post = { body, done in send("POST", "/panel/api/reminders/local", body) { ok, a in done(ok ? (a ?? [:]) : nil) } }
    }

    /// After the start (or a panel signed in again): the chosen calendars and Reminders kept in step from now on.
    func resume() {
        calendars.start()
        calendars.push()
        reminders.start()
        reminders.sync()
    }

    /// One ask, already checked (parsePakoMessage). False: not one of these (the app's own windows: settings, the welcome's word).
    func handle(_ msg: PakoMessage, answer: @escaping Answer) -> Bool {
        switch msg {
        case let .discover(what, openMail): discover(what, openMail: openMail, answer: answer)
        case let .calendarSelect(ids):
            calendars.select(ids) { n in answer("pakoCalendarSynced", n.map { ["events": $0, "calendars": ids.count] }) }
        case .contactsImport: importContacts(answer: answer)
        case let .openURL(url): NSWorkspace.shared.open(url)
        case .calendarPush:
            // The dashboard's refresh: a new invitation reaches Pako now. Rate-limited, a page cannot make the app read EventKit in a loop.
            if Date().timeIntervalSince(lastPush) >= 30 {
                lastPush = Date()
                calendars.push()
            }
        case let .use(what, ids): use(what, ids: ids, answer: answer)
        case let .reminders(on): reminders.setOn(on) { r in answer("pakoReminders", r) }
        case .openSettingsWindow, .openWindow, .panelWord: return false
        }
        return true
    }

    /// The connections page's "use this": the calendars' events go to Pako from now on, the contacts are imported, or Zoom's recordings
    /// (already found by the look; Pako reads their transcripts from the folder the discovery names). Answered pakoUsed({what, ok, count}); for
    /// the contacts with what Pako's import did too ({added, merged, count}: count is how many people Pako knows from this Mac now).
    private func use(_ what: String, ids: [String], answer: @escaping Answer) {
        let used = { (ok: Bool, n: Int, extra: [String: Any]?) in
            var out: [String: Any] = ["what": what, "ok": ok, "count": n]
            for k in ["added", "merged", "count"] { if let v = extra?[k] as? Int { out[k] = v } }
            answer("pakoUsed", out)
        }
        switch what {
        case "calendars":
            calendars.select(ids) { n in
                answer("pakoCalendarSynced", n.map { ["events": $0, "calendars": ids.count] })
                used(n != nil, n ?? 0, nil)
            }
        case "contacts": importContacts(answer: answer, used: used)
        default:
            let s = sources
            work.async {
                let n = s.zoomFolders().map(zoomRecordingCount)
                DispatchQueue.main.async { used(n != nil, n ?? 0, nil) }
            }
        }
    }

    /// One look (the person said yes in the panel), on its own queue. What Pako keeps is read first and this look put on top of it
    /// (mergeDiscovery), then posted, then answered.
    private func discover(_ what: [String], openMail: Bool, answer: @escaping Answer) {
        guard !discovering else { return }
        discovering = true
        let s = sources
        work.async {
            let fresh = runDiscovery(what: what, openMail: openMail, sources: s, now: Date())
            DispatchQueue.main.async {
                self.send("GET", "/panel/api/discovery", nil) { _, kept in
                    let all = mergeDiscovery(kept: kept ?? [:], fresh: fresh)
                    self.send("POST", "/panel/api/discovery", all) { _, _ in
                        self.discovering = false
                        answer("pakoDiscovered", all)
                    }
                }
            }
        }
    }

    /// The contacts, after the person confirmed the import in the panel: read (macOS asks first, if it never did), shaped and posted.
    private func importContacts(answer: @escaping Answer, used: ((Bool, Int, [String: Any]?) -> Void)? = nil) {
        let s = sources
        work.async {
            if s.contactsPermission() == "notAsked" { _ = s.requestContacts() }
            let people = shapePeople(s.people())
            DispatchQueue.main.async {
                guard s.contactsPermission() == "granted" else {
                    used?(false, 0, nil)
                    return answer("pakoImported", nil)
                }
                // The person confirmed the import in the panel ("Import N people"): written now (the route's preview is for a page that
                // asks first).
                self.send("POST", "/panel/api/people/import", ["people": people, "confirm": true]) { ok, body in
                    answer("pakoImported", ok ? (body ?? ["people": people.count]) : nil)
                    used?(ok, people.count, body)
                }
            }
        }
    }
}
