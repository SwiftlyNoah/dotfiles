// The owner portal. It runs as its own service under the nbportal user (the secure-pages
// design in ~/coding/noahbrauner), on 127.0.0.1:4400, and `tailscale serve` puts it at this
// Mac's tailnet name. This app only checks it and opens it; it never serves it. The tailnet
// name is read from Tailscale, never written here, since this repo is public.
import Foundation

struct PortalStatus: Sendable {
  enum Local: Sendable { case unknown, up, down }
  var local: Local = .unknown
  var tailscaleRunning: Bool?
  var host: String? // the tailnet name, without the trailing dot

  var url: URL? {
    guard tailscaleRunning == true, let host else { return nil }
    return URL(string: "https://\(host)/")
  }

  var summary: String {
    switch (local, tailscaleRunning) {
    case (.unknown, _), (_, nil): return "Checking"
    case (.down, _): return "Not responding on this Mac"
    case (.up, false): return "Running, but Tailscale is off"
    case (.up, true):
      let name = host.map { String($0.split(separator: ".").first ?? Substring($0)) } ?? "this Mac"
      return "Running at \(name)"
    }
  }
}

@MainActor
final class Portal {
  private(set) var status = PortalStatus()
  var onChange: (() -> Void)?
  private var checking = false

  func refresh() {
    guard !checking else { return }
    checking = true
    Task {
      let fresh = await Self.check()
      status = fresh
      checking = false
      onChange?()
    }
  }

  nonisolated private static func check() async -> PortalStatus {
    async let local = checkLocal()
    async let tailscale = run("/usr/local/bin/tailscale", ["status", "--json", "--peers=false"])
    var status = PortalStatus()
    status.local = await local ? .up : .down
    if let data = await tailscale,
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      status.tailscaleRunning = json["BackendState"] as? String == "Running"
      if let me = json["Self"] as? [String: Any], let name = me["DNSName"] as? String, !name.isEmpty {
        status.host = name.hasSuffix(".") ? String(name.dropLast()) : name
      }
    } else {
      status.tailscaleRunning = false
    }
    return status
  }

  nonisolated private static func checkLocal() async -> Bool {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:4400/")!)
    request.timeoutInterval = 3
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (_, response) = try? await URLSession.shared.data(for: request),
          let http = response as? HTTPURLResponse else { return false }
    return http.statusCode < 500
  }

  /// Runs a command and returns its output, or nil if it failed.
  nonisolated private static func run(_ path: String, _ args: [String]) async -> Data? {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch {
          continuation.resume(returning: nil)
          return
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        continuation.resume(returning: process.terminationStatus == 0 ? data : nil)
      }
    }
  }
}
