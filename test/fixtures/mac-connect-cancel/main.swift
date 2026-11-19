// Repro: Cancel/Close pressed while App.swift's connectPrimary is still looking (locate, origin, auth status) is lost: ClaudeHelper.signIn
// sets cancelled = false at its start, so the sign-in (the browser page) starts anyway. This runs connectPrimary's own sequence of calls.
import Foundation
let runner = PakoRunner()
let helper = ClaudeHelper(runner: runner)
let bin = CommandLine.arguments[1]
let done = DispatchSemaphore(value: 0)
var result: String?? = nil
DispatchQueue.global().async {
    // App.swift connectPrimary, in order: locate, origin, auth status (withKey false), then signIn.
    let found = helper.locate()
    _ = helper.origin(found.bin ?? bin)
    if helper.authStatus(found.bin ?? bin, withKey: false)?.loggedIn == true { print("signed in"); done.signal(); return }
    print("cancelled before signIn? \(helper.cancelled)")
    result = .some(helper.signIn(found.bin ?? bin) { s in print("step: \(s)") })
    done.signal()
}
Thread.sleep(forTimeInterval: 0.5)
print("pressing Cancel (helper.cancel(), as onSecondary does while connecting)")
helper.cancel()
_ = done.wait(timeout: .now() + 12)
let started = FileManager.default.fileExists(atPath: (bin as NSString).deletingLastPathComponent + "/login-started.txt")
print("`claude auth login` was started after Cancel: \(started)")
helper.cancel()
exit(started ? 1 : 0)
