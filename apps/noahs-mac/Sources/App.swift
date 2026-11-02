// Noah's Mac: a menu bar app for the things this Mac does for me. The portal's status and
// link, AirDrop on for a while (the awdl-guard job keeps it off otherwise), and the Lilac
// Moon wallpaper following the sun or held at one time of day.
import AppKit

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private static var shared: AppDelegate?

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    shared = delegate
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  private var statusItem: NSStatusItem!
  private let portal = Portal()
  private var portalLine: NSMenuItem?
  private var openPortalItem: NSMenuItem?
  private var copyLinkItem: NSMenuItem?
  private var thumbnails: [Int: NSImage] = [:]

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    statusItem.menu = menu
    updateIcon()

    portal.onChange = { [weak self] in self?.updatePortalLines() }
    portal.refresh()

    // The icon follows AirDrop's real state, which can change without this app (the guard
    // job closing a window when it ends).
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
      MainActor.assumeIsolated { AppDelegate.shared?.updateIcon() }
    }
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
      MainActor.assumeIsolated { AppDelegate.shared?.portal.refresh() }
    }
    DispatchQueue.main.async { [weak self] in
      self?.thumbnails = Wallpaper.thumbnails(height: 36)
    }
  }

  private func updateIcon() {
    let on = AirDrop.isUp
    let name = on ? "dot.radiowaves.left.and.right" : "moon.fill"
    let image = NSImage(systemSymbolName: name, accessibilityDescription: on ? "Noah's Mac, AirDrop on" : "Noah's Mac")
    image?.isTemplate = true
    if statusItem.button?.image?.accessibilityDescription != image?.accessibilityDescription {
      statusItem.button?.image = image
    }
  }

  // MARK: The menu, rebuilt each time it opens

  func menuWillOpen(_ menu: NSMenu) {
    portal.refresh()
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    menu.addItem(.sectionHeader(title: "Portal"))
    let line = info("")
    portalLine = line
    menu.addItem(line)
    let open = action("Open Portal", #selector(openPortal), key: "o")
    openPortalItem = open
    menu.addItem(open)
    let copy = action("Copy Link", #selector(copyPortalLink), key: "c")
    copyLinkItem = copy
    menu.addItem(copy)
    updatePortalLines()

    menu.addItem(.separator())
    menu.addItem(.sectionHeader(title: "AirDrop"))
    if let until = AirDrop.openUntil() {
      menu.addItem(info("On until \(until.formatted(date: .omitted, time: .shortened))"))
      menu.addItem(action("Turn Off", #selector(airDropOff)))
      menu.addItem(action("Keep On for 30 Minutes", #selector(airDropOn(_:)), tag: 30))
    } else {
      menu.addItem(info(AirDrop.isUp ? "Turning off" : "Off, so calls stay smooth"))
      menu.addItem(action("Turn On for 10 Minutes", #selector(airDropOn(_:)), tag: 10))
      menu.addItem(action("Turn On for 30 Minutes", #selector(airDropOn(_:)), tag: 30))
      menu.addItem(action("Turn On for an Hour", #selector(airDropOn(_:)), tag: 60))
    }

    menu.addItem(.separator())
    menu.addItem(.sectionHeader(title: "Wallpaper"))
    let current = Wallpaper.current()
    let sun = action("Follow the Sun", #selector(followSun))
    sun.state = current == .sun ? .on : .off
    menu.addItem(sun)
    let times = NSMenuItem(title: "Hold One Time of Day", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    sub.autoenablesItems = false
    for (i, frame) in Wallpaper.frames.enumerated() {
      let item = action(frame.name, #selector(pinFrame(_:)), tag: i)
      item.subtitle = frame.clockTime
      item.image = thumbnails[i]
      item.state = current == .frame(i) ? .on : .off
      sub.addItem(item)
    }
    times.submenu = sub
    if case .frame(let i) = current, Wallpaper.frames.indices.contains(i) {
      times.title = "Holding \(Wallpaper.frames[i].name)"
    }
    times.isEnabled = !Wallpaper.frames.isEmpty
    menu.addItem(times)

    menu.addItem(.separator())
    menu.addItem(action("Quit Noah's Mac", #selector(quit), key: "q"))
  }

  private func updatePortalLines() {
    let s = portal.status
    portalLine?.title = s.summary
    openPortalItem?.isEnabled = s.url != nil
    copyLinkItem?.isEnabled = s.url != nil
  }

  private func info(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private func action(_ title: String, _ selector: Selector, key: String = "", tag: Int = 0) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
    item.target = self
    item.tag = tag
    return item
  }

  // MARK: Actions

  @objc private func openPortal() {
    if let url = portal.status.url { NSWorkspace.shared.open(url) }
  }

  @objc private func copyPortalLink() {
    guard let url = portal.status.url else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(url.absoluteString, forType: .string)
  }

  @objc private func airDropOn(_ sender: NSMenuItem) {
    report(AirDrop.turnOn(minutes: sender.tag))
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.updateIcon() }
  }

  @objc private func airDropOff() {
    report(AirDrop.turnOff())
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.updateIcon() }
  }

  @objc private func followSun() {
    report(Wallpaper.followSun())
  }

  @objc private func pinFrame(_ sender: NSMenuItem) {
    report(Wallpaper.hold(frame: sender.tag))
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func report(_ problems: [String]) {
    guard !problems.isEmpty else { return }
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "That didn't fully work"
    alert.informativeText = problems.joined(separator: "\n")
    alert.runModal()
  }
}
