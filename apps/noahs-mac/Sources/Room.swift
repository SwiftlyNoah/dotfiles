// The room: what noah-os's room service says right now (RoomNow), and the Room part of the menu
// built from it. Everything here is plain data and words, so the tests (test.sh) can check it
// without AppKit. The menu never shows the Halo; the room service handles it on its own.
import Foundation

/// RoomNow, as `noah room status --json` and each line of `noah room watch` print it. Only the
/// fields the menu uses; the rest (presence, the day so far, sources) is ignored.
struct RoomNow: Decodable, Equatable, Sendable {
  var version: Int?
  var lights: [Light]?
  var sensor: Sensor?
  var mode: Mode?
  var paused: Paused?
  var desk: Desk?
  var visit: Visit?
  var scene: SceneNow?
  var next: Next?
  var notices: [Notice]?

  struct Light: Decodable, Equatable, Sendable {
    var key: String?
    var label: String?
    var on: Bool?
    var reachable: Bool?
    var colormode: String?
    var xy: [Double]?
    var ct: Int?
    var kelvin: Int?
    var colorName: String?
  }

  struct Sensor: Decodable, Equatable, Sendable {
    var tempF: Double?
  }

  struct Mode: Decodable, Equatable, Sendable {
    var current: String?
  }

  struct Desk: Decodable, Equatable, Sendable {
    var atDesk: Bool?
  }

  struct Visit: Decodable, Equatable, Sendable {
    var inRoom: Bool?
  }

  struct SceneNow: Decodable, Equatable, Sendable {
    var last: String?
  }

  struct Next: Decodable, Equatable, Sendable {
    var events: [Event]?
    struct Event: Decodable, Equatable, Sendable {
      var kind: String
      var at: String
      var state: String?
    }
  }

  struct Notice: Decodable, Equatable, Sendable {
    var key: String?
    var text: String
  }

  static func decode(_ data: Data) -> RoomNow? {
    try? Room.decoder.decode(RoomNow.self, from: data)
  }
}

/// A pause of the automations (`paused` in RoomNow, and what `noah room pause` answers).
struct Paused: Decodable, Equatable, Sendable {
  var until: String?
  var untilMode: String?
  var level: Int?
  var by: String?
  var why: String?
}

/// What a scene run answers (SceneResult). Per light: ok, unreachable or failed. The Halo's own
/// field is left out on purpose: it never makes a run fail and the menu never shows it.
struct SceneResult: Decodable, Equatable, Sendable {
  var ok: Bool
  var scene: String?
  var lights: [String: String]?
}

/// One of the room's named scenes (contract 2.4). The names are fixed; their colors come from
/// `noah room export --public` when it answers (RoomScenes).
struct RoomScene: Equatable, Sendable {
  let key: String
  let name: String
  let family: String
}

enum Room {
  static let decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }()

  static let scenes: [RoomScene] = [
    .init(key: "arrive", name: "Arrive", family: "everyday"),
    .init(key: "arrive-late", name: "Arrive late", family: "everyday"),
    .init(key: "focus", name: "Focus", family: "everyday"),
    .init(key: "evening", name: "Evening", family: "everyday"),
    .init(key: "bright", name: "Bright", family: "everyday"),
    .init(key: "call", name: "Call", family: "moods"),
    .init(key: "watch", name: "Watch", family: "moods"),
    .init(key: "lilac-moon", name: "Lilac Moon", family: "moods"),
    .init(key: "wind-down", name: "Wind down", family: "sleep"),
    .init(key: "last-call", name: "Last call", family: "sleep"),
    .init(key: "lights-out", name: "Lights out", family: "sleep"),
    .init(key: "night-path", name: "Night path", family: "sleep"),
    .init(key: "wake", name: "Wake", family: "sleep"),
    .init(key: "away", name: "Away", family: "system"),
  ]

  static func sceneName(_ key: String) -> String {
    scenes.first { $0.key == key }?.name ?? key
  }

  /// The four Hue lights' labels (contract 2.1), for when RoomNow doesn't carry them.
  static let lightLabels: [String: String] = [
    "bar-left": "Left bar", "bar-right": "Right bar", "fan-desk": "Fan, desk side", "fan-far": "Fan, far side",
  ]

  static let modeLabels: [String: String] = [
    "day": "Day", "evening": "Evening", "late": "Late", "wind_down": "Wind down", "sleep": "Sleep", "away": "Away",
  ]

  static let nextLabels: [String: String] = [
    "evening": "Evening", "late": "Late", "wind_down": "Wind down", "last_call": "Last call",
    "lights_out": "Lights out", "wake_ramp": "Wake ramp", "wake": "Wake",
  ]

  /// Lilac Moon's gold (palette.json), the amber the moon fills with during wind down.
  static let amber = "#f6c177"

  // MARK: Times

  static func date(_ iso: String) -> Date? {
    if let d = try? Date(iso, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
    return try? Date(iso, strategy: .iso8601)
  }

  /// "9:40 pm", "7:40 am tomorrow" or "Sat 9:40 am", from where `now` is.
  static func clock(_ date: Date, now: Date, zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = zone
    f.amSymbol = "am"
    f.pmSymbol = "pm"
    f.dateFormat = "h:mm a"
    let time = f.string(from: date)
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
    switch days {
    case 0: return time
    case 1: return "\(time) tomorrow"
    default:
      f.dateFormat = "EEE"
      return "\(f.string(from: date)) \(time)"
    }
  }
}

// MARK: The feed's state

/// Where the menu's picture of the room comes from right now.
enum RoomState: Equatable, Sendable {
  case checking
  case live(RoomNow)
  /// `noah room` exited 4: the room service isn't running.
  case down
  /// There is no `noah room` to ask: noah-os isn't on this Mac, or it predates the room commands.
  case unavailable(String)
  /// `noah room status` failed some other way.
  case failed(String)

  var now: RoomNow? {
    if case .live(let now) = self { return now }
    return nil
  }
}

// MARK: The menu

enum RoomAction: Equatable, Sendable {
  case scene(String)
  case roomOff
  case leaving
  case bed
  case pause
  case resume
  case openPage

  /// The `noah room` arguments for it (before `--json --client menubar`), or nil when it isn't a
  /// room command.
  var command: [String]? {
    switch self {
    case .scene(let key): ["scene", key]
    case .roomOff: ["scene", "away"]
    case .leaving: ["leaving"]
    case .bed: ["bed"]
    case .pause: ["pause", "--for", "1h"]
    case .resume: ["resume"]
    case .openPage: nil
    }
  }
}

/// A global chord: ⌃⌥ plus a letter.
struct Hotkey: Equatable, Sendable {
  let letter: String // lowercase, as NSMenuItem's keyEquivalent wants it

  var glyphs: String { "⌃⌥\(letter.uppercased())" }
}

enum RoomEntry: Equatable, Sendable {
  case info(String)
  case item(Item)
  case submenu(String, [RoomEntry])
  case separator

  struct Item: Equatable, Sendable {
    var title: String
    var subtitle: String?
    var action: RoomAction
    var enabled: Bool
    var checked = false
    var hotkey: Hotkey?
    /// The scene whose colors the item's dot shows, if any.
    var dot: String?
  }
}

struct RoomMenu: Equatable, Sendable {
  var header: String
  var entries: [RoomEntry]

  static let hotkeys: [String: Hotkey] = ["focus": Hotkey(letter: "f"), "watch": Hotkey(letter: "w")]

  /// The Room part of the menu. `pageAvailable` is whether the portal has a link to open.
  static func build(_ state: RoomState, now: Date, zone: TimeZone = .current, pageAvailable: Bool) -> RoomMenu {
    let room = state.now
    let live = room != nil
    var entries: [RoomEntry] = []

    entries.append(.info(stateLine(state, now: now, zone: zone)))
    for notice in room?.notices ?? [] where !notice.text.isEmpty {
      entries.append(.info(notice.text))
    }

    let current = room?.scene?.last
    // Focus and Watch sit at the top with their hotkeys; every scene is in the submenu with its
    // colors (only there, so the main menu's titles keep their left edge).
    func scene(_ key: String, top: Bool) -> RoomEntry.Item {
      .init(title: Room.sceneName(key), action: .scene(key), enabled: live, checked: current == key,
            hotkey: top ? hotkeys[key] : nil, dot: top ? nil : key)
    }
    entries.append(.item(scene("focus", top: true)))
    entries.append(.item(scene("watch", top: true)))
    var more: [RoomEntry] = []
    for family in ["everyday", "moods", "sleep"] {
      if !more.isEmpty { more.append(.separator) }
      for s in Room.scenes where s.family == family {
        more.append(.item(scene(s.key, top: false)))
      }
    }
    entries.append(.submenu("More scenes", more))
    entries.append(.item(.init(title: "Room off", action: .roomOff, enabled: live, checked: current == "away")))

    entries.append(.separator)
    entries.append(.item(.init(title: "Leaving", subtitle: "Away now", action: .leaving, enabled: live)))
    entries.append(.item(.init(title: "Going to bed", subtitle: "Lights out now", action: .bed, enabled: live)))
    if room?.paused != nil {
      entries.append(.item(.init(title: "Resume automations", action: .resume, enabled: live)))
    } else {
      entries.append(.item(.init(title: "Pause automations for 1 h", action: .pause, enabled: live)))
    }

    entries.append(.separator)
    if let room, let next = nextLine(room, now: now, zone: zone) {
      entries.append(.info(next))
    }
    entries.append(.item(.init(title: "Open Room page…", action: .openPage, enabled: pageAvailable)))

    return RoomMenu(header: header(room), entries: entries)
  }

  /// "Room · Evening · 70.5°F"
  static func header(_ room: RoomNow?) -> String {
    var parts = ["Room"]
    if let mode = room?.mode?.current, let label = Room.modeLabels[mode] { parts.append(label) }
    if let f = room?.sensor?.tempF { parts.append(String(format: "%.1f°F", f)) }
    return parts.joined(separator: " · ")
  }

  static func stateLine(_ state: RoomState, now: Date, zone: TimeZone) -> String {
    switch state {
    case .checking: return "Checking"
    case .down: return "Room service isn't running"
    case .unavailable(let why), .failed(let why): return why
    case .live(let room):
      if let paused = room.paused { return pausedLine(paused, now: now, zone: zone) }
      if room.desk?.atDesk == true { return "Automations on · at the desk" }
      if room.visit?.inRoom == true { return "Automations on · in the room" }
      return "Automations on"
    }
  }

  /// "Paused until 9:40 pm, because I set the bars to rose", or "Paused by hand until 9:40 pm".
  static func pausedLine(_ p: Paused, now: Date, zone: TimeZone) -> String {
    var until = ""
    if let mode = p.untilMode, let label = Room.modeLabels[mode] {
      until = " until \(label)"
    } else if let at = p.until.flatMap(Room.date) {
      until = " until \(Room.clock(at, now: now, zone: zone))"
    }
    if p.by == "by_hand" { return "Paused by hand\(until)" }
    if let why = p.why, !why.isEmpty { return "Paused\(until), because \(why)" }
    return "Paused\(until)"
  }

  /// "Next: Wind down at 11:30 pm": the first planned boundary still ahead. The pause's own end
  /// is on the state line already, and a wake ramp that won't run isn't next.
  static func nextLine(_ room: RoomNow, now: Date, zone: TimeZone) -> String? {
    let upcoming = (room.next?.events ?? []).compactMap { e -> (String, Date)? in
      guard let label = Room.nextLabels[e.kind], let at = Room.date(e.at), at > now else { return nil }
      if e.kind == "wake_ramp", let state = e.state, state != "planned" { return nil }
      return (label, at)
    }
    guard let first = upcoming.min(by: { $0.1 < $1.1 }) else { return nil }
    return "Next: \(first.0) at \(Room.clock(first.1, now: now, zone: zone))"
  }
}

// MARK: The moon icon

/// The menu bar moon: plain (template), the bars' color, or filled amber during wind down.
enum RoomIcon: Equatable, Sendable {
  case plain
  case tinted(String) // "#rrggbb"
  case windDown

  static func of(_ state: RoomState, palette: [String: String]) -> RoomIcon {
    guard let room = state.now else { return .plain }
    if room.mode?.current == "wind_down" { return .windDown }
    let bars = ["bar-left", "bar-right"].compactMap { key in room.lights?.first { $0.key == key } }
    for bar in bars where bar.on == true && bar.reachable != false {
      if let hex = Color.hex(of: bar, palette: palette) { return .tinted(hex) }
    }
    return .plain
  }
}

enum Color {
  /// A light's color as the screen shows it: the palette's hex for a named color, else from its
  /// xy or color temperature.
  static func hex(of light: RoomNow.Light, palette: [String: String]) -> String? {
    if let name = light.colorName, let hex = palette[name] { return hex }
    if light.colormode == "ct" {
      if let k = light.kelvin { return kelvin(k) }
      if let ct = light.ct, ct > 0 { return kelvin(Int(1_000_000 / Double(ct))) }
    }
    if let xy = light.xy, xy.count == 2 { return self.xy(xy[0], xy[1]) }
    return nil
  }

  /// CIE xy at full brightness to sRGB (Philips' wide gamut conversion).
  static func xy(_ x: Double, _ y: Double) -> String {
    guard y > 0 else { return "#ffffff" }
    let Y = 1.0, X = Y / y * x, Z = Y / y * (1 - x - y)
    var rgb = [
      X * 1.656492 - Y * 0.354851 - Z * 0.255038,
      -X * 0.707196 + Y * 1.655397 + Z * 0.036152,
      X * 0.051713 - Y * 0.121364 + Z * 1.011530,
    ].map { max(0, $0) }
    let top = rgb.max() ?? 1
    if top > 0 { rgb = rgb.map { $0 / top } }
    let gamma = rgb.map { v in v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055 }
    return hex(gamma)
  }

  /// A color temperature in kelvin to sRGB (Tanner Helland's fit).
  static func kelvin(_ k: Int) -> String {
    let t = Double(min(max(k, 1000), 40000)) / 100
    let r = t <= 66 ? 255 : 329.698727446 * pow(t - 60, -0.1332047592)
    let g = t <= 66 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60, -0.0755148492)
    let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * log(t - 10) - 305.0447927307
    return hex([r, g, b].map { $0 / 255 })
  }

  private static func hex(_ rgb: [Double]) -> String {
    "#" + rgb.map { String(format: "%02x", Int((min(max($0, 0), 1) * 255).rounded())) }.joined()
  }
}

// MARK: Scene colors

/// The scenes' colors from `noah room export --public` (contract 8): for each scene, the bars'
/// colors (or the fan's when the bars are off), as the dot beside it in the menu shows them.
struct RoomScenes: Equatable, Sendable {
  var palette: [String: String] = [:] // color name to "#rrggbb"
  var dots: [String: [String]] = [:] // scene key to one or two "#rrggbb"

  private struct Export: Decodable {
    var palette: [String: Swatch]
    var scenes: [Scene]
    struct Swatch: Decodable { var hex: String }
    struct Scene: Decodable {
      var key: String
      var lights: [String: Light]
    }
    struct Light: Decodable {
      var on: Bool
      var color: String?
      var kelvin: Int?
    }
  }

  static func decode(_ data: Data) -> RoomScenes? {
    guard let export = try? JSONDecoder().decode(Export.self, from: data) else { return nil }
    var result = RoomScenes()
    result.palette = export.palette.mapValues { $0.hex.lowercased() }
    for scene in export.scenes {
      func hex(_ key: String) -> String? {
        guard let light = scene.lights[key], light.on else { return nil }
        if let name = light.color { return result.palette[name] }
        return light.kelvin.map(Color.kelvin)
      }
      var colors = ["bar-left", "bar-right"].compactMap(hex)
      if colors.isEmpty { colors = ["fan-desk", "fan-far"].compactMap(hex) }
      if colors.count == 2, colors[0] == colors[1] { colors.removeLast() }
      result.dots[scene.key] = Array(colors.prefix(2))
    }
    return result
  }
}
