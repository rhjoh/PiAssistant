use serde::{Deserialize, Serialize};

// =============================================================================
// Client -> Gateway messages
// =============================================================================

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "prompt")]
    Prompt { message: String },
    #[serde(rename = "prompt_with_images")]
    PromptWithImages { message: String, images: Vec<ImageAttachment> },
    #[serde(rename = "abort")]
    Abort,
    #[serde(rename = "get_state")]
    GetState,
    #[serde(rename = "get_history")]
    GetHistory { limit: Option<usize> },
    #[serde(rename = "get_models")]
    GetModels,
    #[serde(rename = "switch_model")]
    SwitchModel { provider: String, model_id: String },
    #[serde(rename = "command")]
    Command { command: String, args: Option<Vec<String>> },
    #[serde(rename = "ping")]
    Ping { timestamp: Option<u64> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub data: String, // base64
    pub mime_type: String,
}

// =============================================================================
// Gateway -> Client messages
// =============================================================================

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "connection")]
    Connection { data: ConnectionData },
    #[serde(rename = "user_message")]
    UserMessage { data: UserMessageData },
    #[serde(rename = "text_delta")]
    TextDelta { data: TextDeltaData },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { data: ThinkingDeltaData },
    #[serde(rename = "thinking_done")]
    ThinkingDone { data: ThinkingDoneData },
    #[serde(rename = "tool_start")]
    ToolStart { data: ToolStartData },
    #[serde(rename = "tool_output")]
    ToolOutput { data: ToolOutputData },
    #[serde(rename = "tool_end")]
    ToolEnd { data: ToolEndData },
    #[serde(rename = "image")]
    Image { data: ImageData },
    #[serde(rename = "error")]
    Error { data: ErrorData },
    #[serde(rename = "done")]
    Done { data: DoneData },
    #[serde(rename = "usage")]
    Usage { data: TokenUsage },
    #[serde(rename = "state")]
    State { data: StateData },
    #[serde(rename = "history")]
    History { data: HistoryData },
    #[serde(rename = "models")]
    Models { data: ModelsData },
    #[serde(rename = "model_switched")]
    ModelSwitched { data: ModelSwitchedData },
    #[serde(rename = "pong")]
    Pong { data: PongData },
    #[serde(rename = "proactive")]
    Proactive { data: ProactiveData },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionData {
    pub connected: bool,
    pub model: Option<ModelInfo>,
    pub context_window: Option<u64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct UserMessageData {
    pub content: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TextDeltaData {
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingDeltaData {
    pub thinking_id: String,
    pub content: String,
    #[allow(dead_code)]
    pub seq: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingDoneData {
    pub thinking_id: String,
    pub content: String,
    #[allow(dead_code)]
    pub seq: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStartData {
    pub tool_call_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub args: Option<serde_json::Value>,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputData {
    pub tool_call_id: String,
    pub output: String,
    #[serde(default)]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEndData {
    pub tool_call_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageData {
    pub source: String,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorData {
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneData {
    pub final_text: String,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    pub total: u64,
    #[serde(default)]
    pub cost: Option<f64>,
    /// Per-turn cumulative session totals
    #[serde(default)]
    pub cumulative: Option<CumulativeUsage>,
    /// Current context size estimate (cache_read + input)
    #[serde(default)]
    pub context_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CumulativeUsage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    pub total: u64,
    #[serde(default)]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateData {
    pub model: Option<ModelInfo>,
    pub context_window: Option<u64>,
    #[serde(default)]
    pub context_tokens: Option<u64>,
    pub is_processing: bool,
    #[serde(default)]
    pub session_usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryData {
    pub messages: Vec<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ModelsData {
    pub models: Vec<ModelInfo>,
    pub current: Option<ModelInfo>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ModelSwitchedData {
    pub success: bool,
    pub model: Option<ModelInfo>,
    #[serde(default)]
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct PongData {
    pub timestamp: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProactiveData {
    pub message: String,
}
