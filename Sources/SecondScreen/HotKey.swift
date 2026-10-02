import Carbon.HIToolbox

/// A system-wide keyboard shortcut.
///
/// Carbon's hot key API reserves only the one key combination, so unlike an
/// event tap it needs no Input Monitoring permission and never sees other
/// keystrokes.
@MainActor
final class HotKey {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    /// - Parameters:
    ///   - keyCode: a virtual key code such as `kVK_ANSI_M`.
    ///   - modifiers: Carbon modifier flags such as `cmdKey | optionKey`.
    init?(keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
        self.action = action
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                    eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            // Carbon delivers hot keys on the main run loop.
            MainActor.assumeIsolated {
                Unmanaged<HotKey>.fromOpaque(context).takeUnretainedValue().action()
            }
            return noErr
        }, 1, &pressed, context, &handler)
        guard installed == noErr else { return nil }

        let id = EventHotKeyID(signature: OSType(0x3253_4E44), id: 1)  // '2SND'
        guard RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), id,
                                  GetApplicationEventTarget(), 0, &hotKey) == noErr
        else {
            if let handler { RemoveEventHandler(handler) }
            return nil
        }
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }
}
