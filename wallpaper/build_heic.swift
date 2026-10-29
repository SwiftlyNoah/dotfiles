// Pack rendered frames into a macOS dynamic wallpaper (sun position, "solar" metadata).
//
//   swift build_heic.swift <out.heic> <dark index> <light index> <alt,az> <frame.png> [<alt,az> <frame.png> ...]
//
// The first image carries an XMP property apple_desktop:solar: a base64 binary plist
// {si: [{i: frame index, a: sun altitude, z: sun azimuth from north}], ap: {d: dark frame, l: light frame}}.
// macOS then lists the file under Dynamic wallpapers and shows the frame nearest the sun's
// real position for this Mac's location, so it follows sunrise and sunset through the year.

import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 6, (args.count - 4) % 2 == 0,
      let dark = Int(args[2]), let light = Int(args[3]) else {
    fail("usage: build_heic.swift <out.heic> <dark index> <light index> <alt,az> <frame.png> ...")
}
let out = URL(fileURLWithPath: args[1])
var suns: [(altitude: Double, azimuth: Double)] = []
var frames: [URL] = []
for k in stride(from: 4, to: args.count, by: 2) {
    let sun = args[k].split(separator: ",").compactMap { Double($0) }
    guard sun.count == 2 else { fail("bad sun position \(args[k])") }
    suns.append((sun[0], sun[1]))
    frames.append(URL(fileURLWithPath: args[k + 1]))
}

let info: [String: Any] = [
    "si": suns.enumerated().map { ["i": $0.offset, "a": $0.element.altitude, "z": $0.element.azimuth] as [String: Any] },
    "ap": ["d": dark, "l": light],
]
let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0)

let meta = CGImageMetadataCreateMutable()
var error: Unmanaged<CFError>?
guard CGImageMetadataRegisterNamespaceForPrefix(
    meta, "http://ns.apple.com/namespace/1.0/" as CFString, "apple_desktop" as CFString, &error) else {
    fail("could not register the apple_desktop namespace")
}
guard CGImageMetadataSetValueWithPath(meta, nil, "apple_desktop:solar" as CFString,
                                      plist.base64EncodedString() as CFString) else {
    fail("could not set apple_desktop:solar")
}

guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.heic.identifier as CFString, frames.count, nil) else {
    fail("could not create \(out.path)")
}
let options = [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary
for (i, url) in frames.enumerated() {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        fail("could not read \(url.path)")
    }
    if i == 0 {
        CGImageDestinationAddImageAndMetadata(dest, image, meta, options)
    } else {
        CGImageDestinationAddImage(dest, image, options)
    }
}
guard CGImageDestinationFinalize(dest) else { fail("could not write \(out.path)") }
print("\(out.path): \(frames.count) frames, dark \(dark), light \(light)")
