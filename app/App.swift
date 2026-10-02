import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let store = Store()
    let paths = ClaudePaths.live
    lazy var switcher = Switcher(store: store, paths: paths)
    let client = QuotaClient()
    lazy var quotas = QuotaCache(fetch: { [weak self] account, done in self?.fetchUsage(account, done) })
    var item: NSStatusItem!
    var panel: NSPanel?
    var stack: NSStackView?
    var accounts: [SavedAccount] = []
    var current: Identity?
    var busy = false
    var state = ""
    var syncing = false
    var syncResult: String?
    var timer: Timer?
    var lastLogSize: UInt64 = .max
    var addingSince: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let appMenu = NSMenu(); let appItem = NSMenuItem(); let actions = NSMenu()
        actions.addItem(withTitle: "Quit Claude Accounts", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = actions; appMenu.addItem(appItem); NSApp.mainMenu = appMenu
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Claude"
        item.button?.image = NSImage(systemSymbolName: "person.crop.circle", accessibilityDescription: "Claude Accounts")
        item.button?.imagePosition = .imageLeft
        let menu = NSMenu(); menu.autoenablesItems = false; menu.delegate = self; item.menu = menu
        quotas.onChange = { [weak self] in self?.updateQuotas() }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, !self.busy else { return }
            self.refresh()
        }
        showPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { busy ? .terminateCancel : .terminateNow }

    // MARK: state

    func refresh() {
        let size = logSize(paths.log)
        if size != lastLogSize { lastLogSize = size; current = readIdentity(log: paths.log) }
        let before = accounts.map(\.accountId)
        saveAddedAccount()
        accounts = store.all()
        let name = accounts.first { $0.accountId == current?.account }?.label
        item.button?.toolTip = name.map { "Claude: \($0)" } ?? "Claude Accounts"
        if !busy {
            if addingSince != nil { state = "Sign in to the new account in Claude; it is saved automatically" }
            else if let name { state = "Signed in: \(name)" }
            else if current != nil { state = "Signed in to an account that is not saved yet" }
            else { state = "Claude is not signed in" }
        }
        quotas.refresh(accounts)
        if before != accounts.map(\.accountId) { renderPanel() }
    }

    func isCurrent(_ account: SavedAccount) -> Bool { account.accountId == current?.account }

    // After Add Account, the first account Claude loads that is not saved yet gets saved.
    func saveAddedAccount() {
        guard let since = addingSince else { return }
        guard Date().timeIntervalSince(since) < 15 * 60 else { addingSince = nil; return }
        guard let current, store.load(current.account) == nil, var account = try? captureCurrent(paths: paths) else { return }
        account.savedAt = Date().timeIntervalSince1970 * 1000
        guard (try? store.save(account)) != nil else { return }
        addingSince = nil
        fillLabels(account, signIn: account.signIn)
    }

    // The signed-in account uses Claude's live cookies; the others use their saved copies.
    func fetchUsage(_ account: SavedAccount, _ done: @escaping (Result<Usage, Error>) -> Void) {
        let signIn = isCurrent(account) ? ((try? readSignIn(paths)) ?? account.signIn) : account.signIn
        client.usage(orgId: account.orgId, signIn: signIn) { [weak self] result in
            done(result)
            if case .success = result, account.email == nil { self?.fillLabels(account, signIn: signIn) }
        }
    }

    func fillLabels(_ account: SavedAccount, signIn: SignIn) {
        client.accountInfo(orgId: account.orgId, signIn: signIn) { [weak self] email, orgName in
            guard let self, email != nil || orgName != nil, var latest = self.store.load(account.accountId) else { return }
            latest.email = latest.email ?? email; latest.orgName = latest.orgName ?? orgName
            try? self.store.save(latest)
            self.refresh(); self.renderPanel()
        }
    }

    func title(_ account: SavedAccount) -> String {
        account.label + " — " + (quotas.entries[account.accountId] ?? QuotaEntry()).label
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        refresh(); menu.removeAllItems()
        let info = NSMenuItem(title: state, action: nil, keyEquivalent: ""); info.isEnabled = false; menu.addItem(info)
        menu.addItem(.separator())
        for account in accounts {
            let row = NSMenuItem(title: title(account), action: #selector(chooseMenu(_:)), keyEquivalent: "")
            row.target = self; row.representedObject = account.accountId
            row.toolTip = quotas.entries[account.accountId]?.details
            row.state = isCurrent(account) ? .on : .off
            row.isEnabled = !busy
            menu.addItem(row)
        }
        if accounts.isEmpty {
            let none = NSMenuItem(title: "No saved accounts yet", action: nil, keyEquivalent: ""); none.isEnabled = false; menu.addItem(none)
        }
        menu.addItem(.separator())
        let legend = NSMenuItem(title: "Usage shown as percent used", action: nil, keyEquivalent: ""); legend.isEnabled = false; menu.addItem(legend)
        add(menu, quotas.loading ? "Refreshing Quotas…" : "Refresh Quotas", #selector(refreshQuotas), enabled: !quotas.loading, id: "quota-refresh")
        add(menu, "Show Accounts…", #selector(showPanel))
        add(menu, "Add Account…", #selector(addAccount), enabled: !busy)
        add(menu, "Save Current Account", #selector(saveAccount), enabled: !busy)
        add(menu, syncing ? "Syncing Sessions…" : "Sync Sessions", #selector(syncSessions), enabled: !syncing && SyncTool.find() != nil)
        if let syncResult { let r = NSMenuItem(title: "   \(syncResult)", action: nil, keyEquivalent: ""); r.isEnabled = false; menu.addItem(r) }
        let remove = NSMenuItem(title: "Remove Account", action: nil, keyEquivalent: ""); let sub = NSMenu()
        for account in accounts {
            let row = NSMenuItem(title: account.label, action: #selector(removeAccount(_:)), keyEquivalent: "")
            row.target = self; row.representedObject = account.accountId; row.isEnabled = !busy; sub.addItem(row)
        }
        remove.submenu = sub; remove.isEnabled = !accounts.isEmpty && !busy; menu.addItem(remove)
        menu.addItem(.separator())
        add(menu, "Quit Claude Accounts", #selector(quit), enabled: !busy, key: "q")
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, enabled: Bool = true, id: String? = nil, key: String = "") {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self; entry.isEnabled = enabled
        if let id { entry.identifier = NSUserInterfaceItemIdentifier(id) }
        menu.addItem(entry)
    }

    func updateQuotas() {
        if panel?.isVisible == true { renderPanel() }
        // Update rows in place so a late answer cannot move a row the user is about to click.
        for row in item.menu?.items ?? [] {
            if let id = row.representedObject as? String, let account = accounts.first(where: { $0.accountId == id }) {
                row.title = title(account); row.toolTip = quotas.entries[id]?.details
            } else if row.identifier?.rawValue == "quota-refresh" {
                row.title = quotas.loading ? "Refreshing Quotas…" : "Refresh Quotas"; row.isEnabled = !quotas.loading
            }
        }
    }

    // MARK: panel

    @objc func showPanel() {
        if panel == nil {
            let view = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 560))
            let panel = NSPanel(contentRect: view.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "Claude Accounts"; panel.contentView = view; panel.isReleasedWhenClosed = false
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
            stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 22),
                                         stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -22),
                                         stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 20)])
            self.panel = panel; self.stack = stack; panel.center()
        }
        refresh(); renderPanel()
        panel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    func label(_ text: String, size: CGFloat = 11, weight: NSFont.Weight = .regular, secondary: Bool = true) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        if secondary { field.textColor = .secondaryLabelColor }
        return field
    }

    func renderPanel() {
        guard let stack else { return }
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        stack.addArrangedSubview(label(state, size: 12))
        stack.addArrangedSubview(label("Usage (percent used)", size: 12, weight: .medium, secondary: false))
        for account in accounts {
            let entry = quotas.entries[account.accountId] ?? QuotaEntry()
            let button = NSButton(title: (isCurrent(account) ? "✓  " : "    ") + title(account), target: self, action: #selector(chooseButton(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(account.accountId); button.bezelStyle = .rounded; button.alignment = .left
            button.toolTip = entry.details; button.isEnabled = !busy
            stack.addArrangedSubview(button)
            button.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            button.heightAnchor.constraint(equalToConstant: 30).isActive = true
            var detail = entry.error ?? entry.value?.resetLabel ?? (entry.loading ? "Checking claude.ai…" : "Not checked yet")
            if let org = account.orgName { detail = "\(org) · \(detail)" }
            let line = label(detail); line.toolTip = entry.details
            stack.addArrangedSubview(line); stack.setCustomSpacing(1, after: button)
        }
        if accounts.isEmpty { stack.addArrangedSubview(label("No saved accounts yet.", size: 12)) }
        stack.addArrangedSubview(label("Switching quits and reopens Claude; running Code sessions stop and can be resumed."))
        let reload = NSButton(title: quotas.loading ? "Refreshing Quotas…" : "Refresh Quotas", target: self, action: #selector(refreshQuotas))
        reload.bezelStyle = .rounded; reload.isEnabled = !quotas.loading
        let add = NSButton(title: "Add Account…", target: self, action: #selector(addAccount)); add.bezelStyle = .rounded; add.isEnabled = !busy
        let save = NSButton(title: "Save Current", target: self, action: #selector(saveAccount)); save.bezelStyle = .rounded; save.isEnabled = !busy
        let sync = NSButton(title: syncing ? "Syncing…" : "Sync Sessions", target: self, action: #selector(syncSessions))
        sync.bezelStyle = .rounded; sync.isEnabled = !syncing && SyncTool.find() != nil
        stack.addArrangedSubview(NSStackView(views: [reload, add, save, sync]))
        let background = SyncTool.find() == nil ? "Session sync is not installed." : (SyncTool.agentRunning ? "Background session sync is running." : "Background session sync is not running.")
        stack.addArrangedSubview(label([background, syncResult.map { "Last sync: \($0)" }].compactMap { $0 }.joined(separator: " ")))
        let help = label("To add an account, choose Add Account…, then sign in to it in Claude. Don't use Claude's own Log Out: it ends the saved session. Quotas refresh every two minutes.")
        stack.addArrangedSubview(help); help.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    // MARK: actions

    @objc func refreshQuotas() { refresh(); quotas.refresh(accounts, force: true) }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func chooseMenu(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { switchAccount(id) } }
    @objc func chooseButton(_ sender: NSButton) { if let id = sender.identifier?.rawValue { switchAccount(id) } }

    @objc func saveAccount() {
        guard !busy else { return }
        do {
            var account = try captureCurrent(paths: paths)
            if let existing = store.load(account.accountId) { account.email = existing.email; account.orgName = existing.orgName }
            try store.save(account)
            lastLogSize = .max; refresh(); renderPanel()
            quotas.refresh(accounts, force: true)
            if account.email == nil { fillLabels(account, signIn: account.signIn) }
        } catch { alert("Could not save the account", error.localizedDescription) }
    }

    @objc func addAccount() {
        guard !busy else { return }
        let confirm = NSAlert()
        confirm.messageText = "Add another account?"
        confirm.informativeText = "Claude will quit and reopen signed out, so you can sign in to another account. The account you are signed in to now is saved first and keeps working. Running Code sessions stop."
        confirm.addButton(withTitle: "Continue"); confirm.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        busy = true; item.button?.title = "Signing out…"; renderPanel()
        switcher.signOut(progress: { [weak self] step in self?.state = step; self?.renderPanel() }) { [weak self] error in
            guard let self else { return }
            self.busy = false; self.item.button?.title = "Claude"; self.lastLogSize = .max
            if let error { self.alert("Could not sign Claude out", error.localizedDescription) }
            else { self.addingSince = Date() }
            self.refresh(); self.renderPanel()
        }
    }

    @objc func removeAccount(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let account = store.load(id) else { return }
        let confirm = NSAlert()
        confirm.messageText = "Remove \(account.label)?"
        confirm.informativeText = "Its saved sign-in is deleted from Claude Accounts. Claude itself is not changed."
        confirm.addButton(withTitle: "Remove"); confirm.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        try? store.remove(id); refresh(); renderPanel()
    }

    @objc func syncSessions() {
        guard !syncing, let tool = SyncTool.find() else { return }
        syncing = true; renderPanel()
        tool.run { [weak self] summary, _ in
            guard let self else { return }
            self.syncing = false; self.syncResult = summary; self.renderPanel()
        }
    }

    func switchAccount(_ id: String) {
        guard !busy, let target = store.load(id) else { return }
        if isCurrent(target) && switcher.claudeRunning { panel?.orderOut(nil); return }
        busy = true; item.button?.title = "Switching…"; state = "Switching to \(target.label)…"; renderPanel()
        switcher.switchTo(target, progress: { [weak self] step in
            self?.state = step; self?.renderPanel()
        }, done: { [weak self] error, outgoing in
            guard let self else { return }
            self.busy = false; self.item.button?.title = "Claude"; self.lastLogSize = .max
            self.refresh(); self.renderPanel()
            guard let error else { self.panel?.orderOut(nil); self.quotas.refresh(self.accounts, force: true); return }
            let back = outgoing.flatMap { self.store.load($0.account) }.flatMap { $0.accountId == target.accountId ? nil : $0 }
            let alert = NSAlert(); alert.messageText = "Switch to \(target.label) did not complete"; alert.informativeText = error.localizedDescription
            if let back { alert.addButton(withTitle: "Put Back \(back.label)") }
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            if back != nil && alert.runModal() == .alertFirstButtonReturn { self.switchAccount(back!.accountId) }
            else if back == nil { alert.runModal() }
        })
    }

    func alert(_ title: String, _ text: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = text; alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
}
