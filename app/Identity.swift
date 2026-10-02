import Foundation

struct Identity: Equatable {
    let account: String
    let org: String
}

// Claude Desktop logs this when an account finishes loading its Code sessions.
private let initPattern = try! NSRegularExpression(
    pattern: #"\[LocalSessionManager\] Initialization succeeded — accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})"#)

func identityFromLog(_ text: String) -> Identity? {
    let range = NSRange(text.startIndex..., in: text)
    guard let match = initPattern.matches(in: text, range: range).last,
          let account = Range(match.range(at: 1), in: text), let org = Range(match.range(at: 2), in: text) else { return nil }
    return Identity(account: String(text[account]), org: String(text[org]))
}

func logSize(_ log: URL) -> UInt64 {
    ((try? FileManager.default.attributesOfItem(atPath: log.path))?[.size] as? NSNumber)?.uint64Value ?? 0
}

// Only what was written after `offset`: used to confirm the account Claude loads after a relaunch.
func identityAfter(log: URL, offset: UInt64) -> Identity? {
    guard let handle = try? FileHandle(forReadingFrom: log) else { return nil }
    defer { try? handle.close() }
    guard (try? handle.seek(toOffset: offset)) != nil, let data = try? handle.readToEnd() else { return nil }
    return identityFromLog(String(decoding: data, as: UTF8.self))
}

func readIdentity(log: URL, tailBytes: UInt64 = 512 * 1024) -> Identity? {
    let size = logSize(log)
    if let found = identityAfter(log: log, offset: size > tailBytes ? size - tailBytes : 0) { return found }
    return size > tailBytes ? identityAfter(log: log, offset: 0) : nil
}
