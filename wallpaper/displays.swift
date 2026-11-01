// The connected displays, for build.sh.
//
//   swift displays.swift sizes        each display's size in pixels, one "W H" per line
//   swift displays.swift set <dir>    give each display the wallpaper built for its size
//
// macOS keeps a wallpaper per display, so a display set here keeps its own picture when it is
// unplugged and plugged in again.
import AppKit

func pixels(_ screen: NSScreen) -> (Int, Int) {
  let mode = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID)
    .flatMap { CGDisplayCopyDisplayMode($0) }
  if let mode { return (mode.pixelWidth, mode.pixelHeight) }
  let s = screen.backingScaleFactor
  return (Int(screen.frame.width * s), Int(screen.frame.height * s))
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "sizes":
  for line in Set(NSScreen.screens.map { pixels($0) }.map { "\($0.0) \($0.1)" }).sorted() { print(line) }
case "set" where args.count == 3:
  var failed = false
  for screen in NSScreen.screens {
    let (w, h) = pixels(screen)
    let name = (w, h) == (3024, 1964) ? "lilac-moon-dynamic.heic" : "lilac-moon-dynamic-\(w)x\(h).heic"
    let url = URL(fileURLWithPath: args[2]).appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: url.path) else {
      FileHandle.standardError.write("\(screen.localizedName): no \(name); run ./build.sh \(w) \(h)\n".data(using: .utf8)!)
      failed = true
      continue
    }
    do {
      try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [:])
      print("\(screen.localizedName): \(name)")
    } catch {
      FileHandle.standardError.write("\(screen.localizedName): \(error.localizedDescription)\n".data(using: .utf8)!)
      failed = true
    }
  }
  exit(failed ? 1 : 0)
default:
  FileHandle.standardError.write("usage: swift displays.swift sizes | set <dir>\n".data(using: .utf8)!)
  exit(2)
}
