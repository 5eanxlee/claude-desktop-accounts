import Foundation

enum QuotaFailure: LocalizedError {
    case signInAgain, blocked, http(Int), offline
    var errorDescription: String? {
        switch self {
        case .signInAgain: return "Sign in to this account in Claude again, then save it."
        case .blocked: return "claude.ai refused the request from outside Claude."
        case .http(let status): return "Claude could not return usage (HTTP \(status))."
        case .offline: return "Could not reach claude.ai."
        }
    }
}

struct QuotaEntry {
    var value: Usage?
    var checked: Date?
    var attempted: Date?
    var loading = false
    var error: String?
    var version: Double = 0

    var stale: Bool { value != nil && (error != nil || checked.map { Date().timeIntervalSince($0) > 300 } == true) }
    var label: String {
        if let value { return value.label + (stale ? " · stale" : "") }
        if loading { return "Checking…" }
        return error == QuotaFailure.signInAgain.errorDescription ? "Sign in again" : "Unavailable"
    }
    var details: String {
        var lines: [String] = []
        if let value { lines.append("Used: \(value.label)."); lines.append(value.resetLabel + ".") }
        if let checked { lines.append("Checked \(DateFormatter.localizedString(from: checked, dateStyle: .none, timeStyle: .medium)).") }
        if let error { lines.append(error) }
        if loading { lines.append("Refreshing…") }
        return lines.isEmpty ? "Usage has not been checked yet." : lines.joined(separator: "\n")
    }
}

// Main-thread state. A refresh never changes a saved account or the signed-in one.
final class QuotaCache {
    typealias Fetch = (SavedAccount, @escaping (Result<Usage, Error>) -> Void) -> Void
    private let fetch: Fetch
    private let now: () -> Date
    private(set) var entries: [String: QuotaEntry] = [:]
    var onChange: (() -> Void)?
    var loading: Bool { entries.values.contains { $0.loading } }

    init(fetch: @escaping Fetch, now: @escaping () -> Date = Date.init) { self.fetch = fetch; self.now = now }

    func refresh(_ accounts: [SavedAccount], force: Bool = false) {
        let ids = Set(accounts.map(\.accountId))
        var changed = entries.keys.contains { !ids.contains($0) }
        entries = entries.filter { ids.contains($0.key) }
        for account in accounts {
            var entry = entries[account.accountId] ?? QuotaEntry(version: account.savedAt)
            // A re-saved sign-in starts over, so an answer for the old one cannot land on it.
            if entry.version != account.savedAt { entry = QuotaEntry(version: account.savedAt); changed = true }
            guard !entry.loading else { entries[account.accountId] = entry; continue }
            guard force || entry.attempted.map({ now().timeIntervalSince($0) >= 120 }) != false else { entries[account.accountId] = entry; continue }
            entry.loading = true; entry.attempted = now()
            entries[account.accountId] = entry; changed = true
            let version = account.savedAt
            fetch(account) { [weak self] result in
                guard let self, var entry = self.entries[account.accountId], entry.version == version, entry.loading else { return }
                entry.loading = false
                switch result {
                case .success(let usage): entry.value = usage; entry.checked = self.now(); entry.error = nil
                case .failure(let error): entry.error = error.localizedDescription
                }
                self.entries[account.accountId] = entry
                self.onChange?()
            }
        }
        if changed { onChange?() }
    }
}

// Talks to claude.ai with an account's own session cookies. Redirects are refused, nothing is stored.
final class QuotaClient: NSObject, URLSessionTaskDelegate {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private let keyQueue = DispatchQueue(label: "claude-accounts.keychain")
    private var key: Data?

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    static let userAgent: String = {
        let app = claudeAppURL()
        let claude = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let electron = Bundle(url: app.appendingPathComponent("Contents/Frameworks/Electron Framework.framework"))?
            .object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/\(claude) Electron/\(electron) Safari/537.36"
    }()

    // The Keychain prompt can block, so the key is fetched off the main thread, once.
    func withKey(_ body: @escaping (Result<Data, Error>) -> Void) {
        keyQueue.async {
            if let key = self.key { body(.success(key)); return }
            do { let key = try claudeCookieKey(); self.key = key; body(.success(key)) }
            catch { body(.failure(error)) }
        }
    }

    func get(_ path: String, signIn: SignIn, completion: @escaping (Result<Data, Error>) -> Void) {
        withKey { result in
            switch result {
            case .failure(let error): DispatchQueue.main.async { completion(.failure(error)) }
            case .success(let key):
                guard let cookie = cookieHeader(signIn, key: key) else {
                    DispatchQueue.main.async { completion(.failure(QuotaFailure.signInAgain)) }; return
                }
                var request = URLRequest(url: URL(string: "https://claude.ai\(path)")!)
                request.setValue(cookie, forHTTPHeaderField: "Cookie")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
                self.session.dataTask(with: request) { data, response, error in
                    let result: Result<Data, Error>
                    let http = response as? HTTPURLResponse
                    let isJSON = http?.value(forHTTPHeaderField: "Content-Type")?.contains("json") == true
                    if error != nil { result = .failure(QuotaFailure.offline) }
                    else if http?.statusCode == 200 { result = .success(data ?? Data()) }
                    else if (http?.statusCode == 401 || http?.statusCode == 403) && isJSON { result = .failure(QuotaFailure.signInAgain) }
                    else if http?.statusCode == 403 || http?.value(forHTTPHeaderField: "cf-mitigated") != nil { result = .failure(QuotaFailure.blocked) }
                    else { result = .failure(QuotaFailure.http(http?.statusCode ?? 0)) }
                    DispatchQueue.main.async { completion(result) }
                }.resume()
            }
        }
    }

    func usage(orgId: String, signIn: SignIn, completion: @escaping (Result<Usage, Error>) -> Void) {
        get("/api/organizations/\(orgId)/usage", signIn: signIn) { result in
            completion(result.flatMap { data in Result { try Usage(data: data) } })
        }
    }

    // Email and organization name, for labels.
    func accountInfo(orgId: String, signIn: SignIn, completion: @escaping (String?, String?) -> Void) {
        get("/api/account", signIn: signIn) { result in
            guard case .success(let data) = result, let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                completion(nil, nil); return
            }
            let email = body["email_address"] as? String ?? body["email"] as? String
            let orgs = (body["memberships"] as? [[String: Any]] ?? []).compactMap { $0["organization"] as? [String: Any] }
            completion(email, orgs.first { $0["uuid"] as? String == orgId }?["name"] as? String)
        }
    }
}
