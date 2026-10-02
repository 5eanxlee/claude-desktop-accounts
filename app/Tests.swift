import Foundation
import SQLite3

func runTests() {
    var count = 0
    func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
        count += 1
    }
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("claude-accounts-tests-\(UUID().uuidString)")
    try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }
    func hex(_ s: String) -> Data {
        var data = Data(); var i = s.startIndex
        while i < s.endIndex { let j = s.index(i, offsetBy: 2); data.append(UInt8(s[i..<j], radix: 16)!); i = j }
        return data
    }
    func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }

    // Identity from Claude's log
    let A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OA = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0"
    let B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", OB = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0"
    func line(_ account: String, _ org: String) -> String {
        "2026-09-30 03:00:00 [info] [LocalSessionManager] Initialization succeeded — accountId=\(account), orgId=\(org), existingSessions=0"
    }
    check(identityFromLog([line(A, OA), "noise", line(B, OB)].joined(separator: "\n")) == Identity(account: B, org: OB), "Last initialization line wins")
    check(identityFromLog("nothing here") == nil, "No initialization line, no identity")
    check(identityFromLog("[LocalAgentModeSessionManager] Initialization succeeded — accountId=\(B), orgId=\(OB)") == nil, "Other managers are ignored")
    let log = dir.appendingPathComponent("main.log")
    try! (line(A, OA) + "\n").write(to: log, atomically: true, encoding: .utf8)
    check(readIdentity(log: log) == Identity(account: A, org: OA), "Read identity from the log file")
    let offset = logSize(log)
    check(identityAfter(log: log, offset: offset) == nil, "Nothing new after the offset")
    let handle = try! FileHandle(forWritingTo: log); handle.seekToEndOfFile(); handle.write(Data((line(B, OB) + "\n").utf8)); handle.closeFile()
    check(identityAfter(log: log, offset: offset) == Identity(account: B, org: OB), "A line written after the offset is found")
    check(readIdentity(log: dir.appendingPathComponent("missing.log")) == nil, "Missing log gives no identity")

    // Cookie decryption, checked against vectors made with Python and openssl
    let key = deriveKey(password: Data("test-password".utf8))
    check(key == hex("c0ffe4c25f07f62bfc6ab011d9efa54e"), "PBKDF2 key derivation matches Chromium's parameters")
    let prefixed = hex("763130cba8d8b3b813f784aae46dea9258b58b3d19f5f789dc4778df01527afd73e93e11a48f381cecfb20182ade74da794d6c")
    check(decryptCookie(prefixed, key: key, host: ".claude.ai", schema: 24) == "secret-session", "Decrypt a version 24 cookie and strip its host hash")
    check(decryptCookie(prefixed, key: key, host: "claude.ai", schema: 24) == nil, "A host hash for another host is refused")
    check(decryptCookie(hex("763130a9183ac8323e0f540e49674dd4c4bf0d"), key: key, host: ".claude.ai", schema: 23) == "legacy-value", "Decrypt an older cookie without a host hash")
    check(decryptCookie(prefixed, key: deriveKey(password: Data("wrong".utf8)), host: ".claude.ai", schema: 24) == nil, "The wrong key is refused")
    check(decryptCookie(Data("v11abcdefabcdefabcdef".utf8), key: key, host: ".claude.ai", schema: 24) == nil, "An unknown encryption version is refused")

    // Usage response
    let usage = try! Usage(data: json([
        "five_hour": ["utilization": 14.0, "resets_at": "2026-09-30T20:00:00.123456+00:00"],
        "seven_day": ["utilization": 46, "resets_at": "2026-10-03T12:00:00Z"],
        "seven_day_opus": NSNull()
    ]))
    check(usage.fiveHour?.used == 14 && usage.week?.used == 46, "Read five-hour and weekly utilization")
    check(usage.fiveHour?.resets == Date(timeIntervalSince1970: 1790798400), "Read a reset time with microseconds")
    check(usage.week?.resets == Date(timeIntervalSince1970: 1791028800), "Read a reset time without fractions")
    check(usage.label == "5h 14% · week 46%", "Menu label")
    let empty = try! Usage(data: json(["five_hour": NSNull(), "seven_day": ["utilization": NSNull(), "resets_at": NSNull()]]))
    check(empty.fiveHour == nil && empty.week == nil && empty.label == "5h – · week –", "Null buckets show as unknown")
    var refused = false
    do { _ = try Usage(data: Data("[]".utf8)) } catch { refused = true }
    check(refused, "A response that is not an object is refused")
    check(Usage.percent(0) == "0%" && Usage.percent(0.4) == "<1%" && Usage.percent(99.6) == ">99%" && Usage.percent(100) == "100%", "Rounding never fakes an empty or full quota")

    // Claude's sign-in: config entries and claude.ai cookies
    let claudeDir = dir.appendingPathComponent("Claude"); let cookieDir = dir.appendingPathComponent("CookieDir")
    try! fm.createDirectory(at: claudeDir, withIntermediateDirectories: true)
    try! fm.createDirectory(at: cookieDir, withIntermediateDirectories: true)
    let paths = ClaudePaths(config: claudeDir.appendingPathComponent("config.json"), cookies: cookieDir.appendingPathComponent("Cookies"), log: log)
    try! json(["locale": "en-US", "oauth:tokenCache": "OLD1", "oauth:tokenCacheV2": "OLD2", "lastKnownAccountUuid": A, "windowControlsZoomFactor": 1.1, "nested": ["keep": true]])
        .write(to: paths.config)
    try! fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.config.path)
    var db: OpaquePointer?
    sqlite3_open(paths.cookies.path, &db)
    sqlite3_exec(db, """
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta VALUES('version','24');
        CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL);
        INSERT INTO cookies VALUES(13399999999999999, '.claude.ai', 'sessionKey', '', X'763130AABB', '/', 13400000000000001, 1);
        INSERT INTO cookies VALUES(13399999999999998, 'claude.ai', 'anthropic-device-id', '', X'763130CCDD', '/', 0, 1);
        INSERT INTO cookies VALUES(1, '.example.com', 'other', 'keep-me', X'', '/', 0, 0);
        """, nil, nil, nil)
    sqlite3_close(db)
    let current = try! readSignIn(paths)
    check(current.config == ["oauth:tokenCache": "OLD1", "oauth:tokenCacheV2": "OLD2", "lastKnownAccountUuid": A], "Read the three sign-in config entries")
    check(current.cookieSchema == 24 && current.cookies.count == 2 && current.hasSessionKey, "Read only claude.ai cookies, including the session key")
    check(current.cookies.contains { $0["creation_utc"] == .integer("13399999999999999") }, "Large cookie timestamps survive exactly")

    var target = current
    target.config = ["oauth:tokenCache": "NEW1", "oauth:tokenCacheV2": "NEW2", "lastKnownAccountUuid": B]
    target.cookies = [current.cookies[0].merging(["encrypted_value": .blob(Data([0x76, 0x31, 0x30, 1, 2, 3]))]) { $1 }]
    try! writeCookies(target, paths)
    try! writeConfig(target.config, paths)
    let after = try! readSignIn(paths)
    check(after.config == target.config && after.cookies == target.cookies, "Write another account's sign-in")
    let config = try! JSONSerialization.jsonObject(with: Data(contentsOf: paths.config)) as! [String: Any]
    check(config["locale"] as? String == "en-US" && (config["nested"] as? [String: Bool])?["keep"] == true && config["windowControlsZoomFactor"] as? Double == 1.1, "Other config entries survive")
    check((try! fm.attributesOfItem(atPath: paths.config.path)[.posixPermissions] as! Int) == 0o600, "Config keeps its private permissions")
    func otherRows() -> Int {
        var db: OpaquePointer?; sqlite3_open(paths.cookies.path, &db); defer { sqlite3_close(db) }
        var statement: OpaquePointer?; sqlite3_prepare_v2(db, "SELECT count(*) FROM cookies WHERE host_key='.example.com' AND value='keep-me'", -1, &statement, nil)
        sqlite3_step(statement); defer { sqlite3_finalize(statement) }; return Int(sqlite3_column_int(statement, 0))
    }
    check(otherRows() == 1, "Cookies for other sites are untouched")

    var mismatched = current; mismatched.cookieSchema = 25
    refused = false
    do { try writeCookies(mismatched, paths) } catch { refused = true }
    check(refused && (try! readSignIn(paths)).cookies == target.cookies, "A cookie format mismatch is refused without changes")
    var extraColumn = current; extraColumn.cookies = [current.cookies[0].merging(["surprise": .text("x")]) { $1 }]
    refused = false
    do { try writeCookies(extraColumn, paths) } catch { refused = true }
    check(refused && (try! readSignIn(paths)).cookies == target.cookies, "Saved cookies with unknown columns are refused without changes")
    sqlite3_open(paths.cookies.path, &db)
    sqlite3_exec(db, "CREATE TRIGGER boom BEFORE INSERT ON cookies WHEN NEW.name='anthropic-device-id' BEGIN SELECT RAISE(ABORT,'fixture'); END;", nil, nil, nil)
    sqlite3_close(db)
    refused = false
    do { try writeCookies(current, paths) } catch { refused = true }
    check(refused && (try! readSignIn(paths)).cookies == target.cookies, "A failed cookie write leaves the table as it was")
    sqlite3_open(paths.cookies.path, &db); sqlite3_exec(db, "DROP TRIGGER boom", nil, nil, nil); sqlite3_close(db)

    // Saved accounts
    let store = Store(root: dir.appendingPathComponent("Claude Accounts"))
    let saved = SavedAccount(accountId: A, orgId: OA, email: "a@example.com", orgName: "A Org", savedAt: 1, signIn: current)
    try! store.save(saved)
    check(store.load(A) == saved, "Saved account round trip")
    check((try! fm.attributesOfItem(atPath: store.file(A).path)[.posixPermissions] as! Int) == 0o600, "Saved account is private")
    check((try! fm.attributesOfItem(atPath: store.accountsDir.path)[.posixPermissions] as! Int) == 0o700, "Saved account folder is private")
    try! store.save(SavedAccount(accountId: B, orgId: OB, email: nil, orgName: nil, savedAt: 2, signIn: target))
    check(store.all().map(\.accountId) == [A, B], "Accounts listed by email, unknown emails last")
    try! store.remove(B)
    check(store.all().map(\.accountId) == [A], "Remove an account")

    // Swapping sign-ins, with the outgoing account re-saved and rollback on failure
    try! writeCookies(current, paths); try! writeConfig(current.config, paths)
    let bSaved = SavedAccount(accountId: B, orgId: OB, email: "b@example.com", orgName: nil, savedAt: 2, signIn: target)
    try! store.save(bSaved)
    try! store.save(SavedAccount(accountId: A, orgId: OA, email: "a@example.com", orgName: "A Org", savedAt: 0, signIn: target))
    let previous = store.root.appendingPathComponent("previous.json")
    try! swapSignIn(to: bSaved, outgoing: Identity(account: A, org: OA), store: store, paths: paths, previous: previous)
    let swapped = try! readSignIn(paths)
    check(swapped.config == target.config && swapped.cookies == target.cookies, "Swap puts the target's sign-in in place")
    let resaved = store.load(A)!
    check(resaved.signIn == current && resaved.email == "a@example.com" && resaved.orgName == "A Org", "The outgoing account is re-saved from disk and keeps its labels")
    check((try! fm.attributesOfItem(atPath: previous.path)[.posixPermissions] as! Int) == 0o600, "The previous sign-in copy is private")

    try! writeCookies(current, paths); try! writeConfig(current.config, paths)
    try! fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: claudeDir.path)
    refused = false
    do { try swapSignIn(to: bSaved, outgoing: Identity(account: A, org: OA), store: store, paths: paths, previous: previous) } catch { refused = true }
    try! fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: claudeDir.path)
    let rolledBack = try! readSignIn(paths)
    check(refused && rolledBack.cookies == current.cookies && rolledBack.config == current.config, "A failed config write puts the previous cookies back")

    var signedOut = current; signedOut.cookies = signedOut.cookies.filter { $0["name"] != .text("sessionKey") }
    try! writeCookies(signedOut, paths)
    try! store.save(SavedAccount(accountId: A, orgId: OA, email: "a@example.com", orgName: nil, savedAt: 5, signIn: current))
    try! swapSignIn(to: bSaved, outgoing: Identity(account: A, org: OA), store: store, paths: paths, previous: previous)
    check(store.load(A)!.signIn == current, "A signed-out state never overwrites a saved account")

    var wrongAccount = current; wrongAccount.config["lastKnownAccountUuid"] = B
    try! writeCookies(wrongAccount, paths); try! writeConfig(wrongAccount.config, paths)
    try! swapSignIn(to: bSaved, outgoing: Identity(account: A, org: OA), store: store, paths: paths, previous: previous)
    check(store.load(A)!.signIn == current, "A sign-in that belongs to another account is not saved under the logged one")

    // Add Account: sign Claude out locally, without contacting the server
    try! writeCookies(current, paths); try! writeConfig(current.config, paths)
    try! store.save(SavedAccount(accountId: A, orgId: OA, email: "a@example.com", orgName: nil, savedAt: 7, signIn: target))
    try! signOutLocally(outgoing: Identity(account: A, org: OA), store: store, paths: paths, previous: previous)
    let cleared = try! readSignIn(paths)
    check(cleared.config.isEmpty && cleared.cookies.isEmpty && !cleared.hasSessionKey, "Local sign-out removes the sign-in entries and claude.ai cookies")
    check(otherRows() == 1, "Local sign-out leaves other sites' cookies alone")
    let keptConfig = try! JSONSerialization.jsonObject(with: Data(contentsOf: paths.config)) as! [String: Any]
    check(keptConfig["locale"] as? String == "en-US", "Local sign-out keeps other settings")
    check(store.load(A)!.signIn == current && store.load(A)!.email == "a@example.com", "Local sign-out saves the outgoing account first")

    // Save Current Account
    try! writeCookies(current, paths); try! writeConfig(current.config, paths)
    try! (line(A, OA) + "\n").write(to: log, atomically: true, encoding: .utf8)
    let captured = try! captureCurrent(paths: paths)
    check(captured.accountId == A && captured.orgId == OA && captured.signIn == current, "Capture the signed-in account")
    try! (line(B, OB) + "\n").write(to: log, atomically: true, encoding: .utf8)
    refused = false
    do { _ = try captureCurrent(paths: paths) } catch { refused = true }
    check(refused, "Refuse to save when the log and the sign-in name different accounts")
    try! (line(A, OA) + "\n").write(to: log, atomically: true, encoding: .utf8)
    try! writeCookies(signedOut, paths)
    refused = false
    do { _ = try captureCurrent(paths: paths) } catch { refused = true }
    check(refused, "Refuse to save a signed-out Claude")

    // Cookie header for the usage request
    var cookieJar = current
    cookieJar.cookies = [
        ["host_key": .text(".claude.ai"), "name": .text("sessionKey"), "value": .text(""), "encrypted_value": .blob(prefixed)],
        ["host_key": .text(".claude.ai"), "name": .text("cf_clearance"), "value": .text("browser-only"), "encrypted_value": .blob(Data())],
        ["host_key": .text(".claude.ai"), "name": .text("lastActiveOrg"), "value": .text("org-1"), "encrypted_value": .blob(Data())]
    ]
    check(cookieHeader(cookieJar, key: key) == "sessionKey=secret-session; lastActiveOrg=org-1", "Send only the session cookies, decrypted")
    check(cookieHeader(cookieJar, key: deriveKey(password: Data("wrong".utf8))) == nil, "No header when the session key cannot be decrypted")

    // Quota cache
    var stamp = Date()
    var requests: [(SavedAccount, (Result<Usage, Error>) -> Void)] = []
    let cache = QuotaCache(fetch: { requests.append(($0, $1)) }, now: { stamp })
    let aAccount = store.load(A)!
    cache.refresh([aAccount]); cache.refresh([aAccount], force: true)
    check(requests.count == 1 && cache.loading, "Concurrent refreshes are coalesced")
    requests[0].1(.success(usage))
    check(!cache.loading && cache.entries[A]?.value == usage && cache.entries[A]?.label == "5h 14% · week 46%", "A result is stored")
    cache.refresh([aAccount])
    check(requests.count == 1, "Automatic refreshes wait two minutes")
    stamp = stamp.addingTimeInterval(121); cache.refresh([aAccount])
    check(requests.count == 2, "Refresh once two minutes have passed")
    requests[1].1(.failure(AccountError(message: "Offline")))
    check(cache.entries[A]?.label == "5h 14% · week 46% · stale", "A failure keeps the last numbers, marked stale")
    cache.refresh([aAccount], force: true)
    check(requests.count == 3, "Refresh Quotas skips the wait")
    requests[2].1(.failure(QuotaFailure.signInAgain))
    check(cache.entries[A]?.details.contains("Sign in to this account in Claude again") == true, "An expired session says what to do")
    let fresh = SavedAccount(accountId: A, orgId: OA, email: "a@example.com", orgName: nil, savedAt: 99, signIn: current)
    cache.refresh([aAccount], force: true); cache.refresh([fresh])
    requests[3].1(.success(Usage(fiveHour: nil, week: nil)))
    check(cache.entries[A]?.value == nil && cache.loading, "A reply for an older saved sign-in is ignored")
    requests[4].1(.success(usage))
    check(cache.entries[A]?.value == usage, "The re-saved sign-in gets its own result")
    cache.refresh([]); check(cache.entries.isEmpty, "Removed accounts are dropped")
    let noUsage = QuotaEntry()
    check(noUsage.label == "Unavailable" && QuotaEntry(loading: true).label == "Checking…", "Labels before any result")

    // Sync tool
    let agent = dir.appendingPathComponent("agent.plist")
    try! PropertyListSerialization.data(fromPropertyList: ["Label": "local.claude-session-sync", "ProgramArguments": ["/opt/homebrew/bin/node", "/Users/x/claude-session-sync/bin/claude-session-sync.js", "watch"]], format: .xml, options: 0).write(to: agent)
    check(SyncTool.fromAgent(agent) == SyncTool(node: "/opt/homebrew/bin/node", script: "/Users/x/claude-session-sync/bin/claude-session-sync.js"), "Find the sync command from its agent")
    check(SyncTool.fromAgent(dir.appendingPathComponent("none.plist")) == nil, "No agent, no command")
    check(lastLine("4 folders, 20 sessions.\nDone: 0 created, 1 updated, 0 trashed.\n\n") == "Done: 0 created, 1 updated, 0 trashed.", "Show the sync's last line")

    print("\(count) claude-accounts checks passed.")
}
