import Foundation

@MainActor
protocol ChatServiceDelegate: AnyObject {
    func chatServiceDidConnect(_ service: ChatService, model: String?)
    func chatServiceDidDisconnect(_ service: ChatService)
    func chatService(_ service: ChatService, didReceiveError error: String)
    func chatService(_ service: ChatService, didReceiveTextDelta delta: String)
    func chatService(_ service: ChatService, didReceiveThinkingDelta delta: String)
    func chatService(_ service: ChatService, didCompleteThinking content: String)
    func chatService(_ service: ChatService, didStartToolCall id: String, name: String, args: Any?, label: String)
    func chatService(_ service: ChatService, didReceiveToolOutput id: String, output: String, truncated: Bool)
    func chatService(_ service: ChatService, didEndToolCall id: String, name: String)
    func chatService(_ service: ChatService, didReceiveImage source: String, alt: String?)
    func chatService(_ service: ChatService, didCompleteWithFinalText text: String, usage: TokenUsageData?)
    func chatService(_ service: ChatService, didReceiveHistory messages: [ChatMessage])
    func chatService(_ service: ChatService, didReceiveState model: String?, provider: String?, contextTokens: Int?)
}

@MainActor
class ChatService: NSObject, ObservableObject {
    @Published var connectionState: ConnectionState = .disconnected
    
    weak var delegate: ChatServiceDelegate?
    
    private var webSocketTask: URLSessionWebSocketTask?
    private let serverURL = URL(string: "ws://localhost:3456")!
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private var reconnectTimer: Timer?
    
    private var currentToolCallId: String?
    private var accumulatedText = ""
    
    func connect() {
        guard connectionState != .connecting else { return }
        
        connectionState = .connecting
        
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: serverURL)
        webSocketTask?.delegate = self
        
        webSocketTask?.resume()
        listen()
    }
    
    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        reconnectAttempts = 0
        
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        
        connectionState = .disconnected
        delegate?.chatServiceDidDisconnect(self)
    }
    
    func sendPrompt(_ message: String) {
        guard case .connected = connectionState else {
            delegate?.chatService(self, didReceiveError: "Not connected")
            return
        }
        
        accumulatedText = ""
        currentToolCallId = nil
        
        let promptMessage = WSClientMessage.prompt(message: message, id: nil)
        send(promptMessage)
    }
    
    func sendPromptWithImages(_ message: String, images: [ImageAttachment]) {
        guard case .connected = connectionState else {
            delegate?.chatService(self, didReceiveError: "Not connected")
            return
        }
        
        accumulatedText = ""
        currentToolCallId = nil
        
        print("[ChatService] Sending prompt with \(images.count) image(s):")
        for (i, img) in images.enumerated() {
            print("  Image \(i+1): \(img.mimeType), \(img.base64String.prefix(50))... (\(img.base64String.count) chars)")
        }
        
        let promptMessage = WSClientMessage.promptWithImages(message: message, images: images, id: nil)
        send(promptMessage)
    }
    
    func abort() {
        let abortMessage = WSClientMessage.abort
        send(abortMessage)
    }
    
    func requestState() {
        let stateMessage = WSClientMessage.getState
        send(stateMessage)
    }
    
    func requestHistory(limit: Int = 50) {
        let historyMessage = WSClientMessage.getHistory(limit: limit)
        send(historyMessage)
    }
    
    func send(_ message: WSClientMessage) {
        guard case .connected = connectionState else {
            delegate?.chatService(self, didReceiveError: "Not connected")
            return
        }
        
        do {
            let data = try JSONEncoder().encode(message)
            let messageString = String(data: data, encoding: .utf8)!
            webSocketTask?.send(.string(messageString)) { [weak self] error in
                if let error = error {
                    Task { @MainActor [weak self] in
                        self?.handleError("Send failed: \(error.localizedDescription)")
                    }
                }
            }
        } catch {
            handleError("Encode failed: \(error.localizedDescription)")
        }
    }
    
    private func listen() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.handleMessage(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleMessage(text)
                        }
                    @unknown default:
                        break
                    }
                    // Continue listening
                    self.listen()
                    
                case .failure(let error):
                    self.handleError("WebSocket error: \(error.localizedDescription)")
                    self.scheduleReconnect()
                }
            }
        }
    }
    
    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        
        do {
            let message = try JSONDecoder().decode(WSServerMessage.self, from: data)
            
            switch message {
            case .connection(let data):
                connectionState = .connected(model: data.model)
                reconnectAttempts = 0
                delegate?.chatServiceDidConnect(self, model: data.model)
                // Request history after connecting
                requestHistory()
                
            case .textDelta(let content):
                accumulatedText += content
                delegate?.chatService(self, didReceiveTextDelta: content)
                
            case .thinkingDelta(let content):
                delegate?.chatService(self, didReceiveThinkingDelta: content)
                
            case .thinkingDone(let content):
                delegate?.chatService(self, didCompleteThinking: content)
                
            case .toolStart(let id, let name, let args, let label):
                currentToolCallId = id
                delegate?.chatService(self, didStartToolCall: id, name: name, args: args?.value, label: label)
                
            case .toolOutput(let id, let output, let truncated):
                delegate?.chatService(self, didReceiveToolOutput: id, output: output, truncated: truncated ?? false)
                
            case .toolEnd(let id, let name):
                currentToolCallId = nil
                delegate?.chatService(self, didEndToolCall: id, name: name)

            case .image(let source, let alt):
                delegate?.chatService(self, didReceiveImage: source, alt: alt)
                
            case .done(let finalText, let usage):
                delegate?.chatService(self, didCompleteWithFinalText: finalText, usage: usage)
                
            case .error(let errorMessage):
                delegate?.chatService(self, didReceiveError: errorMessage)
                
            case .state(let data):
                connectionState = .connected(model: data.model)
                // Only notify delegate if we have actual state data (not just isProcessing updates)
                if data.model != nil || data.provider != nil || data.contextTokens != nil {
                    delegate?.chatService(self, didReceiveState: data.model, provider: data.provider, contextTokens: data.contextTokens)
                }
                
            case .history(let messagesData):
                let historyMessages = parseHistoryMessages(messagesData)
                delegate?.chatService(self, didReceiveHistory: historyMessages)
            }
        } catch {
            print("Failed to decode message: \(error)")
            print("Raw: \(text)")
        }
    }
    
    private func handleError(_ message: String) {
        connectionState = .error(message)
        delegate?.chatService(self, didReceiveError: message)
    }
    
    private func scheduleReconnect() {
        reconnectAttempts += 1
        
        guard reconnectAttempts <= maxReconnectAttempts else {
            connectionState = .error("Max reconnect attempts reached")
            return
        }
        
        let delay = min(Double(reconnectAttempts) * 2.0, 10.0)
        
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.connect()
            }
        }
    }
    
    private func parseHistoryMessages(_ messagesData: [AnyCodable]) -> [ChatMessage] {
        return messagesData.compactMap { anyCodable in
            guard let dict = anyCodable.value as? [String: Any] else {
                return nil
            }

            let role = dict["role"] as? String
            let content = dict["content"]

            guard let role = role else { return nil }

            let messageRole: MessageRole = role == "user" ? .user : .assistant
            var items: [ContentItem] = []

            if let str = content as? String, !str.isEmpty {
                items.append(.text(str))
            } else if let arr = content as? [[String: Any]] {
                for part in arr {
                    let type = part["type"] as? String

                    if type == "text", let text = part["text"] as? String, !text.isEmpty {
                        items.append(.text(text))
                        continue
                    }

                    if let imageSource = extractImageSource(from: part) {
                        items.append(.image(source: imageSource))
                    }
                }
            }

            return ChatMessage(role: messageRole, items: items, isStreaming: false)
        }
    }

    private func extractImageSource(from part: [String: Any]) -> String? {
        let type = part["type"] as? String

        // Native Pi image part: { type: "image", data: "...", mimeType: "image/png" }
        if type == "image", let data = part["data"] as? String {
            let mimeType = (part["mimeType"] as? String) ?? "image/png"
            return "data:\(mimeType);base64,\(data)"
        }

        if type == "image", let image = part["image"] as? [String: Any] {
            if let url = image["url"] as? String { return url }
            if let path = image["path"] as? String { return path }
            if let source = image["source"] as? String { return source }
        }

        if type == "image_url", let imageURL = part["image_url"] as? [String: Any], let url = imageURL["url"] as? String {
            return url
        }

        if let source = part["source"] as? [String: Any] {
            if let path = source["path"] as? String { return path }
            if let url = source["url"] as? String { return url }
        }

        if let path = part["path"] as? String { return path }
        if let url = part["url"] as? String { return url }

        return nil
    }
}

extension ChatService: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        // Connection opened
    }
    
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor [weak self] in
            if let error = error {
                self?.handleError("Connection closed: \(error.localizedDescription)")
                self?.scheduleReconnect()
            }
        }
    }
}
