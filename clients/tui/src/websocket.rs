use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::time::{interval, timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tracing::{debug, error, info, warn};

use crate::protocol::{ClientMessage, ServerMessage};

/// Events emitted by the WebSocket client
#[derive(Debug, Clone)]
pub enum WsEvent {
    Connected,
    Disconnected,
    Message(ServerMessage),
    Latency(u64), // milliseconds
    Error(String),
}

#[allow(dead_code)]
pub struct WebSocketClient {
    url: String,
    event_tx: UnboundedSender<WsEvent>,
    cmd_rx: UnboundedReceiver<ClientMessage>,
    #[allow(dead_code)]
    cmd_tx: UnboundedSender<ClientMessage>,
    reconnect_attempts: u32,
    max_reconnect_attempts: u32,
}

impl WebSocketClient {
    pub fn new(
        url: impl Into<String>,
    ) -> (
        Self,
        UnboundedReceiver<WsEvent>,
        UnboundedSender<ClientMessage>,
    ) {
        let url = url.into();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let client = Self {
            url,
            event_tx,
            cmd_rx,
            cmd_tx: cmd_tx.clone(),
            reconnect_attempts: 0,
            max_reconnect_attempts: 10,
        };

        (client, event_rx, cmd_tx)
    }

    #[allow(dead_code)]
    pub fn sender(&self) -> UnboundedSender<ClientMessage> {
        self.cmd_tx.clone()
    }

    pub async fn run(mut self) {
        info!("WebSocket client starting: {}", self.url);

        loop {
            match self.connect_and_run().await {
                Ok(()) => {
                    info!("WebSocket connection closed gracefully");
                    self.reconnect_attempts = 0;
                }
                Err(e) => {
                    error!("WebSocket error: {}", e);
                }
            }

            self.reconnect_attempts += 1;
            if self.reconnect_attempts > self.max_reconnect_attempts {
                let _ = self
                    .event_tx
                    .send(WsEvent::Error("Max reconnect attempts reached".to_string()));
                break;
            }

            let delay = Duration::from_secs((2_u64).pow(self.reconnect_attempts.min(6)));
            info!(
                "Reconnecting in {:?} (attempt {})",
                delay, self.reconnect_attempts
            );
            tokio::time::sleep(delay).await;
        }

        info!("WebSocket client stopped");
    }

    async fn connect_and_run(&mut self) -> Result<()> {
        let (ws_stream, _) = timeout(Duration::from_secs(10), connect_async(&self.url))
            .await
            .context("Connection timeout")?
            .context("Failed to connect")?;

        info!("WebSocket connected");
        let _ = self.event_tx.send(WsEvent::Connected);
        self.reconnect_attempts = 0;

        let (mut write, mut read) = ws_stream.split();
        let mut ping_interval = interval(Duration::from_secs(5));
        let mut last_ping_time: Option<Instant> = None;

        loop {
            tokio::select! {
                // Handle incoming WebSocket messages
                msg = read.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            debug!("WS recv: {}", text);
                            match serde_json::from_str::<ServerMessage>(&text) {
                                Ok(server_msg) => {
                                    // Calculate latency on pong
                                    if let ServerMessage::Pong { data: _ } = &server_msg {
                                        if let Some(sent) = last_ping_time {
                                            let latency = sent.elapsed().as_millis() as u64;
                                            let _ = self.event_tx.send(WsEvent::Latency(latency));
                                            last_ping_time = None;
                                        }
                                    }
                                    let _ = self.event_tx.send(WsEvent::Message(server_msg));
                                }
                                Err(e) => {
                                    warn!("Failed to parse message: {} | text: {}", e, text);
                                }
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            info!("WebSocket closed by server");
                            let _ = self.event_tx.send(WsEvent::Disconnected);
                            break;
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            write.send(WsMessage::Pong(data)).await.ok();
                        }
                        Some(Err(e)) => {
                            error!("WebSocket read error: {}", e);
                            let _ = self.event_tx.send(WsEvent::Disconnected);
                            return Err(e.into());
                        }
                        None => {
                            info!("WebSocket stream ended");
                            let _ = self.event_tx.send(WsEvent::Disconnected);
                            break;
                        }
                        _ => {}
                    }
                }

                // Handle outgoing messages
                Some(cmd) = self.cmd_rx.recv() => {
                    let json = serde_json::to_string(&cmd)?;
                    debug!("WS send: {}", json);
                    write.send(WsMessage::Text(json.into())).await.ok();
                }

                // Send periodic pings
                _ = ping_interval.tick() => {
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let ping = ClientMessage::Ping { timestamp: Some(timestamp) };
                    let json = serde_json::to_string(&ping)?;
                    last_ping_time = Some(Instant::now());
                    write.send(WsMessage::Text(json.into())).await.ok();
                }
            }
        }

        Ok(())
    }
}
