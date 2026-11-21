// Apple Reminders as the phone-side copy of Pako's follow-ups (src/reminders-local.ts, docs/features.md "On your iPhone, through Reminders"):
// off until the person turns it on in the panel's calendar card, then macOS asks (Reminders), and Pako's two lists ("Pako" and "Pako: waiting
// on", made in the default Reminders account when missing) are posted to this computer's Pako every three minutes and a few seconds after
// Reminders changes (EKEventStoreChanged). The answer's changes are made here, each one checked first (RemindersCore.swift): nothing outside
// Pako's lists, nothing without that loop's tag. The rules are in RemindersCore.swift; here only EventKit. A check-only run never asks.

import EventKit
import Foundation

/// A value set from EventKit's callback and read after the wait.
private final class Wait<T>: @unchecked Sendable {
    var value: T
    init(_ v: T) { value = v }
}

/// What RemindersFeed asks of Reminders: MacReminders below (EventKit), or a made-up one in the tests (test/fixtures/mac-core/main.swift).
protocol RemindersStore: Sendable {
    func access() -> String
    func request() -> String
    func lists(create: Set<String>) -> [String: String]
    func read(_ lists: [String: String]) -> [LocalReminder]
    func apply(_ ops: [ReminderOp], lists: [String: String], zone: TimeZone)
}

/// Reminders through EventKit. Its calls may block (macOS's prompt waits for the person, a fetch for EventKit): never on the main thread.
final class MacReminders: RemindersStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _store = EKEventStore()
    private let defaults: UserDefaults
    /// Made anew once access is given: a store made before may not see the lists.
    private var store: EKEventStore {
        lock.lock(); defer { lock.unlock() }
        return _store
    }

    init(defaults: UserDefaults) { self.defaults = defaults }

    func access() -> String {
        // 3 is .authorized up to macOS 13 and .fullAccess from 14; 4 (.writeOnly) cannot read the lists back, so it counts as refused.
        switch EKEventStore.authorizationStatus(for: .reminder).rawValue {
        case 0: return "notAsked"
        case 3: return "granted"
        default: return "denied"
        }
    }

    /// macOS's prompt (only when it was never answered); what it says now.
    func request() -> String {
        guard access() == "notAsked" else { return access() }
        let ok = Wait(false), sem = DispatchSemaphore(value: 0)
        let answer: EKEventStoreRequestAccessCompletionHandler = { granted, _ in ok.value = granted; sem.signal() }
        if #available(macOS 14.0, *) { store.requestFullAccessToReminders(completion: answer) } else { store.requestAccess(to: .reminder, completion: answer) }
        sem.wait()
        if ok.value {
            lock.lock(); _store = EKEventStore(); lock.unlock()
        }
        return access()
    }

    /// Pako's lists that are there (by the id kept here, else by their title in the default account), the ones in `create` made when missing.
    func lists(create: Set<String>) -> [String: String] {
        let s = store
        var kept = defaults.dictionary(forKey: "remindersLists") as? [String: String] ?? [:]
        let all = s.calendars(for: .reminder)
        let home = s.defaultCalendarForNewReminders()?.source
        var out: [String: String] = [:]
        for (kind, title) in reminderListTitles {
            if let id = kept[kind], all.contains(where: { $0.calendarIdentifier == id }) {
                out[kind] = id
                continue
            }
            if let c = all.first(where: { $0.title == title && (home == nil || $0.source == home) }) {
                out[kind] = c.calendarIdentifier
            } else if create.contains(kind), let src = home ?? s.sources.first(where: { $0.sourceType == .local }) {
                let c = EKCalendar(for: .reminder, eventStore: s)
                c.title = title
                c.source = src
                if (try? s.saveCalendar(c, commit: true)) != nil { out[kind] = c.calendarIdentifier }
            }
            if let id = out[kind] { kept[kind] = id } else { kept.removeValue(forKey: kind) }
        }
        defaults.set(kept, forKey: "remindersLists")
        return out
    }

    /// What is in Pako's lists: every open reminder, and the ones completed in the last 30 days.
    func read(_ lists: [String: String]) -> [LocalReminder] {
        let s = store
        let cals = s.calendars(for: .reminder).filter { lists.values.contains($0.calendarIdentifier) }
        guard !cals.isEmpty else { return [] }
        let kind = Dictionary(lists.map { ($0.value, $0.key) }, uniquingKeysWith: { a, _ in a })
        let now = Date()
        let asks = [s.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals),
                    s.predicateForCompletedReminders(withCompletionDateStarting: now.addingTimeInterval(-30 * 86400), ending: now.addingTimeInterval(86400),
                                                     calendars: cals)]
        var out: [LocalReminder] = []
        for p in asks {
            let got = Wait<[EKReminder]>([]), sem = DispatchSemaphore(value: 0)
            s.fetchReminders(matching: p) { r in got.value = r ?? []; sem.signal() }
            sem.wait()
            out += got.value.compactMap { Self.local($0, kind) }
        }
        return out
    }

    private static func local(_ r: EKReminder, _ kind: [String: String]) -> LocalReminder? {
        guard let list = kind[r.calendar?.calendarIdentifier ?? ""] else { return nil }
        return LocalReminder(id: r.calendarItemIdentifier, list: list, title: r.title ?? "", url: r.url?.absoluteString, notes: r.notes,
                             due: r.dueDateComponents, completed: r.isCompleted, modified: r.lastModifiedDate)
    }

    /// The changes, each checked against the reminder it touches as it is now (RemindersCore.swift reminderOpAllowed), then saved together.
    func apply(_ ops: [ReminderOp], lists: [String: String], zone: TimeZone) {
        let s = store
        var lists = lists
        func kind() -> [String: String] { Dictionary(lists.map { ($0.value, $0.key) }, uniquingKeysWith: { a, _ in a }) }
        func setDue(_ r: EKReminder, _ ms: Double?) {
            for a in r.alarms ?? [] { r.removeAlarm(a) }
            guard let ms = ms else {
                r.dueDateComponents = nil
                return
            }
            r.dueDateComponents = reminderDueComponents(ms: ms, zone: zone)
            // A due time alone does not ring on the phone: an alarm at that time does.
            r.addAlarm(EKAlarm(absoluteDate: Date(timeIntervalSince1970: ms / 1000)))
        }
        func mine(_ id: String, _ op: ReminderOp) -> EKReminder? {
            guard let r = s.calendarItem(withIdentifier: id) as? EKReminder, reminderOpAllowed(op, target: Self.local(r, kind())) else { return nil }
            return r
        }
        var changed = false
        for op in ops {
            switch op {
            case let .create(loop, list, title, due, notes):
                if lists[list] == nil { lists.merge(self.lists(create: [list]), uniquingKeysWith: { a, _ in a }) }
                guard let cid = lists[list], let cal = s.calendar(withIdentifier: cid) else { continue }
                let r = EKReminder(eventStore: s)
                r.calendar = cal
                r.title = title
                r.notes = notes
                r.url = URL(string: reminderURL(loop: loop))
                setDue(r, due)
                if (try? s.save(r, commit: false)) != nil { changed = true }
            case let .update(id, _, title, due, notes, completed):
                guard let r = mine(id, op) else { continue }
                if let t = title { r.title = t }
                if let n = notes { r.notes = n }
                if let d = due { setDue(r, d) }
                if let c = completed { r.isCompleted = c }
                if (try? s.save(r, commit: false)) != nil { changed = true }
            case let .remove(id, _):
                guard let r = mine(id, op) else { continue }
                if (try? s.remove(r, commit: false)) != nil { changed = true }
            }
        }
        if changed { try? s.commit() }
    }
}

/// The switch, the timer and the change watch: one round at a time, posted by `post` (the panel's own route, App.swift).
@MainActor
final class RemindersFeed {
    private let work = DispatchQueue(label: "io.github.anxovatomicaes.pako.reminders")
    private let ek: any RemindersStore
    private let live: Bool
    private let defaults: UserDefaults
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private var soon: DispatchWorkItem?
    private var busy = false
    private var again = false
    /// One more at each press of the panel's switch: a round that read Reminders before it is neither posted nor made after it (turning
    /// Reminders off must be the last thing Pako hears, not an older round that was still on its way and would turn it on again).
    private var choice = 0
    /// Posts a body to /panel/api/reminders/local; hears its answer (nil: not taken).
    var post: ((_ body: [String: Any], _ done: @escaping ([String: Any]?) -> Void) -> Void)?

    init(defaults: UserDefaults, live: Bool, store: (any RemindersStore)? = nil) {
        self.defaults = defaults
        self.live = live
        ek = store ?? MacReminders(defaults: defaults)
    }

    var on: Bool { defaults.bool(forKey: "remindersOn") }

    /// The panel's switch. On: macOS asks (once), then in step now; `done` hears {ok, on, access, error?}. Off: Pako hears it once and stops;
    /// Pako's lists stay in Reminders, as the person left them.
    func setOn(_ want: Bool, done: @escaping ([String: Any]) -> Void) {
        guard live else { return done(["ok": false, "on": false, "access": "notAsked", "error": "this app cannot use Reminders"]) }
        let ek = ek
        choice += 1
        if !want {
            defaults.set(false, forKey: "remindersOn")
            stop()
            let access = ek.access()
            post?(["on": false, "access": access, "lists": [String: String](), "reminders": [Any]()]) { r in
                done(["ok": r != nil, "on": false, "access": access])
            }
            return
        }
        work.async {
            let access = ek.request()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard access == "granted" else {
                        return done(["ok": false, "on": false, "access": access,
                                     "error": "macOS did not let Pako use Reminders. Turn Pako on in System Settings > Privacy & Security > Reminders."])
                    }
                    self.defaults.set(true, forKey: "remindersOn")
                    self.start()
                    self.sync { ok in done(["ok": ok, "on": true, "access": access]) }
                }
            }
        }
    }

    /// From the app's start (or a panel signed in again): the timer and the change watch, when it is on.
    func start() {
        guard on, live else { return }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { _ in MainActor.assumeIsolated { self.sync() } }
        }
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { self.changed() }
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
        soon?.cancel()
    }

    /// Reminders change in bursts (iCloud brings many, and the changes made here count too): one round, five seconds after the last.
    private func changed() {
        soon?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.sync() } }
        soon = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: item)
    }

    /// One round: Pako's lists read and posted, the answer's changes made. One at a time; one asked for meanwhile runs after it.
    func sync(done: ((Bool) -> Void)? = nil) {
        guard on, live, let post = post else {
            done?(false)
            return
        }
        if busy {
            again = true
            done?(true)
            return
        }
        busy = true
        let ek = ek, asked = choice
        let zone = TimeZone(identifier: defaults.string(forKey: "remindersZone") ?? "") ?? .current
        work.async {
            let access = ek.access()
            let lists = access == "granted" ? ek.lists(create: ["owe"]) : [:]
            let found = access == "granted" ? ek.read(lists) : []
            let body = remindersPayload(on: true, access: access, lists: lists, reminders: found, zone: zone)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard self.on, self.choice == asked else {
                        return self.answered(nil, access: access, lists: lists, found: found, zone: zone, asked: asked, done: done)
                    }
                    post(body) { answer in self.answered(answer, access: access, lists: lists, found: found, zone: zone, asked: asked, done: done) }
                }
            }
        }
    }

    private func answered(_ answer: [String: Any]?, access: String, lists: [String: String], found: [LocalReminder], zone: TimeZone, asked: Int,
                          done: ((Bool) -> Void)?) {
        // The owner's zone, as Pako says it: the due dates are said in it.
        var zone = zone
        if let z = answer?["zone"] as? String, let tz = TimeZone(identifier: z) {
            defaults.set(z, forKey: "remindersZone")
            zone = tz
        }
        let finish = {
            self.busy = false
            done?(answer != nil)
            if self.again {
                self.again = false
                self.sync()
            }
        }
        let ops = reminderOpsToMake(answer?["ops"] as? [Any] ?? [], existing: found)
        // Turned off (or on again) while the answer was on its way: none of its changes are made.
        guard access == "granted", !ops.isEmpty, on, choice == asked else { return finish() }
        let ek = ek
        work.async {
            ek.apply(ops, lists: lists, zone: zone)
            DispatchQueue.main.async { MainActor.assumeIsolated { finish() } }
        }
    }
}
