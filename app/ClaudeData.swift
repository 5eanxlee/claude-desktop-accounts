import Foundation
import SQLite3

struct ClaudePaths {
    let config: URL
    let cookies: URL
    let log: URL

    static let live: ClaudePaths = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let data = home.appendingPathComponent("Library/Application Support/Claude")
        return ClaudePaths(config: data.appendingPathComponent("config.json"),
                           cookies: data.appendingPathComponent("Cookies"),
                           log: home.appendingPathComponent("Library/Logs/Claude/main.log"))
    }()
}

// One SQLite value, kept exactly: integers as strings because cookie timestamps exceed 2^53.
enum CookieValue: Codable, Equatable {
    case integer(String), real(String), text(String), blob(Data), null

    private enum Key: String, CodingKey { case i, r, s, b, n }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        if let v = try c.decodeIfPresent(String.self, forKey: .i) { self = .integer(v) }
        else if let v = try c.decodeIfPresent(String.self, forKey: .r) { self = .real(v) }
        else if let v = try c.decodeIfPresent(String.self, forKey: .s) { self = .text(v) }
        else if let v = try c.decodeIfPresent(Data.self, forKey: .b) { self = .blob(v) }
        else { self = .null }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .integer(let v): try c.encode(v, forKey: .i)
        case .real(let v): try c.encode(v, forKey: .r)
        case .text(let v): try c.encode(v, forKey: .s)
        case .blob(let v): try c.encode(v, forKey: .b)
        case .null: try c.encode(true, forKey: .n)
        }
    }
    var text: String? { if case .text(let v) = self { return v }; return nil }
    var blob: Data? { if case .blob(let v) = self { return v }; return nil }
}

typealias CookieRow = [String: CookieValue]

let signInKeys = ["oauth:tokenCache", "oauth:tokenCacheV2", "lastKnownAccountUuid"]
private let hostList = "'claude.ai','.claude.ai'"

// Everything that makes Claude Desktop signed in as one account, still encrypted as Claude stored it.
struct SignIn: Codable, Equatable {
    var config: [String: String]
    var cookieSchema: Int
    var cookies: [CookieRow]

    var accountId: String? { config["lastKnownAccountUuid"] }
    var hasTokens: Bool { config["oauth:tokenCacheV2"] != nil || config["oauth:tokenCache"] != nil }
    var hasSessionKey: Bool { cookies.contains { $0["name"]?.text == "sessionKey" } }
}

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private func open(_ url: URL, write: Bool) throws -> OpaquePointer {
    var db: OpaquePointer?
    let flags = (write ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY) | SQLITE_OPEN_NOMUTEX
    guard sqlite3_open_v2(url.path, &db, flags, nil) == SQLITE_OK, let db else {
        if db != nil { sqlite3_close(db) }
        throw AccountError(message: "Claude's cookie database could not be opened.")
    }
    sqlite3_busy_timeout(db, 2000)
    return db
}

private func query(_ db: OpaquePointer, _ sql: String) throws -> [CookieRow] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
        throw AccountError(message: "Claude's cookie database has an unexpected format.")
    }
    defer { sqlite3_finalize(statement) }
    var rows: [CookieRow] = []
    var result = sqlite3_step(statement)
    while result == SQLITE_ROW {
        var row: CookieRow = [:]
        for i in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, i))
            switch sqlite3_column_type(statement, i) {
            case SQLITE_INTEGER: row[name] = .integer(String(sqlite3_column_int64(statement, i)))
            case SQLITE_FLOAT: row[name] = .real(String(sqlite3_column_double(statement, i)))
            case SQLITE_TEXT: row[name] = .text(String(cString: sqlite3_column_text(statement, i)))
            case SQLITE_BLOB:
                let count = Int(sqlite3_column_bytes(statement, i))
                row[name] = .blob(count == 0 ? Data() : Data(bytes: sqlite3_column_blob(statement, i), count: count))
            default: row[name] = .null
            }
        }
        rows.append(row)
        result = sqlite3_step(statement)
    }
    guard result == SQLITE_DONE else { throw AccountError(message: "Claude's cookie database is busy. Try again.") }
    return rows
}

private func schemaVersion(_ db: OpaquePointer) throws -> Int {
    guard let value = try query(db, "SELECT value FROM meta WHERE key='version'").first?["value"]?.text, let version = Int(value) else {
        throw AccountError(message: "Claude's cookie database has no version.")
    }
    return version
}

func readSignIn(_ paths: ClaudePaths) throws -> SignIn {
    guard let config = (try? JSONSerialization.jsonObject(with: Data(contentsOf: paths.config))) as? [String: Any] else {
        throw AccountError(message: "Claude's settings file could not be read.")
    }
    let db = try open(paths.cookies, write: false)
    defer { sqlite3_close(db) }
    let cookies = try query(db, "SELECT * FROM cookies WHERE host_key IN (\(hostList)) ORDER BY host_key, name, path")
    return SignIn(config: config.compactMapValues { $0 as? String }.filter { signInKeys.contains($0.key) },
                  cookieSchema: try schemaVersion(db), cookies: cookies)
}

// Replaces the claude.ai cookies in one transaction; any failure leaves the table as it was.
func writeCookies(_ signIn: SignIn, _ paths: ClaudePaths) throws {
    let db = try open(paths.cookies, write: true)
    defer { sqlite3_close(db) }
    guard try schemaVersion(db) == signIn.cookieSchema else {
        throw AccountError(message: "Claude changed its cookie format since this account was saved. Sign in to it again and save it.")
    }
    let columns = Set(try query(db, "PRAGMA table_info(cookies)").compactMap { $0["name"]?.text })
    guard signIn.cookies.allSatisfy({ Set($0.keys).isSubset(of: columns) }) else {
        throw AccountError(message: "Claude changed its cookie format since this account was saved. Sign in to it again and save it.")
    }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else {
        throw AccountError(message: "Claude's cookie database is busy. Nothing was changed.")
    }
    var committed = false
    defer { if !committed { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) } }
    guard sqlite3_exec(db, "DELETE FROM cookies WHERE host_key IN (\(hostList))", nil, nil, nil) == SQLITE_OK else {
        throw AccountError(message: "The current sign-in cookies could not be replaced.")
    }
    for row in signIn.cookies {
        let names = row.keys.sorted()
        let sql = "INSERT INTO cookies (\(names.map { "\"\($0)\"" }.joined(separator: ","))) VALUES (\(names.map { _ in "?" }.joined(separator: ",")))"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw AccountError(message: "The saved sign-in cookies could not be written.")
        }
        defer { sqlite3_finalize(statement) }
        for (index, name) in names.enumerated() {
            let position = Int32(index + 1)
            switch row[name]! {
            case .integer(let v): sqlite3_bind_int64(statement, position, Int64(v) ?? 0)
            case .real(let v): sqlite3_bind_double(statement, position, Double(v) ?? 0)
            case .text(let v): sqlite3_bind_text(statement, position, v, -1, transient)
            case .blob(let v): _ = v.withUnsafeBytes { sqlite3_bind_blob(statement, position, $0.baseAddress, Int32(v.count), transient) }
            case .null: sqlite3_bind_null(statement, position)
            }
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw AccountError(message: "The saved sign-in cookies could not be written.")
        }
    }
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
        throw AccountError(message: "The saved sign-in cookies could not be written.")
    }
    committed = true
}

// Replaces only the sign-in entries; every other setting is kept. Written to a temp file and renamed.
func writeConfig(_ entries: [String: String], _ paths: ClaudePaths) throws {
    guard var config = (try? JSONSerialization.jsonObject(with: Data(contentsOf: paths.config))) as? [String: Any] else {
        throw AccountError(message: "Claude's settings file could not be read.")
    }
    for key in signInKeys { config[key] = entries[key] }
    let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .withoutEscapingSlashes])
    let mode = (try? FileManager.default.attributesOfItem(atPath: paths.config.path))?[.posixPermissions] as? Int ?? 0o600
    let temp = paths.config.deletingLastPathComponent().appendingPathComponent(".config.json.\(UUID().uuidString).tmp")
    guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: mode]) else {
        throw AccountError(message: "Claude's settings file could not be written.")
    }
    guard rename(temp.path, paths.config.path) == 0 else {
        try? FileManager.default.removeItem(at: temp)
        throw AccountError(message: "Claude's settings file could not be replaced.")
    }
}

// Cookies the usage request needs. Cloudflare and analytics cookies belong to Claude's browser and are left out.
private let sessionCookies: Set<String> = ["sessionKey", "sessionKeyV3", "sessionKeyLC", "sessionKeyV3LC", "lastActiveOrg", "routingHint", "anthropic-device-id"]

func cookieHeader(_ signIn: SignIn, key: Data) -> String? {
    var parts: [String] = []
    var hasSession = false
    for row in signIn.cookies {
        guard let name = row["name"]?.text, sessionCookies.contains(name), let host = row["host_key"]?.text else { continue }
        let value: String?
        if let encrypted = row["encrypted_value"]?.blob, !encrypted.isEmpty {
            value = decryptCookie(encrypted, key: key, host: host, schema: signIn.cookieSchema)
        } else {
            value = row["value"]?.text
        }
        guard let value, !value.isEmpty else { continue }
        if name == "sessionKey" { hasSession = true }
        parts.append("\(name)=\(value)")
    }
    return hasSession ? parts.joined(separator: "; ") : nil
}
