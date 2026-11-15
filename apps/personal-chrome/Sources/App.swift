// Personal Chrome: the default browser, so every link an app opens lands in my own Chrome.
//
// The shared agent browsers are copies of Google Chrome too (home/bin/agent-browser-chrome),
// and macOS hands a link to any running app with Chrome's bundle ID. With my Chrome closed,
// a link from Zoom, Slack or Mail would open in an agent's browser. This app takes the link
// and starts my Chrome with it: a new process with the default profile folder, which hands
// the link to my running Chrome or becomes it. It quits once the links are passed on.
import AppKit

@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
  private var quitTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    scheduleQuit()
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls { openInPersonalChrome(url) }
    scheduleQuit()
  }

  private func openInPersonalChrome(_ url: URL) {
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    // -n: a new Chrome process even while an agent's Chrome runs; without --user-data-dir it
    // uses my own profile folder, so Chrome passes the link to my window (or opens one).
    let target = url.isFileURL ? url.path : url.absoluteString
    open.arguments = ["-n", "-a", "Google Chrome", "--args", target]
    try? open.run()
  }

  // Links can arrive a moment after launch, so wait a little after the last one.
  private func scheduleQuit() {
    quitTimer?.invalidate()
    quitTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in
      Task { @MainActor in NSApp.terminate(nil) }
    }
  }
}

@main
struct PersonalChrome {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = Delegate()
    app.delegate = delegate
    app.setActivationPolicy(.prohibited)
    app.run()
  }
}
