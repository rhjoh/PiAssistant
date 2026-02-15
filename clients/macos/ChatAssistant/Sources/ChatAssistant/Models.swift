import Foundation
import AppKit

// MARK: - Message Models

enum MessageRole {
    case user
    case assistant
}

// MARK: - Image Attachment

struct ImageAttachment: Identifiable {
    let id = UUID()
    let nsImage: NSImage
    let base64String: String
    let mimeType: String
    let fileSize: Int
    
    var fileSizeFormatted: String {
        if fileSize < 1024 {
            return "\(fileSize) B"
        } else if fileSize < 1024 * 1024 {
            return String(format: "%.1f KB", Double(fileSize) / 1024)
        } else {
            return String(format: "%.1f MB", Double(fileSize) / (1024 * 1024))
        }
    }
    
    static func from(nsImage: NSImage, mimeType: String = "image/png") -> ImageAttachment? {
        guard let tiffData = nsImage.tiffRepresentation else { return nil }
        guard let bitmap = NSBitmapImageRep(data: tiffData) else { return nil }
        
        let data: Data?
        switch mimeType {
        case "image/jpeg":
            data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9])
        case "image/png":
            fallthrough
        default:
            data = bitmap.representation(using: .png, properties: [:])
        }
        
        guard let imageData = data else { return nil }
        let base64 = imageData.base64EncodedString()
        
        return ImageAttachment(
            nsImage: nsImage,
            base64String: base64,
            mimeType: mimeType,
            fileSize: imageData.count
        )
    }
    
    static func from(fileURL: URL) -> ImageAttachment? {
        guard let image = NSImage(contentsOf: fileURL) else { return nil }
        
        // Determine mime type from extension
        let ext = fileURL.pathExtension.lowercased()
        let mimeType: String
        switch ext {
        case "jpg", "jpeg":
            mimeType = "image/jpeg"
        case "png":
            mimeType = "image/png"
        case "gif":
            mimeType = "image/gif"
        case "webp":
            mimeType = "image/webp"
        default:
            mimeType = "image/png"
        }
        
        return from(nsImage: image, mimeType: mimeType)
    }
    
    static func from(pasteboard: NSPasteboard) -> [ImageAttachment] {
        var attachments: [ImageAttachment] = []
        
        // Try to get images directly
        if let images = pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage] {
            for image in images {
                if let attachment = from(nsImage: image) {
                    attachments.append(attachment)
                }
            }
        }
        
        // Also try file URLs (for dragged files or copied files)
        if attachments.isEmpty, let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] {
            for url in urls where url.isFileURL {
                if let attachment = from(fileURL: url) {
                    attachments.append(attachment)
                }
            }
        }
        
        return attachments
    }
}

enum ContentItem: Equatable, Identifiable {
    case text(String)
    case image(source: String)
    case thinking(String, isComplete: Bool)
    case toolCall(id: String, name: String, arguments: String)
    case toolResult(toolCallId: String, toolName: String, content: String, isError: Bool)
    
    var id: String {
        switch self {
        case .text(let content):
            return "text-\(content.hashValue)"
        case .image(let source):
            return "image-\(source.hashValue)"
        case .thinking(let content, let isComplete):
            return "thinking-\(content.hashValue)-\(isComplete)"
        case .toolCall(let id, _, _):
            return "tool-\(id)"
        case .toolResult(let toolCallId, _, _, _):
            return "result-\(toolCallId)"
        }
    }
    
    var isEmptyThinking: Bool {
        if case .thinking(let content, _) = self {
            return content.isEmpty
        }
        return false
    }
    
    var isThinking: Bool {
        if case .thinking(_, _) = self {
            return true
        }
        return false
    }
}

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: MessageRole
    var items: [ContentItem]
    let timestamp = Date()
    var isStreaming = false
}

// MARK: - WebSocket Message Types

enum WSClientMessage: Encodable {
    case prompt(message: String, id: String?)
    case promptWithImages(message: String, images: [ImageAttachment], id: String?)
    case abort
    case getState
    case getHistory(limit: Int?)
    case command(command: String, args: [String]?)
    
    enum CodingKeys: String, CodingKey {
        case type, message, id, limit, command, args, images
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        
        switch self {
        case .prompt(let message, let id):
            try container.encode("prompt", forKey: .type)
            try container.encode(message, forKey: .message)
            if let id = id {
                try container.encode(id, forKey: .id)
            }
        case .promptWithImages(let message, let imageAttachments, let id):
            try container.encode("prompt_with_images", forKey: .type)
            try container.encode(message, forKey: .message)
            if let id = id {
                try container.encode(id, forKey: .id)
            }
            // Encode images as array of objects with data and mimeType
            let imageDicts = imageAttachments.map { ["data": $0.base64String, "mimeType": $0.mimeType] }
            try container.encode(imageDicts, forKey: .images)
        case .abort:
            try container.encode("abort", forKey: .type)
        case .getState:
            try container.encode("get_state", forKey: .type)
        case .getHistory(let limit):
            try container.encode("get_history", forKey: .type)
            if let limit = limit {
                try container.encode(limit, forKey: .limit)
            }
        case .command(let command, let args):
            try container.encode("command", forKey: .type)
            try container.encode(command, forKey: .command)
            if let args = args {
                try container.encode(args, forKey: .args)
            }
        }
    }
}

// Data wrapper structs for nested decoding
struct TextDeltaData: Decodable {
    let content: String
}

struct ThinkingDeltaData: Decodable {
    let content: String
}

struct ThinkingDoneData: Decodable {
    let content: String
}

struct ToolStartData: Decodable {
    let toolCallId: String
    let toolName: String
    let args: AnyCodable?
    let label: String
}

struct ToolOutputData: Decodable {
    let toolCallId: String
    let output: String
    let truncated: Bool?
}

struct ToolEndData: Decodable {
    let toolCallId: String
    let toolName: String
}

struct ErrorData: Decodable {
    let message: String
}

struct ImageData: Decodable {
    let source: String
    let alt: String?
}

struct TokenUsageData: Decodable {
    let input: Int?
    let output: Int?
    let cacheRead: Int?
    let cacheWrite: Int?
    let total: Int?
    let cost: Double?
}

struct DoneData: Decodable {
    let finalText: String
    let usage: TokenUsageData?
}

struct HistoryData: Decodable {
    let messages: [AnyCodable]
}

enum WSServerMessage: Decodable {
    case connection(data: WSConnectionData)
    case textDelta(content: String)
    case thinkingDelta(content: String)
    case thinkingDone(content: String)
    case toolStart(toolCallId: String, toolName: String, args: AnyCodable?, label: String)
    case toolOutput(toolCallId: String, output: String, truncated: Bool?)
    case toolEnd(toolCallId: String, toolName: String)
    case image(source: String, alt: String?)
    case error(message: String)
    case done(finalText: String, usage: TokenUsageData?)
    case state(data: WSStateData)
    case history(messages: [AnyCodable])
    
    enum CodingKeys: String, CodingKey {
        case type, data
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        
        switch type {
        case "connection":
            let data = try container.decode(WSConnectionData.self, forKey: .data)
            self = .connection(data: data)
        case "text_delta":
            let data = try container.decode(TextDeltaData.self, forKey: .data)
            self = .textDelta(content: data.content)
        case "thinking_delta":
            let data = try container.decode(ThinkingDeltaData.self, forKey: .data)
            self = .thinkingDelta(content: data.content)
        case "thinking_done":
            let data = try container.decode(ThinkingDoneData.self, forKey: .data)
            self = .thinkingDone(content: data.content)
        case "tool_start":
            let data = try container.decode(ToolStartData.self, forKey: .data)
            self = .toolStart(toolCallId: data.toolCallId, toolName: data.toolName, args: data.args, label: data.label)
        case "tool_output":
            let data = try container.decode(ToolOutputData.self, forKey: .data)
            self = .toolOutput(toolCallId: data.toolCallId, output: data.output, truncated: data.truncated)
        case "tool_end":
            let data = try container.decode(ToolEndData.self, forKey: .data)
            self = .toolEnd(toolCallId: data.toolCallId, toolName: data.toolName)
        case "image":
            let data = try container.decode(ImageData.self, forKey: .data)
            self = .image(source: data.source, alt: data.alt)
        case "error":
            let data = try container.decode(ErrorData.self, forKey: .data)
            self = .error(message: data.message)
        case "done":
            let data = try container.decode(DoneData.self, forKey: .data)
            self = .done(finalText: data.finalText, usage: data.usage)
        case "state":
            let data = try container.decode(WSStateData.self, forKey: .data)
            self = .state(data: data)
        case "history":
            let data = try container.decode(HistoryData.self, forKey: .data)
            self = .history(messages: data.messages)
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown message type: \(type)")
        }
    }
}

struct WSConnectionData: Decodable {
    let connected: Bool
    let model: String?
    let provider: String?
}

struct WSStateData: Decodable {
    let model: String?
    let provider: String?
    let contextTokens: Int?
    let isProcessing: Bool
}

// MARK: - Helper Types

struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            value = NSNull()
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}

// MARK: - Connection State

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected(model: String?)
    case error(String)
}

// MARK: - Token Usage

struct TokenUsage: Equatable {
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var cacheReadTokens: Int = 0
    var cacheWriteTokens: Int = 0
    
    var totalTokens: Int {
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    }
    
    var formatted: String {
        var parts: [String] = []
        if inputTokens > 0 {
            parts.append("↑ \(formatNumber(inputTokens))")
        }
        if outputTokens > 0 {
            parts.append("↓ \(formatNumber(outputTokens))")
        }
        if cacheReadTokens > 0 {
            parts.append("📖 \(formatNumber(cacheReadTokens))")
        }
        return parts.isEmpty ? "No usage data" : parts.joined(separator: "  ")
    }
    
    private func formatNumber(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        return String(format: "%.1fk", Double(n) / 1000)
    }
}

// MARK: - Slash Commands

struct SlashCommand: Identifiable {
    let id = UUID()
    let name: String
    let description: String
    let usage: String
    
    static let allCommands: [SlashCommand] = [
        SlashCommand(
            name: "status",
            description: "Show gateway status and current model",
            usage: "/status"
        ),
        SlashCommand(
            name: "model",
            description: "View or change the current AI model",
            usage: "/model [list|<number>]"
        ),
        SlashCommand(
            name: "session",
            description: "Show session info, context stats, and archive status",
            usage: "/session"
        ),
        SlashCommand(
            name: "new",
            description: "Archive current session and start a fresh one",
            usage: "/new"
        ),
        SlashCommand(
            name: "takeover",
            description: "Force-kill TUI and reclaim session",
            usage: "/takeover"
        ),
        SlashCommand(
            name: "clear",
            description: "Clear the chat history from view",
            usage: "/clear"
        ),
        SlashCommand(
            name: "help",
            description: "Show available commands",
            usage: "/help"
        )
    ]
    
    /// Fuzzy match command against a query string
    func matches(query: String) -> Bool {
        let lowerQuery = query.lowercased()
        return name.lowercased().contains(lowerQuery) ||
               description.lowercased().contains(lowerQuery)
    }
}

// MARK: - App Settings

class AppSettings: ObservableObject {
    @Published var showThinking: Bool = true
    @Published var zoomLevel: Double = 1.0
    
    static let shared = AppSettings()
    
    private init() {}
    
    func zoomIn() {
        zoomLevel = min(zoomLevel + 0.1, 2.0)
    }
    
    func zoomOut() {
        zoomLevel = max(zoomLevel - 0.1, 0.5)
    }
    
    func resetZoom() {
        zoomLevel = 1.0
    }
}
