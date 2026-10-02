import Foundation

struct SavedAccount: Codable, Equatable {
    let accountId: String
    let orgId: String
    var email: String?
    var orgName: String?
    var savedAt: Double
    var signIn: SignIn

    var label: String { email ?? "Account \(accountId.prefix(8))" }
}

private let uuidPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
func isUUID(_ text: String) -> Bool {
    uuidPattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

// One private file per account. The sign-in inside is still encrypted with Claude's own key.
final class Store {
    let root: URL
    var accountsDir: URL { root.appendingPathComponent("accounts") }

    init(root: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude Accounts")) {
        self.root = root
    }

    func file(_ accountId: String) -> URL { accountsDir.appendingPathComponent("\(accountId).json") }

    func save(_ account: SavedAccount) throws {
        guard isUUID(account.accountId) else { throw AccountError(message: "That account id is not valid.") }
        try writePrivate(JSONEncoder().encode(account), to: file(account.accountId))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }

    func load(_ accountId: String) -> SavedAccount? {
        guard isUUID(accountId), let data = try? Data(contentsOf: file(accountId)) else { return nil }
        return try? JSONDecoder().decode(SavedAccount.self, from: data)
    }

    func all() -> [SavedAccount] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: accountsDir.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.compactMap { load(String($0.dropLast(5))) }.sorted {
            switch ($0.email?.lowercased(), $1.email?.lowercased()) {
            case let (a?, b?): return a < b
            case (.some, .none): return true
            case (.none, .some): return false
            default: return $0.accountId < $1.accountId
            }
        }
    }

    func remove(_ accountId: String) throws {
        guard isUUID(accountId) else { return }
        try? FileManager.default.removeItem(at: file(accountId))
    }
}

func writePrivate(_ data: Data, to url: URL) throws {
    let fm = FileManager.default
    let dir = url.deletingLastPathComponent()
    try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
    try data.write(to: url, options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
