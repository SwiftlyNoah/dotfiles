// The Lilac Moon wallpaper (wallpaper/ in this repo). Each display has a dynamic HEIC built
// for its size in ~/Pictures/Wallpapers, whose frames follow the sun. "Hold" pulls one frame
// out of that file as a still and sets it; "Follow the Sun" sets the HEIC again. The frame
// names and times come from wallpaper/frames.py through frames.json, which build.sh writes.
import AppKit
import ImageIO
import UniformTypeIdentifiers

struct Frame: Decodable, Sendable {
  let name: String
  let time: String // "17:45"

  var clockTime: String {
    let parts = time.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2,
          let date = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: .now)
    else { return time }
    return date.formatted(date: .omitted, time: .shortened)
  }
}

enum Wallpaper {
  enum Choice: Equatable { case sun, frame(Int), other }

  static let frames: [Frame] = {
    guard let url = Bundle.main.url(forResource: "frames", withExtension: "json"),
          let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([Frame].self, from: data)) ?? []
  }()

  private static let built = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Pictures/Wallpapers")
  private static let held = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/Noah's Mac/Wallpaper")

  // The same sizes and names as wallpaper/displays.swift.
  private static func pixels(_ screen: NSScreen) -> (Int, Int) {
    let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    if let id, let mode = CGDisplayCopyDisplayMode(id) { return (mode.pixelWidth, mode.pixelHeight) }
    let s = screen.backingScaleFactor
    return (Int(screen.frame.width * s), Int(screen.frame.height * s))
  }

  private static func dynamic(for screen: NSScreen) -> URL {
    let (w, h) = pixels(screen)
    let name = (w, h) == (3024, 1964) ? "lilac-moon-dynamic.heic" : "lilac-moon-dynamic-\(w)x\(h).heic"
    return built.appending(path: name)
  }

  /// What the main display shows now.
  @MainActor static func current() -> Choice {
    guard let screen = NSScreen.main, let url = NSWorkspace.shared.desktopImageURL(for: screen) else { return .other }
    let name = url.lastPathComponent
    if name.hasPrefix("lilac-moon-dynamic") && name.hasSuffix(".heic") { return .sun }
    if url.deletingLastPathComponent().standardizedFileURL.path == held.standardizedFileURL.path,
       let index = name.split(separator: "-").last?.split(separator: ".").first.flatMap({ Int($0) }) {
      return .frame(index)
    }
    return .other
  }

  @MainActor static func followSun() -> [String] {
    var problems: [String] = []
    for screen in NSScreen.screens {
      let url = dynamic(for: screen)
      guard FileManager.default.fileExists(atPath: url.path) else {
        problems.append("\(screen.localizedName): no \(url.lastPathComponent) yet. Run ~/.dotfiles/wallpaper/new-displays.sh.")
        continue
      }
      do { try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [:]) } catch {
        problems.append("\(screen.localizedName): \(error.localizedDescription)")
      }
    }
    return problems
  }

  @MainActor static func hold(frame index: Int) -> [String] {
    var problems: [String] = []
    for screen in NSScreen.screens {
      let source = dynamic(for: screen)
      let (w, h) = pixels(screen)
      let still = held.appending(path: String(format: "%dx%d-%02d.png", w, h, index))
      do {
        if !FileManager.default.fileExists(atPath: still.path) {
          try extract(index, from: source, to: still)
        }
        try NSWorkspace.shared.setDesktopImageURL(still, for: screen, options: [:])
      } catch {
        problems.append("\(screen.localizedName): \(error.localizedDescription)")
      }
    }
    return problems
  }

  private static func extract(_ index: Int, from heic: URL, to png: URL) throws {
    guard let source = CGImageSourceCreateWithURL(heic as CFURL, nil),
          index < CGImageSourceGetCount(source),
          let image = CGImageSourceCreateImageAtIndex(source, index, nil) else {
      throw problem("Couldn't read frame \(index) of \(heic.lastPathComponent).")
    }
    try FileManager.default.createDirectory(at: png.deletingLastPathComponent(), withIntermediateDirectories: true)
    let temp = png.deletingLastPathComponent().appending(path: ".\(png.lastPathComponent)")
    guard let out = CGImageDestinationCreateWithURL(temp as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw problem("Couldn't write \(png.path).")
    }
    CGImageDestinationAddImage(out, image, nil)
    guard CGImageDestinationFinalize(out) else { throw problem("Couldn't write \(png.path).") }
    _ = try? FileManager.default.removeItem(at: png)
    try FileManager.default.moveItem(at: temp, to: png)
  }

  /// A small picture of each frame for the menu, from the built-in display's wallpaper.
  @MainActor static func thumbnails(height: CGFloat) -> [Int: NSImage] {
    let heic = built.appending(path: "lilac-moon-dynamic.heic")
    guard let source = CGImageSourceCreateWithURL(heic as CFURL, nil) else { return [:] }
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(height * 1.6 * scale),
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    var result: [Int: NSImage] = [:]
    for i in 0..<min(CGImageSourceGetCount(source), frames.count) {
      guard let cg = CGImageSourceCreateThumbnailAtIndex(source, i, options as CFDictionary) else { continue }
      let width = height * CGFloat(cg.width) / CGFloat(cg.height)
      result[i] = rounded(NSImage(cgImage: cg, size: NSSize(width: width, height: height)))
    }
    return result
  }

  private static func rounded(_ image: NSImage) -> NSImage {
    NSImage(size: image.size, flipped: false) { rect in
      NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).addClip()
      image.draw(in: rect)
      return true
    }
  }

  private static func problem(_ text: String) -> NSError {
    NSError(domain: "NoahsMac", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
  }
}
