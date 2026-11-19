// CalendarFeed (desktop/mac/Discovery.swift) with a fake source (test/mac-calendar-feed.test.ts): a push already reading events when the person
// turns the calendars off (select([])). Expected: the LAST thing posted is the empty list (Pako forgets). Prints the posts in order.
import AppKit
final class Slow: PakoSources, @unchecked Sendable {
    let live = true
    func installed(_ b: String) -> Bool { false }
    func calendarPermission() -> String { "granted" }
    func requestCalendars() -> Bool { true }
    func calendars() -> [LocalCalendar] { [] }
    func contactsPermission() -> String { "granted" }
    func requestContacts() -> Bool { true }
    func contactsCount() -> Int { 0 }
    func mailRunning() -> Bool { false }
    func mailPermission() -> String { "notAsked" }
    func mailAccounts() -> String? { nil }
    var zoomFolder: String { "/nonexistent" }
    func zoomFolders() -> [String: [String]]? { nil }
    func people() -> [LocalPerson] { [] }
    func events(ids: [String], from: Date, to: Date) -> [LocalEvent] {
        Thread.sleep(forTimeInterval: 0.3)  // EventKit reading a busy calendar
        return [LocalEvent(id: "ev1", calendarId: "work", title: "Board meeting", start: Date().addingTimeInterval(3600),
                           end: Date().addingTimeInterval(7200), allDay: false, location: nil, notes: nil, url: nil, attendees: [])]
    }
}
var posts: [String] = []
MainActor.assumeIsolated {
    let feed = CalendarFeed(sources: Slow(), ids: ["work"]) { _ in }
    feed.post = { body, done in
        let cals = body["calendars"] as? [String] ?? []
        let n = (body["events"] as? [Any])?.count ?? 0
        posts.append("calendars=\(cals) events=\(n)")
        done(true)
    }
    feed.push()            // the ten-minute timer (or EKEventStoreChanged) fires
    feed.select([]) { n in posts.append("select([]) done: \(String(describing: n))") }  // the person turns them off a moment later
}
DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    for p in posts { print(p) }
    let last = posts.last(where: { $0.hasPrefix("calendars=") }) ?? ""
    print(last == "calendars=[] events=0" ? "PASS: Pako was told to forget last" : "FAIL: the last post was \"\(last)\": Pako keeps the calendar the person turned off")
    exit(last == "calendars=[] events=0" ? 0 : 1)
}
RunLoop.main.run()
