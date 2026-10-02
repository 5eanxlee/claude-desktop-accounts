import AppKit

let arguments = CommandLine.arguments
if arguments.contains("--self-test") { runTests(); exit(0) }

// Waits on the main run loop for asynchronous work in the command-line modes.
func pump(until done: () -> Bool, seconds: Double = 60) {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
}
func printJSON(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

// --list: saved accounts and who is signed in. Never prints credentials.
if arguments.contains("--list") {
    let current = readIdentity(log: ClaudePaths.live.log)
    let saved: [[String: Any]] = Store().all().map { account in
        ["account": account.accountId, "org": account.orgId, "email": (account.email as Any?) ?? NSNull(),
         "current": account.accountId == current?.account]
    }
    let signedIn: Any = current.map { ["account": $0.account, "org": $0.org] } ?? NSNull()
    printJSON(["signedIn": signedIn, "accounts": saved])
    exit(0)
}

// --save: save the signed-in account, as the menu's Save Current Account does.
if arguments.contains("--save") {
    do {
        let store = Store()
        var account = try captureCurrent(paths: .live)
        if let existing = store.load(account.accountId) { account.email = existing.email; account.orgName = existing.orgName }
        try store.save(account)
        print("Saved account \(account.accountId.prefix(8)) (organization \(account.orgId.prefix(8))).")
        exit(0)
    } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
}

// --quota: check every saved account's usage once and fill in missing labels.
if arguments.contains("--quota") {
    let store = Store(); let client = QuotaClient()
    let current = readIdentity(log: ClaudePaths.live.log)
    var rows: [[String: Any]] = []
    var pending = store.all().count
    for account in store.all() {
        let signIn = account.accountId == current?.account ? ((try? readSignIn(.live)) ?? account.signIn) : account.signIn
        client.usage(orgId: account.orgId, signIn: signIn) { result in
            var row: [String: Any] = ["account": String(account.accountId.prefix(8)), "email": account.email ?? NSNull()]
            switch result {
            case .success(let usage): row["usage"] = usage.label; row["resets"] = usage.resetLabel
            case .failure(let error): row["error"] = error.localizedDescription
            }
            guard account.email == nil, case .success = result else { rows.append(row); pending -= 1; return }
            client.accountInfo(orgId: account.orgId, signIn: signIn) { email, orgName in
                if var latest = store.load(account.accountId) {
                    latest.email = latest.email ?? email; latest.orgName = latest.orgName ?? orgName; try? store.save(latest)
                }
                row["email"] = email ?? NSNull(); rows.append(row); pending -= 1
            }
        }
    }
    pump(until: { pending == 0 })
    printJSON(rows)
    exit(rows.allSatisfy { $0["usage"] != nil } ? 0 : 1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
