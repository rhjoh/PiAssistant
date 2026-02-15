import SwiftUI
import AppKit

@main
struct ChatAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var settings = AppSettings.shared
    
    var body: some Scene {
        WindowGroup {
            ChatView()
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 900, height: 700)
        .commands {
            CommandMenu("View") {
                Toggle("Show Thinking Blocks", isOn: $settings.showThinking)
                    .keyboardShortcut("t", modifiers: .control)
            }
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Ensure app is a regular app with dock icon
        NSApp.setActivationPolicy(.regular)
    }
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Activate the app to bring it to foreground
        NSApp.activate(ignoringOtherApps: true)
        
        // Bring window to front and make it key
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.restoreWindow()
        }
    }
    
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        restoreWindow()
        return true
    }
    
    func applicationDidBecomeActive(_ notification: Notification) {
        // Called when app becomes active (from skhd toggle, dock click, etc)
        // Only restore window if it exists and is minimized - don't force re-activation
        guard let window = NSApp.windows.first else { return }
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
    }
    
    private func restoreWindow() {
        guard let window = NSApp.windows.first else { return }
        
        // Deminimize if minimized
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        
        // Make sure it's visible and key
        window.makeKeyAndOrderFront(nil)
        window.level = .normal
        
        // Only force activation on initial launch, not on every window restore
        // This prevents fighting with workspace switches via skhd
        if !NSApp.isActive {
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
