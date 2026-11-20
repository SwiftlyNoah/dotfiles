// How this app reaches the room: noah-os's `noah room` CLI and nothing else (never the bridge or
// a socket), so the menu works when the portal is down. One `noah room watch` child keeps the
// menu live; every action is one `noah room <command> --json --client menubar` run, read by its
// exit code: 0 done, 1 failed, 2 usage, 3 refused by the policy, 4 the room service isn't running.
import Foundation

/// How one `noah room` run ended.
enum RoomOutcome: Equatable, Sendable {
  case ok(Data)
  case failed(String)
  case usage(String)
  /// The policy's own words when noah-os printed them as JSON, else nil.
  case refused(String?)
  case down
  /// noah couldn't be started at all.
  case missing(String)
}

struct RoomCLI: Sendable {
  var noah: URL
  /// How long a status or action run may take before it is stopped.
  var timeout: Double = 60

  static let defaultNoah = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "coding/noah-os/bin/noah")

  static let notInstalled = "noah room isn't installed yet"

  /// `noah room <command> --json --client menubar`.
  func run(_ command: [String]) async -> RoomOutcome {
    await once(["room"] + command + ["--json", "--client", "menubar"])
  }

  /// `noah room export --public`: the scenes' public values (names and colors), read from
  /// room.yaml without the room service.
  func export() async -> RoomOutcome {
    await once(["room", "export", "--public"])
  }

  /// Starts `noah room watch --client menubar`, which prints one RoomNow per line until it exits.
  func watch(onLine: @escaping @Sendable (String) -> Void) throws -> Child {
    let child = Child(noah, ["room", "watch", "--client", "menubar"], onLine: onLine)
    try child.start()
    return child
  }

  private func once(_ args: [String]) async -> RoomOutcome {
    let child = Child(noah, args, onLine: nil)
    do { try child.start() } catch {
      return .missing("noah-os isn't on this Mac (\(Self.tilde(noah.path)))")
    }
    let timer = DispatchWorkItem { child.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
    let end = await child.finished()
    timer.cancel()
    if end.killed {
      logLine("room: noah room \(args[1]) didn't answer in \(Int(timeout)) s and was stopped")
      return .failed("noah room \(args[1]) didn't answer in \(Int(timeout)) s")
    }
    return Self.outcome(code: end.code, stdout: end.stdout, stderr: end.stderr, command: args[1])
  }

  /// The words for a failure are noah-os's own JSON `error` when it printed one. Plain stderr goes
  /// to the log only, and the menu or alert gets a fixed sentence pointing there.
  static func outcome(code: Int32, stdout: Data, stderr: Data, command: String) -> RoomOutcome {
    let error = errorObject(stdout) ?? errorObject(stderr)
    if code == 4 || error?.code == "room_service_down" { return .down }
    if code == 0 { return .ok(stdout) }
    var why = "noah room \(command) exited with \(code)"
    if let message = error?.message {
      why = message
    } else if let line = lastLine(stderr) {
      logLine("room: noah room \(command) exited \(code): \(line)")
      why = "noah room \(command) failed. The details are in ~/Library/Logs/noahs-mac.log."
    }
    switch code {
    case 2: return .usage(why)
    case 3: return .refused(error?.message)
    default: return .failed(why)
    }
  }

  /// `{"error": "...", "code": "..."}`, or `{"error": {"code", "message"}}`.
  private static func errorObject(_ data: Data) -> (message: String, code: String?)? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let message = object["error"] as? String { return (message, object["code"] as? String) }
    if let error = object["error"] as? [String: Any], let message = error["message"] as? String {
      return (message, error["code"] as? String)
    }
    return nil
  }

  private static func lastLine(_ data: Data) -> String? {
    let text = String(decoding: data, as: UTF8.self)
    guard let line = text.split(whereSeparator: \.isNewline).last?.trimmingCharacters(in: .whitespaces),
          !line.isEmpty else { return nil }
    return line.hasPrefix("noah: ") ? String(line.dropFirst(6)) : line
  }

  static func tilde(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
  }
}

/// A child process with its output read as it comes. With `onLine`, stdout is handed over one
/// line at a time and not kept; without it, stdout is kept whole.
final class Child: @unchecked Sendable {
  struct End: Sendable {
    var code: Int32
    var stdout: Data
    var stderr: Data
    var killed: Bool
  }

  private let process = Process()
  private let onLine: (@Sendable (String) -> Void)?
  private let lock = NSLock()
  private let exited = DispatchGroup()
  private let drained = DispatchGroup()
  private var stdout = Data()
  private var stderr = Data()
  private var killed = false

  init(_ executable: URL, _ args: [String], onLine: (@Sendable (String) -> Void)?) {
    process.executableURL = executable
    process.arguments = args
    self.onLine = onLine
  }

  func start() throws {
    let out = Pipe(), err = Pipe()
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = out
    process.standardError = err
    exited.enter()
    drained.enter()
    drained.enter()
    out.fileHandleForReading.readabilityHandler = { [self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        flushLines(final: true)
        drained.leave()
      } else {
        lock.withLock { stdout.append(chunk) }
        flushLines(final: false)
      }
    }
    err.fileHandleForReading.readabilityHandler = { [self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        drained.leave()
      } else {
        lock.withLock {
          stderr.append(chunk)
          if stderr.count > 16_384 { stderr = stderr.suffix(16_384) }
        }
      }
    }
    process.terminationHandler = { [self] _ in exited.leave() }
    do {
      try process.run()
    } catch {
      out.fileHandleForReading.readabilityHandler = nil
      err.fileHandleForReading.readabilityHandler = nil
      throw error
    }
  }

  private func flushLines(final: Bool) {
    guard let onLine else { return }
    let lines: [String] = lock.withLock {
      var found: [String] = []
      while let newline = stdout.firstIndex(of: 0x0A) {
        found.append(String(decoding: stdout[stdout.startIndex..<newline], as: UTF8.self))
        stdout = Data(stdout[stdout.index(after: newline)...])
      }
      if final, !stdout.isEmpty {
        found.append(String(decoding: stdout, as: UTF8.self))
        stdout = Data()
      }
      return found
    }
    for line in lines where !line.trimmingCharacters(in: .whitespaces).isEmpty { onLine(line) }
  }

  /// Waits for the process to exit and its output to close. Output still open a second after
  /// the exit (a grandchild holding the pipe) isn't waited for.
  func finished() async -> End {
    await withCheckedContinuation { continuation in
      exited.notify(queue: .global()) { [self] in
        _ = drained.wait(timeout: .now() + 1)
        let end = lock.withLock {
          End(code: process.terminationStatus, stdout: stdout, stderr: stderr, killed: killed)
        }
        continuation.resume(returning: end)
      }
    }
  }

  func terminate() {
    lock.withLock { killed = true }
    if process.isRunning { process.terminate() }
  }
}

/// The live room: `noah room status` once, then one `noah room watch` child, started again when it
/// exits. A watch that ran a while comes back after 5 s; failures in a row wait longer (up to a
/// minute), so a stopped room service doesn't cost a Node start every 5 s. Opening the menu while
/// the room isn't live asks again right away.
@MainActor
final class RoomFeed {
  private(set) var state: RoomState = .checking
  var onChange: (() -> Void)?

  let cli: RoomCLI
  private let backoff: [Double]
  private let settled: Double
  private var task: Task<Void, Never>?
  private var child: Child?
  private var watchGeneration = 0
  private var latestVersion: Int?
  private var wake: CheckedContinuation<Void, Never>?
  private var wakeGeneration = 0
  private var stopped = false

  /// `backoff`: the waits after each exit in a row; `settled`: how long a watch must have run for
  /// the waits to start over.
  init(cli: RoomCLI, backoff: [Double] = [5, 10, 20, 40, 60], settled: Double = 60) {
    self.cli = cli
    self.backoff = backoff
    self.settled = settled
  }

  func start() {
    guard task == nil else { return }
    stopped = false
    task = Task { await loop() }
  }

  func stop() {
    stopped = true
    child?.terminate()
    child = nil
    resumeWake()
    task?.cancel()
    task = nil
  }

  /// Asks again now, unless the room is already live.
  func poke() {
    if state.now == nil { resumeWake() }
  }

  /// Runs a menu action and returns what went wrong, if anything, in words for an alert.
  func perform(_ action: RoomAction) async -> [String] {
    guard let command = action.command else { return [] }
    let outcome = await cli.run(command)
    let report = RoomReport.of(action, outcome, room: state.now)
    if case .down = outcome, state.now != nil { set(.down) }
    if case .ok = outcome, state.now == nil { poke() }
    if let paused = report.paused, var room = state.now {
      room.paused = paused.value
      set(.live(room))
    }
    return report.problems
  }

  private func loop() async {
    var misses = 0
    while !stopped {
      let status = await cli.run(["status"])
      if stopped { return }
      switch status {
      case .ok(let data):
        if let room = RoomNow.decode(data) {
          latestVersion = room.version
          set(.live(room))
          let started = Date()
          let code = await watch()
          if stopped { return }
          if Date().timeIntervalSince(started) >= settled { misses = 0 }
          switch code {
          case 4: set(.down)
          case 2:
            // status knew the room commands a moment ago, so this isn't a missing CLI.
            logLine("room: noah room watch exited 2 (usage)")
            set(.failed(.watch))
          default:
            logLine("room: noah room watch exited \(code)")
            set(.reconnecting)
          }
        } else {
          logLine("room: noah room status printed something that isn't RoomNow")
          set(.failed(.status))
        }
      case .down: set(.down)
      case .usage: set(.unavailable(RoomCLI.notInstalled))
      case .missing(let why): set(.unavailable(why))
      case .refused:
        logLine("room: noah room status was refused by the policy")
        set(.failed(.status))
      case .failed:
        // outcome() or once() already logged what noah printed.
        logLine("room: noah room status failed")
        set(.failed(.status))
      }
      if stopped { return }
      await pause(backoff[min(misses, backoff.count - 1)])
      misses += 1
    }
  }

  /// Runs one watch child until it exits, and returns its exit code.
  private func watch() async -> Int32 {
    watchGeneration += 1
    let generation = watchGeneration
    let started: Child
    do {
      started = try cli.watch { [weak self] line in
        DispatchQueue.main.async {
          MainActor.assumeIsolated { self?.line(line, generation: generation) }
        }
      }
    } catch {
      return 127
    }
    child = started
    let end = await started.finished()
    if child === started { child = nil }
    watchGeneration += 1 // lines still queued from this child are dropped
    return end.code
  }

  private func line(_ text: String, generation: Int) {
    guard generation == watchGeneration, !stopped,
          let room = RoomNow.decode(Data(text.utf8)) else { return }
    if let v = room.version, let latest = latestVersion, v < latest { return }
    latestVersion = room.version ?? latestVersion
    set(.live(room))
  }

  private func set(_ new: RoomState) {
    guard new != state else { return }
    let was = state
    state = new
    if Self.kind(was) != Self.kind(new) { logLine("room: \(Self.kind(new))") }
    onChange?()
  }

  private static func kind(_ s: RoomState) -> String {
    switch s {
    case .checking: "checking"
    case .live: "live"
    case .down: "the room service isn't running"
    case .unavailable(let why): why
    case .reconnecting: "reconnecting"
    case .failed(let failure): failure.sentence
    }
  }

  private func pause(_ seconds: Double) async {
    wakeGeneration += 1
    let generation = wakeGeneration
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      wake = continuation
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
        MainActor.assumeIsolated {
          guard let self, self.wakeGeneration == generation else { return }
          self.resumeWake()
        }
      }
    }
  }

  private func resumeWake() {
    wake?.resume()
    wake = nil
  }
}

/// On SIGTERM, SIGINT or SIGHUP: runs `stop`, then dies of the same signal, so launchd sees the
/// exit it would have seen anyway. AppKit doesn't call applicationWillTerminate for a signal
/// (launchctl kickstart -k from build.sh, a logout), and Process starts the watch child in its own
/// process group, so without this the child would outlive the app.
@MainActor
enum Termination {
  private static var sources: [DispatchSourceSignal] = []

  static func onSignal(_ stop: @escaping @MainActor () -> Void) {
    for number in [SIGTERM, SIGINT, SIGHUP] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler {
        MainActor.assumeIsolated { stop() }
        signal(number, SIG_DFL)
        raise(number)
      }
      source.resume()
      sources.append(source)
    }
  }
}

/// A line in the app's log (~/Library/Logs/noahs-mac.log), unbuffered. Never the room's
/// contents: they carry presence and sleep times.
func logLine(_ line: String) {
  FileHandle.standardError.write(Data((line + "\n").utf8))
}

/// What a finished action means for the menu: problems to show, and the new pause when it
/// changed one (`.some(nil)` after a resume).
struct RoomReport: Equatable {
  var problems: [String] = []
  var paused: PausedChange?

  struct PausedChange: Equatable { var value: Paused? }

  static func of(_ action: RoomAction, _ outcome: RoomOutcome, room: RoomNow?) -> RoomReport {
    switch outcome {
    case .down: return RoomReport(problems: ["The room service isn't running, so nothing changed."])
    case .missing(let why): return RoomReport(problems: ["\(why), so nothing changed."])
    case .usage: return RoomReport(problems: ["\(RoomCLI.notInstalled), so nothing changed."])
    case .refused(let why?): return RoomReport(problems: ["noah-os's policy said no: \(why)"])
    case .refused(nil): return RoomReport(problems: ["noah-os's policy said no."])
    case .failed(let why): return RoomReport(problems: [why])
    case .ok(let data): return ok(action, data, room: room)
    }
  }

  private struct Wrapped: Decodable { var result: SceneResult }
  private struct PauseAnswer: Decodable { var paused: Paused? }

  private static func ok(_ action: RoomAction, _ data: Data, room: RoomNow?) -> RoomReport {
    switch action {
    case .scene, .roomOff:
      return RoomReport(problems: sceneProblems(try? Room.decoder.decode(SceneResult.self, from: data), room: room))
    case .leaving, .bed:
      return RoomReport(problems: sceneProblems((try? Room.decoder.decode(Wrapped.self, from: data))?.result, room: room))
    case .pause:
      guard let answer = try? Room.decoder.decode(PauseAnswer.self, from: data), let paused = answer.paused else {
        return RoomReport()
      }
      return RoomReport(paused: PausedChange(value: paused))
    case .resume:
      return RoomReport(paused: PausedChange(value: nil))
    case .openPage:
      return RoomReport()
    }
  }

  /// A light that is unreachable (the fan's wall switch) isn't a problem; one that failed is.
  private static func sceneProblems(_ result: SceneResult?, room: RoomNow?) -> [String] {
    guard let result, !result.ok else { return [] }
    let failed = (result.lights ?? [:]).filter { $0.value == "failed" }.keys.sorted { a, b in
      order(a) < order(b)
    }
    let name = result.scene.map(Room.sceneName) ?? "The scene"
    guard !failed.isEmpty else { return ["\(name) didn't fully work."] }
    let labels = failed.map { key in
      room?.lights?.first { $0.key == key }?.label ?? Room.lightLabels[key] ?? key
    }
    return ["\(name) didn't reach the \(list(labels))."]
  }

  private static func order(_ key: String) -> Int {
    ["bar-left", "bar-right", "fan-desk", "fan-far"].firstIndex(of: key) ?? 99
  }

  private static func list(_ words: [String]) -> String {
    switch words.count {
    case 0: ""
    case 1: words[0]
    case 2: "\(words[0]) or the \(words[1])"
    default: words.dropLast().joined(separator: ", the ") + " or the \(words.last!)"
    }
  }
}
