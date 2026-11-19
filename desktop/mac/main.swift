// Pako.app's entry point (built by desktop/mac/build.sh): a regular app with a Dock icon and a window, plus its menu-bar item.

import AppKit

// Top-level code runs on the main thread; said so, for the app's delegate, which belongs to it.
// A pipe whose reader has ended (the sign-in's stdin, the code sent just as it quits) is then an error where it is written, not the app's end.
signal(SIGPIPE, SIG_IGN)

// The View menu has the app's own Enter Full Screen (in the app's language): AppKit, which reads this as it starts, adds no second one.
UserDefaults.standard.register(defaults: ["NSFullScreenMenuItemEverywhere": false])

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // A headless self-test (App.swift) shows nothing at all, not even a Dock icon for a moment.
    app.setActivationPolicy(AppDelegate.headless ? .prohibited : .regular)
    app.run()
}
