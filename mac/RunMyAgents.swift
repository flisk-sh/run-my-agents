// Run My Agents: a native macOS window around the local board (http://127.0.0.1:4100/).
import AppKit
import WebKit

let port = 4100
let boardURL = URL(string: "http://127.0.0.1:\(port)/")!
let healthURL = URL(string: "http://127.0.0.1:\(port)/health")!
// BAKED_BOARD_DIR is replaced by build.sh
let bakedBoardDir = "__BAKED_BOARD_DIR__"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var web: WKWebView!
  var statusItem: NSStatusItem!
  var server: Process?

  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.appearance = NSAppearance(named: .darkAqua)
    buildMenu(); buildWindow(); buildStatusItem()
    web.loadHTMLString(page("Starting board…", ""), baseURL: nil)
    DispatchQueue.global().async { self.ensureServer() }
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
    sub("Run My Agents", [it("About Run My Agents", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""), .separator(),
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
