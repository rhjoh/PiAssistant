import SwiftUI
import AppKit

// MARK: - Message View (handles all content types)
struct MessageView: View {
    let message: ChatMessage
    var showThinking: Bool = true
    var zoomLevel: Double = 1.0
    var theme: Theme
    
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
                    .font(theme.caption(size: 11 * zoomLevel))
                    .foregroundColor(theme.textSecondary)
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
                ImageBubbleView(source: imageSource, isUserMessage: message.role == .user, zoomLevel: zoomLevel, theme: theme)
            } else {
                textBubble(text: text)
            }

        case .image(let source):
            ImageBubbleView(source: source, isUserMessage: message.role == .user, zoomLevel: zoomLevel, theme: theme)
            
        case .thinking(let content, let isComplete):
            ThinkingView(content: content, isComplete: isComplete, zoomLevel: zoomLevel, theme: theme)
                .opacity(showThinking ? 1 : 0)
                .frame(height: showThinking ? nil : 0)
            
        case .toolCall(let id, let name, let arguments):
            ToolCallView(id: id, name: name, arguments: arguments, zoomLevel: zoomLevel, theme: theme)
            
        case .toolResult(let toolCallId, let toolName, let content, let isError):
            ToolResultView(toolCallId: toolCallId, toolName: toolName, content: content, isError: isError, zoomLevel: zoomLevel, theme: theme)
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
                .font(theme.caption(size: 10 * zoomLevel))
                .foregroundColor(theme.heartbeat)
            Text(isPrompt ? "Heartbeat check" : "Heartbeat")
                .font(theme.caption(size: 12 * zoomLevel))
                .foregroundColor(theme.textSecondary)
        }
        .padding(.horizontal, 10 * zoomLevel)
        .padding(.vertical, 6 * zoomLevel)
        .background(theme.heartbeatBackground)
        .cornerRadius(theme.cornerRadius)
    }
    
    private func textBubble(text: String) -> some View {
        let normalized = normalizeLineBreaks(text)
        let escaped = escapeMarkdownLineStart(normalized)

        return renderedMarkdownPreservingNewlines(escaped)
            .font(theme.body(size: 14 * zoomLevel))
            .padding(12 * zoomLevel)
            .background(message.role == .user ? theme.userBubble : theme.assistantBubble)
            .foregroundColor(message.role == .user ? .white : theme.textPrimary)
            .cornerRadius(theme.cornerRadius)
            .overlay(
                RoundedRectangle(cornerRadius: theme.cornerRadius)
                    .stroke(message.role == .user ? theme.userBubbleBorder : theme.assistantBubbleBorder, lineWidth: 1)
            )
            .textSelection(.enabled)
    }

    private func normalizeLineBreaks(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            // Handle literal escaped newlines coming from transport/model text
            .replacingOccurrences(of: "\\n", with: "\n")
    }
    
    /// Escape Markdown special characters at line start to preserve formatting
    private func escapeMarkdownLineStart(_ text: String) -> String {
        text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                let str = String(line)
                let trimmed = str
                
                // Escape > at start to prevent blockquote parsing
                if trimmed.hasPrefix("> ") {
                    return "\\" + str
                }
                
                // Escape number. at start to prevent ordered list parsing
                if let match = trimmed.range(of: "^\\s*\\d+\\.", options: .regularExpression) {
                    let beforeNumber = String(str[..<match.lowerBound])
                    let numberPart = String(str[match.lowerBound..<match.upperBound])
                    let afterNumber = String(str[match.upperBound...])
                    return beforeNumber + numberPart.replacingOccurrences(of: ".", with: "\\.") + afterNumber
                }
                
                return str
            }
            .joined(separator: "\n")
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
    var theme: Theme
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
                .font(theme.caption(size: 11 * zoomLevel))
                .foregroundColor(theme.textSecondary)
        }
        .padding(8 * zoomLevel)
        .background(isUserMessage ? theme.userBubble.opacity(0.3) : theme.assistantBubble)
        .cornerRadius(theme.cornerRadius)
        .overlay(
            RoundedRectangle(cornerRadius: theme.cornerRadius)
                .stroke(theme.border, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: theme.cornerRadius))
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
    var theme: Theme
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            HStack {
                Image(systemName: iconForTool(name))
                    .font(theme.body(size: 16 * zoomLevel))
                    .foregroundColor(theme.toolCall)
                VStack(alignment: .leading, spacing: 2 * zoomLevel) {
                    Text("Using tool: \(name)")
                        .font(theme.body(size: 14 * zoomLevel))
                    if let detail = toolDetailText {
                        Text(detail)
                            .font(theme.caption(size: 11 * zoomLevel))
                            .foregroundColor(theme.textSecondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(theme.textSecondary)
                    .font(theme.caption(size: 11 * zoomLevel))
            }
            
            if isExpanded {
                VStack(alignment: .leading, spacing: 4 * zoomLevel) {
                    Text("Arguments:")
                        .font(theme.caption(size: 11 * zoomLevel))
                        .foregroundColor(theme.textSecondary)
                    Text(formatJSON(arguments))
                        .font(theme.code(size: 11 * zoomLevel))
                        .foregroundColor(theme.codeText)
                        .textSelection(.enabled)
                        .padding(8 * zoomLevel)
                        .background(theme.codeBackground)
                        .cornerRadius(theme.cornerRadius)
                }
            }
        }
        .padding(12 * zoomLevel)
        .background(theme.toolCallBackground)
        .cornerRadius(theme.cornerRadius)
        .overlay(
            RoundedRectangle(cornerRadius: theme.cornerRadius)
                .stroke(theme.toolCallBorder, lineWidth: 1)
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
    var theme: Theme
    @State private var isExpanded = true
    @State private var didCopy = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            // Header - tap to expand/collapse
            HStack {
                Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(theme.body(size: 16 * zoomLevel))
                    .foregroundColor(isError ? .red : theme.toolResult)
                Text(isError ? "Tool failed" : "Tool result")
                    .font(theme.body(size: 14 * zoomLevel))
                Spacer()

                Button(action: copyToClipboard) {
                    HStack(spacing: 4) {
                        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                            .font(theme.caption(size: 11 * zoomLevel))
                        Text(didCopy ? "Copied" : "Copy")
                            .font(theme.caption(size: 11 * zoomLevel))
                    }
                }
                .buttonStyle(.borderless)
                .foregroundColor(didCopy ? .green : theme.textSecondary)
                .help("Copy tool output")

                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(theme.textSecondary)
                    .font(theme.caption(size: 11 * zoomLevel))
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            }
            
            if isExpanded {
                Text(content)
                    .font(theme.code(size: 13 * zoomLevel))
                    .foregroundColor(theme.codeText)
                    .lineLimit(20)
                    .padding(10 * zoomLevel)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.codeBackground)
                    .cornerRadius(theme.cornerRadius)
            }
        }
        .padding(12 * zoomLevel)
        .background(isError ? Color.red.opacity(0.06) : theme.toolResultBackground)
        .cornerRadius(theme.cornerRadius)
        .overlay(
            RoundedRectangle(cornerRadius: theme.cornerRadius)
                .stroke(isError ? Color.red.opacity(0.2) : theme.toolResultBorder, lineWidth: 1)
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
                    .opacity(isAnimating ? 1.0 : 0.35)
                    .animation(
                        Animation.easeInOut(duration: 0.4)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.15),
                        value: isAnimating
                    )
            }
        }
        .frame(height: 8) // Hard layout boundary so animation can't shift surrounding messages
        .padding(.horizontal, 4)
        .onAppear { isAnimating = true }
    }
}

// MARK: - Thinking View
struct ThinkingView: View {
    let content: String
    let isComplete: Bool
    var zoomLevel: Double = 1.0
    var theme: Theme
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8 * zoomLevel) {
            HStack(spacing: 8 * zoomLevel) {
                Image(systemName: "brain")
                    .foregroundColor(.purple)
                    .font(theme.body(size: 14 * zoomLevel))
                
                Text(isComplete ? "Thought process" : "Thinking...")
                    .font(theme.body(size: 14 * zoomLevel))
                    .foregroundColor(.purple)
                
                Spacer()
                
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .foregroundColor(theme.textSecondary)
                    .font(theme.caption(size: 12 * zoomLevel))
            }
            
            if isExpanded && !content.isEmpty {
                Text(content)
                    .font(theme.code(size: 14 * zoomLevel))
                    .padding(10 * zoomLevel)
                    .textSelection(.enabled)
                    .background(theme.background)
                    .cornerRadius(theme.cornerRadius)
            }
        }
        .padding(.horizontal, 12 * zoomLevel)
        .padding(.vertical, 10 * zoomLevel)
        .background(theme.thinkingBlock)
        .cornerRadius(theme.cornerRadius)
        .overlay(
            RoundedRectangle(cornerRadius: theme.cornerRadius)
                .stroke(theme.thinkingBlockBorder, lineWidth: 1)
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
    var theme: Theme
    
    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(statusText)
                .font(theme.caption(size: 11))
                .foregroundColor(theme.textSecondary)
            if showThinking {
                Text("• Thinking On")
                    .font(theme.caption(size: 11))
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
                return "Connected • \(model.name)"
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
    let zoomLevel: Double
    let theme: Theme
    let onSelect: (SlashCommand) -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                CommandRow(
                    command: command,
                    isSelected: index == selectedIndex,
                    zoomLevel: zoomLevel,
                    theme: theme
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    onSelect(command)
                }
                
                if index < commands.count - 1 {
                    Divider()
                        .padding(.horizontal, 8 * zoomLevel)
                }
            }
        }
        .background(theme.headerBackground)
        .cornerRadius(theme.cornerRadius * zoomLevel)
        .shadow(color: .black.opacity(0.15), radius: 8 * zoomLevel, x: 0, y: -4 * zoomLevel)
        .frame(maxHeight: 280 * zoomLevel)
    }
}

struct CommandRow: View {
    let command: SlashCommand
    let isSelected: Bool
    let zoomLevel: Double
    let theme: Theme
    
    var body: some View {
        HStack(spacing: 12 * zoomLevel) {
            Image(systemName: "command")
                .font(theme.body(size: 14 * zoomLevel))
                .foregroundColor(isSelected ? .white : .blue)
                .frame(width: 24 * zoomLevel)
            
            VStack(alignment: .leading, spacing: 2 * zoomLevel) {
                Text(command.usage)
                    .font(theme.body(size: 13 * zoomLevel))
                    .foregroundColor(isSelected ? .white : theme.textPrimary)
                
                Text(command.description)
                    .font(theme.caption(size: 11 * zoomLevel))
                    .foregroundColor(isSelected ? .white.opacity(0.85) : theme.textSecondary)
                    .lineLimit(1)
            }
            
            Spacer()
        }
        .padding(.horizontal, 12 * zoomLevel)
        .padding(.vertical, 8 * zoomLevel)
        .background(isSelected ? Color.blue : Color.clear)
    }
}
