import AppKit

let claudeBundleId = "com.anthropic.claudefordesktop"

func claudeAppURL() -> URL {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: claudeBundleId) ?? URL(fileURLWithPath: "/Applications/Claude.app")
}

// The signed-in account, as long as Claude's log and its stored sign-in agree on who that is.
func captureCurrent(paths: ClaudePaths, now: Date = Date()) throws -> SavedAccount {
    guard let identity = readIdentity(log: paths.log) else {
        throw AccountError(message: "Sign in to Claude first, then save the account.")
    }
    let signIn = try readSignIn(paths)
    guard signIn.hasTokens, signIn.hasSessionKey else {
        throw AccountError(message: "Claude is not fully signed in. Sign in to Claude, then save the account.")
    }
    guard signIn.accountId == identity.account else {
        throw AccountError(message: "Claude is still switching accounts. Wait until it has loaded, then save again.")
    }
    return SavedAccount(accountId: identity.account, orgId: identity.org, email: nil, orgName: nil,
                        savedAt: now.timeIntervalSince1970 * 1000, signIn: signIn)
}

// Runs only while Claude is closed. The outgoing account is re-saved first so a token Claude
// refreshed since the last save is kept, and a failure puts the previous sign-in back.
func swapSignIn(to target: SavedAccount, outgoing: Identity?, store: Store, paths: ClaudePaths, previous: URL, now: Date = Date()) throws {
    try replaceSignIn(with: target.signIn, outgoing: outgoing, target: target.accountId, store: store, paths: paths, previous: previous, now: now)
}

// For Add Account: Claude reopens signed out, but the server-side session is never ended,
// so the outgoing account's saved sign-in keeps working. Claude's own Log Out would end it.
func signOutLocally(outgoing: Identity?, store: Store, paths: ClaudePaths, previous: URL, now: Date = Date()) throws {
    let empty = SignIn(config: [:], cookieSchema: try readSignIn(paths).cookieSchema, cookies: [])
    try replaceSignIn(with: empty, outgoing: outgoing, target: nil, store: store, paths: paths, previous: previous, now: now)
}

private func replaceSignIn(with replacement: SignIn, outgoing: Identity?, target: String?, store: Store, paths: ClaudePaths, previous: URL, now: Date) throws {
    let current = try readSignIn(paths)
    try writePrivate(JSONEncoder().encode(current), to: previous)
    if let outgoing, outgoing.account != target,
       current.hasTokens, current.hasSessionKey, current.accountId == outgoing.account {
        let existing = store.load(outgoing.account)
        try store.save(SavedAccount(accountId: outgoing.account, orgId: outgoing.org, email: existing?.email, orgName: existing?.orgName,
                                    savedAt: now.timeIntervalSince1970 * 1000, signIn: current))
    }
    try writeCookies(replacement, paths)
    do {
        try writeConfig(replacement.config, paths)
    } catch {
        try? writeCookies(current, paths)
        throw error
    }
}

// Quit Claude, swap the sign-in, reopen Claude and wait for its log to confirm the account.
final class Switcher {
    let store: Store
    let paths: ClaudePaths
    let bundleId = claudeBundleId
    var appURL: URL { claudeAppURL() }
    var previousFile: URL { store.root.appendingPathComponent("previous.json") }

    init(store: Store, paths: ClaudePaths = .live) { self.store = store; self.paths = paths }

    var claudeRunning: Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).contains { !$0.isTerminated }
    }

    func switchTo(_ target: SavedAccount, progress: @escaping (String) -> Void, done: @escaping (Error?, Identity?) -> Void) {
        let outgoing = readIdentity(log: paths.log)
        if outgoing?.account == target.accountId && claudeRunning { done(nil, outgoing); return }
        progress("Quitting Claude…")
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId) { app.terminate() }
        waitForQuit(deadline: Date().addingTimeInterval(45)) { [self] quit in
            guard quit else {
                done(AccountError(message: "Claude stayed open, so nothing was changed. Close any dialog Claude is showing, then try again."), outgoing)
                return
            }
            let offset = logSize(paths.log)
            do {
                try swapSignIn(to: target, outgoing: outgoing, store: store, paths: paths, previous: previousFile)
            } catch {
                openClaude { _ in }
                done(error, outgoing)
                return
            }
            progress("Opening Claude as \(target.label)…")
            openClaude { [self] opened in
                guard opened else { done(AccountError(message: "The account is in place, but Claude did not reopen. Open it from Applications."), outgoing); return }
                waitForAccount(target, offset: offset, deadline: Date().addingTimeInterval(45)) { error in done(error, outgoing) }
            }
        }
    }

    func signOut(progress: @escaping (String) -> Void, done: @escaping (Error?) -> Void) {
        let outgoing = readIdentity(log: paths.log)
        progress("Quitting Claude…")
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId) { app.terminate() }
        waitForQuit(deadline: Date().addingTimeInterval(45)) { [self] quit in
            guard quit else { done(AccountError(message: "Claude stayed open, so nothing was changed. Close any dialog Claude is showing, then try again.")); return }
            do { try signOutLocally(outgoing: outgoing, store: store, paths: paths, previous: previousFile) }
            catch { openClaude { _ in }; done(error); return }
            progress("Opening Claude signed out…")
            openClaude { opened in done(opened ? nil : AccountError(message: "Claude did not reopen. Open it from Applications and sign in.")) }
        }
    }

    private func waitForQuit(deadline: Date, _ finish: @escaping (Bool) -> Void) {
        if !claudeRunning { finish(true); return }
        guard Date() < deadline else { finish(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForQuit(deadline: deadline, finish) }
    }

    private func openClaude(_ finish: @escaping (Bool) -> Void) {
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { _, error in
            DispatchQueue.main.async { finish(error == nil) }
        }
    }

    private func waitForAccount(_ target: SavedAccount, offset: UInt64, deadline: Date, _ finish: @escaping (Error?) -> Void) {
        if let loaded = identityAfter(log: paths.log, offset: offset) {
            if loaded.account == target.accountId { finish(nil); return }
            finish(AccountError(message: "Claude opened a different account than \(target.label). Its saved sign-in may have expired: sign in to it in Claude and save it again."))
            return
        }
        guard Date() < deadline else {
            finish(AccountError(message: "Claude has not confirmed \(target.label) yet. If it shows a sign-in screen, the saved sign-in has expired."))
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForAccount(target, offset: offset, deadline: deadline, finish) }
    }
}
