import AppKit
import Foundation
import SecondScreenCore
import TarsAgent

/// `2ndscreen iphone setup`: an agent screen with iPhone Mirroring on it,
/// kept sized to its window (it turns landscape with the phone's videos).
enum IPhoneCommands {
    static func run(_ args: Arguments) -> Never {
        guard args.positional.dropFirst().first == "setup" else {
            fail("usage: 2ndscreen iphone setup [--screen NAME]")
        }
        let name = args.value("--screen") ?? "phone"
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
            fail(error.localizedDescription)
        }
    }
}
