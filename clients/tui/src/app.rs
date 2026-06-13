use std::collections::HashMap;
use std::fmt;

use chrono::Local;
use ratatui::layout::{Rect, Size};
use ratatui::text::Line;
use ratatui_image::picker::Picker;
use ratatui_image::protocol::Protocol;
use ratatui_image::Resize;
use tracing::{debug, info, warn};

use crate::protocol::{ClientMessage, ModelInfo, ServerMessage, TokenUsage, ToolOutputData};
use crate::theme::Theme;
use crate::websocket::WsEvent;

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConnectionState {
    #[default]
    Disconnected,
    #[allow(dead_code)]
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub role: MessageRole,
    pub items: Vec<ContentItem>,
    pub timestamp: chrono::DateTime<Local>,
    pub is_streaming: bool,
    pub render_cache: Vec<Line<'static>>,
    pub render_dirty: bool,
    /// Line offset within render_cache for each ContentItem (for image overlay positioning).
    pub item_line_offsets: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone)]
pub enum ContentItem {
    Text(String),
    Thinking {
        thinking_id: Option<String>,
        content: String,
        is_complete: bool,
    },
    ToolCall {
        id: String,
        name: String,
        #[allow(dead_code)]
        args: String,
        label: String,
        is_complete: bool,
        /// Live-updated tool output (merged in-place instead of a separate block).
        result: Option<String>,
        is_error: bool,
    },
    /// Legacy: only used for history entries that arrive without a paired ToolCall.
    ToolResult {
        #[allow(dead_code)]
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
    },
    Image {
        source: String,
        alt: Option<String>,
    },
}

/// A known slash command with metadata.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct SlashCommand {
    pub name: &'static str,
    pub description: &'static str,
    pub usage: &'static str,
}

/// All available slash commands (must stay in sync with gateway CommandRegistry).
pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "status",
        description: "Show gateway status and current model",
        usage: "/status",
    },
    SlashCommand {
        name: "model",
        description: "View or change the current AI model",
        usage: "/model [list|<number>]",
    },
    SlashCommand {
        name: "session",
        description: "Show session info and stats",
        usage: "/session",
    },
    SlashCommand {
        name: "new",
        description: "Archive session and start fresh",
        usage: "/new",
    },
    SlashCommand {
        name: "clear",
        description: "Clear the chat view",
        usage: "/clear",
    },
    SlashCommand {
        name: "theme",
        description: "Switch color theme",
        usage: "/theme [<name>]",
    },
];

/// State for the slash-command autocomplete popup.
#[derive(Debug)]
pub struct CommandPopup {
    #[allow(dead_code)]
    pub query: String,
    pub selected: usize,
    pub matches: Vec<SlashCommand>,
}

/// State for the model picker fuzzy-finder popup.
#[derive(Debug)]
pub struct ModelPicker {
    pub query: String,
    pub selected: usize,
    /// All models fetched from the gateway.
    pub all_models: Vec<ModelInfo>,
    /// Indices into `all_models` matching the current query.
    pub filtered_indices: Vec<usize>,
    /// The currently active model (for highlighting).
    pub current: Option<ModelInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SelectionPoint {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone)]
pub struct MouseSelection {
    pub anchor: SelectionPoint,
    pub focus: SelectionPoint,
    pub dragging: bool,
}

pub struct App {
    pub theme: Theme,
    pub connection_state: ConnectionState,
    pub messages: Vec<ChatMessage>,
    pub input_text: String,
    pub is_input_focused: bool,
    /// Line offset from the bottom of the content. 0 = auto-scroll (pinned to bottom).
    pub scroll_from_bottom: usize,
    /// Maximum valid scroll offset from the bottom for the current rendered viewport.
    pub max_scroll_from_bottom: usize,
    pub current_model: Option<ModelInfo>,
    pub context_window: Option<u64>,
    /// Current context tokens (from gateway's done.contextTokens or state.contextTokens)
    pub context_tokens: Option<u64>,
    pub is_processing: bool,
    pub latency_ms: Option<u64>,
    pub token_usage: TokenUsage,
    pub error_message: Option<String>,
    pub show_help: bool,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub render_cache_width: Option<u16>,
    pub render_cache_show_thinking: bool,
    pub render_cache_show_tools: bool,
    /// Spinner animation frame counter (cycles through spinner chars)
    pub spinner_frame: usize,
    // Track streaming state
    streaming_message_id: Option<String>,
    /// Set when user aborts; prevents residual deltas from creating new streaming messages.
    aborted: bool,
    // Track tool outputs for deduplication during streaming
    tool_outputs: HashMap<String, String>,
    // Track pending slash command so responses render as system messages
    pub pending_command: Option<String>,
    command_response_buffer: String,
    // Slash command autocomplete popup
    pub command_popup: Option<CommandPopup>,
    // Model picker fuzzy-finder popup
    pub model_picker: Option<ModelPicker>,
    /// Cached available models (populated on connect or on-demand).
    pub available_models: Vec<ModelInfo>,
    pub message_viewport: Option<Rect>,
    pub visible_text_lines: Vec<String>,
    pub mouse_selection: Option<MouseSelection>,
    pub message_start_lines: Vec<usize>,
    pub current_message_index: Option<usize>,
    /// Terminal image protocol picker (protocol + font size detection).
    pub picker: Picker,
    /// Cache of pre-encoded images keyed by source file path.
    pub image_cache: HashMap<String, Protocol>,
}

impl fmt::Debug for App {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("App")
            .field("connection_state", &self.connection_state)
            .field("messages", &self.messages.len())
            .field("input_text", &self.input_text)
            .field("is_input_focused", &self.is_input_focused)
            .field("scroll_from_bottom", &self.scroll_from_bottom)
            .field("current_model", &self.current_model)
            .field("is_processing", &self.is_processing)
            .field("image_cache_size", &self.image_cache.len())
            .finish()
    }
}

impl App {
    pub fn new(picker: Picker, theme: Theme) -> Self {
        Self {
            theme,
            connection_state: ConnectionState::default(),
            messages: Vec::new(),
            input_text: String::new(),
            is_input_focused: true,
            scroll_from_bottom: 0,
            max_scroll_from_bottom: 0,
            current_model: None,
            context_window: None,
            context_tokens: None,
            is_processing: false,
            latency_ms: None,
            token_usage: TokenUsage::default(),
            error_message: None,
            show_help: false,
            show_thinking: true,
            show_tools: true,
            render_cache_width: None,
            render_cache_show_thinking: true,
            render_cache_show_tools: true,
            spinner_frame: 0,
            streaming_message_id: None,
            aborted: false,
            tool_outputs: HashMap::new(),
            pending_command: None,
            command_response_buffer: String::new(),
            command_popup: None,
            model_picker: None,
            available_models: Vec::new(),
            message_viewport: None,
            visible_text_lines: Vec::new(),
            mouse_selection: None,
            message_start_lines: Vec::new(),
            current_message_index: None,
            picker,
            image_cache: HashMap::new(),
        }
    }

    pub fn handle_event(&mut self, event: WsEvent) {
        match event {
            WsEvent::Connected => {
                self.connection_state = ConnectionState::Connected;
                self.error_message = None;
                info!("Connected to gateway");
            }
            WsEvent::Disconnected => {
                self.connection_state = ConnectionState::Disconnected;
                self.is_processing = false;
                self.streaming_message_id = None;
                self.pending_command = None;
                self.command_response_buffer.clear();
                info!("Disconnected from gateway");
            }
            WsEvent::Latency(ms) => {
                self.latency_ms = Some(ms);
            }
            WsEvent::Error(msg) => {
                self.connection_state = ConnectionState::Error;
                self.error_message = Some(msg);
                self.is_processing = false;
                self.streaming_message_id = None;
                self.pending_command = None;
                self.command_response_buffer.clear();
            }
            WsEvent::Message(msg) => self.handle_server_message(msg),
        }
    }

    fn handle_server_message(&mut self, msg: ServerMessage) {
        debug!("Server message: {:?}", msg);

        match msg {
            ServerMessage::Connection { data } => {
                self.connection_state = if data.connected {
                    ConnectionState::Connected
                } else {
                    ConnectionState::Disconnected
                };
                if let Some(model) = data.model {
                    self.current_model = Some(model);
                }
                if let Some(context_window) = data.context_window {
                    self.context_window = Some(context_window);
                }
            }
            ServerMessage::UserMessage { data } => {
                if !is_heartbeat_prompt(&data.content) {
                    self.add_user_message(&data.content);
                }
            }
            ServerMessage::TextDelta { data } => {
                if let Some(ref cmd) = self.pending_command {
                    info!("Buffering text_delta for command /{}", cmd);
                    self.command_response_buffer.push_str(&data.content);
                } else {
                    self.append_text_delta(&data.content);
                }
            }
            ServerMessage::ThinkingDelta { data } => {
                self.append_thinking_delta(&data.thinking_id, &data.content);
            }
            ServerMessage::ThinkingDone { data } => {
                self.complete_thinking(&data.thinking_id, &data.content);
            }
            ServerMessage::ToolStart { data } => {
                self.add_tool_call(&data.tool_call_id, &data.tool_name, &data.args, &data.label);
            }
            ServerMessage::ToolOutput { data } => {
                self.update_tool_output(&data);
            }
            ServerMessage::ToolEnd { data } => {
                self.finalize_tool_call(&data.tool_call_id, &data.tool_name);
            }
            ServerMessage::Image { data } => {
                self.add_image(&data.source, data.alt);
            }
            ServerMessage::Error { data } => {
                if self.pending_command.take().is_some() {
                    info!("Error received while waiting for command response — clearing state");
                }
                self.command_response_buffer.clear();
                self.add_system_message(&format!("⚠️  {}", data.message));
                self.is_processing = false;
                self.streaming_message_id = None;
            }
            ServerMessage::Done { data } => {
                if let Some(cmd) = self.pending_command.take() {
                    // Command response — render as system message instead of assistant turn
                    info!(
                        "Done received for command /{} — rendering as system message",
                        cmd
                    );
                    let text = if !self.command_response_buffer.is_empty() {
                        std::mem::take(&mut self.command_response_buffer)
                    } else {
                        data.final_text
                    };
                    self.add_system_message(&text);
                    self.is_processing = false;
                    self.streaming_message_id = None;
                    self.aborted = false;
                    return;
                }
                // Skip heartbeat responses entirely
                if is_heartbeat_response(&data.final_text) {
                    info!("Skipping heartbeat response in done");
                    self.cancel_streaming_message();
                    return;
                }
                info!("Done received for normal prompt — finalizing streaming");
                self.finalize_streaming(&data.final_text);
                if let Some(usage) = data.usage {
                    // Use gateway-provided context tokens (most accurate)
                    if let Some(ct) = usage.context_tokens {
                        self.context_tokens = Some(ct);
                    }
                    // Use cumulative session usage if provided, otherwise accumulate manually
                    if let Some(ref cumulative) = usage.cumulative {
                        self.token_usage = TokenUsage {
                            input: cumulative.input,
                            output: cumulative.output,
                            cache_read: cumulative.cache_read,
                            cache_write: cumulative.cache_write,
                            total: cumulative.total,
                            cost: cumulative.cost,
                            context_tokens: None, // already set above from usage.context_tokens
                            cumulative: None,
                        };
                    } else {
                        // Fallback: accumulate per-turn usage
                        self.token_usage.input += usage.input;
                        self.token_usage.output += usage.output;
                        self.token_usage.cache_read += usage.cache_read;
                        self.token_usage.cache_write += usage.cache_write;
                        self.token_usage.total += usage.total;
                        if let Some(cost) = usage.cost {
                            self.token_usage.cost =
                                Some(self.token_usage.cost.unwrap_or(0.0) + cost);
                        }
                    }
                }
            }
            ServerMessage::Usage { data } => {
                self.token_usage.input += data.input;
                self.token_usage.output += data.output;
                self.token_usage.cache_read += data.cache_read;
                self.token_usage.cache_write += data.cache_write;
                self.token_usage.total += data.total;
            }
            ServerMessage::Models { data } => {
                self.available_models = data.models;
                // If a model picker is open and waiting for data, populate it.
                if let Some(ref mut picker) = self.model_picker {
                    picker.all_models = self.available_models.clone();
                    picker.current = data.current;
                    self.filter_models();
                }
            }
            ServerMessage::State { data } => {
                if let Some(model) = data.model {
                    self.current_model = Some(model);
                }
                if let Some(context_window) = data.context_window {
                    self.context_window = Some(context_window);
                }
                // Use state context tokens as fallback
                if self.context_tokens.is_none() {
                    self.context_tokens = data.context_tokens;
                }
                // Use session usage from state if available (covers reconnection)
                if let Some(ref session_usage) = data.session_usage {
                    if session_usage.total > self.token_usage.total {
                        self.token_usage = session_usage.clone();
                    }
                }
                self.is_processing = data.is_processing;
            }
            ServerMessage::ModelSwitched { data } => {
                if data.success {
                    self.current_model = data.model;
                } else if let Some(error) = data.error {
                    self.add_system_message(&format!("⚠️  Failed to switch model: {}", error));
                }
            }
            ServerMessage::History { data } => {
                self.load_history(data.messages);
            }
            ServerMessage::Proactive { data } => {
                self.add_system_message(&data.message);
            }
            _ => {}
        }
    }

    // ==========================================================================
    // Message builders
    // ==========================================================================

    fn add_user_message(&mut self, content: &str) {
        let msg = ChatMessage {
            id: format!("msg-{}", self.messages.len()),
            role: MessageRole::User,
            items: vec![ContentItem::Text(sanitize_display_text(content))],
            timestamp: Local::now(),
            is_streaming: false,
            render_cache: Vec::new(),
            render_dirty: true,
            item_line_offsets: Vec::new(),
        };
        self.messages.push(msg);
    }

    fn ensure_streaming_message(&mut self) -> &mut ChatMessage {
        if let Some(id) = &self.streaming_message_id {
            if let Some(idx) = self.messages.iter().position(|m| &m.id == id) {
                return &mut self.messages[idx];
            }
        }

        // Create new assistant message
        let id = format!("msg-{}", self.messages.len());
        let msg = ChatMessage {
            id: id.clone(),
            role: MessageRole::Assistant,
            items: vec![],
            timestamp: Local::now(),
            is_streaming: true,
            render_cache: Vec::new(),
            render_dirty: true,
            item_line_offsets: Vec::new(),
        };
        self.messages.push(msg);
        self.streaming_message_id = Some(id.clone());
        self.is_processing = true;

        let idx = self.messages.len() - 1;
        &mut self.messages[idx]
    }

    fn append_text_delta(&mut self, delta: &str) {
        if self.aborted {
            return;
        }
        let msg = self.ensure_streaming_message();

        // Skip heartbeat responses
        if delta.contains("[[NO_ACTION]]") || delta.starts_with("[Heartbeat]") {
            return;
        }

        let delta = sanitize_display_text(delta);

        // Append to last text item, or create new one
        if let Some(last) = msg.items.last_mut() {
            match last {
                ContentItem::Text(text) => {
                    text.push_str(&delta);
                    msg.render_dirty = true;
                    return;
                }
                _ => {}
            }
        }
        msg.items.push(ContentItem::Text(delta));
        msg.render_dirty = true;
    }

    fn append_thinking_delta(&mut self, thinking_id: &str, delta: &str) {
        if self.aborted {
            return;
        }
        let msg = self.ensure_streaming_message();

        if delta.contains("[[NO_ACTION]]") || delta.starts_with("[Heartbeat]") {
            return;
        }

        let delta = sanitize_display_text(delta);

        // Append to the matching streaming thinking block if it already exists.
        for item in msg.items.iter_mut().rev() {
            if let ContentItem::Thinking {
                thinking_id: Some(existing_id),
                content,
                is_complete: false,
            } = item
            {
                if existing_id == thinking_id {
                    content.push_str(&delta);
                    msg.render_dirty = true;
                    return;
                }
            }
        }

        // Fall back to the latest unkeyed incomplete block for compatibility with older history.
        for item in msg.items.iter_mut().rev() {
            if let ContentItem::Thinking {
                thinking_id: None,
                content,
                is_complete: false,
            } = item
            {
                content.push_str(&delta);
                msg.render_dirty = true;
                return;
            }
        }

        // Create new thinking block
        msg.items.push(ContentItem::Thinking {
            thinking_id: Some(thinking_id.to_string()),
            content: delta,
            is_complete: false,
        });
        msg.render_dirty = true;
    }

    fn complete_thinking(&mut self, thinking_id: &str, content: &str) {
        if let Some(id) = &self.streaming_message_id {
            if let Some(idx) = self.messages.iter().position(|m| &m.id == id) {
                let msg = &mut self.messages[idx];
                // Complete the matching thinking block if present.
                for item in msg.items.iter_mut().rev() {
                    if let ContentItem::Thinking {
                        thinking_id: Some(existing_id),
                        content: existing_content,
                        is_complete,
                    } = item
                    {
                        if existing_id == thinking_id && !*is_complete {
                            *existing_content = sanitize_display_text(content);
                            *is_complete = true;
                            msg.render_dirty = true;
                            return;
                        }
                    }
                }

                // Compatibility fallback for older/unkeyed thinking blocks.
                for item in msg.items.iter_mut().rev() {
                    if let ContentItem::Thinking {
                        thinking_id: None,
                        content: existing_content,
                        is_complete,
                    } = item
                    {
                        if !*is_complete {
                            *existing_content = sanitize_display_text(content);
                            *is_complete = true;
                            msg.render_dirty = true;
                            return;
                        }
                    }
                }

                // If the gateway sends only a completion snapshot, still preserve order.
                msg.items.push(ContentItem::Thinking {
                    thinking_id: Some(thinking_id.to_string()),
                    content: sanitize_display_text(content),
                    is_complete: true,
                });
                msg.render_dirty = true;
            }
        }
    }

    fn add_tool_call(
        &mut self,
        id: &str,
        name: &str,
        args: &Option<serde_json::Value>,
        label: &str,
    ) {
        if self.aborted {
            return;
        }
        let msg = self.ensure_streaming_message();

        let args_str = args
            .as_ref()
            .map(|v| sanitize_display_text(&v.to_string()))
            .unwrap_or_else(|| "{}".to_string());

        msg.items.push(ContentItem::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            args: args_str,
            label: sanitize_display_text(label),
            is_complete: false,
            result: None,
            is_error: false,
        });
        msg.render_dirty = true;
    }

    fn update_tool_output(&mut self, data: &ToolOutputData) {
        let Some(msg_id) = &self.streaming_message_id else {
            return;
        };
        let Some(idx) = self.messages.iter().position(|m| &m.id == msg_id) else {
            return;
        };
        let msg = &mut self.messages[idx];

        let output = if data.truncated.unwrap_or(false) {
            format!("{}\n… (truncated)", sanitize_display_text(&data.output))
        } else {
            sanitize_display_text(&data.output)
        };

        // Store in our tracking map
        self.tool_outputs
            .insert(data.tool_call_id.clone(), output.clone());

        // Merge output directly into the matching ToolCall item.
        if let Some(tool_idx) = msg.items.iter().position(|item| {
            matches!(item,
                ContentItem::ToolCall { id, .. } if id == &data.tool_call_id
            )
        }) {
            if let ContentItem::ToolCall {
                result, is_error, ..
            } = &mut msg.items[tool_idx]
            {
                *result = Some(output);
                *is_error = false;
                msg.render_dirty = true;
            }
        }
    }

    fn finalize_tool_call(&mut self, tool_call_id: &str, tool_name: &str) {
        let _ = tool_name;
        let Some(msg_id) = &self.streaming_message_id else {
            return;
        };
        let Some(idx) = self.messages.iter().position(|m| &m.id == msg_id) else {
            return;
        };
        let msg = &mut self.messages[idx];

        for item in &mut msg.items {
            if let ContentItem::ToolCall {
                id, is_complete, ..
            } = item
            {
                if id == tool_call_id {
                    *is_complete = true;
                    msg.render_dirty = true;
                    break;
                }
            }
        }
    }

    fn add_image(&mut self, source: &str, alt: Option<String>) {
        if self.aborted {
            return;
        }

        // Try to decode and encode the image for terminal rendering.
        // The source is a local file path (from the gateway's image storage).
        if !self.image_cache.contains_key(source) {
            match self.encode_image(source) {
                Ok(proto) => {
                    self.image_cache.insert(source.to_string(), proto);
                }
                Err(e) => {
                    warn!("Failed to encode image {}: {}", source, e);
                    // Continue — the image will render as a text placeholder.
                }
            }
        }

        let msg = self.ensure_streaming_message();
        msg.items.push(ContentItem::Image {
            source: source.to_string(),
            alt,
        });
        msg.render_dirty = true;
    }

    /// Decode an image from disk and pre-encode it for the terminal's graphics protocol.
    fn encode_image(&mut self, path: &str) -> anyhow::Result<Protocol> {
        let dyn_img = image::ImageReader::open(path)?.decode()?;

        let (img_w, img_h) = (dyn_img.width(), dyn_img.height());

        // Calculate target cell size: fit to content_width, preserve aspect ratio.
        let cols = self.render_cache_width.unwrap_or(80) as u32;
        let font_size = self.picker.font_size();
        let cell_w_px = font_size.width as u32;
        let cell_h_px = font_size.height as u32;

        // Fit image to the available width in cells, calculate proportional height.
        let target_width_cells = cols.saturating_sub(4); // margin
        let target_width_px = target_width_cells * cell_w_px;
        let scale = target_width_px as f64 / img_w as f64;
        let target_height_cells = ((img_h as f64 * scale) / cell_h_px as f64).ceil() as u16;
        let target_width_cells = target_width_cells as u16;

        let size = Size::new(target_width_cells, target_height_cells.max(1));

        let proto = self.picker.new_protocol(dyn_img, size, Resize::Fit(None))?;

        debug!(
            "Encoded image {}: {}x{} cells ({}x{}px original)",
            path, size.width, size.height, img_w, img_h
        );

        Ok(proto)
    }

    pub fn add_system_message(&mut self, content: &str) {
        let msg = ChatMessage {
            id: format!("msg-{}", self.messages.len()),
            role: MessageRole::System,
            items: vec![ContentItem::Text(sanitize_display_text(content))],
            timestamp: Local::now(),
            is_streaming: false,
            render_cache: Vec::new(),
            render_dirty: true,
            item_line_offsets: Vec::new(),
        };
        self.messages.push(msg);
    }

    fn finalize_streaming(&mut self, final_text: &str) {
        if let Some(id) = self.streaming_message_id.take() {
            if let Some(idx) = self.messages.iter().position(|m| m.id == id) {
                let msg = &mut self.messages[idx];
                msg.is_streaming = false;

                // Web UI semantics: keep streamed items as-is (text blocks stay in their
                // natural position relative to tool calls). Only append final_text if there
                // are zero text items at all (prevents blank responses).
                let has_text = msg.items.iter().any(|i| matches!(i, ContentItem::Text(_)));

                if !has_text && !final_text.is_empty() {
                    msg.items
                        .push(ContentItem::Text(sanitize_display_text(final_text)));
                }

                // Mark incomplete thinking blocks as complete; remove empty ones
                msg.items.retain(|item| {
                    if let ContentItem::Thinking { content, .. } = item {
                        !content.is_empty()
                    } else {
                        true
                    }
                });
                for item in &mut msg.items {
                    if let ContentItem::Thinking {
                        ref mut is_complete,
                        ref mut content,
                        ..
                    } = item
                    {
                        if !*is_complete {
                            *is_complete = true;
                            *content = sanitize_display_text(content);
                        }
                    }
                }

                msg.render_dirty = true;
            }
        }

        self.is_processing = false;
        self.aborted = false;
        self.tool_outputs.clear();
    }

    /// Re-enable auto-scroll (pin to bottom)

    // ==========================================================================
    // User actions
    // ==========================================================================

    pub fn submit_message(&mut self) -> Option<ClientMessage> {
        let text = self.input_text.trim().to_string();
        if text.is_empty() || self.is_processing {
            return None;
        }

        self.aborted = false;

        // Add user message locally (gateway doesn't echo it back to sender)
        let user_msg = ChatMessage {
            id: format!("msg-{}", self.messages.len()),
            role: MessageRole::User,
            items: vec![ContentItem::Text(sanitize_display_text(&text))],
            timestamp: Local::now(),
            is_streaming: false,
            render_cache: Vec::new(),
            render_dirty: true,
            item_line_offsets: Vec::new(),
        };
        self.messages.push(user_msg);
        self.scroll_to_bottom();

        let msg = if text.starts_with('/') {
            let parts: Vec<&str> = text[1..].splitn(2, ' ').collect();
            let command = parts[0].to_string();

            // Handle local-only commands
            if command == "clear" {
                self.messages.clear();
                self.input_text.clear();
                return None;
            }

            // Intercept /model with no args (or /model list) to show the fuzzy picker.
            if command == "model" {
                let arg = parts.get(1).map(|s| s.trim());
                if arg.is_none() || arg == Some("list") {
                    self.input_text.clear();
                    self.pending_command = None;
                    if self.available_models.is_empty() {
                        // We don't have models cached yet — request them and show picker when they arrive.
                        self.add_system_message("Loading models…");
                    }
                    self.open_model_picker();
                    return None;
                }
            }

            // Handle /theme locally (no gateway round-trip)
            if command == "theme" {
                self.input_text.clear();
                self.pending_command = None;
                let arg = parts.get(1).map(|s| s.trim());
                match arg {
                    None | Some("") | Some("list") => {
                        let names = Theme::all_names();
                        let list = names
                            .iter()
                            .map(|n| {
                                format!(
                                    "  • {} {}",
                                    n,
                                    if *n == self.theme.name {
                                        "← current"
                                    } else {
                                        ""
                                    }
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        self.add_system_message(&format!(
                            "Available themes:\n{}\n\nUsage: /theme <name>",
                            list
                        ));
                    }
                    Some(name) => {
                        if self.set_theme(name) {
                            self.add_system_message(&format!("Switched to theme: {}", name));
                        } else {
                            let names = Theme::all_names().join(", ");
                            self.add_system_message(&format!(
                                "Unknown theme \"{}\". Available: {}",
                                name, names
                            ));
                        }
                    }
                }
                return None;
            }

            self.pending_command = Some(command.clone());
            self.command_response_buffer.clear();
            info!("Command submitted: /{} — pending_command set", command);
            let args = parts.get(1).map(|s| vec![s.to_string()]);
            ClientMessage::Command { command, args }
        } else {
            // Normal prompt — clear any stale command state
            self.pending_command = None;
            self.command_response_buffer.clear();
            ClientMessage::Prompt { message: text }
        };

        self.input_text.clear();
        self.command_popup = None;
        Some(msg)
    }

    pub fn abort(&mut self) -> Option<ClientMessage> {
        if self.is_processing {
            info!("Aborting — cleaning up streaming state");
            // Clean up streaming state immediately so the UI reflects the abort
            // even before the gateway sends done/error.
            if let Some(ref id) = self.streaming_message_id.clone() {
                if let Some(idx) = self.messages.iter().position(|m| &m.id == id) {
                    let msg = &mut self.messages[idx];
                    msg.is_streaming = false;
                    // Append an aborted marker to the last text item, or create one
                    let has_text = msg.items.iter().any(|i| matches!(i, ContentItem::Text(_)));
                    if has_text {
                        if let Some(last) = msg.items.last_mut() {
                            if let ContentItem::Text(ref mut text) = last {
                                text.push_str("\n\n⚠️  Aborted");
                            }
                        }
                    } else {
                        msg.items.push(ContentItem::Text("⚠️  Aborted".to_string()));
                    }
                    msg.render_dirty = true;
                }
            }
            self.streaming_message_id = None;
            self.is_processing = false;
            self.aborted = true;
            self.tool_outputs.clear();
            Some(ClientMessage::Abort)
        } else {
            None
        }
    }

    pub fn scroll_up(&mut self) {
        let _ = self.scroll_up_lines(3);
    }

    pub fn scroll_down(&mut self) {
        let _ = self.scroll_down_lines(3);
    }

    pub fn page_up(&mut self, page_size: usize) {
        let _ = self.scroll_up_lines(page_size);
    }

    pub fn page_down(&mut self, page_size: usize) {
        let _ = self.scroll_down_lines(page_size);
    }

    pub fn half_page_up(&mut self) {
        let _ = self.scroll_up_lines(self.half_page_size());
    }

    pub fn half_page_down(&mut self) {
        let _ = self.scroll_down_lines(self.half_page_size());
    }

    pub fn jump_prev_message(&mut self) -> bool {
        let Some(current_idx) = self.current_message_index else {
            return false;
        };
        if current_idx == 0 {
            return false;
        }
        self.jump_to_message_index(current_idx - 1)
    }

    pub fn jump_next_message(&mut self) -> bool {
        let Some(current_idx) = self.current_message_index else {
            return false;
        };
        if current_idx + 1 >= self.message_start_lines.len() {
            return false;
        }
        self.jump_to_message_index(current_idx + 1)
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_from_bottom = 0;
    }

    pub fn scroll_to_top(&mut self) {
        self.scroll_from_bottom = usize::MAX;
    }

    #[allow(dead_code)]
    pub fn is_auto_scrolling(&self) -> bool {
        self.scroll_from_bottom == 0
    }

    pub fn scroll_up_lines(&mut self, lines: usize) -> bool {
        let previous = self.scroll_from_bottom;
        self.scroll_from_bottom = self
            .scroll_from_bottom
            .saturating_add(lines)
            .min(self.max_scroll_from_bottom);
        if self.scroll_from_bottom != previous {
            self.clear_mouse_selection();
        }
        self.scroll_from_bottom != previous
    }

    pub fn scroll_down_lines(&mut self, lines: usize) -> bool {
        let previous = self.scroll_from_bottom;
        self.scroll_from_bottom = self.scroll_from_bottom.saturating_sub(lines);
        if self.scroll_from_bottom != previous {
            self.clear_mouse_selection();
        }
        self.scroll_from_bottom != previous
    }

    /// Advance spinner animation. Call on each tick.
    pub fn tick(&mut self) {
        self.spinner_frame = (self.spinner_frame + 1) % SPINNER_FRAMES.len();
        if self.is_processing {
            for msg in &mut self.messages {
                if msg.is_streaming {
                    msg.render_dirty = true;
                }
            }
        }
    }

    /// Get the current spinner character
    pub fn spinner_char(&self) -> &'static str {
        SPINNER_FRAMES[self.spinner_frame]
    }

    pub fn toggle_thinking(&mut self) {
        self.show_thinking = !self.show_thinking;
    }

    pub fn toggle_tools(&mut self) {
        self.show_tools = !self.show_tools;
    }

    /// Invalidate the image cache (e.g. on terminal resize — images need re-encoding at new width).
    pub fn invalidate_image_cache(&mut self) {
        self.image_cache.clear();
    }

    /// Switch to a different theme at runtime.
    pub fn set_theme(&mut self, name: &str) -> bool {
        if let Some(theme) = Theme::by_name(name) {
            self.theme = theme;
            // Mark all messages dirty so they re-render with new theme
            for msg in &mut self.messages {
                msg.render_dirty = true;
            }
            true
        } else {
            false
        }
    }

    pub fn toggle_help(&mut self) {
        self.show_help = !self.show_help;
    }

    // ==========================================================================
    // Slash command autocomplete
    // ==========================================================================

    /// Open the command autocomplete popup based on the current input text.
    pub fn open_command_popup(&mut self) {
        if !self.input_text.starts_with('/') {
            self.command_popup = None;
            return;
        }
        // Only complete the command name, not args
        let after_slash = &self.input_text[1..];
        if after_slash.contains(' ') {
            self.command_popup = None;
            return;
        }
        let query = after_slash.to_lowercase();
        let matches: Vec<SlashCommand> = SLASH_COMMANDS
            .iter()
            .filter(|cmd| cmd.name.starts_with(&query))
            .copied()
            .collect();
        if matches.is_empty() {
            self.command_popup = None;
            return;
        }
        self.command_popup = Some(CommandPopup {
            query,
            selected: 0,
            matches,
        });
    }

    /// Cycle to the next command match.
    pub fn select_next_command(&mut self) {
        if let Some(ref mut popup) = self.command_popup {
            popup.selected = (popup.selected + 1) % popup.matches.len();
        }
    }

    /// Cycle to the previous command match.
    pub fn select_prev_command(&mut self) {
        if let Some(ref mut popup) = self.command_popup {
            let len = popup.matches.len();
            popup.selected = (popup.selected + len - 1) % len;
        }
    }

    /// Accept the currently selected command: fill input and close popup.
    pub fn accept_command_completion(&mut self) {
        if let Some(popup) = self.command_popup.take() {
            if let Some(cmd) = popup.matches.get(popup.selected) {
                self.input_text = cmd.usage.to_string();
            }
        }
    }

    /// Close the command popup without accepting.
    pub fn close_command_popup(&mut self) {
        self.command_popup = None;
    }

    // ==========================================================================
    // Model Picker
    // ==========================================================================

    /// Open the model picker fuzzy-finder popup.
    pub fn open_model_picker(&mut self) {
        let all = self.available_models.clone();
        let current = self.current_model.clone();
        let filtered: Vec<usize> = (0..all.len()).collect();
        self.model_picker = Some(ModelPicker {
            query: String::new(),
            selected: 0,
            all_models: all,
            filtered_indices: filtered,
            current: current.clone(),
        });
        // If we already know which model is current, pre-select it in the list.
        if let Some(ref cur) = current {
            if let Some(idx) = self
                .available_models
                .iter()
                .position(|m| m.provider == cur.provider && m.id == cur.id)
            {
                if let Some(ref mut picker) = self.model_picker {
                    picker.selected = idx;
                }
            }
        }
    }

    /// Close the model picker without selecting.
    pub fn close_model_picker(&mut self) {
        self.model_picker = None;
    }

    /// Recompute filtered_indices based on the current query.
    pub fn filter_models(&mut self) {
        if let Some(ref mut picker) = self.model_picker {
            let q = picker.query.to_lowercase();
            if q.is_empty() {
                picker.filtered_indices = (0..picker.all_models.len()).collect();
            } else {
                picker.filtered_indices = picker
                    .all_models
                    .iter()
                    .enumerate()
                    .filter(|(_, m)| {
                        let combined = format!("{}/{}", m.provider, m.id);
                        combined.to_lowercase().contains(&q)
                            || m.name.to_lowercase().contains(&q)
                            || m.id.to_lowercase().contains(&q)
                            || m.provider.to_lowercase().contains(&q)
                    })
                    .map(|(i, _)| i)
                    .collect();
            }
            picker.selected = picker
                .selected
                .min(picker.filtered_indices.len().saturating_sub(1));
        }
    }

    /// Append a character to the model picker query and refilter.
    pub fn model_picker_type_char(&mut self, c: char) {
        if let Some(ref mut picker) = self.model_picker {
            picker.query.push(c);
        }
        self.filter_models();
    }

    /// Remove the last character from the model picker query and refilter.
    pub fn model_picker_backspace(&mut self) {
        if let Some(ref mut picker) = self.model_picker {
            picker.query.pop();
        }
        self.filter_models();
    }

    /// Cycle to the next model match.
    pub fn select_next_model(&mut self) {
        if let Some(ref mut picker) = self.model_picker {
            let len = picker.filtered_indices.len();
            if len > 0 {
                picker.selected = (picker.selected + 1) % len;
            }
        }
    }

    /// Cycle to the previous model match.
    pub fn select_prev_model(&mut self) {
        if let Some(ref mut picker) = self.model_picker {
            let len = picker.filtered_indices.len();
            if len > 0 {
                picker.selected = (picker.selected + len - 1) % len;
            }
        }
    }

    /// Returns the currently selected model (by filtered index), or None.
    pub fn selected_model(&self) -> Option<ModelInfo> {
        let picker = self.model_picker.as_ref()?;
        let idx = picker.filtered_indices.get(picker.selected)?;
        picker.all_models.get(*idx).cloned()
    }

    /// Accept the currently selected model and return a SwitchModel message.
    pub fn accept_model_selection(&mut self) -> Option<ClientMessage> {
        let model = self.selected_model()?;
        self.close_model_picker();
        Some(ClientMessage::SwitchModel {
            provider: model.provider,
            model_id: model.id,
        })
    }

    pub fn update_message_viewport(&mut self, viewport: Rect, visible_text_lines: Vec<String>) {
        self.message_viewport = Some(viewport);
        self.visible_text_lines = visible_text_lines;
        if let Some(selection) = &self.mouse_selection {
            if selection.anchor.row >= self.visible_text_lines.len()
                || selection.focus.row >= self.visible_text_lines.len()
            {
                self.mouse_selection = None;
            }
        }
    }

    pub fn update_message_navigation(
        &mut self,
        message_start_lines: Vec<usize>,
        first_visible_line: usize,
    ) {
        self.message_start_lines = message_start_lines;
        let focus_line = first_visible_line
            + self
                .message_viewport
                .map(|viewport| usize::from(viewport.height) / 2)
                .unwrap_or(0);
        self.current_message_index = self
            .message_start_lines
            .iter()
            .enumerate()
            .take_while(|(_, line)| **line <= focus_line)
            .map(|(idx, _)| idx)
            .last()
            .or_else(|| (!self.message_start_lines.is_empty()).then_some(0));
    }

    pub fn handle_mouse_down(&mut self, x: u16, y: u16) -> bool {
        let Some(point) = self.selection_point_from_mouse(x, y) else {
            self.clear_mouse_selection();
            return false;
        };
        self.mouse_selection = Some(MouseSelection {
            anchor: point,
            focus: point,
            dragging: true,
        });
        true
    }

    pub fn handle_mouse_drag(&mut self, x: u16, y: u16) -> bool {
        let Some(point) = self.selection_point_from_mouse(x, y) else {
            return false;
        };
        let Some(selection) = &mut self.mouse_selection else {
            return false;
        };
        selection.focus = point;
        selection.dragging = true;
        true
    }

    pub fn handle_mouse_up(&mut self, x: u16, y: u16) -> Option<String> {
        let Some(point) = self.selection_point_from_mouse(x, y) else {
            self.clear_mouse_selection();
            return None;
        };
        let selection = self.mouse_selection.as_mut()?;
        selection.focus = point;
        selection.dragging = false;
        self.selected_text()
    }

    pub fn clear_mouse_selection(&mut self) {
        self.mouse_selection = None;
    }

    pub fn selection_bounds(&self) -> Option<(SelectionPoint, SelectionPoint)> {
        let selection = self.mouse_selection.as_ref()?;
        if selection.anchor <= selection.focus {
            Some((selection.anchor, selection.focus))
        } else {
            Some((selection.focus, selection.anchor))
        }
    }

    pub fn selected_text(&self) -> Option<String> {
        let (start, end) = self.selection_bounds()?;
        if self.visible_text_lines.is_empty() || start.row >= self.visible_text_lines.len() {
            return None;
        }

        let last_row = end.row.min(self.visible_text_lines.len().saturating_sub(1));
        let mut parts = Vec::new();

        for row in start.row..=last_row {
            let line = self.visible_text_lines.get(row)?;
            let text = if start.row == end.row {
                slice_text_by_columns(line, start.col, end.col.saturating_add(1))
            } else if row == start.row {
                slice_text_by_columns(line, start.col, usize::MAX)
            } else if row == last_row {
                slice_text_by_columns(line, 0, end.col.saturating_add(1))
            } else {
                line.clone()
            };
            parts.push(text.trim_end_matches(' ').to_string());
        }

        let joined = parts.join("\n");
        if joined.trim().is_empty() {
            None
        } else {
            Some(joined)
        }
    }

    fn selection_point_from_mouse(&self, x: u16, y: u16) -> Option<SelectionPoint> {
        let viewport = self.message_viewport?;
        if viewport.width == 0
            || viewport.height == 0
            || x < viewport.x
            || y < viewport.y
            || x >= viewport.x + viewport.width
            || y >= viewport.y + viewport.height
        {
            return None;
        }

        let row = (y - viewport.y) as usize;
        let line = self.visible_text_lines.get(row)?;
        let col = clamp_column_to_text(line, (x - viewport.x) as usize);
        Some(SelectionPoint { row, col })
    }

    fn half_page_size(&self) -> usize {
        self.message_viewport
            .map(|viewport| usize::from(viewport.height.saturating_sub(1)).max(1) / 2)
            .unwrap_or(10)
            .max(1)
    }

    fn jump_to_message_index(&mut self, message_idx: usize) -> bool {
        let Some(&target_line) = self.message_start_lines.get(message_idx) else {
            return false;
        };
        let next_start = self
            .message_start_lines
            .get(message_idx + 1)
            .copied()
            .unwrap_or(target_line + 1);
        let message_height = next_start.saturating_sub(target_line).max(1);
        let message_mid = target_line + (message_height / 2);
        let viewport_mid = self
            .message_viewport
            .map(|viewport| usize::from(viewport.height) / 2)
            .unwrap_or(0);
        let target_viewport_start = message_mid.saturating_sub(viewport_mid);
        let target_scroll = self
            .max_scroll_from_bottom
            .saturating_sub(target_viewport_start)
            .min(self.max_scroll_from_bottom);
        let changed = self.scroll_from_bottom != target_scroll;
        self.scroll_from_bottom = target_scroll;
        self.current_message_index = Some(message_idx);
        if changed {
            self.clear_mouse_selection();
        }
        changed
    }

    /// Load history messages from the gateway into the message list.
    fn load_history(&mut self, raw_messages: Vec<serde_json::Value>) {
        if raw_messages.is_empty() {
            return;
        }

        info!("Loading {} history messages", raw_messages.len());

        for entry in raw_messages {
            let role = entry
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("unknown");

            match role {
                "user" => {
                    if let Some(content) = self.extract_text_content(&entry) {
                        if is_heartbeat_prompt(&content) {
                            continue;
                        }
                        let id = entry
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("hist")
                            .to_string();
                        let timestamp = entry
                            .get("timestamp")
                            .and_then(|v| v.as_str())
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|dt| dt.with_timezone(&chrono::Local))
                            .unwrap_or_else(chrono::Local::now);
                        let msg = ChatMessage {
                            id,
                            role: MessageRole::User,
                            items: vec![ContentItem::Text(sanitize_display_text(&content))],
                            timestamp,
                            is_streaming: false,
                            render_cache: Vec::new(),
                            render_dirty: true,
                            item_line_offsets: Vec::new(),
                        };
                        self.messages.push(msg);
                    }
                }
                "assistant" => {
                    let id = entry
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("hist")
                        .to_string();
                    let timestamp = entry
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Local))
                        .unwrap_or_else(chrono::Local::now);

                    let mut items = Vec::new();
                    if let Some(content) = entry.get("content").and_then(|c| c.as_array()) {
                        for block in content {
                            let block_type =
                                block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match block_type {
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        if !text.is_empty() {
                                            items.push(ContentItem::Text(sanitize_display_text(
                                                text,
                                            )));
                                        }
                                    }
                                }
                                "thinking" => {
                                    if let Some(thinking) =
                                        block.get("thinking").and_then(|t| t.as_str())
                                    {
                                        if !thinking.is_empty() {
                                            items.push(ContentItem::Thinking {
                                                thinking_id: None,
                                                content: sanitize_display_text(thinking),
                                                is_complete: true,
                                            });
                                        }
                                    }
                                }
                                "toolCall" => {
                                    // History can have either format:
                                    // - Raw session: { type: "toolCall", id: "call_x", name: "bash", arguments: {...} }
                                    // - Gateway enriched: { type: "toolCall", toolCallId: "call_x", toolName: "bash", label: "..." }
                                    let tool_id = block
                                        .get("toolCallId")
                                        .or_else(|| block.get("id"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let tool_name = block
                                        .get("toolName")
                                        .or_else(|| block.get("name"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool")
                                        .to_string();
                                    let label = block
                                        .get("label")
                                        .and_then(|v| v.as_str())
                                        .map(sanitize_display_text)
                                        .unwrap_or_else(|| {
                                            // Build a label from arguments
                                            if let Some(args) = block.get("arguments") {
                                                if let Some(obj) = args.as_object() {
                                                    if let Some(first_val) = obj.values().next() {
                                                        if let Some(s) = first_val.as_str() {
                                                            if s.len() > 60 {
                                                                format!("{}...", &s[..57])
                                                            } else {
                                                                s.to_string()
                                                            }
                                                        } else {
                                                            first_val.to_string()
                                                        }
                                                    } else {
                                                        String::new()
                                                    }
                                                } else {
                                                    String::new()
                                                }
                                            } else {
                                                String::new()
                                            }
                                        });
                                    let args_str = block
                                        .get("arguments")
                                        .map(|a| sanitize_display_text(&a.to_string()))
                                        .unwrap_or_default();
                                    items.push(ContentItem::ToolCall {
                                        id: tool_id,
                                        name: tool_name,
                                        args: args_str,
                                        label,
                                        is_complete: true,
                                        result: None,
                                        is_error: false,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }

                    // Skip assistant messages that are just heartbeat/no-action responses,
                    // even if they include a thinking block.
                    if is_heartbeat_history_assistant(&items) {
                        continue;
                    }

                    if !items.is_empty() {
                        // Each assistant entry from the session is one LLM generation cycle.
                        // Don't merge consecutive entries — each gets its own message so
                        // the natural order (thinking → text → toolCall → tool call output)
                        // is preserved per cycle, matching the streaming UX.
                        let msg = ChatMessage {
                            id,
                            role: MessageRole::Assistant,
                            items,
                            timestamp,
                            is_streaming: false,
                            render_cache: Vec::new(),
                            render_dirty: true,
                            item_line_offsets: Vec::new(),
                        };
                        self.messages.push(msg);
                    }
                }
                "toolResult" => {
                    // Tool results come as top-level fields
                    let tool_call_id = entry
                        .get("toolCallId")
                        .or_else(|| entry.get("tool_call_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_name = entry
                        .get("toolName")
                        .or_else(|| entry.get("tool_name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let is_error = entry
                        .get("isError")
                        .or_else(|| entry.get("is_error"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let content = entry
                        .get("content")
                        .and_then(|c| c.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "(no output)".to_string());

                    // Merge into matching ToolCall in the last assistant message if possible.
                    let mut merged = false;
                    if let Some(last) = self.messages.last_mut() {
                        if last.role == MessageRole::Assistant {
                            for item in &mut last.items {
                                if let ContentItem::ToolCall {
                                    id,
                                    result: res,
                                    is_error: err_flag,
                                    ..
                                } = item
                                {
                                    if id == &tool_call_id {
                                        *res = Some(sanitize_display_text(&content));
                                        *err_flag = is_error;
                                        merged = true;
                                        last.render_dirty = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Fallback: orphan tool result with no matching ToolCall.
                    if !merged {
                        if let Some(last) = self.messages.last_mut() {
                            if last.role == MessageRole::Assistant {
                                last.items.push(ContentItem::ToolResult {
                                    tool_call_id,
                                    tool_name,
                                    content: sanitize_display_text(&content),
                                    is_error,
                                });
                                last.render_dirty = true;
                            }
                        }
                    }
                }
                _ => {
                    debug!("Skipping history entry with unknown role: {}", role);
                }
            }
        }

        info!("Loaded {} messages from history", self.messages.len());
    }

    /// Extract text content from a user/assistant message entry.
    fn extract_text_content(&self, entry: &serde_json::Value) -> Option<String> {
        let content = entry.get("content")?;

        // Content can be a string or an array of content blocks
        if let Some(text) = content.as_str() {
            if !text.is_empty() {
                return Some(sanitize_display_text(text));
            }
        }

        if let Some(arr) = content.as_array() {
            let texts: Vec<String> = arr
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        block
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(sanitize_display_text)
                    } else {
                        None
                    }
                })
                .collect();
            if !texts.is_empty() {
                return Some(texts.join("\n"));
            }
        }

        None
    }

    pub fn status_bar_text(&self) -> String {
        let mut parts = Vec::new();

        // Context tokens — the useful number (how much of the context window is used)
        if let Some(tokens) = self.context_tokens {
            if let Some(window) = self.context_window {
                let pct = (tokens as f64 / window as f64 * 100.0) as u16;
                parts.push(format!("{} ({}%)", format_number(tokens), pct));
            } else {
                parts.push(format!("{}", format_number(tokens)));
            }
        }

        // Last turn tokens (not cumulative — shows cost of the last response)
        if self.token_usage.total > 0 {
            parts.push(format!(
                "↑{} ↓{}",
                format_number(self.token_usage.input),
                format_number(self.token_usage.output),
            ));
        }

        if let Some(latency) = self.latency_ms {
            parts.push(format!("{}ms", latency));
        }

        if parts.is_empty() {
            String::new()
        } else {
            parts.join(" │ ")
        }
    }

    /// Remove the current streaming message without finalizing it.
    /// Used to discard heartbeat responses that should not appear in chat.
    fn cancel_streaming_message(&mut self) {
        if let Some(id) = self.streaming_message_id.take() {
            if let Some(idx) = self.messages.iter().position(|m| m.id == id) {
                self.messages.remove(idx);
            }
        }
        self.is_processing = false;
        self.aborted = false;
        self.tool_outputs.clear();
    }
}

fn clamp_column_to_text(text: &str, target_col: usize) -> usize {
    let mut current_col = 0usize;
    let mut last_boundary = 0usize;

    for ch in text.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if current_col + ch_width > target_col {
            return last_boundary;
        }
        current_col += ch_width;
        last_boundary = current_col;
    }

    current_col.min(target_col)
}

fn slice_text_by_columns(text: &str, start_col: usize, end_col: usize) -> String {
    let mut current_col = 0usize;
    let mut output = String::new();

    for ch in text.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        let next_col = current_col + ch_width;
        if next_col > start_col && current_col < end_col {
            output.push(ch);
        }
        current_col = next_col;
        if current_col >= end_col {
            break;
        }
    }

    output
}

/// Returns true if the message is a heartbeat prompt from the gateway.
fn is_heartbeat_prompt(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("[Heartbeat]")
        || trimmed.contains("MEMORY-WATCHER-SKIP")
        || (trimmed.contains("# Heartbeat") && trimmed.contains("Current Time"))
}

/// Returns true if the text is a heartbeat no-action response.
/// Only exact [[NO_ACTION]] / [[NO-ACTION]] matches are filtered —
/// real heartbeat content (reminders, suggestions, etc.) is shown.
fn is_heartbeat_response(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed == "[[NO_ACTION]]" || trimmed == "[[NO-ACTION]]"
}

fn is_heartbeat_history_assistant(items: &[ContentItem]) -> bool {
    if items.is_empty() {
        return false;
    }

    let mut saw_text = false;

    for item in items {
        match item {
            ContentItem::Text(t) => {
                saw_text = true;
                if !is_heartbeat_response(t) {
                    return false;
                }
            }
            ContentItem::Thinking { .. } => {}
            _ => return false,
        }
    }

    saw_text
}

fn sanitize_display_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if ch == '\u{1b}' {
            i += 1;
            if i < chars.len() && chars[i] == '[' {
                i += 1;
                while i < chars.len() {
                    let c = chars[i];
                    i += 1;
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }

        if ch == '[' {
            let mut j = i + 1;
            let mut saw_digit = false;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ';') {
                saw_digit = true;
                j += 1;
            }
            if saw_digit && j < chars.len() && chars[j] == 'm' {
                i = j + 1;
                continue;
            }
        }

        match ch {
            '\t' => out.push_str("    "),
            '\r' => {}
            '\n' => out.push('\n'),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_history_assistant_with_thinking_is_filtered() {
        let items = vec![
            ContentItem::Thinking {
                thinking_id: None,
                content: "Another heartbeat with empty action items.".to_string(),
                is_complete: true,
            },
            ContentItem::Text("[[NO_ACTION]]".to_string()),
        ];

        assert!(is_heartbeat_history_assistant(&items));
    }

    #[test]
    fn normal_assistant_message_is_not_filtered_as_heartbeat() {
        let items = vec![
            ContentItem::Thinking {
                thinking_id: None,
                content: "Thinking about the reply.".to_string(),
                is_complete: true,
            },
            ContentItem::Text("Real response".to_string()),
        ];

        assert!(!is_heartbeat_history_assistant(&items));
    }
}

fn format_number(n: u64) -> String {
    if n < 1000 {
        n.to_string()
    } else {
        format!("{:.1}k", n as f64 / 1000.0)
    }
}
