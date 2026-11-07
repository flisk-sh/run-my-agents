// Run My Agents: a native macOS window around the local board (http://127.0.0.1:4100/).
import AppKit
import WebKit

let port = 4100
let boardURL = URL(string: "http://127.0.0.1:\(port)/")!
let healthURL = URL(string: "http://127.0.0.1:\(port)/health")!
// Where updates come from: the latest GitHub release and its Mac zip (built by .github/workflows/release-mac.yml).
// The release page, not the API: the API allows 60 calls an hour per address without a login, and that ran out on a
// network shared with other tools ("API rate limit exceeded"), so Check for Updates said GitHub did not answer.
// github.com/<repo>/releases/latest redirects to /releases/tag/<tag>, and the zip is at /releases/download/<tag>/.
let releases = "https://github.com/flisk-sh/run-my-agents/releases"
let zipName = "Run-My-Agents-macOS.zip"
/** How often a running app looks for a new release. */
let updateEvery: TimeInterval = 6 * 60 * 60
// BAKED_BOARD_DIR is replaced by build.sh
let bakedBoardDir = "__BAKED_BOARD_DIR__"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var web: WKWebView!
  var statusItem: NSStatusItem!
  var server: Process?
  var updateItem: NSMenuItem!
  /** A downloaded, checked release waiting to replace this app: on quit, or now from the menu. */
  var staged: (app: URL, version: String)?
  var checking = false

  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.appearance = NSAppearance(named: .darkAqua)
    buildMenu(); buildWindow(); buildStatusItem()
    web.loadHTMLString(page("Starting board…", ""), baseURL: nil)
    DispatchQueue.global().async {
      // Before the board starts, nothing is cooking yet: the best moment to update.
      if self.selfUpdates() {
        if self.checkRelease(manual: false, installNow: true, wait: 8) { return }
      } else {
        self.pullCheckout(manual: false)
      }
      self.ensureServer()
    }
    Timer.scheduledTimer(withTimeInterval: updateEvery, repeats: true) { [weak self] _ in
      guard let self, self.selfUpdates() else { return }
      // While it runs, download and stage only: restarting would kill the board mid-order. It installs on quit.
      DispatchQueue.global().async { self.checkRelease(manual: false, installNow: false, wait: 60) }
    }
  }

  // MARK: updates
  var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0" }

  /** A released app (the board compiled in) updates itself; a dev build runs the board from a checkout instead. */
  func selfUpdates() -> Bool {
    let env = ProcessInfo.processInfo.environment
    guard env["RUN_MY_AGENTS_NO_UPDATE"] == nil, env["RUN_MY_AGENTS_BOARD"] == nil,
          Bundle.main.url(forResource: "board", withExtension: nil) != nil else { return false }
    return FileManager.default.isWritableFile(atPath: (Bundle.main.bundlePath as NSString).deletingLastPathComponent)
  }

  /** 0.1.10 is newer than 0.1.9: compare the numbers, not the text. */
  static func newer(_ a: String, than b: String) -> Bool {
    let n = { (s: String) in s.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
    let x = n(a), y = n(b)
    for i in 0..<max(x.count, y.count) {
      let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
      if l != r { return l > r }
    }
    return false
  }

  @discardableResult
  func run(_ tool: String, _ args: [String], in dir: String? = nil) -> (ok: Bool, out: String) {
    let p = Process(); let pipe = Pipe()
    p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
    if let dir { p.currentDirectoryURL = URL(fileURLWithPath: dir) }
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env["GIT_TERMINAL_PROMPT"] = "0"
    p.environment = env
    p.standardOutput = pipe; p.standardError = pipe
    do { try p.run() } catch { return (false, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus == 0, String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
  }

  func tell(_ title: String, _ text: String) {
    DispatchQueue.main.async {
      let a = NSAlert(); a.messageText = title; a.informativeText = text
      NSApp.activate(ignoringOtherApps: true); a.runModal()
    }
  }

  func setUpdateTitle(_ t: String) { DispatchQueue.main.async { self.updateItem?.title = t } }

  /**
   * Looks at the latest release. When it is newer, downloads its zip, unpacks and checks the app in it, and either
   * installs it now (relaunching) or keeps it staged until quit. Blocks the calling (background) thread. True when it
   * is installing now and the app is about to quit.
   */
  @discardableResult
  func checkRelease(manual: Bool, installNow: Bool, wait: TimeInterval) -> Bool {
    if checking { return false }
    if staged != nil {
      if manual { DispatchQueue.main.async { self.installStaged(relaunch: true) } }
      return false
    }
    checking = true; defer { checking = false; if staged == nil { setUpdateTitle("Check for Updates…") } }
    setUpdateTitle("Checking for updates…")
    var req = URLRequest(url: URL(string: "\(releases)/latest")!); req.timeoutInterval = wait
    req.httpMethod = "HEAD"
    req.setValue("RunMyAgents/\(version)", forHTTPHeaderField: "User-Agent")
    let sem = DispatchSemaphore(value: 0); var landed: URL?; var status = 0; var failure = ""
    URLSession.shared.dataTask(with: req) { _, r, e in
      status = (r as? HTTPURLResponse)?.statusCode ?? 0
      landed = r?.url
      failure = e?.localizedDescription ?? ""
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + wait + 1)
    // The redirect's last path part is the tag: …/releases/tag/v0.1.13.
    guard status == 200, let landed, landed.deletingLastPathComponent().lastPathComponent == "tag",
          let zipURL = URL(string: "\(releases)/download/\(landed.lastPathComponent)/\(zipName)") else {
      if manual { tell("Could not check for updates", failure.isEmpty ? "GitHub's release page answered \(status == 0 ? "nothing" : "HTTP \(status)")." : failure) }
      return false
    }
    let tag = landed.lastPathComponent
    let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    guard Self.newer(latest, than: version) else {
      if manual { tell("Run My Agents is up to date", "You have version \(version), the latest release.") }
      return false
    }
    setUpdateTitle("Downloading v\(latest)…")
    guard let app = download(zipURL, timeout: max(wait, 600)) else {
      if manual { tell("Update failed", "Could not download or verify v\(latest). The app was not changed.") }
      return false
    }
    staged = (app, latest)
    setUpdateTitle("Restart to Update to v\(latest)")
    guard installNow || manual else { return false }
    DispatchQueue.main.sync { self.installStaged(relaunch: true) }
    return true
  }

  /** The release zip, downloaded and unpacked to a temporary folder; nil unless it holds a whole, validly signed app. */
  func download(_ url: URL, timeout: TimeInterval) -> URL? {
    let fm = FileManager.default
    let work = fm.temporaryDirectory.appendingPathComponent("run-my-agents-update-\(UUID().uuidString)")
    try? fm.createDirectory(at: work, withIntermediateDirectories: true)
    let zip = work.appendingPathComponent(zipName)
    var req = URLRequest(url: url); req.timeoutInterval = timeout
    let sem = DispatchSemaphore(value: 0); var ok = false
    URLSession.shared.downloadTask(with: req) { tmp, r, _ in
      if let tmp, (r as? HTTPURLResponse)?.statusCode == 200 { ok = (try? fm.moveItem(at: tmp, to: zip)) != nil }
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 5)
    guard ok, run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path]).ok else { return nil }
    let app = work.appendingPathComponent("Run My Agents.app")
    guard fm.fileExists(atPath: app.appendingPathComponent("Contents/Resources/board").path),
          fm.fileExists(atPath: app.appendingPathComponent("Contents/MacOS/RunMyAgents").path),
          run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]).ok else { return nil }
    run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
    return app
  }

  /**
   * Swaps the staged app in for this one. A detached shell waits for this process to exit, moves the old bundle
   * aside, moves the new one in (putting the old one back if that fails) and opens it again when asked to.
   */
  func installStaged(relaunch: Bool) {
    guard let s = staged else { return }
    staged = nil
    let script = """
    while kill -0 "$RMA_PID" 2>/dev/null; do sleep 0.2; done
    old="$RMA_TARGET.old-update"; rm -rf "$old"
    if mv "$RMA_TARGET" "$old"; then
      if mv "$RMA_NEW" "$RMA_TARGET"; then rm -rf "$old"; else mv "$old" "$RMA_TARGET"; fi
    fi
    [ "$RMA_RELAUNCH" = 1 ] && open "$RMA_TARGET"
    """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", script]
    var env = ProcessInfo.processInfo.environment
    env["RMA_PID"] = "\(ProcessInfo.processInfo.processIdentifier)"
    env["RMA_TARGET"] = Bundle.main.bundlePath
    env["RMA_NEW"] = s.app.path
    env["RMA_RELAUNCH"] = relaunch ? "1" : "0"
    p.environment = env
    do { try p.run() } catch { return }
    if relaunch { NSApp.terminate(nil) }
  }

  /**
   * A dev build runs the board from its checkout, so updating it means pulling: only a clean checkout on main, and
   * only a fast-forward, so local work is never touched. Before the board starts, or by hand from the menu.
   */
  func pullCheckout(manual: Bool) {
    let dir = ProcessInfo.processInfo.environment["RUN_MY_AGENTS_BOARD"] ?? bakedBoardDir
    guard ProcessInfo.processInfo.environment["RUN_MY_AGENTS_NO_UPDATE"] == nil,
          FileManager.default.fileExists(atPath: dir) else { return }
    let git = { (a: [String]) in self.run("/usr/bin/env", ["git", "-C", dir] + a) }
    let branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out
    guard branch == "main" else {
      if manual { tell("Not updated", "The board's checkout is on \(branch.isEmpty ? "no branch" : branch), not main. Switch to main to update it.") }
      return
    }
    guard git(["status", "--porcelain", "--untracked-files=no"]).out.isEmpty else {
      if manual { tell("Not updated", "The board's checkout has local changes. Commit or stash them, then try again.") }
      return
    }
    let before = git(["rev-parse", "HEAD"]).out
    let pull = git(["pull", "--ff-only", "--quiet"])
    let after = git(["rev-parse", "HEAD"]).out
    if pull.ok && before != after { run("/usr/bin/env", ["bun", "install"], in: dir) }
    guard manual else { return }
    if !pull.ok { return tell("Update failed", pull.out) }
    if before == after { return tell("Run My Agents is up to date", "The checkout is at the latest main.") }
    restartBoard()
    tell("Updated", "Pulled the latest main and restarted the board.")
  }

  @objc func checkForUpdates() {
    DispatchQueue.global().async {
      if self.selfUpdates() { self.checkRelease(manual: true, installNow: true, wait: 30) } else { self.pullCheckout(manual: true) }
    }
  }

  /** Stops the board this app started and starts it again, so it runs the code on disk now. */
  @objc func restartBoard() {
    DispatchQueue.global().async {
      if let s = self.server, s.isRunning { s.terminate(); s.waitUntilExit() }
      self.server = nil
      DispatchQueue.main.async { self.web.loadHTMLString(self.page("Restarting board…", ""), baseURL: nil) }
      self.ensureServer()
    }
  }

  // MARK: server
  func healthy() -> Bool {
    var req = URLRequest(url: healthURL); req.timeoutInterval = 1
    let sem = DispatchSemaphore(value: 0); var ok = false
    URLSession.shared.dataTask(with: req) { _, r, _ in ok = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 2); return ok
  }

  func ensureServer() {
    if healthy() { return DispatchQueue.main.async { self.loadBoard() } }
    let dir = ProcessInfo.processInfo.environment["RUN_MY_AGENTS_BOARD"] ?? bakedBoardDir
    let home = NSHomeDirectory()
    var env = ProcessInfo.processInfo.environment
    env["PORT"] = "\(port)"
    // Apps start with a bare PATH; add where claude, codex and bun usually live so the board can send messages.
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin:\(home)/.claude/local:\(home)/.bun/bin:\(home)/.npm-global/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    let p = Process()
    // A release app carries the board compiled into one binary (no Bun needed); a dev build runs the source.
    let bundled = Bundle.main.url(forResource: "board", withExtension: nil)
    if let bundled, ProcessInfo.processInfo.environment["RUN_MY_AGENTS_BOARD"] == nil {
      p.executableURL = bundled
    } else {
      p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      p.arguments = ["bun", "src/index.ts"]
      p.currentDirectoryURL = URL(fileURLWithPath: dir)
    }
    p.environment = env
    let log = FileManager.default.temporaryDirectory.appendingPathComponent("run-my-agents-board.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    if let h = try? FileHandle(forWritingTo: log) { p.standardOutput = h; p.standardError = h }
    do { try p.run(); server = p } catch { return fail(dir, "\(error.localizedDescription)") }
    for _ in 0..<40 {
      if healthy() { return DispatchQueue.main.async { self.loadBoard() } }
      if !p.isRunning { break }
      Thread.sleep(forTimeInterval: 0.25)
    }
    if p.isRunning { p.terminate() }
    server = nil
    fail(dir, "The board did not answer on port \(port). Log: \(log.path)")
  }

  func fail(_ dir: String, _ why: String) {
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
    let body = """
    <p>Run My Agents could not start the board server.</p><p class=e>\(esc(why))</p>
    <p>Install Bun from <a href="https://bun.sh">bun.sh</a> (<code>curl -fsSL https://bun.sh/install | bash</code>), then run:</p>
    <pre>cd \(esc(dir))\nPORT=\(port) bun src/index.ts</pre><p>and press <b>⌘R</b> to reload.</p>
    """
    DispatchQueue.main.async { self.web.loadHTMLString(self.page("Board server not running", body), baseURL: nil) }
  }

  func page(_ title: String, _ body: String) -> String {
    """
    <html><body style="background:#0b0b12;color:#e5e7eb;font:15px -apple-system;padding:64px 48px;max-width:720px">
    <style>a{color:#f472b6}pre,code{background:#16161f;border-radius:6px;padding:2px 6px}pre{padding:12px}.e{color:#fca5a5}</style>
    <h2>\(title)</h2>\(body)</body></html>
    """
  }

  func loadBoard() { web.load(URLRequest(url: boardURL)) }

  @objc func reload() {
    if web.url?.host == "127.0.0.1" { web.reload() }
    else { DispatchQueue.global().async { self.ensureServer() } }
  }

  func applicationWillTerminate(_ n: Notification) {
    if let s = server, s.isRunning { s.terminate(); s.waitUntilExit() }
    // A release downloaded while the app ran goes in now, so the next launch is the new version.
    installStaged(relaunch: false)
  }

  // MARK: UI
  func buildWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    window.title = "Run My Agents"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.minSize = NSSize(width: 720, height: 480)
    window.backgroundColor = NSColor(red: 0x0b/255, green: 0x0b/255, blue: 0x12/255, alpha: 1)
    window.isReleasedWhenClosed = false
    window.isMovableByWindowBackground = true
    window.setFrameAutosaveName("RunMyAgentsMain")
    let cfg = WKWebViewConfiguration()
    // The page asks to drag the window when you press on something that is not a control.
    cfg.userContentController.add(self, name: "drag")
    cfg.preferences.setValue(true, forKey: "javaScriptCanAccessClipboard")
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self; web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")
    window.contentView!.addSubview(web)
    window.center(); window.makeKeyAndOrderFront(nil)
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard m.name == "drag", let e = NSApp.currentEvent, e.type == .leftMouseDown || e.type == .leftMouseDragged else { return }
    window.performDrag(with: e)
  }

  // Opt-in self-check: RUN_MY_AGENTS_SNAPSHOT=/path.png writes a snapshot of the page after load.
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    guard w.url?.host == "127.0.0.1", let out = ProcessInfo.processInfo.environment["RUN_MY_AGENTS_SNAPSHOT"] else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      w.takeSnapshot(with: nil) { img, _ in
        guard let img = img, let t = img.tiffRepresentation, let r = NSBitmapImageRep(data: t) else { return }
        try? r.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
      }
    }
  }

  func isExternal(_ u: URL?) -> Bool {
    guard let u = u, let s = u.scheme, s == "http" || s == "https" else { return false }
    return !(u.host == "127.0.0.1" || u.host == "localhost")
  }

  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if isExternal(a.request.url) && (a.navigationType == .linkActivated || a.targetFrame == nil) {
      NSWorkspace.shared.open(a.request.url!); return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  // target=_blank / window.open
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { if isExternal(u) { NSWorkspace.shared.open(u) } else { w.load(a.request) } }
    return nil
  }

  // The paperclip: <input type=file> needs the app to show the open panel itself.
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    // Always answer WebKit exactly once; dropping the handler aborts the app.
    var answered = false
    let answer: ([URL]?) -> Void = { urls in
      if answered { return }
      answered = true
      completionHandler(urls)
    }
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.allowsMultipleSelection = p.allowsMultipleSelection
      panel.canChooseFiles = true
      panel.canChooseDirectories = false
      panel.prompt = "Attach"
      NSApp.activate(ignoringOtherApps: true)
      panel.begin { r in answer(r == .OK ? panel.urls : nil) }
    }
  }

  func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
      NSColor.black.setFill()
      let face = NSBezierPath(roundedRect: r.insetBy(dx: 2, dy: 2), xRadius: 4, yRadius: 4)
      face.append(NSBezierPath(ovalIn: NSRect(x: 5.5, y: 7.5, width: 2.5, height: 4)))
      face.append(NSBezierPath(ovalIn: NSRect(x: 10, y: 7.5, width: 2.5, height: 4)))
      face.windingRule = .evenOdd; face.fill(); return true
    }
    img.isTemplate = true
    statusItem.button?.image = img
    statusItem.button?.toolTip = "Run My Agents"
    let m = NSMenu()
    m.addItem(withTitle: "Open board", action: #selector(showWindow), keyEquivalent: "")
    m.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "")
    m.addItem(withTitle: "Restart Board", action: #selector(restartBoard), keyEquivalent: "")
    updateItem = m.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
    m.addItem(.separator())
    m.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    statusItem.menu = m
  }

  @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }

  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
    if !f { showWindow() }; return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

  func buildMenu() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) { let i = NSMenuItem(); let m = NSMenu(title: title); items.forEach(m.addItem); i.submenu = m; main.addItem(i) }
    func it(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
    sub("Run My Agents", [it("About Run My Agents", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      it("Check for Updates…", #selector(checkForUpdates), ""), .separator(),
      it("Hide Run My Agents", #selector(NSApplication.hide(_:)), "h"), .separator(),
      it("Quit Run My Agents", #selector(NSApplication.terminate(_:)), "q")])
    sub("File", [it("Close Window", #selector(NSWindow.performClose(_:)), "w")])
    sub("Edit", [it("Undo", Selector(("undo:")), "z"), it("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
      it("Cut", #selector(NSText.cut(_:)), "x"), it("Copy", #selector(NSText.copy(_:)), "c"),
      it("Paste", #selector(NSText.paste(_:)), "v"), it("Select All", #selector(NSText.selectAll(_:)), "a")])
    sub("View", [it("Reload", #selector(reload), "r"), it("Open Board", #selector(showWindow), "0")])
    sub("Window", [it("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")])
    NSApp.windowsMenu = main.items.last!.submenu
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
