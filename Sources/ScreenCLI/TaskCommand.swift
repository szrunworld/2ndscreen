import AppKit
import Foundation

/// `2ndscreen task …`: hands the words, untouched, to the task runtime's
/// command line (packages/task-runtime/src/cli.ts, `runCli`), which checks
/// them, makes one call on the runtime's task control and prints one JSON
/// line. This process is replaced by Node with `execv`: no shell sees the
/// words, and the exit status and signals are Node's own.
///
/// The runtime ships inside 2ndscreen.app, never from npx, the PATH or the
/// working directory:
///
///   <runtime>/bin/node   the Node it was built and tested with (>= 22.13)
///   <runtime>/main.mjs   its entry point
///
/// <runtime> is the first that exists of: $SECONDSCREEN_TASK_RUNTIME (an
/// absolute directory, for development and tests), Contents/Resources/
/// task-runtime of the app this executable lives in (following symlinks, so
/// a linked /usr/local/bin/2ndscreen works), and that of the running
/// 2ndscreen.app. $SECONDSCREEN_NODE (absolute) replaces <runtime>/bin/node.
/// Without a runtime, every task command fails with capability_missing.
enum TaskCommand {
    static let commands = ["run", "status", "pause", "resume", "cancel", "artifacts", "inspect-procedure", "bind-account", "agents", "usage",
                           "inbox", "approve", "deny", "answer"]

    static let usage = """
    usage:
      2ndscreen task run SKILL_ID --job TEXT --limit N --output DIR
                     [--source conversations|recommend] [--mode available|original-only]
                     [--browse-limit N] [--deadline ISO_TIME] [--budget FIELD=N]...
                     [--take-over] [--keep-window] [--analysis off|on] [--account ACCOUNT_KEY]
      2ndscreen task status|pause|resume|cancel|artifacts TASK_ID
      2ndscreen task inspect-procedure PROCEDURE_ID
      2ndscreen task bind-account TASK_ID ACCOUNT_KEY
      2ndscreen task agents [--all]
      2ndscreen task usage [--by agent|provider|model|task] [--since ISO_TIME]
      2ndscreen task inbox
      2ndscreen task approve INBOX_ID
      2ndscreen task deny INBOX_ID [--hint HINT]... [--text TEXT]
      2ndscreen task answer INBOX_ID TEXT

    Runs skill tasks such as boss.collect-resumes in the background through the
    task runtime bundled with 2ndscreen.app. Every command prints one JSON line
    and exits 0 when done, 1 when the runtime refuses or fails, 2 on bad words.
    agents lists agent runs, blocked ones first with what they wait for; usage
    sums provider calls, tokens and cost per agent, provider, model or task.
    inbox lists approvals and questions agents wait on; approve, deny and
    answer decide them.
    """

    static func run(_ words: [String]) -> Never {
        let runtime: TaskRuntime
        switch TaskRuntime.locate() {
        case .success(let found):
            runtime = found
        case .failure(let missing):
            if words.isEmpty || words == ["help"] || words.contains("--help") || words.contains("-h") {
                print(usage + "\n\n" + missing.message)
                exit(words.isEmpty ? 2 : 0)
            }
            refuse(words, missing.message)
        }

        // The runtime drives this same CLI for screens and the agent bridge.
        if let me = executableURL() { setenv("SECONDSCREEN_CLI", me.path, 1) }
        // node:sqlite still prints an ExperimentalWarning on Node 22; the command line writes nothing to stderr.
        let argv = [runtime.node.path, "--disable-warning=ExperimentalWarning", runtime.entry.path] + words
        var cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        cArgs.append(nil)
        execv(runtime.node.path, &cArgs)
        refuse(words, "could not start \(runtime.node.path): \(String(cString: strerror(errno)))")
    }

    /// One JSON line saying the runtime is not usable, shaped like runCli's errors.
    private static func refuse(_ words: [String], _ message: String) -> Never {
        let command: Any = words.first.flatMap { commands.contains($0) ? $0 : nil } ?? NSNull()
        let line: [String: Any] = ["ok": false, "command": command,
                                   "error": ["code": "capability_missing", "message": message]]
        let data = (try? JSONSerialization.data(withJSONObject: line, options: [.withoutEscapingSlashes])) ?? Data()
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        exit(1)
    }

    /// This executable with symlinks resolved.
    static func executableURL() -> URL? {
        (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])).resolvingSymlinksInPath()
    }
}

/// Where the bundled task runtime is, if anywhere.
struct TaskRuntime {
    let directory: URL
    let node: URL
    let entry: URL

    struct Missing: Error {
        let message: String
    }

    static let appBundleID = "io.github.szrunworld.2ndscreen"
    static let resourcePath = "Contents/Resources/task-runtime"

    static func locate(environment: [String: String] = ProcessInfo.processInfo.environment,
                       executable: URL? = TaskCommand.executableURL(),
                       runningApps: () -> [URL] = runningAppBundles) -> Result<TaskRuntime, Missing> {
        let fileManager = FileManager.default
        func isDirectory(_ url: URL) -> Bool {
            var directory: ObjCBool = false
            return fileManager.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
        }

        let directory: URL
        if let override = environment["SECONDSCREEN_TASK_RUNTIME"], !override.isEmpty {
            // An explicit choice is used or refused, never silently passed over.
            guard override.hasPrefix("/") else {
                return .failure(Missing(message: "SECONDSCREEN_TASK_RUNTIME must be an absolute directory"))
            }
            let url = URL(fileURLWithPath: override).resolvingSymlinksInPath()
            guard isDirectory(url) else {
                return .failure(Missing(message: "SECONDSCREEN_TASK_RUNTIME \(override) is not a directory"))
            }
            directory = url
        } else {
            var candidates: [URL] = []
            if let app = executable.flatMap(enclosingApp) { candidates.append(app.appendingPathComponent(resourcePath)) }
            candidates += runningApps().map { $0.appendingPathComponent(resourcePath) }
            guard let found = candidates.first(where: isDirectory) else {
                return .failure(Missing(message: "the task runtime is not installed: no \(resourcePath) in the 2ndscreen.app "
                    + "this CLI belongs to or in a running 2ndscreen.app; this build does not include it yet"))
            }
            directory = found
        }

        let node: URL
        if let override = environment["SECONDSCREEN_NODE"], !override.isEmpty {
            guard override.hasPrefix("/"), fileManager.isExecutableFile(atPath: override) else {
                return .failure(Missing(message: "SECONDSCREEN_NODE must be an absolute path to an executable node"))
            }
            node = URL(fileURLWithPath: override)
        } else {
            node = directory.appendingPathComponent("bin/node")
            guard fileManager.isExecutableFile(atPath: node.path) else {
                return .failure(Missing(message: "the task runtime at \(directory.path) has no bin/node"))
            }
        }
        let entry = directory.appendingPathComponent("main.mjs")
        guard fileManager.isReadableFile(atPath: entry.path), !isDirectory(entry) else {
            return .failure(Missing(message: "the task runtime at \(directory.path) has no main.mjs entry"))
        }
        return .success(TaskRuntime(directory: directory, node: node, entry: entry))
    }

    /// The .app holding `executable` at Contents/MacOS or Contents/Resources/bin,
    /// looking at a fixed number of parents and no further.
    static func enclosingApp(of executable: URL) -> URL? {
        var url = executable.deletingLastPathComponent()
        for _ in 0..<4 {
            if url.pathExtension == "app" { return url }
            url = url.deletingLastPathComponent()
        }
        return nil
    }

    static func runningAppBundles() -> [URL] {
        NSRunningApplication.runningApplications(withBundleIdentifier: appBundleID).compactMap(\.bundleURL)
    }
}
