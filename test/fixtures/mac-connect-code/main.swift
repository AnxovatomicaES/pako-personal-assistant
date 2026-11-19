// Repro: the Connect Claude window after a second wrong code. Drives the real ClaudeHelper.signIn and the real ConnectWindow, as App.swift does
// (setStep -> ConnectWindow.show, onCode -> helper.sendCode on its own queue).
import AppKit

MainActor.assumeIsolated {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let runner = PakoRunner()
    let helper = ClaudeHelper(runner: runner)
    let w = ConnectWindow()
    let texts = Texts()
    let send = DispatchQueue(label: "send")
    var steps: [String] = []
    w.onCode = { pasted in
        guard let code = cleanLoginCode(pasted) else { return }
        send.async { _ = helper.sendCode(code) }
    }
    let bin = CommandLine.arguments[1]
    DispatchQueue.global().async {
        let r = helper.signIn(bin) { s in
            DispatchQueue.main.async { MainActor.assumeIsolated { steps.append("\(s)"); print("STEP \(Date().timeIntervalSince1970): \(s)"); w.show(s, keySource: nil, texts: texts) } }
        }
        print("signIn returned: \(String(describing: r))")
    }
    func spin(_ s: Double) { let until = Date().addingTimeInterval(s); while Date() < until { _ = RunLoop.main.run(mode: .default, before: until) } }
    func fields(_ v: NSView) -> [NSTextField] { v.subviews.flatMap { ($0 as? NSTextField).map { [$0] } ?? [] + fields($0) } + v.subviews.flatMap { fields($0) } }
    func allButtons(_ v: NSView) -> [NSButton] { ((v as? NSButton).map { [$0] } ?? []) + v.subviews.flatMap { allButtons($0) } }
    func codeField() -> NSTextField? { fields(w.panel.contentView!).first { $0.isEditable } }
    func title() -> String { fields(w.panel.contentView!).first { $0.font?.pointSize == 15 }?.stringValue ?? "?" }
    var waited = 0.0
    while !(steps.last ?? "").contains("code: true") && waited < 15 { spin(0.2); waited += 0.2 }
    guard let f = codeField(), !f.isHidden else { print("FAIL: never asked for a code"); exit(2) }
    for attempt in 1...3 {
        guard f.isEnabled else { print("attempt \(attempt): the code field is DISABLED, title: \(title())"); break }
        f.stringValue = "wrong-code-\(attempt)"
        w.perform(NSSelectorFromString("primaryPressed"))
        spin(0.3)
        print("  right after pressing Continue for code \(attempt): title=\"\(title())\", field enabled=\(f.isEnabled)")
        spin(7.7)
        let shown = fields(w.panel.contentView!).filter { !$0.isHidden && !$0.isEditable && !$0.stringValue.isEmpty }.map(\.stringValue)
        print("  visible texts: \(Array(NSOrderedSet(array: shown)))")
        let btns = w.panel.contentView!.subviews.flatMap { allButtons($0) }.filter { !$0.isHidden }.map(\.title)
        print("  visible buttons: \(btns)")
        print("\(Date().timeIntervalSince1970) after code \(attempt) (8 s): field enabled=\(f.isEnabled), title=\"\(title())\"")
    }
    print("steps seen: \(steps.count)")
    helper.cancel()
    spin(1)
    exit(f.isEnabled ? 0 : 1)
}
