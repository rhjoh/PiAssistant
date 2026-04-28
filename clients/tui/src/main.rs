use std::cell::Cell;
use std::io;
use std::panic;
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use ratatui::{
    backend::{Backend, CrosstermBackend},
    Terminal,
};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time;
use tracing::{error, info};

mod app;
mod clipboard;
mod protocol;
mod ui;
mod websocket;

use app::App;
use websocket::{WebSocketClient, WsEvent};

const GATEWAY_URL: &str = "ws://localhost:3456";
const TICK_RATE: Duration = Duration::from_millis(50);
/// Minimum time between redraws during mouse drag to prevent lag.
const DRAG_DRAW_THROTTLE: Duration = Duration::from_millis(33);

fn mouse_capture_enabled() -> bool {
    !matches!(
        std::env::var("ASSISTANT_TUI_MOUSE").ok().as_deref(),
        Some("0" | "false" | "FALSE" | "no" | "NO")
    )
}

/// RAII guard that restores terminal state when dropped.
/// Ensures cleanup even on panics or early returns.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        if mouse_capture_enabled() {
            let _ = execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
        } else {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Setup panic hook
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        // Guard drop will also restore, but be explicit on panic
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        original_hook(info);
    }));

    // Setup logging to file (NOT stdout — that would corrupt the TUI)
    let log_dir = dirs::home_dir()
        .map(|h| h.join(".local/share/assistant-tui/logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("./logs"));
    std::fs::create_dir_all(&log_dir)?;

    let file_appender = tracing_appender::rolling::daily(&log_dir, "assistant-tui.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter("assistant_tui=info")
        .init();

    info!("Starting Assistant TUI");

    // Setup terminal
    let _guard = TerminalGuard; // Restores terminal on drop (any exit path)
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    if mouse_capture_enabled() {
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    } else {
        execute!(stdout, EnterAlternateScreen)?;
    }
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Create app and websocket
    let mut app = App::new();
    let (ws_client, mut ws_rx, ws_tx) = WebSocketClient::new(GATEWAY_URL);

    // Start websocket in background
    let ws_handle = tokio::spawn(ws_client.run());

    // Request initial state, history, and model list
    let _ = ws_tx.send(protocol::ClientMessage::GetState);
    let _ = ws_tx.send(protocol::ClientMessage::GetModels);
    // Request a larger window because recent session history can be dominated
    // by heartbeat/internal turns that the TUI intentionally filters out.
    let _ = ws_tx.send(protocol::ClientMessage::GetHistory { limit: Some(1000) });

    // Run main loop — if ctrl+c or shutdown signal fires, exit gracefully
    let res = run_app(&mut terminal, &mut app, &ws_tx, &mut ws_rx).await;

    // Cleanup — guard handles terminal restore, but show cursor explicitly
    let _ = terminal.show_cursor();

    // Abort websocket
    ws_handle.abort();

    info!("Assistant TUI shutting down");

    if let Err(err) = res {
        error!("Error: {:?}", err);
    }

    Ok(())
}

async fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
    ws_tx: &tokio::sync::mpsc::UnboundedSender<protocol::ClientMessage>,
    ws_rx: &mut UnboundedReceiver<WsEvent>,
) -> Result<()> {
    let mut reader = EventStream::new();
    let mut tick_interval = time::interval(TICK_RATE);
    tick_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_draw = Instant::now();
    // Accumulate rapid mouse scroll events and apply in batches.
    let pending_scroll: Cell<i32> = Cell::new(0);
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);

    // Helper: apply accumulated mouse scroll before drawing.
    let apply_pending_scroll = |app: &mut App| -> bool {
        let ps = pending_scroll.get();
        if ps == 0 {
            return false;
        }
        let lines = ps.abs().min(3) as usize;
        let changed = if ps > 0 {
            app.scroll_up_lines(lines)
        } else {
            app.scroll_down_lines(lines)
        };
        pending_scroll.set(if ps > 0 {
            (ps - lines as i32).max(0)
        } else {
            (ps + lines as i32).min(0)
        });
        changed
    };

    // Initial draw
    terminal.draw(|f| ui::render(f, app))?;

    loop {
        tokio::select! {
            // Graceful shutdown on Ctrl+C from OS
            _ = &mut shutdown => {
                info!("Ctrl+C received, shutting down gracefully");
                break;
            }

            // Handle websocket events
            event = ws_rx.recv() => {
                match event {
                    Some(ev) => {
                        app.handle_event(ev);
                        let _ = apply_pending_scroll(app);
                        terminal.draw(|f| ui::render(f, app))?;
                    }
                    None => {
                        info!("WebSocket channel closed, exiting");
                        break;
                    }
                }
            }

            // Handle keyboard input — truly async via EventStream
            event = reader.next() => {
                match event {
                    Some(Ok(Event::Key(key))) => {
                        if key.kind == KeyEventKind::Press {
                            if handle_key(app, ws_tx, key).await? {
                                break;
                            }
                            let _ = apply_pending_scroll(app);
                            terminal.draw(|f| ui::render(f, app))?;
                        }
                    }
                    Some(Ok(Event::Resize(_, _))) => {
                        let _ = apply_pending_scroll(app);
                        terminal.draw(|f| ui::render(f, app))?;
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        match mouse.kind {
                            MouseEventKind::ScrollUp => {
                                pending_scroll.set(pending_scroll.get() + 1);
                            }
                            MouseEventKind::ScrollDown => {
                                pending_scroll.set(pending_scroll.get() - 1);
                            }
                            MouseEventKind::Down(MouseButton::Left) => {
                                if app.handle_mouse_down(mouse.column, mouse.row) {
                                    let _ = apply_pending_scroll(app);
                                    terminal.draw(|f| ui::render(f, app))?;
                                    last_draw = Instant::now();
                                }
                            }
                            MouseEventKind::Drag(MouseButton::Left) => {
                                if app.handle_mouse_drag(mouse.column, mouse.row) {
                                    if last_draw.elapsed() >= DRAG_DRAW_THROTTLE {
                                        let _ = apply_pending_scroll(app);
                                        terminal.draw(|f| ui::render(f, app))?;
                                        last_draw = Instant::now();
                                    }
                                }
                            }
                            MouseEventKind::Up(MouseButton::Left) => {
                                if let Some(text) = app.handle_mouse_up(mouse.column, mouse.row) {
                                    if let Err(e) = clipboard::copy_text(&text) {
                                        app.add_system_message(&format!("Failed to copy selection: {}", e));
                                    }
                                    let _ = apply_pending_scroll(app);
                                    terminal.draw(|f| ui::render(f, app))?;
                                    last_draw = Instant::now();
                                } else if app.mouse_selection.is_some() {
                                    let _ = apply_pending_scroll(app);
                                    terminal.draw(|f| ui::render(f, app))?;
                                    last_draw = Instant::now();
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(Err(e)) => {
                        error!("Event stream error: {}", e);
                    }
                    None => {
                        info!("Event stream closed, exiting");
                        break;
                    }
                    _ => {}
                }
            }

            // Tick for spinner animation and batched scroll application
            _ = tick_interval.tick() => {
                let scroll_changed = apply_pending_scroll(app);
                if app.is_processing {
                    app.tick();
                }
                if scroll_changed || app.is_processing {
                    terminal.draw(|f| ui::render(f, app))?;
                }
            }
        }
    }

    Ok(())
}

async fn handle_key(
    app: &mut App,
    ws_tx: &tokio::sync::mpsc::UnboundedSender<protocol::ClientMessage>,
    key: KeyEvent,
) -> Result<bool> {
    use KeyCode::*;

    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

    // ── Phase 1: Global shortcuts (always active) ───────────────────────────
    match key.code {
        // Ctrl+C: always quit
        Char('c') if ctrl => {
            return Ok(true);
        }

        // Esc: abort generation if processing
        Esc => {
            if app.is_processing {
                if let Some(msg) = app.abort() {
                    let _ = ws_tx.send(msg);
                }
                return Ok(false);
            }
            // Not processing: handle contextually below
        }

        // Toggle help overlay
        Char('?') if !app.is_input_focused => {
            app.toggle_help();
            return Ok(false);
        }

        _ => {}
    }

    if app.show_help {
        // Help overlay: Esc or ? closes it
        match key.code {
            Esc | Char('?') => {
                app.toggle_help();
            }
            _ => {}
        }
        return Ok(false);
    }

    // ── Model picker active: intercept all keys ─────────────────────────────
    if app.model_picker.is_some() {
        match key.code {
            Esc => {
                app.close_model_picker();
            }
            Enter => {
                if let Some(msg) = app.accept_model_selection() {
                    let _ = ws_tx.send(msg);
                }
            }
            Up | Char('k') => {
                app.select_prev_model();
            }
            Down | Char('j') => {
                app.select_next_model();
            }
            Backspace => {
                app.model_picker_backspace();
            }
            Char(c) => {
                app.model_picker_type_char(c);
            }
            _ => {}
        }
        return Ok(false);
    }

    // ── Phase 2: Input mode vs Navigation mode ──────────────────────────────
    if app.is_input_focused {
        // ── Command popup active: intercept navigation keys ─────────────────
        if app.command_popup.is_some() {
            match key.code {
                Tab | Down => {
                    app.select_next_command();
                    return Ok(false);
                }
                Up => {
                    app.select_prev_command();
                    return Ok(false);
                }
                Enter => {
                    app.accept_command_completion();
                    return Ok(false);
                }
                Esc => {
                    app.close_command_popup();
                    return Ok(false);
                }
                Backspace => {
                    app.input_text.pop();
                    app.open_command_popup(); // re-filter
                    return Ok(false);
                }
                Char(c) => {
                    app.input_text.push(c);
                    app.open_command_popup(); // re-filter
                    app.scroll_to_bottom();
                    return Ok(false);
                }
                _ => {
                    app.close_command_popup();
                }
            }
        }

        match key.code {
            Enter => {
                if let Some(msg) = app.submit_message() {
                    let _ = ws_tx.send(msg);
                }
            }
            Backspace => {
                // Cmd+Backspace (macOS) → clear line
                if key.modifiers.contains(KeyModifiers::SUPER) {
                    app.input_text.clear();
                // Option+Backspace (macOS) → delete word
                } else if key.modifiers.contains(KeyModifiers::ALT) {
                    delete_last_word(&mut app.input_text);
                } else {
                    app.input_text.pop();
                }
                if app.input_text.starts_with('/') {
                    app.open_command_popup();
                } else {
                    app.close_command_popup();
                }
            }
            // Ctrl+U: clear line when typing, otherwise Vim-style half-page up
            Char('u') if ctrl => {
                if app.input_text.is_empty() {
                    app.half_page_up();
                } else {
                    app.input_text.clear();
                    app.close_command_popup();
                }
            }
            // Ctrl+D: Vim-style half-page down
            Char('d') if ctrl => {
                app.half_page_down();
            }
            Char('{') => {
                app.jump_prev_message();
            }
            Char('}') => {
                app.jump_next_message();
            }
            Tab => {
                app.open_command_popup();
            }
            Esc => {
                if app.is_input_focused {
                    app.is_input_focused = false;
                }
            }
            Up => app.scroll_up(),
            Down => app.scroll_down(),
            PageUp => app.page_up(10),
            PageDown => app.page_down(10),
            Char(c) => {
                app.input_text.push(c);
                if app.input_text.starts_with('/') {
                    app.open_command_popup();
                }
                app.scroll_to_bottom();
            }
            _ => {}
        }
    } else {
        match key.code {
            Char('i') | Enter => {
                app.is_input_focused = true;
            }
            Char('?') => app.toggle_help(),
            Char('t') => app.toggle_thinking(),
            Char('y') => {
                if let Err(e) = clipboard::copy_last_message(app) {
                    app.add_system_message(&format!("Failed to copy: {}", e));
                }
            }
            Char('{') => {
                app.jump_prev_message();
            }
            Char('}') => {
                app.jump_next_message();
            }
            Char('u') if ctrl => app.half_page_up(),
            Char('d') if ctrl => app.half_page_down(),
            Up | Char('k') => app.scroll_up(),
            Down | Char('j') => app.scroll_down(),
            PageUp => app.page_up(10),
            PageDown => app.page_down(10),
            Char('g') => app.scroll_to_top(),
            Char('G') => app.scroll_to_bottom(),
            _ => {}
        }
    }

    Ok(false)
}

/// Delete the last word from a string, mimicking macOS Option+Backspace.
/// Trims trailing whitespace, then removes the word back to the previous
/// whitespace boundary.
fn delete_last_word(text: &mut String) {
    if text.is_empty() {
        return;
    }

    // Remove trailing whitespace first
    while text.ends_with(|c: char| c.is_whitespace()) {
        text.pop();
    }

    // Remove the last word (everything back to previous whitespace)
    while let Some(c) = text.pop() {
        if c.is_whitespace() {
            break;
        }
    }
}
