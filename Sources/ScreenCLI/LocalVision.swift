import Dispatch
import Foundation
import SecondScreenCore

/// `2ndscreen vision`: the task runtime's on-device image helper. It reads
/// one JSON request line from stdin, writes one JSON reply line to stdout
/// and exits 0 (done), 1 (failed) or 2 (invalid request). It only reads
/// image files it is given and writes a compose output; it takes no
/// screenshots, sends no input and calls no model or network.
///
/// main.swift registers it before the help check (A7):
///   if words.first == "vision" { runLocalVision(Array(words.dropFirst())) }
let localVisionUsage = """
usage: 2ndscreen vision < request.json

One JSON request on stdin, one JSON reply on stdout. Rects are image pixels,
origin top-left. Ops: ocr, compare, compose, metadata; see
Sources/SecondScreenCore/LocalVision.swift for fields.
  echo '{"v":1,"op":"ocr","image":"/abs/shot.png","languages":["zh-Hans","en-US"]}' | 2ndscreen vision
"""

/// The partial compose file this process created, to delete if the runtime
/// cancels us with SIGTERM. It is set only once the file is ours.
private final class PartialFile: @unchecked Sendable {
    private let lock = NSLock()
    private var path: String?
    func set(_ value: String?) { lock.lock(); path = value; lock.unlock() }
    func take() -> String? { lock.lock(); defer { lock.unlock() }; return path }
}

func runLocalVision(_ args: [String]) -> Never {
    if args.contains("--help") || args.contains("-h") {
        print(localVisionUsage)
        exit(0)
    }
    guard args.isEmpty else {
        FileHandle.standardError.write(Data("vision takes no arguments; send the request on stdin\n".utf8))
        exit(2)
    }

    let partial = PartialFile()
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler {
        if let path = partial.take() { unlink(path) }
        _exit(143)
    }
    termination.resume()

    let limits = LocalVision.Limits()
    let input = FileHandle.standardInput.readData(ofLength: limits.maxRequestBytes + 1)
    let line = input.split(separator: UInt8(ascii: "\n"), maxSplits: 1, omittingEmptySubsequences: true).first ?? Data()
    let reply = LocalVision.handle(input.count > limits.maxRequestBytes ? input : Data(line), limits: limits,
                                   tempFile: { partial.set($0) })
    FileHandle.standardOutput.write(reply.json + Data("\n".utf8))
    exit(reply.exitCode)
}
