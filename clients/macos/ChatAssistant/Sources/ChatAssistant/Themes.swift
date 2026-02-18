import SwiftUI

// MARK: - Theme Definition
struct Theme {
    // Name & Icon
    let name: String
    let icon: String
    
    // Colors
    let background: Color
    let userBubble: Color
    let userBubbleBorder: Color
    let assistantBubble: Color
    let assistantBubbleBorder: Color
    let thinkingBlock: Color
    let thinkingBlockBorder: Color
    let toolCall: Color
    let toolCallBackground: Color
    let toolCallBorder: Color
    let toolResult: Color
    let toolResultBackground: Color
    let toolResultBorder: Color
    let textPrimary: Color
    let textSecondary: Color
    let border: Color
    let inputBackground: Color
    let inputBorder: Color
    let headerBackground: Color
    let heartbeat: Color
    let heartbeatBackground: Color
    let codeText: Color
    let codeBackground: Color
    
    // Fonts
    let bodyFont: String
    let codeFont: String
    let captionFont: String
    
    // Geometry
    let cornerRadius: CGFloat
    
    // MARK: - Font Helpers
    func body(size: CGFloat) -> Font {
        if bodyFont == ".SFUI-Regular" {
            return .system(size: size)
        }
        return Font.custom(bodyFont, size: size)
    }
    
    func code(size: CGFloat) -> Font {
        if codeFont == ".SFUI-Regular" {
            return .system(size: size, design: .monospaced)
        }
        return Font.custom(codeFont, size: size)
    }
    
    func caption(size: CGFloat) -> Font {
        if captionFont == ".SFUI-Regular" {
            return .system(size: size)
        }
        return Font.custom(captionFont, size: size)
    }
}

// MARK: - Predefined Themes
extension Theme {
    static let standard = Theme(
        name: "Standard",
        icon: "sun.max.fill",
        
        // Colors - System defaults
        background: Color(NSColor.windowBackgroundColor),
        userBubble: Color.blue,
        userBubbleBorder: Color.clear,
        assistantBubble: Color.gray.opacity(0.15),
        assistantBubbleBorder: Color.clear,
        thinkingBlock: Color.purple.opacity(0.06),
        thinkingBlockBorder: Color.purple.opacity(0.25),
        toolCall: Color.green,
        toolCallBackground: Color.green.opacity(0.15),
        toolCallBorder: Color.green.opacity(0.4),
        toolResult: Color.green,
        toolResultBackground: Color.green.opacity(0.12),
        toolResultBorder: Color.green.opacity(0.35),
        textPrimary: Color.primary,
        textSecondary: Color.secondary,
        border: Color.gray.opacity(0.2),
        inputBackground: Color(NSColor.controlBackgroundColor),
        inputBorder: Color.gray.opacity(0.3),
        headerBackground: Color(NSColor.controlBackgroundColor),
        heartbeat: Color.pink,
        heartbeatBackground: Color.pink.opacity(0.1),
        codeText: Color.primary,
        codeBackground: Color.black.opacity(0.06),
        
        // Fonts - System
        bodyFont: ".SFUI-Regular",
        codeFont: ".SFUI-Regular",
        captionFont: ".SFUI-Regular",
        
        // Geometry
        cornerRadius: 10
    )
    
    static let terminal = Theme(
        name: "Terminal",
        icon: "keyboard.fill",
        
        // Colors - Dark TUI style
        background: Color(hex: "#0D0D12"),
        userBubble: Color(hex: "#4A6FA5"),
        userBubbleBorder: Color(hex: "#6B8FC7").opacity(0.5),
        assistantBubble: Color(hex: "#1A1A24"),
        assistantBubbleBorder: Color(hex: "#2D2D3D"),
        thinkingBlock: Color(hex: "#2D1F3D"),
        thinkingBlockBorder: Color(hex: "#4A3A5C"),
        toolCall: Color(hex: "#5A8F5A"),
        toolCallBackground: Color(hex: "#1A2A1A"),
        toolCallBorder: Color(hex: "#3A5A3A"),
        toolResult: Color(hex: "#6B9B6B"),
        toolResultBackground: Color(hex: "#1A2A1A"),
        toolResultBorder: Color(hex: "#3A5A3A"),
        textPrimary: Color(hex: "#E8E8ED"),
        textSecondary: Color(hex: "#8E8E93"),
        border: Color(hex: "#2D2D3D"),
        inputBackground: Color(hex: "#14141C"),
        inputBorder: Color(hex: "#2D2D3D"),
        headerBackground: Color(hex: "#111118"),
        heartbeat: Color(hex: "#FF6B9D"),
        heartbeatBackground: Color(hex: "#3D1F2D"),
        codeText: Color.white,
        codeBackground: Color(hex: "#0F1A0F"),
        
        // Fonts - Menlo (Terminal.app default, highly readable)
        bodyFont: "Menlo",
        codeFont: "Menlo",
        captionFont: "Menlo",
        
        // Geometry
        cornerRadius: 2
    )
}

// MARK: - Theme Enum
enum AppTheme: String, CaseIterable {
    case standard
    case terminal
    
    var theme: Theme {
        switch self {
        case .standard:
            return .standard
        case .terminal:
            return .terminal
        }
    }
}

// MARK: - Color Hex Helper
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (1, 1, 1, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}
