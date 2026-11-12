import AppKit
import Combine
import SwiftUI

struct ModelSelection: Decodable, Equatable {
    let model: String
    let effort: String
}

struct ModelEffort: Decodable, Identifiable {
    let id: String
    let verified: Bool
    let status: String?
    let code: String?
}

struct ModelOption: Decodable, Identifiable {
    let id: String
    let proxyListed: Bool?
    let efforts: [ModelEffort]
}

struct ModelSettings: Decodable {
    let selection: ModelSelection
    let models: [ModelOption]
    let testing: Bool
}

struct ServiceState: Decodable {
    var state: String
    var code: String? = nil
    var url: String? = nil
    var anthropicURL: String? = nil
    var expires: String? = nil
    var key: String? = nil
    var restart: Bool? = nil
    var fatal: Bool? = nil
    var modelSettings: ModelSettings? = nil
    var modelError: String? = nil

    var browserURL: URL? {
        guard state == "pending", url == "https://auth.openai.com/codex/device" else { return nil }
        return URL(string: "https://auth.openai.com/codex/device")
    }
}

enum CopyTarget: String {
    case openai, anthropic, apiKey, deviceCode, connection

    var isSecret: Bool { self != .openai && self != .anthropic }
}

enum GatewayEndpoint: String, CaseIterable, Identifiable {
    case openai, anthropic

    var id: String { rawValue }
    var name: String { self == .openai ? "OpenAI" : "Anthropic" }
    var copyTarget: CopyTarget { self == .openai ? .openai : .anthropic }

    func url(in state: ServiceState) -> String? {
        self == .openai ? state.url : state.anthropicURL
    }
}

@MainActor
final class ServiceController: ObservableObject {
    @Published private(set) var status = ServiceState(state: "loading")
    @Published private(set) var noticeKey: String?
    private var process: Process?
    private var input: Pipe?
    private var buffer = Data()
    private var openedCode: String?
    private var quitting = false
    private var shutdownComplete: (() -> Void)?

    func launch() {
        guard process == nil, !quitting,
              let resources = Bundle.main.resourceURL,
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return
        }
        let directory = support.appendingPathComponent("Local Responses Gateway", isDirectory: true)
        let executables = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS")
        let process = Process()
        let input = Pipe(), output = Pipe()
        process.executableURL = executables.appendingPathComponent("node")
        process.arguments = [
            resources.appendingPathComponent("Gateway/scripts/desktop-entry.mjs").path,
            directory.path,
            executables.appendingPathComponent("cliproxyapi").path
        ]
        process.currentDirectoryURL = resources
        process.environment = [
            "HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(), "NO_PROXY": "127.0.0.1,localhost,::1"
        ]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                output.fileHandleForReading.readabilityHandler = nil
                self?.terminated()
            }
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                DispatchQueue.main.async { self?.receive(data) }
            }
        }
        do {
            buffer.removeAll()
            try process.run()
            self.process = process
            self.input = input
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            status = ServiceState(state: "error", code: "desktop_start_failed", fatal: true)
        }
    }

    func send(_ command: String) {
        guard let input, !quitting else { return }
        do {
            try input.fileHandleForWriting.write(contentsOf: Data((command + "\n").utf8))
            noticeKey = nil
            switch command {
            case "connect": status = ServiceState(state: "authorizing")
            case "disconnect", "cancel": status = ServiceState(state: "stopping")
            case let command where command.hasPrefix("{"): break
            default: status = ServiceState(state: "starting")
            }
        } catch {
            status = ServiceState(state: "error", code: "desktop_pipe_closed", fatal: true)
        }
    }

    func modelAction(_ action: String, model: String, effort: String) {
        guard let payload = try? JSONEncoder().encode(["action": action, "model": model, "effort": effort]),
              let command = String(data: payload, encoding: .utf8) else { return }
        send(command)
    }

    private func receive(_ bytes: Data) {
        buffer.append(bytes)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard let next = try? JSONDecoder().decode(ServiceState.self, from: line) else { continue }
            status = next
            if let browserURL = next.browserURL, let code = next.code, openedCode != code {
                openedCode = code
                if !NSWorkspace.shared.open(browserURL) { noticeKey = "notice.openAuthorization" }
            }
        }
        if buffer.count > 16384 { buffer.removeAll() }
    }

    private func terminated() {
        process = nil
        input = nil
        if quitting {
            shutdownComplete?()
            shutdownComplete = nil
        } else if status.fatal != true {
            status = ServiceState(state: "error", code: "desktop_exited", fatal: true)
        }
    }

    func retryLaunch() {
        guard process == nil else { return }
        status = ServiceState(state: "loading")
        launch()
    }

    func shutdown(_ completion: @escaping () -> Void) -> Bool {
        guard let process, process.isRunning else { return false }
        quitting = true
        shutdownComplete = completion
        try? input?.fileHandleForWriting.close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 16) { [weak self] in
            if let self, let process = self.process, process.isRunning { process.terminate() }
        }
        return true
    }

    func openBrowser() {
        if let url = status.browserURL, !NSWorkspace.shared.open(url) { noticeKey = "notice.browserFailed" }
    }

    func copyConnection(_ endpoint: GatewayEndpoint) {
        guard status.state == "running", let url = endpoint.url(in: status), let key = status.key else { return }
        copy("Base URL: \(url)\nAPI Key: \(key)", target: .connection)
    }

    func copy(_ value: String, target: CopyTarget) {
        let clipboard = NSPasteboard.general
        clipboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(value, forType: .string)
        if target.isSecret {
            item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        }
        clipboard.writeObjects([item])
        noticeKey = "copied." + target.rawValue
        if target.isSecret {
            let count = clipboard.changeCount
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                if clipboard.changeCount == count { clipboard.clearContents() }
            }
        }
    }
}

struct ModelControls: View {
    let text: InterfaceStrings
    let settings: ModelSettings
    let error: String?
    let action: (String, String, String) -> Void
    @State private var model: String
    @State private var effort: String

    init(text: InterfaceStrings, settings: ModelSettings, error: String?, action: @escaping (String, String, String) -> Void) {
        self.text = text
        self.settings = settings
        self.error = error
        self.action = action
        _model = State(initialValue: settings.selection.model)
        _effort = State(initialValue: settings.selection.effort)
    }

    private var efforts: [ModelEffort] { settings.models.first { $0.id == model }?.efforts ?? [] }
    private var choice: ModelEffort? { efforts.first { $0.id == effort } }
    private var proxyListed: Bool? { settings.models.first { $0.id == model }?.proxyListed }
    private var applied: Bool { settings.selection == ModelSelection(model: model, effort: effort) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Picker(text("model.default"), selection: $model) {
                    ForEach(settings.models) { option in Text(option.id).tag(option.id) }
                }
                Picker(text("model.effort"), selection: $effort) {
                    ForEach(efforts) { option in Text(effortLabel(option.id)).tag(option.id) }
                }
            }
            .pickerStyle(.menu)
            .onChange(of: model) { _, next in
                if next == settings.selection.model { effort = settings.selection.effort }
                else { effort = efforts.first(where: { $0.verified })?.id ?? efforts.first(where: { $0.id == "low" })?.id ?? "low" }
            }
            .onChange(of: settings.selection) { _, next in model = next.model; effort = next.effort }

            Text(resultText).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(text("model.test")) { action("test", model, effort) }
                    .disabled(settings.testing || choice == nil || proxyListed == false)
                Button(text("model.apply")) { action("apply", model, effort) }
                    .disabled(settings.testing || choice?.verified != true || applied)
            }
            Text(text("model.hint", "local-default"))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func effortLabel(_ id: String) -> String {
        guard let name = text.optional("effort." + id) else { return id }
        return text("effort.named", name, id)
    }

    private var resultText: String {
        if let code = error ?? choice?.code {
            return text.optional("error." + code) ?? text("error.operationCode", code)
        }
        if settings.testing { return text("model.testing") }
        if applied { return text(choice?.verified == true ? "model.current" : "model.testDefault") }
        return text(choice?.verified == true ? "model.verified" : "model.unverified")
    }
}

struct GatewayView: View {
    @ObservedObject var controller: ServiceController
    @ObservedObject var language: InterfaceLanguage
    @State private var showKey = false
    @State private var confirmDisconnect = false

    private var status: ServiceState { controller.status }
    private var text: InterfaceStrings { language.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 46, height: 46)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Responses API").font(.title2.bold())
                    Text(text("window.subtitle")).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 10)
                Picker(text("language.label"),
                       selection: Binding(get: { language.selection }, set: language.select)) {
                    ForEach(AppLanguage.allCases) { option in
                        Text(verbatim: option.name).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .menuOrder(.fixed)
                .labelsHidden()
                .frame(width: 106)
                .accessibilityLabel(text("language.label"))
                .help(text("language.help"))
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if status.state == "running" { connectionControls }
            Text(text(controller.noticeKey ?? "window.footer"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .onChange(of: status.state) { _, _ in showKey = false }
        .confirmationDialog(text("disconnect.title"), isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button(text("disconnect.confirm"), role: .destructive) { controller.send("disconnect") }
            Button(text("action.cancel"), role: .cancel) {}
        } message: {
            Text(text("disconnect.message"))
        }
        .environment(\.locale, text.locale)
    }

    @ViewBuilder private var content: some View {
        switch status.state {
        case "pending":
            Text(text("auth.title")).font(.headline)
            Text(text("auth.instructions")).foregroundStyle(.secondary)
            if let code = status.code {
                HStack {
                    Text(verbatim: code).font(.system(.title2, design: .monospaced).bold()).textSelection(.enabled)
                    Spacer()
                    Button(text("copy.deviceCode")) { controller.copy(code, target: .deviceCode) }
                }
            }
            HStack {
                Button(text("auth.open"), action: controller.openBrowser).buttonStyle(.borderedProminent)
                Button(text("auth.cancel")) { controller.send("cancel") }
            }
        case "running":
            Label(text.status("running"), systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.headline)
            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(GatewayEndpoint.allCases) { endpoint in
                        if let url = endpoint.url(in: status) { row(endpoint.name, value: url, target: endpoint.copyTarget) }
                    }
                    if let key = status.key {
                        row(text("key.label"), value: showKey ? key : String(repeating: "•", count: 24),
                            target: .apiKey, copiedValue: key)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label(text("connection.title"), systemImage: "link")
            }
            if let settings = status.modelSettings {
                GroupBox {
                    ModelControls(text: text, settings: settings, error: status.modelError, action: controller.modelAction)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Label(text("model.title"), systemImage: "slider.horizontal.3")
                }
            }
        case "reconnect":
            Text(text("status.reconnect")).font(.headline)
            Text(text("auth.reconnectInstructions")).foregroundStyle(.secondary)
            connectButton("auth.reconnect")
        case "error":
            Text(text("error.title")).font(.headline)
            Text(description(for: status.code)).foregroundStyle(.secondary)
            if status.fatal == true {
                Button(text("error.restartHelper"), action: controller.retryLaunch)
            } else if status.restart == true {
                HStack {
                    Button(text("error.retryStart")) { controller.send("restart") }.buttonStyle(.borderedProminent)
                    if status.code == "stack_port_in_use" {
                        Button(text("error.changePorts")) { controller.send("change_ports") }
                    }
                    Button(text("disconnect.action")) { confirmDisconnect = true }
                }
            } else {
                connectButton("auth.reconnect")
            }
        case "disconnected":
            Text(text("auth.connectTitle")).font(.headline)
            Text(status.code.map { description(for: $0) } ?? text("auth.connectInstructions"))
                .foregroundStyle(.secondary)
            connectButton("auth.connect")
        default:
            HStack(spacing: 12) {
                ProgressView().controlSize(.small).accessibilityHidden(true)
                Text(text.status(status.state))
            }
        }
    }

    private var connectionControls: some View {
        HStack {
            if status.key != nil {
                Menu {
                    ForEach(GatewayEndpoint.allCases) { endpoint in
                        Button(endpoint.name) { controller.copyConnection(endpoint) }
                            .disabled(endpoint.url(in: status) == nil)
                    }
                } label: {
                    Label(text("connection.copy"), systemImage: "document.on.document")
                }
                .fixedSize()
            }
            Spacer()
            Button(text("disconnect.action")) { confirmDisconnect = true }
        }
    }

    private func connectButton(_ titleKey: String) -> some View {
        Button(text(titleKey)) { controller.send("connect") }.buttonStyle(.borderedProminent)
    }

    private func row(_ label: String, value: String, target: CopyTarget, copiedValue: String? = nil) -> some View {
        HStack(spacing: 12) {
            Text(label).frame(width: 105, alignment: .leading).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: value).font(.system(.callout, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            Spacer()
            if target == .apiKey {
                let visibility = text(showKey ? "key.hide" : "key.show")
                Button { showKey.toggle() } label: {
                    Image(systemName: showKey ? "eye.slash" : "eye")
                }
                .help(visibility)
                .accessibilityLabel(visibility)
            }
            Button(text("copy.button")) { controller.copy(copiedValue ?? value, target: target) }
                .accessibilityLabel(text("copy." + target.rawValue))
        }
    }

    private func description(for code: String?) -> String {
        guard let code else { return text("error.retry") }
        return text.optional("error." + code) ?? text("error.retryCode", code)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let controller = ServiceController()
    let language: InterfaceLanguage
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private let serviceMenuItem = NSMenuItem()
    private let openMenuItem = NSMenuItem(title: "", action: #selector(showWindow), keyEquivalent: "")
    private let quitMenuItem = NSMenuItem(title: "", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    private let appQuitMenuItem = NSMenuItem(title: "", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    private lazy var connectionMenuItems = GatewayEndpoint.allCases.map { endpoint in
        let item = NSMenuItem(title: "", action: #selector(copyConnectionFromMenu(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = endpoint.rawValue
        return (endpoint, item)
    }
    private var menuSubscription: AnyCancellable?
    private lazy var statusImages: (running: NSImage?, waiting: NSImage?) = {
        guard let symbol = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted",
                                   accessibilityDescription: "Responses API") else { return (nil, nil) }
        // Keep native symbol alignment and match the status button's light and dark template tint.
        let ink = NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return NSColor.white.withAlphaComponent(0.9)
            }
            return NSColor.black.withAlphaComponent(0.85)
        }
        // The symbol's primary layer draws the rings. Its secondary layer draws the links.
        let waiting = symbol.withSymbolConfiguration(.init(paletteColors: [ink, .clear]))
        waiting?.isTemplate = true
        symbol.isTemplate = true
        return (symbol, waiting)
    }()

    init(defaults: UserDefaults = .standard) {
        language = InterfaceLanguage(defaults: defaults)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let initialSize = NSSize(width: 660, height: 500)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        window.title = "Responses API"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let host = NSHostingController(rootView: GatewayView(controller: controller, language: language))
        host.sizingOptions = []
        window.contentViewController = host
        window.contentMinSize = NSSize(width: 580, height: 430)
        window.setContentSize(initialSize)
        window.center()
        self.window = window
        configureMenus()
        showWindow()
        controller.launch()
    }

    private func configureMenus() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appQuitMenuItem.target = NSApp
        appMenu.addItem(appQuitMenuItem)
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)
        NSApp.mainMenu = mainMenu

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        serviceMenuItem.isEnabled = false
        menu.addItem(serviceMenuItem)
        menu.addItem(.separator())
        openMenuItem.target = self
        quitMenuItem.target = NSApp
        menu.addItem(openMenuItem)
        for (_, item) in connectionMenuItems { menu.addItem(item) }
        menu.addItem(.separator())
        menu.addItem(quitMenuItem)
        item.menu = menu
        statusItem = item
        updateMenus(for: controller.status.state, language: language.selection)
        menuSubscription = controller.$status
            .map(\.state)
            .removeDuplicates()
            .combineLatest(language.$selection)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state, selection in self?.updateMenus(for: state, language: selection) }
    }

    private func updateMenus(for state: String, language selection: AppLanguage) {
        let text = language.strings(for: selection)
        let title = text.status(state)
        serviceMenuItem.title = title
        openMenuItem.title = text("menu.open")
        for (endpoint, item) in connectionMenuItems {
            item.title = text("menu.copyConnection", endpoint.name)
            item.isHidden = state != "running"
        }
        let quit = text("menu.quit", "Responses API")
        quitMenuItem.title = quit
        appQuitMenuItem.title = quit
        window?.standardWindowButton(.closeButton)?.setAccessibilityLabel(text("window.close"))
        window?.standardWindowButton(.miniaturizeButton)?.setAccessibilityLabel(text("window.minimize"))
        window?.standardWindowButton(.zoomButton)?.setAccessibilityLabel(text("window.zoom"))
        guard let button = statusItem?.button else { return }
        let image = state == "running" ? statusImages.running : statusImages.waiting
        if button.image !== image { button.image = image }
        button.title = image == nil ? "R" : ""
        button.toolTip = text("menu.tooltip", "Responses API", title)
        button.setAccessibilityLabel(button.toolTip)
    }

    @objc private func copyConnectionFromMenu(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String, let endpoint = GatewayEndpoint(rawValue: value) else { return }
        controller.copyConnection(endpoint)
    }

    @objc private func showWindow() {
        guard let window else { return }
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow, closingWindow === window else { return }
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        controller.shutdown { sender.reply(toApplicationShouldTerminate: true) } ? .terminateLater : .terminateNow
    }
}

@main
struct ResponsesDesktop {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
