// The Room part of the menu as AppKit items (from RoomMenu in Room.swift), and the moon icon.
import AppKit

@MainActor
enum RoomMenuItems {
  /// The section's items, header first. Each action item sends `selector` to `target`; its
  /// RoomAction is read back with `action(of:)`. `dots` are the scenes' colors (RoomScenes), nil
  /// until `noah room export --public` has answered.
  static func make(_ model: RoomMenu, dots: [String: [String]]?, target: AnyObject, selector: Selector) -> [NSMenuItem] {
    [.sectionHeader(title: model.header)] + model.entries.map { item($0, dots, target, selector) }
  }

  static func action(of item: NSMenuItem) -> RoomAction? {
    (item.representedObject as? Box)?.action
  }

  private static func item(_ entry: RoomEntry, _ dots: [String: [String]]?, _ target: AnyObject, _ selector: Selector) -> NSMenuItem {
    switch entry {
    case .info(let text):
      let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
      item.isEnabled = false
      return item
    case .separator:
      return .separator()
    case .submenu(let title, let entries):
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let sub = NSMenu()
      sub.autoenablesItems = false
      for entry in entries { sub.addItem(self.item(entry, dots, target, selector)) }
      item.submenu = sub
      item.isEnabled = sub.items.contains { $0.action != nil && $0.isEnabled }
      return item
    case .item(let entry):
      let item = NSMenuItem(title: entry.title, action: selector, keyEquivalent: "")
      item.target = target
      item.representedObject = Box(entry.action)
      item.subtitle = entry.subtitle
      item.isEnabled = entry.enabled
      item.state = entry.checked ? .on : .off
      if let hotkey = entry.hotkey {
        item.keyEquivalent = hotkey.letter
        item.keyEquivalentModifierMask = [.control, .option]
      }
      if let key = entry.dot, let dots {
        item.attributedTitle = titled(entry.title, dot: dots[key])
      }
      return item
    }
  }

  /// The menu bar moon for the room's state: a template moon, the bars' color, or filled amber.
  static func moon(_ icon: RoomIcon) -> NSImage? {
    switch icon {
    case .plain:
      let image = NSImage(systemSymbolName: "moon.fill", accessibilityDescription: "Noah's Mac")
      image?.isTemplate = true
      return image
    case .tinted(let hex):
      return symbol("moon.fill", [hex], "Noah's Mac")
    case .windDown:
      // A dark crescent on an amber disk: one palette color alone would fill the crescent too.
      return symbol("moon.circle.fill", [Room.night, Room.amber], "Noah's Mac, wind down")
    }
  }

  private static func symbol(_ name: String, _ hexes: [String], _ description: String) -> NSImage? {
    let config = NSImage.SymbolConfiguration(paletteColors: hexes.map(color))
    let image = NSImage(systemSymbolName: name, accessibilityDescription: description)?.withSymbolConfiguration(config)
    image?.isTemplate = false
    return image
  }

  static func color(_ hex: String) -> NSColor {
    let value = UInt32(hex.dropFirst(), radix: 16) ?? 0xFFFFFF
    return NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255, alpha: 1)
  }

  /// A scene's title after its dot. The dot is in the title, not the item's image, because
  /// macOS 27 draws no images in menu items.
  private static func titled(_ title: String, dot hexes: [String]?) -> NSAttributedString {
    let font = NSFont.menuFont(ofSize: 0)
    let size: CGFloat = 12
    let attachment = NSTextAttachment()
    attachment.image = hexes.map(dot) ?? NSImage(size: NSSize(width: size, height: size))
    attachment.bounds = NSRect(x: 0, y: ((font.capHeight - size) / 2).rounded(), width: size, height: size)
    let text = NSMutableAttributedString(attachment: attachment)
    text.append(NSAttributedString(string: "  \(title)", attributes: [.font: font]))
    return text
  }

  /// A scene's dot: its bars' color (left and right halves when they differ), or an empty ring
  /// for a scene that turns everything off.
  private static func dot(_ hexes: [String]) -> NSImage {
    let colors = hexes.map(color)
    return NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
      let circle = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
      if colors.isEmpty {
        NSColor.secondaryLabelColor.setStroke()
        circle.lineWidth = 1
        circle.stroke()
        return true
      }
      circle.addClip()
      colors[0].setFill()
      rect.fill()
      if colors.count > 1 {
        colors[1].setFill()
        NSRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height).fill()
      }
      return true
    }
  }

  /// Carries a RoomAction on an NSMenuItem.
  private final class Box: NSObject {
    let action: RoomAction
    init(_ action: RoomAction) { self.action = action }
  }
}
