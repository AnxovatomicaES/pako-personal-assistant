// Apple Reminders as the phone-side copy of Pako's follow-ups (src/reminders-local.ts, docs/features.md "On your iPhone, through Reminders"),
// as rules free of EventKit: which reminder is Pako's and of which loop, how a due date is said both ways, what is posted, and which change
// the server asks for may be made. Reminders.swift does the reading and writing; the test program (test/fixtures/mac-core/main.swift) runs
// these on made-up reminders.
//
// What decides what changes is the server (src/reminders-local.ts reconcile): the app only reads Pako's two lists, posts them, and makes the
// changes that come back, each one checked here first: never a reminder outside Pako's lists, nor one of them without that loop's tag.

import Foundation

/// Pako's two lists, by the server's names, and their titles in Reminders.
let reminderListTitles: [String: String] = ["owe": "Pako", "waiting": "Pako: waiting on"]

/// A reminder of one of Pako's lists, as EventKit gives it (Reminders.swift reads it; the tests make them up).
struct LocalReminder {
    var id: String
    /// "owe" or "waiting": which of Pako's lists it is in.
    var list: String
    var title: String
    var url: String?
    var notes: String?
    var due: DateComponents?
    var completed: Bool
    var modified: Date?
}

private let loopID = try! NSRegularExpression(pattern: "^[0-9a-f]{10}$")
private func isLoopID(_ s: String) -> Bool { loopID.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

/// The link that names a loop in its reminder.
func reminderURL(loop: String) -> String { "pako://loop/\(loop)" }

/// The loop a reminder is the copy of: its link (pako://loop/<id>), or else the tag at the end of its notes ([pako:<id>], kept when a device
/// drops the link). nil: not one of Pako's (a reminder the person added to a Pako list), and then it is never touched.
func reminderLoopID(url: String?, notes: String?) -> String? {
    if let u = url, u.hasPrefix("pako://loop/") {
        let id = String(u.dropFirst("pako://loop/".count))
        if isLoopID(id) { return id }
    }
    guard let n = notes, let r = n.range(of: "[pako:", options: .backwards) else { return nil }
    let rest = n[r.upperBound...]
    guard let end = rest.firstIndex(of: "]") else { return nil }
    let id = String(rest[..<end])
    return isLoopID(id) ? id : nil
}

/// A reminder's due as Pako reads it: ms since 1970 for a day and a time, "YYYY-MM-DD" for a day with no time, nil for none.
func reminderDueValue(_ c: DateComponents?, zone: TimeZone) -> Any? {
    guard let c = c, let y = c.year, let m = c.month, let d = c.day else { return nil }
    guard let h = c.hour else { return String(format: "%04d-%02d-%02d", y, m, d) }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = c.timeZone ?? zone
    let parts = DateComponents(year: y, month: m, day: d, hour: h, minute: c.minute ?? 0)
    return cal.date(from: parts).map { ($0.timeIntervalSince1970 * 1000).rounded() }
}

/// The time Pako asks for (ms) as Reminders keeps a due date: that day and minute in the owner's zone.
func reminderDueComponents(ms: Double, zone: TimeZone) -> DateComponents {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = zone
    var c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: Date(timeIntervalSince1970: ms / 1000))
    c.timeZone = zone
    return c
}

/// What is posted to /panel/api/reminders/local: on or off, macOS's answer, Pako's lists and what is in them. Only a reminder's id, list,
/// loop, title, due, whether it is completed and when it last changed: never its notes.
func remindersPayload(on: Bool, access: String, lists: [String: String], reminders: [LocalReminder], zone: TimeZone) -> [String: Any] {
    var out: [[String: Any]] = []
    for r in reminders.prefix(500) where reminderListTitles[r.list] != nil {
        var d: [String: Any] = ["id": r.id, "list": r.list, "title": clip(r.title, 300), "completed": r.completed,
                                "due": reminderDueValue(r.due, zone: zone) ?? NSNull()]
        if let loop = reminderLoopID(url: r.url, notes: r.notes) { d["loop"] = loop }
        if let m = r.modified { d["modified"] = (m.timeIntervalSince1970 * 1000).rounded() }
        out.append(d)
    }
    return ["on": on, "access": access, "lists": lists.filter { reminderListTitles[$0.key] != nil }, "reminders": on ? out : []]
}

/// One change the server asks for. `due`: nil leaves it, .some(nil) takes it away.
enum ReminderOp: Equatable {
    case create(loop: String, list: String, title: String, due: Double?, notes: String)
    case update(id: String, loop: String, title: String?, due: Double??, notes: String?, completed: Bool?)
    case remove(id: String, loop: String)
}

/// The server's op, read field by field; nil when it is not one this app makes.
func parseReminderOp(_ v: Any) -> ReminderOp? {
    guard let d = v as? [String: Any], let loop = d["loop"] as? String, isLoopID(loop) else { return nil }
    let text = { (k: String, n: Int) -> String? in (d[k] as? String).map { String($0.prefix(n)) } }
    func due(_ x: Any?) -> Double?? {
        guard let x = x else { return nil }
        if x is NSNull { return .some(nil) }
        guard let n = x as? Double, n.isFinite else { return nil }
        return .some(n)
    }
    switch d["op"] as? String {
    case "create":
        guard let list = d["list"] as? String, reminderListTitles[list] != nil, let title = text("title", 300), !title.isEmpty else { return nil }
        return .create(loop: loop, list: list, title: title, due: due(d["due"]) ?? nil, notes: text("notes", 2000) ?? "")
    case "update":
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        return .update(id: id, loop: loop, title: text("title", 300), due: due(d["due"]), notes: text("notes", 2000), completed: d["completed"] as? Bool)
    case "remove":
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        return .remove(id: id, loop: loop)
    default:
        return nil
    }
}

/// Whether a change may touch this reminder (found by the op's id): only one in Pako's lists that carries that same loop's tag.
func reminderOpAllowed(_ op: ReminderOp, target: LocalReminder?) -> Bool {
    switch op {
    case .create: return true
    case let .update(id, loop, _, _, _, _), let .remove(id, loop):
        guard let t = target, t.id == id, reminderListTitles[t.list] != nil else { return false }
        return reminderLoopID(url: t.url, notes: t.notes) == loop
    }
}

/// The ops of the server's answer that are made this round: the ones it may make, each create once (a loop that already has its reminder in
/// that list is not made again: a round sent twice makes no twin).
func reminderOpsToMake(_ raw: [Any], existing: [LocalReminder]) -> [ReminderOp] {
    var made = Set(existing.compactMap { r in reminderLoopID(url: r.url, notes: r.notes).map { "\(r.list):\($0)" } })
    var out: [ReminderOp] = []
    for v in raw.prefix(500) {
        guard let op = parseReminderOp(v) else { continue }
        if case let .create(loop, list, _, _, _) = op {
            guard made.insert("\(list):\(loop)").inserted else { continue }
        }
        out.append(op)
    }
    return out
}
