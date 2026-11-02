// AirDrop's Wi-Fi link (the awdl0 interface) stays down, because it pulls the radio off the
// network every few seconds and freezes video calls. The root job awdl-guard
// (configuration.nix) brings it up only until the time written in `allow-until`, the same
// file home/bin/airdrop writes.
import Foundation

enum AirDrop {
  static let file = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/awdl-guard/allow-until")

  /// When the open window ends, or nil when AirDrop is meant to be off.
  static func openUntil() -> Date? {
    guard let text = try? String(contentsOf: file, encoding: .utf8),
          let seconds = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    let end = Date(timeIntervalSince1970: TimeInterval(seconds))
    return end > .now ? end : nil
  }

  static func turnOn(minutes: Int) -> [String] {
    write(Int(Date.now.timeIntervalSince1970) + minutes * 60)
  }

  static func turnOff() -> [String] {
    write(0)
  }

  private static func write(_ seconds: Int) -> [String] {
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try "\(seconds)\n".write(to: file, atomically: true, encoding: .utf8)
      return []
    } catch {
      return ["Couldn't write \(file.path): \(error.localizedDescription)"]
    }
  }

  /// Whether awdl0 is up right now, read from the interface flags (no process).
  static var isUp: Bool {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0 else { return false }
    defer { freeifaddrs(head) }
    var cursor = head
    while let entry = cursor {
      if String(cString: entry.pointee.ifa_name) == "awdl0" {
        return entry.pointee.ifa_flags & UInt32(IFF_UP) != 0
      }
      cursor = entry.pointee.ifa_next
    }
    return false
  }
}
