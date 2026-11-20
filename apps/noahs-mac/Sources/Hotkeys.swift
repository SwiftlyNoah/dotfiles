// Global hotkeys (⌃⌥ plus a letter), through Carbon's RegisterEventHotKey, which needs no
// Accessibility permission. Each press runs its handler on the main thread.
import Carbon.HIToolbox

@MainActor
enum Hotkeys {
  private static var handlers: [UInt32: () -> Void] = [:]
  private static var refs: [EventHotKeyRef] = []
  private static var installed = false
  private static let signature: OSType = 0x4E_4D_61_63 // "NMac"

  private static let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
  ]

  /// Registers ⌃⌥ plus `hotkey`'s letter. Returns false when the chord can't be had (another app
  /// holds it).
  @discardableResult
  static func register(_ hotkey: Hotkey, _ handler: @escaping () -> Void) -> Bool {
    installHandler()
    guard let code = keyCodes[hotkey.letter] else { return false }
    let id = UInt32(handlers.count + 1)
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(
      UInt32(code), UInt32(controlKey | optionKey), EventHotKeyID(signature: signature, id: id),
      GetApplicationEventTarget(), 0, &ref)
    guard status == noErr, let ref else {
      logLine("hotkeys: \(hotkey.glyphs) is taken (\(status))")
      return false
    }
    refs.append(ref)
    handlers[id] = handler
    return true
  }

  private static func installHandler() {
    guard !installed else { return }
    installed = true
    var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var id = EventHotKeyID()
      let status = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
        MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard status == noErr else { return status }
      let key = id.id
      MainActor.assumeIsolated { Hotkeys.handlers[key]?() }
      return noErr
    }, 1, &pressed, nil, nil)
  }
}
