// Noah's Mac: a menu bar app for the things this Mac does for me. The room's lights and
// automations (through noah-os's `noah room`, Room.swift), the portal's status and link,
// AirDrop on for a while (the awdl-guard job keeps it off otherwise), and the Lilac Moon
// wallpaper following the sun or held at one time of day.
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
  private let room = RoomFeed(cli: RoomCLI(noah: RoomCLI.defaultNoah))
  private var roomScenes: RoomScenes?
  private var scenesTriedAt: Date?
  private var roomModel: RoomMenu?
  private var roomItems: [NSMenuItem] = []
  private var iconKey = ""
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

    portal.onChange = { [weak self] in
      self?.updatePortalLines()
      self?.refreshRoomItems()
    }
    portal.refresh()

    room.onChange = { [weak self] in
      guard let self else { return }
      if room.state.now != nil || room.state == .down { loadScenes() }
      updateIcon()
      refreshRoomItems()
    }
    room.start()
    Termination.onSignal { AppDelegate.shared?.room.stop() }
    for (key, hotkey) in RoomMenu.hotkeys {
      Hotkeys.register(hotkey) { AppDelegate.shared?.run(.scene(key)) }
    }

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

  func applicationWillTerminate(_ notification: Notification) {
    room.stop()
  }

  /// The moon, unless AirDrop is on (radio waves). The moon takes the bars' color while they're
  /// on and fills with amber during wind down. The 3 s timer also catches the menu bar turning
  /// light or dark.
  private func updateIcon() {
    let airDrop = AirDrop.isUp
    let lightBar = statusItem.button?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua
    let moon = RoomIcon.of(room.state, palette: roomScenes?.palette ?? [:], lightMenuBar: lightBar)
    let key = airDrop ? "airdrop" : "\(moon)"
    guard key != iconKey else { return }
    iconKey = key
    let image: NSImage?
    if airDrop {
      image = NSImage(systemSymbolName: "dot.radiowaves.left.and.right", accessibilityDescription: "Noah's Mac, AirDrop on")
      image?.isTemplate = true
    } else {
      image = RoomMenuItems.moon(moon)
    }
    statusItem.button?.image = image
  }

  // MARK: The menu, rebuilt each time it opens

  func menuWillOpen(_ menu: NSMenu) {
    portal.refresh()
    room.poke()
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    roomModel = nil
    roomItems = makeRoomItems()
    roomItems.forEach(menu.addItem)

    menu.addItem(.separator())
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

  // MARK: The room

  private var roomPage: URL? {
    portal.status.url?.appending(path: "portal/room/")
  }

  private func makeRoomItems() -> [NSMenuItem] {
    let model = RoomMenu.build(room.state, now: .now, pageAvailable: roomPage != nil)
    roomModel = model
    return RoomMenuItems.make(model, dots: roomScenes?.dots, target: self, selector: #selector(roomAction(_:)))
  }

  /// Rebuilds the Room items in place while the menu is open, when what they say changed.
  private func refreshRoomItems() {
    guard let menu = statusItem.menu, let first = roomItems.first,
          let start = menu.items.firstIndex(of: first) else { return }
    let model = RoomMenu.build(room.state, now: .now, pageAvailable: roomPage != nil)
    guard model != roomModel else { return }
    roomItems.forEach(menu.removeItem)
    roomItems = makeRoomItems()
    for (offset, item) in roomItems.enumerated() { menu.insertItem(item, at: start + offset) }
  }

  /// The scenes' colors, read once from `noah room export --public` (tried again every 10
  /// minutes until it answers).
  private func loadScenes() {
    guard roomScenes == nil, scenesTriedAt.map({ Date.now.timeIntervalSince($0) > 600 }) ?? true else { return }
    scenesTriedAt = .now
    Task {
      if case .ok(let data) = await room.cli.export() { roomScenes = RoomScenes.decode(data) }
      updateIcon()
    }
  }

  @objc private func roomAction(_ sender: NSMenuItem) {
    if let action = RoomMenuItems.action(of: sender) { run(action) }
  }

  fileprivate func run(_ action: RoomAction) {
    if action == .openPage {
      if let url = roomPage { NSWorkspace.shared.open(url) }
      return
    }
    Task {
      let problems = await room.perform(action)
      report(problems)
    }
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
