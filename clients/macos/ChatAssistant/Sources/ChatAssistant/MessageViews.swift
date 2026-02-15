import SwiftUI
import AppKit

// MARK: - Message View (handles all content types)
struct MessageView: View {
    let message: ChatMessage
    var showThinking: Bool = true
    var zoomLevel: Double = 1.0
    
    var body: some View {
        HStack {
            if message.role == .user {
                Spacer()
            }
            
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8 * zoomLevel) {
                ForEach(message.items) { item in
                    contentView(for: item)
                }
                
                if message.isStreaming {
                    TypingIndicator()
                        .padding(.horizontal, 4)
                }
                
                Text(formattedTime(message.timestamp))
                    .font(.system(size: 11 * zoomLevel))
                    .foregroundColor(.gray)
                    .padding(.horizontal, 4)
            }
            .frame(maxWidth: min(550 * zoomLevel, 800), alignment: message.role == .user ? .trailing : .leading)
            
            if message.role == .assistant {
                Spacer()
            }
        }
    }
    
    @ViewBuilder
    private func contentView(for item: ContentItem) -> some View {
        switch item {
        case .text(let text):
            if isHeartbeatResponse(text) {
                heartbeatIndicator(isPrompt: false)
            } else if isHeartbeatPrompt(text) {
                heartbeatIndicator(isPrompt: true)
            } else if let imageSource = extractMarkdownImageSource(from: text) {
                ImageBubbleView(source: imageSource, isUserMessage: message.role == .user, zoomLevel: zoomLevel)
            } else {
                textBubble(text: text)
            }

        case .image(let source):
            ImageBubbleView(source: source, isUserMessage: message.role == .user, zoomLevel: zoomLevel)
            
        case .thinking(let content, let isComplete):
            ThinkingView(content: content, isComplete: isComplete, zoomLevel: zoomLevel)
                .opacity(showThinking ? 1 : 0)
                .frame(height: showThinking ? nil : 0)
            
        case .toolCall(let id, let name, let arguments):
            ToolCallView(id: id, name: name, arguments: arguments, zoomLevel: zoomLevel)
            
        case .toolResult(let toolCallId, let toolName, let content, let isError):
            ToolResultView(toolCallId: toolCallId, toolName: toolName, content: content, isError: isError, zoomLevel: zoomLevel)
        }
    }
    
    private func isHeartbeatResponse(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines) == "[[NO_ACTION]]"
    }
    
    private func isHeartbeatPrompt(_ text: String) -> Bool {
        // Heartbeat prompts start with the memory-watcher-skip comment
        text.contains("MEMORY-WATCHER-SKIP") || 
        (text.contains("# Heartbeat") && text.contains("Current Time"))
    }

    private func extractMarkdownImageSource(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("![") else { return nil }

        guard let openParen = trimmed.firstIndex(of: "("),
              let closeParen = trimmed.lastIndex(of: ")"),
              openParen < closeParen else {
            return nil
        }

        let source = String(trimmed[trimmed.index(after: openParen)..<closeParen]).trimmingCharacters(in: .whitespacesAndNewlines)
        return source.isEmpty ? nil : source
    }
    
    private func heartbeatIndicator(isPrompt: Bool = false) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "heart.fill")
                .font(.system(size: 10 * zoomLevel))
                .foregroundColor(.pink)
            Text(isPrompt ? "Heartbeat check" : "Heartbeat")
                .font(.system(size: 12 * zoomLevel))
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10 * zoomLevel)
        .padding(.vertical, 6 * zoomLevel)
        .background(Color.pink.opacity(0.1))
        .cornerRadius(12)
    }
    
    private func textBubble(text: String) -> some View {
        let normalized = normalizeLineBreaks(text)

        return renderedMarkdownPreservingNewlines(normalized)
            .font(.system(size: 14 * zoomLevel))
            .padding(12 * zoomLevel)
            .background(message.role == .user ? Color.blue : Color.gray.opacity(0.15))
            .foregroundColor(message.role == .user ? .white : .primary)
            .cornerRadius(16)
            .textSelection(.enabled)
    }

    private func normalizeLineBreaks(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            // Handle literal escaped newlines coming from transport/model text
            .replacingOccurrences(of: "\\n", with: "\n")
    }

    private func renderedMarkdownPreservingNewlines(_ text: String) -> Text {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)

        return lines.enumerated().reduce(Text("")) { acc, pair in
            let (index, rawLine) = pair
            let line = String(rawLine)

            let lineText: Text
            if let attributed = try? AttributedString(
                markdown: line,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .full,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            ) {
                lineText = Text(attributed)
            } else {
                lineText = Text(verbatim: line)
            }

            if index == 0 {
                return lineText
            }
            return acc + Text("\n") + lineText
        }
    }
    
    private func formattedTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

struct ImageBubbleView: View {
    let source: String
    let isUserMessage: Bool
    var zoomLevel: Double = 1.0
    @State private var showPreview = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6 * zoomLevel) {
            Group {
                if let image = localImage {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                } else if let url = imageURL {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            imageLoadError
                        case .empty:
                            ProgressView()
                        @unknown default:
                            ProgressView()
                        }
                    }
                } else {
                    imageLoadError
                }
            }
            .frame(maxWidth: 420 * zoomLevel, maxHeight: 320 * zoomLevel)

            Text("Click to expand")
                .font(.system(size: 11 * zoomLevel))
                .foregroundColor(.secondary)
        }
        .padding(8 * zoomLevel)
        .background(isUserMessage ? Color.blue.opacity(0.15) : Color.gray.opacity(0.15))
        .cornerRadius(12)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture {
            showPreview = true
        }
        .popover(isPresented: $showPreview, arrowEdge: .bottom) {
            ImagePreviewModal(source: source, localImage: localImage, imageURL: imageURL)
        }
    }

    private var imageURL: URL? {
        guard let url = URL(string: source), let scheme = url.scheme else { return nil }
        return (scheme == "http" || scheme == "https" || scheme == "file") ? url : nil
    }

    private var localImage: NSImage? {
        if source.hasPrefix("data:"),
           let commaIndex = source.firstIndex(of: ",") {
            let base64Part = String(source[source.index(after: commaIndex)...])
            if let data = Data(base64Encoded: base64Part) {
                return NSImage(data: data)
            }
        }

        if source.hasPrefix("file://"), let url = URL(string: source) {
            return NSImage(contentsOf: url)
        }

        if source.hasPrefix("/") {
            return NSImage(contentsOfFile: source)
        }

        return nil
    }

    private var imageLoadError: some View {
        VStack(spacing: 6) {
            Image(systemName: "photo")
                .foregroundColor(.secondary)
            Text("Unable to load image")
                .font(.caption)
                .foregroundColor(.secondary)
            Text(source)
                .font(.caption2)
                .foregroundColor(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ImagePreviewModal: View {
    let source: String
    let localImage: NSImage?
    let imageURL: URL?

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.opacity(0.94)

                Group {
                    if let image = localImage {
                        Image(nsImage: image)
                            .interpolation(.high)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: geo.size.width * 0.98, maxHeight: geo.size.height * 0.98)
                    } else if let imageURL {
                        AsyncImage(url: imageURL) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .scaledToFit()
                                    .frame(maxWidth: geo.size.width * 0.98, maxHeight: geo.size.height * 0.98)
                            case .failure:
                                Text("Unable to load image")
                                    .foregroundColor(.white.opacity(0.8))
                            case .empty:
                                ProgressView()
                            @unknown default:
                                ProgressView()
                            }
                        }
                    } else {
                        Text("Unable to load image")
                            .foregroundColor(.white.opacity(0.8))
                    }
                }
            }
        }
        .frame(width: preferredSize.width, height: preferredSize.height)
    }

    private var preferredSize: CGSize {
        let screenSize = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900)
        let maxWidth = screenSize.width * 0.9
        let maxHeight = screenSize.height * 0.9

        if let image = localImage, image.size.width > 0, image.size.height > 0 {
            let scale = min(maxWidth / image.size.width, maxHeight / image.size.height, 1.0)
            let width = max(520, image.size.width * scale)
            let height = max(360, image.size.height * scale)
            return CGSize(width: width, height: height)
        }

        return CGSize(width: min(1200, maxWidth), height: min(800, maxHeight))
    }
}

// MARK: - Tool Call View
struct ToolCallView: View {
    let id: String
    let name: String
    let arguments: String
    var zoomLevel: Double = 1.0
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            HStack {
                Image(systemName: iconForTool(name))
                    .font(.system(size: 16 * zoomLevel))
                    .foregroundColor(colorForTool(name))
                VStack(alignment: .leading, spacing: 2 * zoomLevel) {
                    Text("Using tool: \(name)")
                        .font(.system(size: 14 * zoomLevel, weight: .medium))
                    if let detail = toolDetailText {
                        Text(detail)
                            .font(.system(size: 11 * zoomLevel))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(.secondary)
                    .font(.system(size: 11 * zoomLevel))
            }
            
            if isExpanded {
                VStack(alignment: .leading, spacing: 4 * zoomLevel) {
                    Text("Arguments:")
                        .font(.system(size: 11 * zoomLevel))
                        .foregroundColor(.secondary)
                    Text(formatJSON(arguments))
                        .font(.system(size: 11 * zoomLevel, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8 * zoomLevel)
                        .background(Color.black.opacity(0.05))
                        .cornerRadius(6)
                }
            }
        }
        .padding(12 * zoomLevel)
        .background(colorForTool(name).opacity(0.08))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(colorForTool(name).opacity(0.3), lineWidth: 1)
        )
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
            }
        }
    }
    
    /// Extracts a short detail text for the tool call (e.g., command name for bash, filename for read)
    private var toolDetailText: String? {
        // Parse arguments as JSON to extract details
        guard let data = arguments.data(using: .utf8) else { return nil }
        
        if name == "bash" || name == "shell" {
            // Extract first word of command
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let command = json["command"] as? String ?? json["cmd"] as? String {
                let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
                let firstWord = trimmed.split(separator: " ", omittingEmptySubsequences: true).first
                return firstWord.map { "\($0)" }
            }
        } else if name == "read" || name == "write" || name == "edit" {
            // Extract filename from path
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let path = json["path"] as? String {
                let url = URL(fileURLWithPath: path)
                return url.lastPathComponent.isEmpty ? nil : url.lastPathComponent
            }
        }
        
        return nil
    }
    
    private func formatJSON(_ json: String) -> String {
        // Simple formatting - in production use JSONSerialization
        return json
            .replacingOccurrences(of: "{", with: "{\n  ")
            .replacingOccurrences(of: "}", with: "\n}")
            .replacingOccurrences(of: ",", with: ",\n  ")
            .replacingOccurrences(of: ":", with: ": ")
    }
    
    private func iconForTool(_ name: String) -> String {
        switch name {
        case "read":
            return "doc.text.magnifyingglass"
        case "write", "edit":
            return "pencil.circle.fill"
        case "bash", "shell":
            return "terminal.fill"
        case "search":
            return "magnifyingglass.circle.fill"
        case "ask":
            return "questionmark.circle.fill"
        default:
            return "hammer.fill"
        }
    }
    
    private func colorForTool(_ name: String) -> Color {
        switch name {
        case "read":
            return .blue
        case "write", "edit":
            return .orange
        case "bash", "shell":
            return .green
        case "search":
            return .indigo
        case "ask":
            return .teal
        default:
            return .purple
        }
    }
}

// MARK: - Tool Result View
struct ToolResultView: View {
    let toolCallId: String
    let toolName: String
    let content: String
    let isError: Bool
    var zoomLevel: Double = 1.0
    @State private var isExpanded = true
    @State private var didCopy = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            // Header - tap to expand/collapse
            HStack {
                Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 16 * zoomLevel))
                    .foregroundColor(isError ? .red : .green)
                Text(isError ? "Tool failed" : "Tool result")
                    .font(.system(size: 14 * zoomLevel, weight: .medium))
                Spacer()

                Button(action: copyToClipboard) {
                    HStack(spacing: 4) {
                        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11 * zoomLevel, weight: .semibold))
                        Text(didCopy ? "Copied" : "Copy")
                            .font(.system(size: 11 * zoomLevel, weight: .medium))
                    }
                }
                .buttonStyle(.borderless)
                .foregroundColor(didCopy ? .green : .secondary)
                .help("Copy tool output")

                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(.secondary)
                    .font(.system(size: 11 * zoomLevel))
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            }
            
            if isExpanded {
                Text(content)
                    .font(.system(size: 13 * zoomLevel, design: .monospaced))
                    .lineLimit(20)
                    .padding(10 * zoomLevel)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.06))
                    .cornerRadius(8)
            }
        }
        .padding(12 * zoomLevel)
        .background(isError ? Color.red.opacity(0.06) : Color.green.opacity(0.06))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(isError ? Color.red.opacity(0.2) : Color.green.opacity(0.2), lineWidth: 1)
        )
    }

    private func copyToClipboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
        didCopy = true

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            didCopy = false
        }
    }
}

// MARK: - Typing Indicator
struct TypingIndicator: View {
    @State private var isAnimating = false
    
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(Color.gray.opacity(0.6))
                    .frame(width: 5, height: 5)
                    .scaleEffect(isAnimating ? 1.2 : 0.8)
                    .animation(
                        Animation.easeInOut(duration: 0.4)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.15),
                        value: isAnimating
                    )
            }
        }
        .padding(.horizontal, 4)
        .onAppear { isAnimating = true }
    }
}

// MARK: - Thinking View
struct ThinkingView: View {
    let content: String
    let isComplete: Bool
    var zoomLevel: Double = 1.0
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            HStack(spacing: 8 * zoomLevel) {
                Image(systemName: "brain")
                    .foregroundColor(.purple)
                    .font(.system(size: 14 * zoomLevel))
                
                Text(isComplete ? "Thought process" : "Thinking...")
                    .font(.system(size: 14 * zoomLevel, weight: .medium))
                    .foregroundColor(.purple)
                
                Spacer()
                
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(.secondary.opacity(0.7))
                    .font(.system(size: 12 * zoomLevel))
            }
            
            if isExpanded && !content.isEmpty {
                Text(content)
                    .font(.system(size: 14 * zoomLevel, design: .monospaced))
                    .padding(10 * zoomLevel)
                    .textSelection(.enabled)
                    .background(Color.purple.opacity(0.05))
                    .cornerRadius(8)
            }
        }
        .padding(.horizontal, 12 * zoomLevel)
        .padding(.vertical, 10 * zoomLevel)
        .background(Color.purple.opacity(0.06))
        .cornerRadius(10)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.purple.opacity(0.25), lineWidth: 1)
        )
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
            }
        }
    }
}

// MARK: - Connection Status View
struct ConnectionStatusView: View {
    let state: ConnectionState
    var showThinking: Bool = false
    
    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(statusText)
                .font(.caption)
                .foregroundColor(.secondary)
            if showThinking {
                Text("• Thinking On")
                    .font(.caption)
                    .foregroundColor(.purple)
            }
        }
    }
    
    private var statusColor: Color {
        switch state {
        case .disconnected:
            return .red
        case .connecting:
            return .orange
        case .connected:
            return .green
        case .error:
            return .red
        }
    }
    
    private var statusText: String {
        switch state {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting..."
        case .connected(let model):
            if let model = model {
                return "Connected • \(model)"
            }
            return "Connected"
        case .error(let message):
            return "Error: \(message)"
        }
    }
}

// MARK: - Command Popup (IntelliSense-style)
struct CommandPopup: View {
    let commands: [SlashCommand]
    let selectedIndex: Int
    let onSelect: (SlashCommand) -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                CommandRow(
                    command: command,
                    isSelected: index == selectedIndex
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    onSelect(command)
                }
                
                if index < commands.count - 1 {
                    Divider()
                        .padding(.horizontal, 8)
                }
            }
        }
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(10)
        .shadow(color: .black.opacity(0.15), radius: 8, x: 0, y: -4)
        .frame(maxHeight: 280)
    }
}

struct CommandRow: View {
    let command: SlashCommand
    let isSelected: Bool
    
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "command")
                .font(.system(size: 14))
                .foregroundColor(isSelected ? .white : .blue)
                .frame(width: 24)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(command.usage)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(isSelected ? .white : .primary)
                
                Text(command.description)
                    .font(.system(size: 11))
                    .foregroundColor(isSelected ? .white.opacity(0.85) : .secondary)
                    .lineLimit(1)
            }
            
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isSelected ? Color.blue : Color.clear)
    }
}
