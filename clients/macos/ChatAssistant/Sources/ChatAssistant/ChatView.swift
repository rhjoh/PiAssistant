import SwiftUI
import AppKit

@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var isStreaming = false
    @Published var connectionState: ConnectionState = .disconnected
    @Published var isThinking = false
    
    // Token tracking
    @Published var currentTokenUsage = TokenUsage()
    @Published var contextTokens: Int?
    
    // Slash command state
    @Published var showCommandPopup = false
    @Published var commandQuery = ""
    @Published var selectedCommandIndex = 0
    
    // Image attachments
    @Published var imageAttachments: [ImageAttachment] = []
    
    let chatService = ChatService()
    
    // Maximum total attachment size (5MB)
    let maxTotalAttachmentSize = 5 * 1024 * 1024
    
    var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !imageAttachments.isEmpty
    }
    
    var filteredCommands: [SlashCommand] {
        if commandQuery.isEmpty {
            return SlashCommand.allCommands
        }
        return SlashCommand.allCommands.filter { $0.matches(query: commandQuery) }
    }
    
    init() {
        chatService.delegate = self
    }
    
    func connect() {
        chatService.connect()
    }
    
    func disconnect() {
        chatService.disconnect()
    }
    
    func sendMessage() {
        let trimmed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        
        // Require either text or images
        guard !trimmed.isEmpty || !imageAttachments.isEmpty else { return }
        
        // Check if this is a slash command (only if no images)
        if trimmed.hasPrefix("/"), imageAttachments.isEmpty {
            handleSlashCommand(trimmed)
            inputText = ""
            return
        }
        
        // Build user message items (text + images)
        var userItems: [ContentItem] = []
        if !trimmed.isEmpty {
            userItems.append(.text(trimmed))
        }
        // Add images as content items for display
        for attachment in imageAttachments {
            userItems.append(.image(source: "data:\(attachment.mimeType);base64,\(attachment.base64String)"))
        }
        
        // Add user message
        let userMessage = ChatMessage(role: .user, items: userItems)
        messages.append(userMessage)
        
        inputText = ""
        let attachmentsToSend = imageAttachments
        imageAttachments.removeAll()
        isStreaming = true
        
        // Create assistant message placeholder with empty thinking block
        let assistantMessage = ChatMessage(
            role: .assistant,
            items: [.thinking("", isComplete: false)],
            isStreaming: true
        )
        messages.append(assistantMessage)
        
        // Send via WebSocket (with or without images)
        if attachmentsToSend.isEmpty {
            chatService.sendPrompt(trimmed)
        } else {
            chatService.sendPromptWithImages(trimmed, images: attachmentsToSend)
        }
    }
    
    // MARK: - Image Attachments
    
    func addImageAttachment(_ attachment: ImageAttachment) -> Bool {
        // Check total size limit
        let currentTotal = imageAttachments.reduce(0) { $0 + $1.fileSize }
        if currentTotal + attachment.fileSize > maxTotalAttachmentSize {
            return false
        }
        imageAttachments.append(attachment)
        return true
    }
    
    func addImageAttachments(_ attachments: [ImageAttachment]) -> [ImageAttachment] {
        var added: [ImageAttachment] = []
        for attachment in attachments {
            if addImageAttachment(attachment) {
                added.append(attachment)
            }
        }
        return added
    }
    
    func removeImageAttachment(id: UUID) {
        imageAttachments.removeAll { $0.id == id }
    }
    
    func clearImageAttachments() {
        imageAttachments.removeAll()
    }
    
    var canAddMoreAttachments: Bool {
        let currentTotal = imageAttachments.reduce(0) { $0 + $1.fileSize }
        return currentTotal < maxTotalAttachmentSize
    }
    
    var totalAttachmentSizeFormatted: String {
        let total = imageAttachments.reduce(0) { $0 + $1.fileSize }
        if total < 1024 {
            return "\(total) B"
        } else if total < 1024 * 1024 {
            return String(format: "%.1f KB", Double(total) / 1024)
        } else {
            return String(format: "%.1f MB", Double(total) / (1024 * 1024))
        }
    }
    
    func cancelStreaming() {
        chatService.abort()
        isStreaming = false
        if let lastIndex = messages.indices.last {
            messages[lastIndex].isStreaming = false
        }
    }
    
    // MARK: - Slash Commands
    
    func handleSlashCommand(_ command: String) {
        let parts = command.split(separator: " ", maxSplits: 1)
        let cmd = String(parts[0]).lowercased()
        let args = parts.count > 1 ? String(parts[1]) : ""
        
        // Add command to chat as user message
        let userMessage = ChatMessage(role: .user, items: [.text(command)])
        messages.append(userMessage)
        
        switch cmd {
        case "/clear":
            messages.removeAll()
            return
            
        case "/status":
            chatService.requestState()
            addSystemMessage("Requested status...")
            return
            
        case "/model", "/session", "/new", "/takeover":
            // Commands that expect a response from the gateway
            isStreaming = true
            
            // Create assistant placeholder for the response
            let assistantMessage = ChatMessage(
                role: .assistant,
                items: [.thinking("", isComplete: false)],
                isStreaming: true
            )
            messages.append(assistantMessage)
            
            let commandName = String(cmd.dropFirst()) // Remove the leading /
            let commandMessage = WSClientMessage.command(command: commandName, args: args.isEmpty ? nil : [args])
            chatService.send(commandMessage)
            
        case "/help":
            let helpText = SlashCommand.allCommands.map { cmd in
                "**\(cmd.usage)** - \(cmd.description)"
            }.joined(separator: "\n")
            addSystemMessage("**Available Commands:**\n\n" + helpText)
            
        default:
            addSystemMessage("Unknown command: \(cmd). Type /help for available commands.")
        }
    }
    
    func addSystemMessage(_ text: String) {
        let message = ChatMessage(
            role: .assistant,
            items: [.text(text)],
            isStreaming: false
        )
        messages.append(message)
    }
    
    func updateCommandQuery(from input: String) {
        guard input.hasPrefix("/") else {
            showCommandPopup = false
            commandQuery = ""
            return
        }
        
        // Extract the command part (everything after / up to space or end)
        let afterSlash = String(input.dropFirst())
        if afterSlash.contains(" ") {
            // Space found - command is complete, hide popup
            showCommandPopup = false
            commandQuery = ""
        } else {
            // Still typing command - show popup and filter
            commandQuery = afterSlash
            showCommandPopup = true
            selectedCommandIndex = 0
        }
    }
    
    func selectNextCommand() {
        guard !filteredCommands.isEmpty else { return }
        selectedCommandIndex = (selectedCommandIndex + 1) % filteredCommands.count
    }
    
    func selectPreviousCommand() {
        guard !filteredCommands.isEmpty else { return }
        selectedCommandIndex = (selectedCommandIndex - 1 + filteredCommands.count) % filteredCommands.count
    }
    
    func executeSelectedCommand() {
        guard !filteredCommands.isEmpty else { return }
        let command = filteredCommands[selectedCommandIndex]
        inputText = command.usage
        showCommandPopup = false
    }
}

extension ChatViewModel: ChatServiceDelegate {
    func chatServiceDidConnect(_ service: ChatService, model: String?) {
        connectionState = .connected(model: model)
    }
    
    func chatServiceDidDisconnect(_ service: ChatService) {
        connectionState = .disconnected
    }
    
    func chatService(_ service: ChatService, didReceiveError error: String) {
        // Add error as system message
        let errorMessage = ChatMessage(
            role: .assistant,
            items: [.text("⚠️ \(error)")],
            isStreaming: false
        )
        messages.append(errorMessage)
    }
    
    func chatService(_ service: ChatService, didReceiveTextDelta delta: String) {
        guard let lastIndex = messages.indices.last else { return }
        
        // Append text content to the message, preserving all existing items
        appendTextContent(delta, in: lastIndex)
    }
    
    /// Appends text content to the message, merging with existing content.
    /// Preserves all existing items (thinking, tool calls, results).
    private func appendTextContent(_ delta: String, in messageIndex: Int) {
        // If the last item is text, append to it
        if let lastItemIndex = messages[messageIndex].items.indices.last,
           case .text(let existingText) = messages[messageIndex].items[lastItemIndex] {
            messages[messageIndex].items[lastItemIndex] = .text(existingText + delta)
        } else {
            // Otherwise add new text item
            messages[messageIndex].items.append(.text(delta))
        }
    }
    
    func chatService(_ service: ChatService, didReceiveThinkingDelta delta: String) {
        guard let lastIndex = messages.indices.last else { return }
        
        isThinking = true
        
        // If the last item is an incomplete thinking block, append to it
        if let lastItemIndex = messages[lastIndex].items.indices.last,
           case .thinking(let existingText, let isComplete) = messages[lastIndex].items[lastItemIndex],
           !isComplete {
            messages[lastIndex].items[lastItemIndex] = .thinking(existingText + delta, isComplete: false)
        } else {
            // Otherwise add new thinking block
            messages[lastIndex].items.append(.thinking(delta, isComplete: false))
        }
    }
    
    func chatService(_ service: ChatService, didCompleteThinking content: String) {
        guard let lastIndex = messages.indices.last else { return }
        
        isThinking = false
        
        // Find and mark the incomplete thinking block as complete
        if let thinkingIndex = messages[lastIndex].items.indices.last(where: { index in
            if case .thinking(_, let isComplete) = messages[lastIndex].items[index] {
                return !isComplete
            }
            return false
        }) {
            messages[lastIndex].items[thinkingIndex] = .thinking(content, isComplete: true)
        }
    }
    
    func chatService(_ service: ChatService, didStartToolCall id: String, name: String, args: Any?, label: String) {
        guard let lastIndex = messages.indices.last else { return }
        
        // Serialize args to proper JSON string
        let argsString: String
        if let args = args {
            do {
                let data = try JSONSerialization.data(withJSONObject: args, options: [.sortedKeys])
                argsString = String(data: data, encoding: .utf8) ?? "{}"
            } catch {
                argsString = "{}"
            }
        } else {
            argsString = "{}"
        }
        messages[lastIndex].items.append(.toolCall(id: id, name: name, arguments: argsString))
    }
    
    func chatService(_ service: ChatService, didReceiveToolOutput id: String, output: String, truncated: Bool) {
        guard let lastIndex = messages.indices.last else { return }

        let finalOutput = truncated ? output + "\n… (truncated)" : output

        // Update existing tool result if present (streaming), otherwise insert after the tool call.
        if let existingResultIndex = messages[lastIndex].items.firstIndex(where: { item in
            if case .toolResult(let toolCallId, _, _, _) = item {
                return toolCallId == id
            }
            return false
        }) {
            let toolName = getToolNameForResult(toolCallId: id, in: messages[lastIndex].items) ?? "tool"

            let existingContent: String
            if case .toolResult(_, _, let content, _) = messages[lastIndex].items[existingResultIndex] {
                existingContent = content
            } else {
                existingContent = ""
            }

            let mergedOutput = mergeToolOutput(existing: existingContent, incoming: finalOutput)

            messages[lastIndex].items[existingResultIndex] = .toolResult(
                toolCallId: id,
                toolName: toolName,
                content: mergedOutput,
                isError: false
            )
            return
        }

        if let toolCallIndex = messages[lastIndex].items.firstIndex(where: { item in
            if case .toolCall(let toolId, _, _) = item {
                return toolId == id
            }
            return false
        }) {
            let toolName = getToolName(from: messages[lastIndex].items[toolCallIndex])
            messages[lastIndex].items.insert(
                .toolResult(toolCallId: id, toolName: toolName, content: finalOutput, isError: false),
                at: toolCallIndex + 1
            )
        }
    }
    
    func chatService(_ service: ChatService, didEndToolCall id: String, name: String) {
        // Tool call complete - could update UI if needed
    }

    func chatService(_ service: ChatService, didReceiveImage source: String, alt: String?) {
        guard let lastIndex = messages.indices.last else { return }
        messages[lastIndex].items.append(.image(source: source))
    }
    
    func chatService(_ service: ChatService, didCompleteWithFinalText text: String, usage: TokenUsageData?) {
        isStreaming = false
        isThinking = false
        
        // Accumulate token usage
        if let usage = usage {
            currentTokenUsage.inputTokens += usage.input ?? 0
            currentTokenUsage.outputTokens += usage.output ?? 0
            currentTokenUsage.cacheReadTokens += usage.cacheRead ?? 0
            currentTokenUsage.cacheWriteTokens += usage.cacheWrite ?? 0
        }
        
        if let lastIndex = messages.indices.last {
            messages[lastIndex].isStreaming = false
            
            // Replace accumulated text deltas with the properly formatted final text
            // This fixes spacing issues that can occur with streaming deltas
            var updatedItems: [ContentItem] = []
            var foundText = false
            
            for item in messages[lastIndex].items {
                switch item {
                case .text:
                    // Replace the first text item with the final text
                    if !foundText {
                        updatedItems.append(.text(text))
                        foundText = true
                    }
                    // Skip any additional text items (they're duplicates from streaming)
                case .thinking(let content, let isComplete):
                    // Keep thinking blocks, mark incomplete as complete
                    if !isComplete && !content.isEmpty {
                        updatedItems.append(.thinking(content, isComplete: true))
                    } else if !content.isEmpty {
                        updatedItems.append(item)
                    }
                default:
                    // Keep all other items (tool calls, results, images)
                    updatedItems.append(item)
                }
            }
            
            // If no text item was found, append the final text
            if !foundText {
                updatedItems.append(.text(text))
            }
            
            messages[lastIndex].items = updatedItems
        }
    }

    
    func chatService(_ service: ChatService, didReceiveHistory historyMessages: [ChatMessage]) {
        // Prepend history to current messages (if any)
        messages = historyMessages + messages
    }
    
    func chatService(_ service: ChatService, didReceiveState model: String?, provider: String?, contextTokens: Int?) {
        // Store context tokens for display in header
        self.contextTokens = contextTokens
        
        var lines = [String]()
        
        if let model = model, let provider = provider {
            lines.append("**Model:** \(provider)/\(model)")
        } else if let model = model {
            lines.append("**Model:** \(model)")
        }
        
        if let tokens = contextTokens {
            lines.append("**Context Tokens:** ~\(tokens)")
        }
        
        let statusText = lines.isEmpty ? "Connected (no additional info)" : lines.joined(separator: "\n")
        
        // Update the last message if it's a status request placeholder, or add new one
        if let lastIndex = messages.indices.last,
           case .text(let text) = messages[lastIndex].items.first,
           text == "Requested status..." {
            messages[lastIndex] = ChatMessage(
                role: .assistant,
                items: [.text(statusText)],
                isStreaming: false
            )
        } else {
            addSystemMessage(statusText)
        }
    }
    
    private func getToolName(from item: ContentItem) -> String {
        if case .toolCall(_, let name, _) = item {
            return name
        }
        return "tool"
    }

    private func mergeToolOutput(existing: String, incoming: String) -> String {
        if existing.isEmpty { return incoming }
        if incoming.isEmpty { return existing }

        // If gateway sends cumulative snapshots, just replace.
        if incoming.hasPrefix(existing) || incoming.count >= existing.count {
            return incoming
        }

        // If incoming is just a shorter repeat (e.g. truncation), keep existing.
        if existing.contains(incoming) {
            return existing
        }

        // If gateway sends deltas/chunks, append so streaming remains visible.
        return existing + incoming
    }

    private func getToolNameForResult(toolCallId: String, in items: [ContentItem]) -> String? {
        for item in items {
            if case .toolCall(let id, let name, _) = item, id == toolCallId {
                return name
            }
        }
        return nil
    }
}

// MARK: - Chat View
struct ChatView: View {
    @StateObject private var viewModel = ChatViewModel()
    @StateObject private var settings = AppSettings.shared
    @FocusState private var isInputFocused: Bool
    @State private var pasteMonitor: AnyObject?
    @State private var isAutoScrollEnabled = true  // Auto-scroll when near bottom
    @State private var hasCompletedInitialScroll = false
    @State private var scrollToBottom: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Personal Assistant")
                        .font(.headline)
                    HStack(spacing: 6) {
                        ConnectionStatusView(state: viewModel.connectionState, showThinking: settings.showThinking)
                        if viewModel.isStreaming {
                            Text("• Generating...")
                                .font(.caption)
                                .foregroundColor(.orange)
                        }
                        if viewModel.isThinking {
                            Text("• Thinking...")
                                .font(.caption)
                                .foregroundColor(.purple)
                        }
                    }
                }
                
                Spacer()
                
                // Token usage display
                HStack(spacing: 12) {
                    if viewModel.currentTokenUsage.inputTokens > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 11, weight: .semibold))
                            Text("\(viewModel.currentTokenUsage.inputTokens / 1000)k")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundColor(.blue)
                    }
                    if viewModel.currentTokenUsage.outputTokens > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 11, weight: .semibold))
                            Text("\(viewModel.currentTokenUsage.outputTokens / 1000)k")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundColor(.green)
                    }
                    if viewModel.currentTokenUsage.cacheReadTokens > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "book")
                                .font(.system(size: 11, weight: .semibold))
                            Text("\(viewModel.currentTokenUsage.cacheReadTokens / 1000)k")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundColor(.purple)
                    }
                    if let context = viewModel.contextTokens, context > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.system(size: 11, weight: .semibold))
                            Text("\(context / 1000)k")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundColor(.orange)
                    }
                }
                .help("Token usage: ↑ input ↓ output 📖 cache ⏱ context")
                
                // Thinking toggle button
                Button(action: { settings.showThinking.toggle() }) {
                    HStack(spacing: 4) {
                        Image(systemName: "brain")
                            .foregroundColor(settings.showThinking ? .purple : .gray)
                        if settings.showThinking {
                            Text("Thinking On")
                                .font(.caption)
                                .foregroundColor(.purple)
                        }
                    }
                }
                .buttonStyle(.borderless)
                .help("Toggle thinking blocks (⌃T)")
                
                Button(action: { viewModel.connect() }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.connectionState == .connecting)
            }
            .padding()
            .background(.ultraThinMaterial)
            
            // Messages List
            ZStack(alignment: .bottomTrailing) {
                ScrollViewWithOffsetTracking(
                    onScroll: { offset, contentHeight, visibleHeight in
                        // User is considered "at bottom" if within 50pts of the end
                        let isAtBottom = (contentHeight - offset - visibleHeight) < 50
                        // Only update if changed to avoid unnecessary renders
                        if isAutoScrollEnabled != isAtBottom {
                            isAutoScrollEnabled = isAtBottom
                        }
                    },
                    onContentHeightChange: { _ in
                        // Keep following streaming growth (text/tool output) while sticky
                        if hasCompletedInitialScroll && isAutoScrollEnabled {
                            scrollToBottom?()
                        }
                    },
                    onScrollToBottomCallback: { scrollFn in
                        self.scrollToBottom = scrollFn
                    }
                ) {
                    LazyVStack(spacing: 16) {
                        ForEach(viewModel.messages) { message in
                            MessageView(message: message, showThinking: settings.showThinking, zoomLevel: settings.zoomLevel)
                        }
                    }
                    .padding()
                }
                .onChange(of: viewModel.messages.count) { _ in
                    // On initial load (first time we get messages), scroll to bottom
                    if !hasCompletedInitialScroll && !viewModel.messages.isEmpty {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            scrollToBottom?()
                            hasCompletedInitialScroll = true
                        }
                    } else if isAutoScrollEnabled {
                        // Only auto-scroll if user was already at bottom when new message arrives
                        scrollToBottom?()
                    }
                }

                // Scroll to bottom button (shown when auto-scroll disabled)
                if !isAutoScrollEnabled {
                    Button(action: {
                        scrollToBottom?()
                        isAutoScrollEnabled = true
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle.fill")
                            Text("New messages")
                                .font(.caption)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(20)
                        .shadow(radius: 4)
                    }
                    .buttonStyle(.borderless)
                    .padding(.trailing, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }

            Divider()
            
            // Input Area with Image Attachments and Command Popup
            VStack(spacing: 0) {
                // Image Attachment Bar
                if !viewModel.imageAttachments.isEmpty {
                    ImageAttachmentBar(
                        attachments: viewModel.imageAttachments,
                        totalSize: viewModel.totalAttachmentSizeFormatted,
                        onRemove: { id in
                            viewModel.removeImageAttachment(id: id)
                        },
                        onClear: {
                            viewModel.clearImageAttachments()
                        }
                    )
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                
                // Input field with drag & drop support
                ZStack(alignment: .bottomLeading) {
                    // Input field
                    HStack(alignment: .bottom, spacing: 12) {
                        // Auto-growing text field
                        AutoGrowingTextField(
                            text: $viewModel.inputText,
                            placeholder: viewModel.imageAttachments.isEmpty ? "Message..." : "Add a message or send images...",
                            onSubmit: {
                                if !viewModel.showCommandPopup && !viewModel.isStreaming {
                                    sendMessageFromUI()
                                }
                            }
                        )
                        .onChange(of: viewModel.inputText) { newValue in
                            viewModel.updateCommandQuery(from: newValue)
                        }
                        
                        // Send button
                        Button(action: viewModel.isStreaming ? viewModel.cancelStreaming : sendMessageFromUI) {
                            Image(systemName: viewModel.isStreaming ? "stop.fill" : "arrow.up.circle.fill")
                                .font(.system(size: 28))
                                .foregroundColor(viewModel.isStreaming ? .red : .blue)
                        }
                        .keyboardShortcut(.return, modifiers: [])
                        .buttonStyle(.borderless)
                        .disabled(!viewModel.canSend && !viewModel.isStreaming)
                        .padding(.bottom, 4)
                    }
                    .padding()
                    
                    // Command Popup
                    if viewModel.showCommandPopup {
                        CommandPopup(
                            commands: viewModel.filteredCommands,
                            selectedIndex: viewModel.selectedCommandIndex,
                            onSelect: { command in
                                viewModel.inputText = command.usage
                                viewModel.showCommandPopup = false
                            }
                        )
                        .frame(maxWidth: 400)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 70)
                    }
                }
            }
            .background(.ultraThinMaterial)
            // Drag & Drop support for images
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                handleDrop(providers: providers)
            }
        }
        .frame(minWidth: 600, minHeight: 400)
        .onAppear {
            viewModel.connect()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                isInputFocused = true
            }
            setupPasteHandler()
        }
        .onDisappear {
            viewModel.disconnect()
            removePasteHandler()
        }
        .background(
            ViewModifiers(
                zoomIn: settings.zoomIn,
                zoomOut: settings.zoomOut,
                resetZoom: settings.resetZoom,
                cancelStreaming: { [weak viewModel] in
                    viewModel?.cancelStreaming()
                },
                onPasteImage: { attachments in
                    let added = viewModel.addImageAttachments(attachments)
                    return added.count
                }
            )
        )
    }
    
    private var canSend: Bool {
        !viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty || !viewModel.imageAttachments.isEmpty
    }

    private func sendMessageFromUI() {
        let wasSticky = isAutoScrollEnabled
        viewModel.sendMessage()

        // Always show the just-sent user message.
        scrollToBottom?()

        // If user intentionally scrolled up before sending, don't re-enable sticky follow mode.
        if !wasSticky {
            DispatchQueue.main.async {
                isAutoScrollEnabled = false
            }
        }
    }
    
    // MARK: - Drag & Drop Handling
    
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        var handled = false
        
        for provider in providers {
            if provider.canLoadObject(ofClass: URL.self) {
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    guard let fileURL = url, error == nil else { return }
                    
                    // Check if it's an image file
                    let ext = fileURL.pathExtension.lowercased()
                    let imageExts = ["png", "jpg", "jpeg", "gif", "webp"]
                    
                    if imageExts.contains(ext) {
                        DispatchQueue.main.async {
                            if let attachment = ImageAttachment.from(fileURL: fileURL) {
                                let _ = self.viewModel.addImageAttachment(attachment)
                            }
                        }
                        handled = true
                    }
                }
            }
        }
        
        return handled
    }
    
    // MARK: - Paste Handling
    
    private func setupPasteHandler() {
        // Monitor for paste events
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak viewModel] event in
            guard let viewModel = viewModel else { return event }
            
            // Check for Cmd+V
            if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "v" {
                let pasteboard = NSPasteboard.general
                
                // First check for images
                let imageAttachments = ImageAttachment.from(pasteboard: pasteboard)
                
                if !imageAttachments.isEmpty {
                    // Add images as attachments
                    let _ = viewModel.addImageAttachments(imageAttachments)
                    return nil // Consume the event
                }
                // Otherwise let normal paste proceed
            }
            
            return event
        } as AnyObject
    }
    
    private func removePasteHandler() {
        if let monitor = pasteMonitor {
            NSEvent.removeMonitor(monitor)
            // Use a separate state update approach
            DispatchQueue.main.async {
                self.pasteMonitor = nil
            }
        }
    }
}

// MARK: - Image Attachment Bar Component
struct ImageAttachmentBar: View {
    let attachments: [ImageAttachment]
    let totalSize: String
    let onRemove: (UUID) -> Void
    let onClear: () -> Void
    
    var body: some View {
        VStack(spacing: 6) {
            // Thumbnails row
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        ImageAttachmentThumbnail(
                            attachment: attachment,
                            onRemove: { onRemove(attachment.id) }
                        )
                    }
                }
                .padding(.horizontal, 4)
            }
            .frame(height: 64)
            
            // Footer with size and clear button
            HStack {
                Text("\(attachments.count) image\(attachments.count == 1 ? "" : "s") • \(totalSize)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                Spacer()
                
                Button("Clear All", action: onClear)
                    .font(.caption)
                    .buttonStyle(.borderless)
                    .foregroundColor(.red)
            }
        }
        .padding(8)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(8)
    }
}

// MARK: - Image Attachment Thumbnail
struct ImageAttachmentThumbnail: View {
    let attachment: ImageAttachment
    let onRemove: () -> Void
    @State private var isHovering = false
    
    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Thumbnail image
            Image(nsImage: attachment.nsImage)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.gray.opacity(0.2), lineWidth: 1)
                )
            
            // Remove button (visible on hover)
            if isHovering {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(.red)
                        .background(Color.white.clipShape(Circle()))
                }
                .buttonStyle(.borderless)
                .offset(x: 6, y: -6)
                .transition(.scale)
            }
        }
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.1)) {
                isHovering = hovering
            }
        }
    }
}

// MARK: - ScrollView with Offset Tracking
/// A ScrollView that reports scroll offset relative to its content
struct ScrollViewWithOffsetTracking<Content: View>: NSViewRepresentable {
    let onScroll: (CGFloat, CGFloat, CGFloat) -> Void
    let onContentHeightChange: ((CGFloat) -> Void)?
    let onScrollToBottomCallback: ((@escaping () -> Void) -> Void)?
    let content: Content

    init(
        onScroll: @escaping (CGFloat, CGFloat, CGFloat) -> Void,
        onContentHeightChange: ((CGFloat) -> Void)? = nil,
        onScrollToBottomCallback: ((@escaping () -> Void) -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.onScroll = onScroll
        self.onContentHeightChange = onContentHeightChange
        self.onScrollToBottomCallback = onScrollToBottomCallback
        self.content = content()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        context.coordinator.scrollView = scrollView

        let documentView = NSHostingView(rootView: content)
        documentView.translatesAutoresizingMaskIntoConstraints = false
        documentView.postsFrameChangedNotifications = true

        scrollView.documentView = documentView

        NSLayoutConstraint.activate([
            documentView.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
            documentView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor)
        ])

        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.boundsChanged(_:)),
            name: NSView.boundsDidChangeNotification,
            object: scrollView.contentView
        )
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.documentFrameChanged(_:)),
            name: NSView.frameDidChangeNotification,
            object: documentView
        )

        DispatchQueue.main.async {
            let scrollFn = { [weak scrollView] in
                guard let scrollView = scrollView else { return }
                guard let documentView = scrollView.documentView else { return }
                let contentHeight = documentView.frame.height
                let visibleHeight = scrollView.contentView.bounds.height
                let maxOffset = max(0, contentHeight - visibleHeight)

                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.2
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    scrollView.contentView.animator().setBoundsOrigin(NSPoint(x: 0, y: maxOffset))
                }
            }
            context.coordinator.onScrollToBottomCallback?(scrollFn)
            context.coordinator.reportScrollPosition(scrollView)
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        if let documentView = scrollView.documentView as? NSHostingView<Content> {
            documentView.rootView = content
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onScroll: onScroll,
            onContentHeightChange: onContentHeightChange,
            onScrollToBottomCallback: onScrollToBottomCallback
        )
    }

    class Coordinator: NSObject {
        let onScroll: (CGFloat, CGFloat, CGFloat) -> Void
        let onContentHeightChange: ((CGFloat) -> Void)?
        let onScrollToBottomCallback: ((@escaping () -> Void) -> Void)?
        weak var scrollView: NSScrollView?
        private var lastReportedContentHeight: CGFloat = 0

        init(
            onScroll: @escaping (CGFloat, CGFloat, CGFloat) -> Void,
            onContentHeightChange: ((CGFloat) -> Void)? = nil,
            onScrollToBottomCallback: ((@escaping () -> Void) -> Void)? = nil
        ) {
            self.onScroll = onScroll
            self.onContentHeightChange = onContentHeightChange
            self.onScrollToBottomCallback = onScrollToBottomCallback
        }

        @objc func boundsChanged(_ notification: Notification) {
            guard let contentView = notification.object as? NSClipView else { return }
            guard let scrollView = contentView.superview?.superview as? NSScrollView else { return }
            reportScrollPosition(scrollView)
        }

        @objc func documentFrameChanged(_ notification: Notification) {
            guard let view = notification.object as? NSView else { return }
            let newHeight = view.frame.height
            if abs(newHeight - lastReportedContentHeight) > 0.5 {
                lastReportedContentHeight = newHeight
                onContentHeightChange?(newHeight)
            }
        }

        func reportScrollPosition(_ scrollView: NSScrollView) {
            let contentView = scrollView.contentView
            let documentView = scrollView.documentView

            let offset = contentView.bounds.origin.y
            let visibleHeight = contentView.bounds.height
            let contentHeight = documentView?.bounds.height ?? 0

            onScroll(offset, contentHeight, visibleHeight)
        }
    }
}

// MARK: - Keyboard Shortcuts Support
struct ViewModifiers: NSViewRepresentable {
    let zoomIn: () -> Void
    let zoomOut: () -> Void
    let resetZoom: () -> Void
    let cancelStreaming: () -> Void
    var onPasteImage: (([ImageAttachment]) -> Int)?
    
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        
        // Register keyboard shortcuts
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // Check for Ctrl+C (cancel streaming)
            if event.modifierFlags.contains(.control) && event.charactersIgnoringModifiers?.lowercased() == "c" {
                self.cancelStreaming()
                return nil // Consume the event
            }
            
            // Check for Command+ shortcuts
            if event.modifierFlags.contains(.command) {
                switch event.charactersIgnoringModifiers {
                case "=", "+":
                    self.zoomIn()
                    return nil
                case "-":
                    self.zoomOut()
                    return nil
                case "0":
                    self.resetZoom()
                    return nil
                default:
                    break
                }
            }
            return event
        }
        
        return view
    }
    
    func updateNSView(_ nsView: NSView, context: Context) {}
}
