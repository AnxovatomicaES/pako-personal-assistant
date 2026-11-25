// Pako's Mac helper (desktop/mac/helper/build.sh makes it and its LaunchAgent, local.pako.helper): this Mac's calendars, contacts, Mail
// accounts and Apple Reminders for a Pako run from the Terminal, without the Mac app. The same code as the app's (Asks.swift, Discovery.swift):
// the panel's asks come through Pako's relay (src/mac-helper.ts), the answers go back the same way, and the rest goes to the routes the app
// uses, with the bridge token from ~/.pako as the app's own requests send it. Nothing is read before the panel asks; macOS asks the person
// before the first read of each (the texts are in this helper's Info.plist).

import AppKit

signal(SIGPIPE, SIG_IGN)
let runner = PakoRunner()
let net = DispatchQueue(label: "io.github.anxovatomicaes.pako.helper", attributes: .concurrent)

/// One request to the Pako running on this computer (its lock's port, only when that process listens there), with the bridge token.
func call(_ method: String, _ path: String, _ body: Any?, wait: TimeInterval = 15) -> (ok: Bool, body: [String: Any]?) {
    guard let l = runner.liveLock(), l.port > 0, processListens(pid: l.pid, port: l.port), let token = runner.bridgeToken(),
          let url = URL(string: "http://127.0.0.1:\(l.port)\(path)") else { return (false, nil) }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: wait)
    req.httpMethod = method
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let b = body, let data = try? JSONSerialization.data(withJSONObject: b) {
        req.httpBody = data
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    guard let a = runner.send(req).answer else { return (false, nil) }
    return ((200..<300).contains(a.status), try? JSONSerialization.jsonObject(with: a.body) as? [String: Any])
}

MainActor.assumeIsolated {
    var asks: MacAsks?
    let send: MacAsks.Send = { method, path, body, done in
        net.async {
            let r = call(method, path, body)
            DispatchQueue.main.async { done(r.ok, r.body) }
        }
    }
    let reply = { (id: String, fn: String, value: Any?) in
        net.async { _ = call("POST", "/panel/api/helper/answer", ["id": id, "fn": fn, "value": value ?? NSNull()]) }
    }
    // The panel's asks, waited for at Pako (it holds the request up to 25 s); a Pako that does not answer is asked again in 10 s.
    func poll() {
        net.async {
            let r = call("POST", "/panel/api/helper/next", [String: Any](), wait: 40)
            DispatchQueue.main.async {
                for a in r.body?["asks"] as? [[String: Any]] ?? [] {
                    guard let id = a["id"] as? String, let m = a["message"], let msg = parsePakoMessage(m), let asks = asks else { continue }
                    _ = asks.handle(msg) { fn, value in reply(id, fn, value) }
                }
                if r.ok { poll() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 10) { poll() } }
            }
        }
    }
    // At the start, once Pako answers: the calendars chosen before (Pako keeps them), read and kept in step again.
    func begin() {
        net.async {
            let r = call("GET", "/panel/api/calendar/local", nil)
            DispatchQueue.main.async {
                guard r.ok else { return DispatchQueue.main.asyncAfter(deadline: .now() + 10) { begin() } }
                let ids = (r.body?["calendars"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
                let s = MacSources(userHome: runner.userHome, live: true)
                let a = MacAsks(sources: s, calendars: CalendarFeed(sources: s, ids: ids) { _ in },
                                reminders: RemindersFeed(defaults: runner.defaults, live: true), send: send)
                asks = a
                a.resume()
                poll()
            }
        }
    }
    begin()
}
RunLoop.main.run()
