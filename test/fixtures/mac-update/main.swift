// Test only (test/mac-update.test.ts): runs the app's update install (desktop/mac/Update.swift) as the app does once Update is pressed, and
// prints the outcome as JSON. Nothing is relaunched: the test looks at what is in place afterwards.
//   install <feed file> <app> <version> <build|-> <team|-> <home> [macOS version]   Updater.install with a loopback feed allowed
//   team <path>                                                                     signingTeam
//   check <path> <team|->                                                           checkSignature
//   sha <file>                                                                      fileSHA256

import Foundation

let a = Array(CommandLine.arguments.dropFirst())
var out: Any = NSNull()
switch a.first ?? "" {
case "install":
    guard let data = FileManager.default.contents(atPath: a[1]), let info = parseUpdateFeed(data, loopback: true) else {
        out = ["error": "feed"]
        break
    }
    var os = ProcessInfo.processInfo.operatingSystemVersion
    if a.count > 7, let v = nodeVersion(a[7]) { os = OperatingSystemVersion(majorVersion: v.0, minorVersion: v.1, patchVersion: v.2) }
    let current = InstalledApp(url: URL(fileURLWithPath: a[2]), bundleID: "io.github.anxovatomicaes.pako", version: a[3], build: Int(a[4]),
                               team: a[5] == "-" ? nil : a[5], os: os, userHome: a[6])
    var stages: [String] = []
    let lock = NSLock()
    let u = Updater(info: info, current: current, loopback: true) { s in
        lock.lock(); defer { lock.unlock() }
        let name: String
        switch s {
        case .downloading: name = "downloading"
        case .verifying: name = "verifying"
        case .installing: name = "installing"
        }
        if stages.last != name { stages.append(name) }
    }
    if ProcessInfo.processInfo.environment["PAKO_TEST_CANCEL"] == "1" { u.cancel() }
    switch u.install() {
    case let .success(url): out = ["ok": url.path, "stages": stages]
    case let .failure(f): out = ["error": f.code, "stages": stages]
    }
case "team":
    out = signingTeam(URL(fileURLWithPath: a[1])) ?? NSNull()
case "check":
    out = checkSignature(URL(fileURLWithPath: a[1]), team: a[2] == "-" ? nil : a[2])?.code ?? NSNull()
case "sha":
    out = fileSHA256(URL(fileURLWithPath: a[1])) ?? NSNull()
default:
    exit(2)
}
let data = try JSONSerialization.data(withJSONObject: ["r": out], options: [.sortedKeys, .fragmentsAllowed])
print(String(decoding: data, as: UTF8.self))
