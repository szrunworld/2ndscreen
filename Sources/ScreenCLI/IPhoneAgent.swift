import AppKit
import Foundation
import SecondScreenCore
import TarsAgent

/// `2ndscreen iphone ...`: iPhone Mirroring on an agent screen, used like an
/// Android phone's mirror. Nothing here moves the user's pointer: taps and
/// keys go to the window in the background, and only pasting text brings
/// Mirroring to the front, for about a second.
enum IPhoneCommands {
    /// Screenshot pixels per window point; tap coordinates are in pixels.
    static let pixelsPerPoint: CGFloat = 2

    static let usage = """
        usage:
          2ndscreen iphone show [--screen NAME]
          2ndscreen iphone hide
          2ndscreen iphone screenshot [--screen NAME] --output FILE.png
          2ndscreen iphone tap  [--screen NAME] --x X --y Y
          2ndscreen iphone type [--screen NAME] --text TEXT
          2ndscreen iphone key  [--screen NAME] --key home|switcher|spotlight|return|delete|KEY

        Points are the screenshot's pixels, two to a window point.
        """

    static func run(_ args: Arguments) -> Never {
        let name = args.value("--screen") ?? "phone"
        switch args.positional.dropFirst().first {
        case "show", "setup": show(screen: name)
        case "hide": hide()
        case "screenshot": screenshot(screen: name, args)
        case "tap", "type", "key": act(args.positional[1], screen: name, args)
        default: fail(usage)
        }
    }

    /// Make the agent screen if need be and put iPhone Mirroring on it,
    /// launching it in the background when it is not running.
    private static func show(screen name: String) -> Never {
        do {
            let list = try sendControlRequest(ControlRequest(command: .screenList))
            if !(list.screens ?? []).contains(where: { $0.name == name }) {
                var create = ControlRequest(command: .screenCreate)
                create.screen = name
                // Holds iPhone Mirroring's largest window and its menu bar
                // at HiDPI; --fit-screen then follows the window.
                create.width = 525
                create.height = 1001
                create.hiDPI = true
                create.idleTimeout = 0
                let created = try sendControlRequest(create)
                guard created.ok else { fail(created.error ?? "screen create failed") }
            }
            var place: ControlRequest
            if let pid = try? IPhoneAgentScreen.pid() {
                place = ControlRequest(command: .windowMove)
                place.pid = pid
            } else {
                place = ControlRequest(command: .appLaunch)
                place.bundleID = IPhoneAgentScreen.bundleID
            }
            place.screen = name
            place.fitScreen = true
            let response = try sendControlRequest(place)
            var output: [String: Any] = ["ok": response.ok, "screen": name]
            if let error = response.error { output["error"] = error }
            DriverCommands.emit(output)
            exit(response.ok ? 0 : 1)
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }

    /// Quit iPhone Mirroring, which hands the phone back to its owner.
    private static func hide() -> Never {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: IPhoneAgentScreen.bundleID)
        apps.forEach { $0.terminate() }
        DriverCommands.emit(["ok": true, "quit": !apps.isEmpty])
        exit(0)
    }

    private static func screenshot(screen name: String, _ args: Arguments) -> Never {
        guard let output = args.value("--output") else { fail("iphone screenshot needs --output FILE.png") }
        do {
            let phone = IPhoneAgentScreen(screen: name)
            let frame = try phone.frame()
            let size = CGSize(width: frame.width * pixelsPerPoint, height: frame.height * pixelsPerPoint)
            try phone.screenshot(size: size).write(to: URL(fileURLWithPath: output))
            DriverCommands.emit(["ok": true, "output": URL(fileURLWithPath: output).path,
                                 "width": Int(size.width), "height": Int(size.height)])
            exit(0)
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }

    private static func act(_ verb: String, screen name: String, _ args: Arguments) -> Never {
        var action: InputAction
        switch verb {
        case "tap":
            guard let x = args.value("--x").flatMap(Double.init), let y = args.value("--y").flatMap(Double.init)
            else { fail("iphone tap needs --x and --y") }
            action = InputAction(.click)
            action.x = x
            action.y = y
        case "type":
            guard let text = args.value("--text") else { fail("iphone type needs --text") }
            action = InputAction(.type)
            action.value = text
        default:
            guard let key = args.value("--key") else { fail("iphone key needs --key") }
            action = InputAction(.key)
            // Mirroring's View menu: Home Screen ⌘1, App Switcher ⌘2, Spotlight ⌘3.
            switch key.lowercased() {
            case "home": action.key = "home"
            case "switcher", "recents": action.key = "2"; action.modifiers = ["cmd"]
            case "spotlight", "search": action.key = "3"; action.modifiers = ["cmd"]
            case "enter": action.key = "return"
            default: action.key = key.lowercased()
            }
        }
        do {
            let phone = IPhoneAgentScreen(screen: name)
            let frame = try phone.frame()
            if let x = action.x, let y = action.y {
                let point = CGPoint(x: x / pixelsPerPoint, y: y / pixelsPerPoint)
                guard point.x >= 0, point.y >= 0, point.x < frame.width, point.y < frame.height else {
                    fail("(\(Int(x)), \(Int(y))) is outside the \(Int(frame.width * pixelsPerPoint))x"
                        + "\(Int(frame.height * pixelsPerPoint)) screenshot", code: 1)
                }
                action.x = frame.minX + point.x
                action.y = frame.minY + point.y
            }
            finish(try phone.perform(action))
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }
}
