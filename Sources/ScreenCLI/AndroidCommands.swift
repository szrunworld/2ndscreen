import Foundation
import SecondScreenCore

/// `2ndscreen android ...`: connect Android phones over Wi-Fi, mirror them
/// in a window (on an agent screen if asked), and run the bundled adb.
enum AndroidCommands {
    static func run(_ words: [String]) -> Never {
        let subcommand = words.first ?? ""
        ADB.startServer = startServerInApp
        startServerInApp()
        // Everything after `adb` goes to adb untouched, including its own flags.
        if subcommand == "adb" {
            execADB(Array(words.dropFirst()))
        }
        if words.contains("--help") || words.contains("-h") {
            print(usage)
            exit(0)
        }
        let args = Arguments(Array(words.dropFirst()))
        switch subcommand {
        case "devices":
            var request = ControlRequest(command: .androidList)
            request.serial = args.value("--serial")
            do {
                finish(try sendControlRequest(request))
            } catch ControlClientError.notRunning {
                // Listing needs only adb, not the app.
                finish(adbResponse {
                    var response = ControlResponse()
                    response.android = try ADB.devices().map {
                        AndroidDeviceInfo(serial: $0.serial, state: $0.state, model: $0.model, mirroring: false)
                    }
                    return response
                })
            } catch {
                fail(error.localizedDescription, code: 1)
            }
        case "pair":
            guard args.positional.count == 2 else { fail("usage: 2ndscreen android pair HOST:PORT CODE") }
            finish(adbResponse { output(try ADB.pair(address: args.positional[0], code: args.positional[1])) })
        case "connect":
            guard args.positional.count == 1 else { fail("usage: 2ndscreen android connect HOST:PORT") }
            finish(adbResponse { output(try ADB.connect(address: args.positional[0])) })
        case "disconnect":
            finish(adbResponse { output(try ADB.run(["disconnect"] + args.positional)) })
        case "show":
            var request = ControlRequest(command: .androidShow)
            request.serial = args.value("--serial")
            request.screen = args.value("--screen")
            if let size = args.value("--max-size") {
                guard let pixels = Int(size), pixels >= 0 else { fail("--max-size takes pixels, or 0 for full size") }
                request.maxSize = pixels
            }
            send(request)
        case "screenshot", "tap", "swipe", "type", "key":
            send(action(subcommand, args))
        case "hide":
            var request = ControlRequest(command: .androidHide)
            request.serial = args.value("--serial")
            send(request)
        default:
            fail("unknown android command\n\n" + usage)
        }
    }

    /// The adb server, not this client, makes the connections to phones, and
    /// macOS lets a process reach the local network only with the Local
    /// Network permission of the app responsible for it. Started from a
    /// terminal, the server would answer to the terminal's permission and
    /// fail with "No route to host"; started by 2ndscreen.app, it has the
    /// app's. Ask the app to start it before running adb here.
    private static func startServerInApp() {
        _ = try? sendControlRequest(ControlRequest(command: .androidList), timeout: 15)
    }

    private static func action(_ verb: String, _ args: Arguments) -> ControlRequest {
        func number(_ flag: String) -> Double {
            guard let value = args.value(flag).flatMap(Double.init) else { fail("android \(verb) needs \(flag)") }
            return value
        }
        var request: ControlRequest
        switch verb {
        case "screenshot":
            request = ControlRequest(command: .androidScreenshot)
            guard let output = args.value("--output") else { fail("android screenshot needs --output FILE.png") }
            request.output = URL(fileURLWithPath: output).path  // the app runs elsewhere
        case "tap":
            request = ControlRequest(command: .androidTap)
            request.x = number("--x")
            request.y = number("--y")
        case "swipe":
            request = ControlRequest(command: .androidSwipe)
            request.x = number("--x")
            request.y = number("--y")
            request.toX = number("--to-x")
            request.toY = number("--to-y")
            request.duration = args.value("--duration").flatMap(Double.init)
        case "type":
            request = ControlRequest(command: .androidType)
            guard let text = args.value("--text") else { fail("android type needs --text") }
            request.text = text
        default:
            request = ControlRequest(command: .androidKey)
            guard let key = args.value("--key") else { fail("android key needs --key") }
            request.key = key
        }
        request.serial = args.value("--serial")
        return request
    }

    private static func output(_ result: ADB.Result) -> ControlResponse {
        var response = result.ok ? ControlResponse() : .failure(result.message)
        response.output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        return response
    }

    private static func adbResponse(_ work: () throws -> ControlResponse) -> ControlResponse {
        do {
            return try work()
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    private static func send(_ request: ControlRequest) -> Never {
        do {
            finish(try sendControlRequest(request))
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }

    /// Replace this process with adb, so its output, binary or not, and its
    /// exit status are adb's own.
    private static func execADB(_ arguments: [String]) -> Never {
        guard let adb = ADB.executable() else { fail(ADB.Failure.notFound.localizedDescription, code: 1) }
        let argv = ([adb.path] + arguments).map { strdup($0) } + [nil]
        execv(adb.path, argv)
        fail("could not run \(adb.path): \(String(cString: strerror(errno)))", code: 1)
    }
}

func finish(_ response: ControlResponse) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    print(String(data: try! encoder.encode(response), encoding: .utf8)!)
    exit(response.ok ? 0 : 1)
}
