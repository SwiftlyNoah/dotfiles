// Makes Finder's sidebar Favorites exactly the folders given, in that order (home.nix runs it
// with `sidebarFolders` from your own settings). A leading ~ means the home folder. Folders that
// don't exist yet are skipped, a list that already matches is left untouched, and with no
// folders at all it changes nothing. Finder shows the change at once, without a restart.
//
//   swift finder-sidebar.swift /Applications ~/Desktop ~/Downloads ~/Documents
import CoreServices
import Foundation

let wanted = CommandLine.arguments.dropFirst()
  .map { NSString(string: $0).expandingTildeInPath }
  .map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL }
  .filter { FileManager.default.fileExists(atPath: $0.path) }
if wanted.isEmpty { exit(0) }
let wantedPaths = wanted.map(\.path)

guard
  let list = LSSharedFileListCreate(
    nil, kLSSharedFileListFavoriteItems.takeUnretainedValue(), nil)?.takeRetainedValue()
else {
  FileHandle.standardError.write("finder-sidebar: can't open the Favorites list\n".data(using: .utf8)!)
  exit(1)
}

// The list's folder items, each with its path (special items such as AirDrop have none).
func folders() -> [(item: LSSharedFileListItem, path: String)] {
  var seed: UInt32 = 0
  let items = LSSharedFileListCopySnapshot(list, &seed)?.takeRetainedValue() as? [LSSharedFileListItem] ?? []
  let flags = UInt32(kLSSharedFileListNoUserInteraction | kLSSharedFileListDoNotMountVolumes)
  return items.compactMap { item in
    guard let url = LSSharedFileListItemCopyResolvedURL(item, flags, nil)?.takeRetainedValue() as URL?,
      url.isFileURL
    else { return nil }
    return (item, url.standardizedFileURL.path)
  }
}

let current = folders()
if current.map(\.path) == wantedPaths { exit(0) }

for (item, path) in current where !wantedPaths.contains(path) {
  LSSharedFileListItemRemove(list, item)
}
// Inserting a folder that is already in the list moves it, keeping its own name and icon. The
// "before the first item" position is the raw pointer 1, which Swift must not retain, so the
// insert is called through a C signature that takes the position as a plain pointer.
typealias Insert = @convention(c) (
  LSSharedFileList, OpaquePointer?, CFString?, IconRef?, CFURL, CFDictionary?, CFArray?
) -> Unmanaged<LSSharedFileListItem>?
let insert = unsafeBitCast(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "LSSharedFileListInsertItemURL"), to: Insert.self)
var after = OpaquePointer(kLSSharedFileListItemBeforeFirst.toOpaque())
var added: [LSSharedFileListItem] = []  // keeps each item alive while the next goes after it
for url in wanted {
  guard let item = insert(list, after, nil, nil, url as CFURL, nil, nil)?.takeRetainedValue() else {
    FileHandle.standardError.write("finder-sidebar: can't add \(url.path)\n".data(using: .utf8)!)
    exit(1)
  }
  added.append(item)
  after = OpaquePointer(Unmanaged.passUnretained(item).toOpaque())
}
