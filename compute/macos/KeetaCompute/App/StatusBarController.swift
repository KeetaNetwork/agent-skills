import AppKit
import SwiftUI

/// The menu bar item and its popover, as in Keeta Agent. Click to open or
/// close; right-click for a menu with Quit.
@MainActor
final class StatusBarController: NSObject {
    private let popover = NSPopover()
    private let item: NSStatusItem
    private let menu = NSMenu()

    init(model: AppModel, showOnLaunch: Bool) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        let controller = NSHostingController(rootView: RootView().environmentObject(model))
        popover.contentViewController = controller
        popover.contentSize = NSSize(width: PopoverMetrics.width, height: PopoverMetrics.height)
        popover.behavior = .transient
        popover.animates = true
        popover.appearance = NSAppearance(named: .darkAqua)

        if let button = item.button {
            button.image = Self.icon
            button.toolTip = "Keeta Compute"
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        menu.addItem(withTitle: "Open Keeta Compute", action: #selector(openFromMenu), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Keeta Compute", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        PopoverHold.changed = { [weak self] held in
            // A passkey prompt takes focus; a transient popover would close under it.
            self?.popover.behavior = held ? .applicationDefined : .transient
        }

        if showOnLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.showPopover()
            }
        }
    }

    func showPopover() {
        guard let button = item.button, !popover.isShown else { return }
        // An accessory app must be active for text fields in the popover to take typing.
        NSApp.activate()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func closePopover() {
        if popover.isShown {
            popover.performClose(nil)
        }
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            closePopover()
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else if popover.isShown {
            closePopover()
        } else {
            showPopover()
        }
    }

    @objc private func openFromMenu() {
        showPopover()
    }

    /// The Keeta mark as a template image.
    private static var icon: NSImage? {
        guard let image = NSImage(named: "statusbar")?.copy() as? NSImage else {
            return NSImage(systemSymbolName: "cpu", accessibilityDescription: "Keeta Compute")
        }
        // The artwork is 42x17; fit it to the menu bar height.
        image.size = NSSize(width: 37, height: 15)
        image.isTemplate = true
        image.accessibilityDescription = "Keeta Compute"
        return image
    }
}

/// Keeps the popover open while something outside it has focus, such as the
/// system passkey prompt. Calls nest.
@MainActor
enum PopoverHold {
    private static var count = 0
    static var changed: ((Bool) -> Void)?

    static func begin() {
        count += 1
        if count == 1 { changed?(true) }
    }

    static func end() {
        guard count > 0 else { return }
        count -= 1
        if count == 0 { changed?(false) }
    }
}
