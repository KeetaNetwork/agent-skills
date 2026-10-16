import AppKit
import KeetaComputeKit
import SwiftUI

@main
struct KeetaComputeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel

    init() {
        // Writing to the agent after it exits must return EPIPE, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        let model = AppModel()
        _model = StateObject(wrappedValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        WindowGroup("Keeta Compute", id: WindowID.main) {
            RootView()
                .environmentObject(model)
        }
        .defaultSize(width: 980, height: 680)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        Window("Logs", id: WindowID.logs) {
            LogsView()
                .environmentObject(model)
        }
        .defaultSize(width: 760, height: 480)

        MenuBarExtra {
            MenuBarView()
                .environmentObject(model)
        } label: {
            MenuBarLabel()
        }
        .menuBarExtraStyle(.window)
    }
}

enum WindowID {
    static let main = "main"
    static let logs = "logs"
}

extension NSApplication {
    /// Brings the main window forward, opening one if none exists.
    @MainActor
    func showMainWindow(using openWindow: OpenWindowAction) {
        activate()
        if let window = windows.first(where: { $0.identifier?.rawValue.hasPrefix(WindowID.main) == true && $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: WindowID.main)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set once in `KeetaComputeApp.init`, before any delegate callback.
    @MainActor static var model: AppModel?
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            await AppDelegate.model?.start()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep providing from the menu bar when the window is closed.
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateNow }
        terminating = true
        Task { @MainActor in
            await AppDelegate.model?.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

/// Status item icon: the Keeta mark as a template image.
struct MenuBarLabel: View {
    var body: some View {
        if let image = Self.icon {
            Image(nsImage: image)
        } else {
            Image(systemName: "cpu")
        }
    }

    private static var icon: NSImage? {
        guard let image = NSImage(named: "statusbar")?.copy() as? NSImage else { return nil }
        // The artwork is 42x17; fit it to the menu bar height.
        image.size = NSSize(width: 37, height: 15)
        image.isTemplate = true
        return image
    }
}
