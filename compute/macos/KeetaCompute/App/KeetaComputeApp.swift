import AppKit
import KeetaComputeKit
import SwiftUI

/// A menu bar app, like Keeta Agent: no Dock icon and no main window
/// (`LSUIElement` in Info.plist). Everything happens in the status item's popover.
@main
struct KeetaComputeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Writing to the agent after it exits must return EPIPE, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        #if DEBUG
        if Snapshots.directory != nil {
            AppDelegate.model = Snapshots.makeModel()
            return
        }
        #endif
        AppDelegate.model = AppModel()
    }

    var body: some Scene {
        // SwiftUI needs a scene; this one opens no window.
        Settings {
            EmptyView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set once in `KeetaComputeApp.init`, before any delegate callback.
    @MainActor static var model: AppModel?
    @MainActor static weak var shared: AppDelegate?
    @MainActor private var statusBar: StatusBarController?
    @MainActor private var logsWindow: NSWindow?
    private var terminating = false

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        NSApp.setActivationPolicy(.accessory)
        NSWindow.allowsAutomaticWindowTabbing = false
        guard let model = AppDelegate.model else { return }
        #if DEBUG
        if let directory = Snapshots.directory {
            Task { @MainActor in
                await Snapshots.run(model, into: directory)
                exit(0)
            }
            return
        }
        #endif
        // First launch: open the popover so setup is the first thing people see.
        statusBar = StatusBarController(model: model, showOnLaunch: !model.onboardingComplete)
        Task { @MainActor in
            await model.start()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep providing from the menu bar when the logs window is closed.
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

    /// Opening the app again (Finder, Spotlight, login item) shows the popover.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Task { @MainActor in
            self.statusBar?.showPopover()
        }
        return false
    }

    /// The agent's and app's log lines, in their own window.
    @MainActor
    func showLogs() {
        guard let model = AppDelegate.model else { return }
        if logsWindow == nil {
            let controller = NSHostingController(rootView: LogsView().environmentObject(model))
            let window = NSWindow(contentViewController: controller)
            window.title = "Keeta Compute Logs"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 760, height: 480))
            window.isReleasedWhenClosed = false
            window.center()
            logsWindow = window
        }
        statusBar?.closePopover()
        NSApp.activate()
        logsWindow?.makeKeyAndOrderFront(nil)
    }
}
