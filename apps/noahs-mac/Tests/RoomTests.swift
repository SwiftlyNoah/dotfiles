// The Room menu's tests (test.sh runs them): the menu built from the room fixtures, the moon's
// color, the CLI's exit codes, and the live feed against Tests/fake-noah. Plain asserts, no
// XCTest, since the app is built with swiftc alone.
import Foundation

@main
@MainActor
struct RoomTests {
  static func main() async {
    if ProcessInfo.processInfo.environment["ROOM_HARNESS"] == "1" { await harness() }
    let t = Tester()
    await t.all()
    t.finish()
  }
}

/// The test binary run again as a stand-in for the app: a live feed with a watch child, the
/// app's signal handling, and nothing else, until a signal ends it.
@MainActor
func harness() async -> Never {
  let env = ProcessInfo.processInfo.environment
  let feed = RoomFeed(cli: RoomCLI(noah: URL(fileURLWithPath: env["FAKE_NOAH"]!), timeout: 10), backoff: [0.05])
  feed.start()
  Termination.onSignal { feed.stop() }
  while true { try? await Task.sleep(for: .seconds(60)) }
}

func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

@MainActor
final class Tester {
  private var passed = 0
  private var failedTests = 0
  private var failed: [String] = []
  private var current = ""

  let fixtures = URL(fileURLWithPath: ProcessInfo.processInfo.environment["ROOM_FIXTURES"]!)
  let fakeNoah = URL(fileURLWithPath: ProcessInfo.processInfo.environment["FAKE_NOAH"]!)
  let scratch = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TEST_SCRATCH"]!)
  let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  let zone = TimeZone(identifier: "America/New_York")!
  private var control: URL!

  // MARK: Harness

  func test(_ name: String, _ body: () async throws -> Void) async {
    current = name
    control = scratch.appending(path: "fake-\(passed + failedTests)")
    try? FileManager.default.createDirectory(at: control, withIntermediateDirectories: true)
    setenv("FAKE_NOAH_DIR", control.path, 1)
    let before = failed.count
    do { try await body() } catch { failed.append("\(name): threw \(error)") }
    if failed.count == before {
      passed += 1
      print("ok    \(name)")
    } else {
      failedTests += 1
      print("FAIL  \(name)")
    }
  }

  func expect(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok { failed.append("\(current) (line \(line)): \(what)") }
  }

  func equal<T: Equatable>(_ a: T, _ b: T, line: Int = #line) {
    if a != b { failed.append("\(current) (line \(line)): got \(a), wanted \(b)") }
  }

  func finish() {
    for f in failed { print("  \(f)") }
    print("\(passed) passed, \(failedTests) failed")
    exit(failed.isEmpty ? 0 : 1)
  }

  func data(_ path: String) -> Data { try! Data(contentsOf: fixtures.appending(path: path)) }
  func room(_ path: String) -> RoomNow { RoomNow.decode(data(path))! }

  /// A fixture with some of its fields changed.
  func room(_ path: String, _ change: (inout [String: Any]) -> Void) -> RoomNow {
    var object = try! JSONSerialization.jsonObject(with: data(path)) as! [String: Any]
    change(&object)
    return RoomNow.decode(try! JSONSerialization.data(withJSONObject: object))!
  }

  func at(_ iso: String) -> Date { Room.date(iso)! }

  func set(_ name: String, _ value: String) {
    try! value.write(to: control.appending(path: name), atomically: true, encoding: .utf8)
  }

  var calls: [String] {
    ((try? String(contentsOf: control.appending(path: "calls"), encoding: .utf8)) ?? "")
      .split(separator: "\n").map(String.init)
  }

  var cli: RoomCLI { RoomCLI(noah: fakeNoah, timeout: 10) }

  var watchPid: Int32? {
    (try? String(contentsOf: control.appending(path: "watch-pid"), encoding: .utf8))
      .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
  }

  func until(_ seconds: Double = 5, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
  }

  func menu(_ state: RoomState, now: String = "2030-01-15T20:41:10-05:00", page: Bool = true) -> RoomMenu {
    RoomMenu.build(state, now: at(now), zone: zone, pageAvailable: page)
  }

  /// Every word the menu shows.
  func words(_ menu: RoomMenu) -> [String] {
    func walk(_ entries: [RoomEntry]) -> [String] {
      entries.flatMap { entry -> [String] in
        switch entry {
        case .info(let text): [text]
        case .item(let item): [item.title] + (item.subtitle.map { [$0] } ?? [])
        case .submenu(let title, let inner): [title] + walk(inner)
        case .separator: []
        }
      }
    }
    return [menu.header] + walk(menu.entries)
  }

  func items(_ menu: RoomMenu) -> [RoomEntry.Item] {
    func walk(_ entries: [RoomEntry]) -> [RoomEntry.Item] {
      entries.flatMap { entry -> [RoomEntry.Item] in
        switch entry {
        case .item(let item): [item]
        case .submenu(_, let inner): walk(inner)
        default: []
        }
      }
    }
    return walk(menu.entries)
  }

  func infos(_ menu: RoomMenu) -> [String] {
    menu.entries.compactMap { if case .info(let text) = $0 { text } else { nil } }
  }

  func topTitles(_ menu: RoomMenu) -> [String] {
    menu.entries.compactMap { entry in
      switch entry {
      case .info(let text): "i:\(text)"
      case .item(let item): item.title
      case .submenu(let title, _): "\(title) >"
      case .separator: "-"
      }
    }
  }

  // MARK: Tests

  func all() async {
    await menuTests()
    await iconTests()
    await outcomeTests()
    await cliTests()
    await feedTests()
  }

  func menuTests() async {
    await test("the evening status reads as the contract's menu") {
      let m = menu(.live(room("cli/status.json")))
      equal(m.header, "Room · Evening · 70.5°F")
      equal(topTitles(m), [
        "i:Automations on · at the desk", "Focus", "Watch", "More scenes >", "Room off", "-",
        "Leaving", "Going to bed", "Pause automations for 1 h", "-",
        "i:Next: Late at 10:00 pm", "Open Room page…",
      ])
      let leaving = items(m).first { $0.action == .leaving }
      equal(leaving?.subtitle, "Away now")
      equal(items(m).first { $0.action == .bed }?.subtitle, "Lights out now")
      expect(items(m).allSatisfy { $0.enabled }, "every action is enabled while live")
    }

    await test("Focus and Watch carry ⌃⌥F and ⌃⌥W") {
      let m = items(menu(.live(room("cli/status.json"))))
      let focus = m.first { $0.action == .scene("focus") && $0.hotkey != nil }
      let watch = m.first { $0.action == .scene("watch") && $0.hotkey != nil }
      equal(focus?.hotkey?.glyphs, "⌃⌥F")
      equal(watch?.hotkey?.glyphs, "⌃⌥W")
      equal(m.filter { $0.hotkey != nil }.count, 2)
      equal(RoomMenu.hotkeys["focus"]?.letter, "f")
    }

    await test("More scenes lists every scene but Away, in families, with the current one checked") {
      let m = menu(.live(room("cli/status.json")))
      guard case .submenu(_, let inner)? = m.entries.first(where: { if case .submenu = $0 { true } else { false } }) else {
        return expect(false, "no submenu")
      }
      let titles = inner.map { entry -> String in
        if case .item(let item) = entry { item.title } else { "-" }
      }
      equal(titles, [
        "Arrive", "Arrive late", "Focus", "Evening", "Bright", "-", "Call", "Watch", "Lilac Moon", "-",
        "Wind down", "Last call", "Lights out", "Night path", "Wake",
      ])
      let checked = items(m).filter(\.checked).map(\.title)
      equal(checked, ["Evening"])
      expect(inner.allSatisfy { if case .item(let i) = $0 { i.dot != nil && i.hotkey == nil } else { true } },
             "submenu scenes have dots and no hotkeys")
    }

    await test("Room off runs the away scene; the other actions map to their commands") {
      equal(RoomAction.roomOff.command, ["scene", "away"])
      equal(RoomAction.scene("lilac-moon").command, ["scene", "lilac-moon"])
      equal(RoomAction.leaving.command, ["leaving"])
      equal(RoomAction.bed.command, ["bed"])
      equal(RoomAction.pause.command, ["pause", "--for", "1h"])
      equal(RoomAction.resume.command, ["resume"])
      equal(RoomAction.openPage.command, nil)
    }

    await test("a hands-off pause says why, and offers Resume") {
      let m = menu(.live(room("status-paused-hands-off.json")))
      equal(infos(m).first, "Paused until 9:40 pm, because I set the bars to rose")
      expect(topTitles(m).contains("Resume automations"), "Resume is offered")
      expect(!topTitles(m).contains("Pause automations for 1 h"), "Pause isn't")
    }

    await test("a pause by hand says so") {
      equal(infos(menu(.live(room("status-paused-by-hand.json")))).first, "Paused by hand until 9:41 pm")
      let untilMode = room("status-paused-by-hand.json") { o in
        o["paused"] = ["until": "2030-01-16T08:41:10-05:00", "until_mode": "evening", "level": 2, "by": "by_hand",
                       "why": "paused by hand from the menu bar", "via": "menubar", "since": "2030-01-15T20:41:10-05:00"]
      }
      equal(infos(menu(.live(untilMode))).first, "Paused by hand until Evening")
      let overnight = room("status-paused-hands-off.json") { o in
        var p = o["paused"] as! [String: Any]
        p["until"] = "2030-01-16T01:10:00-05:00"
        o["paused"] = p
      }
      equal(infos(menu(.live(overnight))).first, "Paused until 1:10 am tomorrow, because I set the bars to rose")
    }

    await test("the next line is the first boundary still ahead") {
      let r = room("cli/status.json")
      equal(RoomMenu.nextLine(r, now: at("2030-01-15T22:30:00-05:00"), zone: zone), "Next: Wind down at 11:30 pm")
      equal(RoomMenu.nextLine(r, now: at("2030-01-15T23:59:00-05:00"), zone: zone), "Next: Last call at 12:00 am tomorrow")
      equal(RoomMenu.nextLine(r, now: at("2030-01-16T00:20:00-05:00"), zone: zone), "Next: Wake ramp at 7:40 am")
      equal(RoomMenu.nextLine(r, now: at("2030-01-16T08:00:00-05:00"), zone: zone), nil)
      let skipped = room("cli/status.json") { o in
        o["next"] = ["events": [["kind": "wake_ramp", "at": "2030-01-16T07:40:00-05:00", "state": "skipped"],
                                ["kind": "pause_ends", "at": "2030-01-16T07:00:00-05:00"],
                                ["kind": "wake", "at": "2030-01-16T08:00:00-05:00"]]]
      }
      equal(RoomMenu.nextLine(skipped, now: at("2030-01-16T00:20:00-05:00"), zone: zone), "Next: Wake at 8:00 am")
    }

    await test("in the room but away from the desk, and an unknown mode") {
      let r = room("cli/status.json") { o in
        o["desk"] = ["at_desk": false, "why": "idle"]
        o["mode"] = ["current": NSNull()]
        o["sensor"] = NSNull()
      }
      let m = menu(.live(r))
      equal(m.header, "Room")
      equal(infos(m).first, "Automations on · in the room")
    }

    await test("the shared status fixtures: away, asleep, a stale bridge, the Halo on") {
      let away = menu(.live(room("status-away.json")), now: "2030-01-18T12:00:00-05:00")
      equal(away.header, "Room · Away · 67.3°F")
      equal(infos(away), ["Automations on"])
      equal(items(away).first { $0.action == .roomOff }?.checked, true)
      equal(RoomIcon.of(.live(room("status-away.json")), palette: [:]), .plain)

      let sleep = menu(.live(room("status-sleep.json")), now: "2030-01-16T01:00:00-05:00")
      equal(sleep.header, "Room · Sleep · 69.1°F")
      equal(infos(sleep), ["Automations on · in the room", "Next: Wake ramp at 7:40 am"])
      equal(items(sleep).filter(\.checked).map(\.title), ["Lights out"])

      let stale = menu(.live(room("status-bridge-stale.json")))
      equal(infos(stale).prefix(2), [
        "Automations on · at the desk", "The Hue Bridge hasn't answered since 8:41 pm, so the room shows its last read.",
      ])

      let halo = menu(.live(room("status-halo-on.json")))
      equal(items(halo).filter(\.checked).map(\.title), ["Focus", "Focus"])
    }

    await test("notices show under the state line") {
      let r = room("cli/status.json") { o in
        o["notices"] = [["key": "light_service_down", "text": "The light service isn't running"]]
      }
      equal(infos(menu(.live(r))).prefix(2), ["Automations on · at the desk", "The light service isn't running"])
    }

    await test("exit 4: Room service isn't running, every action disabled") {
      let m = menu(.down)
      equal(m.header, "Room")
      equal(infos(m), ["Room service isn't running"])
      expect(items(m).filter { $0.action != .openPage }.allSatisfy { !$0.enabled }, "actions are disabled")
      expect(items(m).first { $0.action == .openPage }?.enabled == true, "the page still opens")
      equal(items(menu(.down, page: false)).first { $0.action == .openPage }?.enabled, false)
    }

    await test("no noah room yet, and still checking") {
      let m = menu(.unavailable(RoomCLI.notInstalled))
      equal(infos(m), ["noah room isn't installed yet"])
      expect(items(m).filter { $0.action != .openPage }.allSatisfy { !$0.enabled }, "actions are disabled")
      equal(infos(menu(.checking)), ["Checking"])
    }

    await test("the Halo is never in the menu") {
      let statuses = try FileManager.default.contentsOfDirectory(atPath: fixtures.path).filter { $0.hasPrefix("status-") } + ["cli/status.json"]
      expect(statuses.count == 9, "\(statuses.count) status fixtures")
      for path in statuses {
        let all = words(menu(.live(room(path))))
        expect(!all.contains { $0.localizedCaseInsensitiveContains("halo") }, "\(path) shows the Halo")
      }
      let notice = room("cli/status.json") { o in
        o["notices"] = [["key": "halo_service_down", "text": "The Halo service isn't answering", "data_classes": []],
                        ["key": "battery_low", "text": "The motion sensor's battery is at 12%", "data_classes": []]]
      }
      let shown = words(menu(.live(notice)))
      expect(!shown.contains { $0.localizedCaseInsensitiveContains("halo") }, "the Halo notice shows: \(shown)")
      expect(shown.contains("The motion sensor's battery is at 12%"), "other notices still show")
      for state in [RoomState.down, .checking, .unavailable(RoomCLI.notInstalled)] {
        expect(!words(menu(state)).contains { $0.localizedCaseInsensitiveContains("halo") }, "\(state) shows the Halo")
      }
    }

    await test("menu copy has no dashes standing in for punctuation") {
      for path in ["cli/status.json", "status-paused-hands-off.json"] {
        for w in words(menu(.live(room(path)))) {
          expect(!w.contains("—") && !w.contains(" - ") && !w.contains("--"), "dash in \(w)")
        }
      }
    }
  }

  func iconTests() async {
    let scenes = RoomScenes.decode(try! Data(contentsOf: tests.appending(path: "scenes-public.json")))!

    await test("the moon takes the bars' color") {
      equal(RoomIcon.of(.live(room("cli/status.json")), palette: scenes.palette), .tinted("#c4a7e7"))
      // Without the export's palette, from the bars' xy: still a lilac, bluer than it is green.
      guard case .tinted(let hex) = RoomIcon.of(.live(room("cli/status.json")), palette: [:]) else {
        return expect(false, "not tinted")
      }
      let v = Int(hex.dropFirst(), radix: 16)!
      expect((v & 0xFF) > ((v >> 8) & 0xFF), "\(hex) is bluer than green")
    }

    await test("the moon fills with amber during wind down") {
      let r = room("cli/status.json") { o in o["mode"] = ["current": "wind_down"] }
      equal(RoomIcon.of(.live(r), palette: scenes.palette), .windDown)
      equal(Room.amber, "#f6c177")
    }

    await test("bars off or unreachable leave the moon plain") {
      let off = room("cli/status.json") { o in
        o["lights"] = (o["lights"] as! [[String: Any]]).map { var l = $0; l["on"] = false; return l }
      }
      equal(RoomIcon.of(.live(off), palette: scenes.palette), .plain)
      let unreachable = room("cli/status.json") { o in
        o["lights"] = [
          ["key": "bar-left", "on": true, "reachable": false, "colormode": "xy", "xy": [0.2875, 0.2024], "color_name": "lilac"],
          ["key": "bar-right", "on": true, "reachable": true, "colormode": "xy", "xy": [0.4553, 0.3353], "color_name": "rose"],
        ]
      }
      equal(RoomIcon.of(.live(unreachable), palette: scenes.palette), .tinted("#ea9a97"))
      equal(RoomIcon.of(.down, palette: scenes.palette), .plain)
      equal(RoomIcon.of(.checking, palette: scenes.palette), .plain)
    }

    await test("a bar in color temperature mode shows that warmth") {
      let ct = room("cli/status.json") { o in
        o["lights"] = [["key": "bar-left", "on": true, "reachable": true, "colormode": "ct", "ct": 370, "kelvin": 2700, "color_name": NSNull()]]
      }
      equal(RoomIcon.of(.live(ct), palette: [:]), .tinted(Color.kelvin(2700)))
      let warm = Int(Color.kelvin(2700).dropFirst(), radix: 16)!
      expect((warm >> 16) & 0xFF == 0xFF && (warm & 0xFF) < 0xC0, "2700 K is warm: \(Color.kelvin(2700))")
    }

    await test("scene dots come from the public export") {
      equal(scenes.palette["lilac"], "#c4a7e7")
      equal(scenes.dots["lilac-moon"], ["#c4a7e7", "#ea9a97"])
      equal(scenes.dots["focus"], ["#f2f1ff"])
      equal(scenes.dots["lights-out"], [])
      equal(scenes.dots["fan-only"], [Color.kelvin(2700)])
      equal(RoomScenes.decode(Data("{}".utf8)), nil)
    }
  }

  func outcomeTests() async {
    func outcome(_ code: Int32, _ out: String = "", _ err: String = "") -> RoomOutcome {
      RoomCLI.outcome(code: code, stdout: Data(out.utf8), stderr: Data(err.utf8))
    }

    await test("exit codes: 0 done, 1 failed, 2 usage, 3 refused, 4 down") {
      equal(outcome(0, "{}"), .ok(Data("{}".utf8)))
      equal(outcome(1, "", "noah: the light service didn't answer\n"), .failed("the light service didn't answer"))
      equal(outcome(1, #"{"error":"the bridge refused","code":"bridge"}"#), .failed("the bridge refused"))
      equal(outcome(2, "", "usage:\n  noah status [--json]\n"), .usage("noah status [--json]"))
      equal(outcome(3, #"{"error":"room.pause is draft","code":"policy"}"#), .refused("room.pause is draft"))
      equal(outcome(4, String(decoding: data("cli/error-room-service-down.json"), as: UTF8.self)), .down)
      equal(outcome(4), .down)
      equal(outcome(1, #"{"error":"the room service isn't running","code":"room_service_down"}"#), .down)
      equal(outcome(9), .failed("noah room exited with 9"))
      equal(outcome(1, #"{"error":{"code":"x","message":"nested words"}}"#), .failed("nested words"))
    }

    await test("action reports") {
      let r = room("cli/status.json")
      equal(RoomReport.of(.scene("focus"), .ok(data("cli/scene.json")), room: r), RoomReport())
      equal(RoomReport.of(.leaving, .ok(data("cli/leaving.json")), room: r), RoomReport())
      equal(RoomReport.of(.bed, .ok(data("cli/bed.json")), room: r), RoomReport())
      equal(RoomReport.of(.pause, .ok(data("cli/pause.json")), room: r).paused?.value?.by, "by_hand")
      equal(RoomReport.of(.resume, .ok(data("cli/resume.json")), room: r), RoomReport(paused: .init(value: nil)))
      equal(RoomReport.of(.bed, .down, room: r).problems, ["The room service isn't running, so nothing changed."])
      equal(RoomReport.of(.pause, .refused("room.pause is draft"), room: r).problems, ["noah-os's policy said no: room.pause is draft"])
      equal(RoomReport.of(.leaving, .usage("x"), room: nil).problems, ["noah room isn't installed yet, so nothing changed."])
      let partial = #"{"ok":false,"scene":"lilac-moon","lights":{"bar-left":"failed","fan-far":"failed","fan-desk":"unreachable"},"halo":"failed"}"#
      equal(RoomReport.of(.scene("lilac-moon"), .ok(Data(partial.utf8)), room: r).problems,
            ["Lilac Moon didn't reach the Left bar or the Fan, far side."])
      let haloOnly = #"{"ok":true,"scene":"focus","lights":{"bar-left":"ok"},"halo":"failed"}"#
      equal(RoomReport.of(.scene("focus"), .ok(Data(haloOnly.utf8)), room: r).problems, [])
    }
  }

  func cliTests() async {
    await test("each action calls noah room with --json --client menubar") {
      for action in [RoomAction.scene("focus"), .roomOff, .leaving, .bed, .pause, .resume] {
        guard case .ok = await cli.run(action.command!) else { return expect(false, "\(action) didn't run") }
      }
      _ = await cli.run(["status"])
      equal(calls, [
        "room scene focus --json --client menubar",
        "room scene away --json --client menubar",
        "room leaving --json --client menubar",
        "room bed --json --client menubar",
        "room pause --for 1h --json --client menubar",
        "room resume --json --client menubar",
        "room status --json --client menubar",
      ])
    }

    await test("the fake's answers are the fixtures, byte for byte") {
      guard case .ok(let out) = await cli.run(["scene", "focus"]) else { return expect(false, "no answer") }
      equal(out, data("cli/scene.json"))
    }

    await test("no noah-os at all") {
      let missing = RoomCLI(noah: scratch.appending(path: "nowhere/bin/noah"))
      guard case .missing(let why) = await missing.run(["status"]) else { return expect(false, "not missing") }
      expect(why.hasPrefix("noah-os isn't on this Mac ("), why)
    }

    await test("a noah-os from before noah room answers usage") {
      set("state", "old")
      guard case .usage = await cli.run(["status"]) else { return expect(false, "not usage") }
    }

    await test("a run that hangs is stopped") {
      set("state", "live")
      set("watch-hold", "30")
      let slow = RoomCLI(noah: fakeNoah, timeout: 1)
      let started = Date()
      // `watch` with --json stands in for any command that never answers.
      let outcome = await slow.run(["watch"])
      expect(Date().timeIntervalSince(started) < 5, "stopped in time")
      equal(outcome, .failed("noah room watch didn't answer in 1 s"))
    }

    await test("the public export") {
      set("export", tests.appending(path: "scenes-public.json").path)
      guard case .ok(let out) = await cli.export() else { return expect(false, "no export") }
      equal(RoomScenes.decode(out)?.dots["focus"], ["#f2f1ff"])
      equal(calls, ["room export --public"])
    }
  }

  func feedTests() async {
    func feed() -> RoomFeed { RoomFeed(cli: cli, backoff: [0.05, 0.1, 0.2], settled: 0.3) }

    await test("status, then each watch line, live") {
      set("watch", fixtures.appending(path: "status-paused-by-hand.json").path)
      set("watch-hold", "2")
      let f = feed()
      f.start()
      expect(await until { f.state.now?.paused?.by == "by_hand" }, "the watch line arrived")
      equal(calls.prefix(2), ["room status --json --client menubar", "room watch --client menubar"])
      f.stop()
    }

    await test("a watch line older than what's shown is dropped") {
      let old = scratch.appending(path: "old.json")
      let newer = scratch.appending(path: "newer.json")
      try JSONSerialization.data(withJSONObject: patched("status-paused-hands-off.json") { $0["version"] = 700 }).write(to: old)
      try JSONSerialization.data(withJSONObject: patched("status-paused-by-hand.json") { $0["version"] = 900 }).write(to: newer)
      set("watch", "\(old.path)\n\(newer.path)\n")
      set("watch-hold", "2")
      let f = feed()
      var seen: [String?] = []
      f.onChange = { seen.append(f.state.now?.paused?.by) }
      f.start()
      expect(await until { f.state.now?.paused?.by == "by_hand" }, "the newer line arrived")
      expect(!seen.contains("hands_off"), "the older line never showed: \(seen)")
      f.stop()
    }

    await test("the watch is started again when it exits") {
      set("watch-exit", "0")
      let f = feed()
      f.start()
      expect(await until { calls.filter { $0.hasPrefix("room watch") }.count >= 3 }, "restarted: \(calls)")
      expect(f.state.now != nil, "still live")
      f.stop()
    }

    await test("watch exiting 4 shows the service down, and it comes back") {
      set("watch-exit", "4")
      let f = feed()
      f.start()
      expect(await until { f.state == .down }, "down")
      set("state", "down")
      try? await Task.sleep(for: .milliseconds(300))
      equal(f.state, .down)
      set("state", "live")
      set("watch-exit", "0")
      set("watch-hold", "5")
      f.poke()
      expect(await until(2) { f.state.now != nil }, "live again")
      f.stop()
    }

    await test("failures in a row wait longer each time") {
      set("state", "down")
      let f = RoomFeed(cli: cli, backoff: [0.05, 0.4, 5], settled: 60)
      f.start()
      try? await Task.sleep(for: .milliseconds(900))
      let n = calls.count
      expect(n >= 2 && n <= 3, "\(n) calls in 0.9 s")
      equal(f.state, .down)
      f.stop()
    }

    await test("no noah room yet: the menu says so") {
      set("state", "old")
      let f = feed()
      f.start()
      expect(await until { f.state == .unavailable(RoomCLI.notInstalled) }, "unavailable: \(f.state)")
      f.stop()
      let none = RoomFeed(cli: RoomCLI(noah: scratch.appending(path: "nowhere/bin/noah")), backoff: [5])
      none.start()
      expect(await until { if case .unavailable(let w) = none.state { w.hasPrefix("noah-os isn't on this Mac") } else { false } },
             "missing: \(none.state)")
      none.stop()
    }

    await test("pause and resume show at once; a scene with a failed light says which") {
      set("watch-hold", "5")
      let f = feed()
      f.start()
      expect(await until { f.state.now != nil }, "live")
      equal(await f.perform(.pause), [])
      equal(f.state.now?.paused?.by, "by_hand")
      equal(await f.perform(.resume), [])
      equal(f.state.now?.paused, nil)
      set("state", "partial")
      equal(await f.perform(.scene("focus")), ["Focus didn't reach the Fan, desk side."])
      set("state", "unreachable")
      equal(await f.perform(.scene("focus")), [])
      set("state", "refused")
      equal(await f.perform(.scene("focus")), ["noah-os's policy said no: room.scene is not auto in the policy"])
      set("state", "failed")
      equal(await f.perform(.leaving), ["the light service didn't answer in 10 s"])
      set("state", "down")
      equal(await f.perform(.bed), ["The room service isn't running, so nothing changed."])
      equal(f.state, .down)
      equal(await f.perform(.openPage), [])
      f.stop()
    }

    await test("an action that works while the menu shows the service down asks again at once") {
      set("state", "down")
      let f = RoomFeed(cli: cli, backoff: [30], settled: 60)
      f.start()
      expect(await until { f.state == .down }, "down")
      set("state", "live")
      set("watch-hold", "5")
      equal(await f.perform(.scene("focus")), [])
      expect(await until(2) { f.state.now != nil }, "live without waiting out the 30 s")
      f.stop()
    }

    await test("stopping ends the watch child") {
      set("watch-hold", "30")
      let f = feed()
      f.start()
      expect(await until { watchPid != nil }, "watching")
      guard let pid = watchPid else { return }
      expect(alive(pid), "the watch child runs")
      f.stop()
      expect(await until(3) { !alive(pid) }, "the watch child \(pid) is gone")
    }

    await test("a SIGTERM to the app ends its watch child too") {
      set("watch-hold", "30")
      let app = Process()
      app.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
      app.environment = ProcessInfo.processInfo.environment.merging(["ROOM_HARNESS": "1"]) { $1 }
      try app.run()
      expect(await until { watchPid != nil }, "watching")
      guard let pid = watchPid else { return app.terminate() }
      expect(alive(pid), "the watch child runs")
      kill(app.processIdentifier, SIGTERM)
      expect(await until(3) { !app.isRunning }, "the app exits")
      equal(app.terminationReason, .uncaughtSignal)
      equal(app.terminationStatus, SIGTERM)
      expect(await until(3) { !alive(pid) }, "the watch child \(pid) is gone")
      if alive(pid) { kill(pid, SIGKILL) }
    }
  }

  func patched(_ path: String, _ change: (inout [String: Any]) -> Void) -> [String: Any] {
    var object = try! JSONSerialization.jsonObject(with: data(path)) as! [String: Any]
    change(&object)
    return object
  }
}
