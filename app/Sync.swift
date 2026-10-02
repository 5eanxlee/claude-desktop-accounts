import Foundation

// The session sync installed alongside this app, run the same way its background agent runs it.
struct SyncTool: Equatable {
    let node: String
    let script: String

    static let label = "local.claude-session-sync"
    static var agentPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static func fromAgent(_ plist: URL) -> SyncTool? {
        guard let data = try? Data(contentsOf: plist),
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = object["ProgramArguments"] as? [String], args.count >= 2 else { return nil }
        return SyncTool(node: args[0], script: args[1])
    }

    static func find() -> SyncTool? {
        if let tool = fromAgent(agentPlist), FileManager.default.isExecutableFile(atPath: tool.node) { return tool }
        let installDir = ProcessInfo.processInfo.environment["CDA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-desktop-accounts")
        let script = installDir.appendingPathComponent("sync/bin/claude-session-sync.js").path
        guard FileManager.default.fileExists(atPath: script) else { return nil }
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
        return node.map { SyncTool(node: $0, script: script) }
    }

    static var agentRunning: Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(getuid())/\(label)"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return false }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    func run(_ completion: @escaping (_ summary: String, _ ok: Bool) -> Void) {
        DispatchQueue.global().async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script, "sync"]
            let pipe = Pipe()
            process.standardOutput = pipe; process.standardError = pipe
            do { try process.run() } catch {
                DispatchQueue.main.async { completion("The session sync could not start.", false) }; return
            }
            let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            process.waitUntilExit()
            let ok = process.terminationStatus == 0
            DispatchQueue.main.async { completion(lastLine(output) ?? (ok ? "Sync finished." : "Sync failed."), ok) }
        }
    }
}

func lastLine(_ text: String) -> String? {
    text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
}
