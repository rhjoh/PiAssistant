use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use crate::theme::{BorderTreatment, MessageBlockStyle, Theme};
use crate::wrap::word_wrap_lines;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, ChatMessage, CommandPopup, ConnectionState, ContentItem, MessageRole, ModelPicker};

/// Main render function — draws the entire UI
pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();

    let main_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Messages
            Constraint::Length(3), // Input
            Constraint::Length(1), // Footer
        ])
        .split(area);

    let theme = app.theme;
    render_message_list(frame, app, main_chunks[0]);
    render_input_area(frame, app, main_chunks[1]);
    render_footer(frame, app, main_chunks[2]);

    if app.show_help {
        render_help_overlay(frame, area, &theme);
    }

    if let Some(ref popup) = app.command_popup {
        render_command_popup(frame, popup, main_chunks[1], &theme);
    }

    if let Some(ref picker) = app.model_picker {
        render_model_picker(frame, picker, area, &theme);
    }
}

// =============================================================================
// Footer (was header + status bar, now combined at bottom)
// =============================================================================

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let c = app.theme.colors;

    let status_color = match app.connection_state {
        ConnectionState::Disconnected => c.disconnected,
        ConnectionState::Connecting => c.connecting,
        ConnectionState::Connected => c.connected,
        ConnectionState::Error => c.error_text,
    };

    let mut left_spans = Vec::new();

    // Connection dot
    left_spans.push(Span::styled("●", Style::default().fg(status_color)));
    left_spans.push(Span::raw(" "));

    // Connection text
    match app.connection_state {
        ConnectionState::Connected => {
            left_spans.push(Span::styled("Connected", Style::default().fg(c.connected)));
        }
        ConnectionState::Disconnected => {
            left_spans.push(Span::styled("Disconnected", Style::default().fg(c.disconnected)));
        }
        ConnectionState::Connecting => {
            left_spans.push(Span::styled("Connecting...", Style::default().fg(c.connecting)));
        }
        ConnectionState::Error => {
            left_spans.push(Span::styled("Error", Style::default().fg(c.error_text)));
        }
    }

    // Model name
    if let Some(model) = &app.current_model {
        left_spans.push(Span::raw(" │ "));
        left_spans.push(Span::styled(&model.name, Style::default().fg(c.accent)));
    }

    // Processing spinner
    if app.is_processing {
        left_spans.push(Span::raw(" "));
        left_spans.push(Span::styled(
            app.spinner_char(),
            Style::default().fg(c.connecting),
        ));
    }

    // Context stats
    let stats = app.status_bar_text();
    if !stats.is_empty() {
        left_spans.push(Span::raw(" │ "));
        left_spans.push(Span::styled(stats, Style::default().fg(c.muted)));
    }

    let mut right_spans = Vec::new();
    if app.is_processing {
        right_spans.push(Span::styled("Esc:abort", Style::default().fg(c.error_text)));
        right_spans.push(Span::raw(" "));
    }
    if app.is_input_focused {
        right_spans.push(Span::styled("Esc:navigate", Style::default().fg(c.muted)));
    } else {
        right_spans.push(Span::styled("i:input ?:help q/Ctrl+D:quit", Style::default().fg(c.muted)));
    }

    let left = Paragraph::new(Line::from(left_spans));
    let right = Paragraph::new(Line::from(right_spans)).alignment(Alignment::Right);

    // Give left side 70% of width, right side 30%
    let left_width = (area.width * 7) / 10;
    let right_width = area.width.saturating_sub(left_width);
    let left_area = Rect { x: area.x, y: area.y, width: left_width, height: area.height };
    let right_area = Rect { x: area.x + left_width, y: area.y, width: right_width, height: area.height };

    frame.render_widget(left, left_area);
    frame.render_widget(right, right_area);
}

// =============================================================================
// Message List
// =============================================================================

fn render_message_list(frame: &mut Frame, app: &mut App, area: Rect) {
    let c = app.theme.colors;

    // Single bottom border to separate from input
    let block = Block::default()
        .borders(Borders::BOTTOM)
        .border_style(Style::default().fg(c.muted));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.messages.is_empty() || inner.height == 0 {
        if inner.height > 0 {
            let empty = Paragraph::new("No messages yet. Type something to start chatting.")
                .style(Style::default().fg(c.muted))
                .alignment(Alignment::Center);
            frame.render_widget(empty, inner);
        }
        return;
    }

    let max_width = inner.width.saturating_sub(2); // small margin
    let invalidate_all = app.render_cache_width != Some(max_width)
        || app.render_cache_show_thinking != app.show_thinking;
    if invalidate_all {
        app.render_cache_width = Some(max_width);
        app.render_cache_show_thinking = app.show_thinking;
        app.invalidate_image_cache(); // re-encode images at new width
    }

    let mut all_lines: Vec<Line> = Vec::new();
    let mut message_start_lines: Vec<usize> = Vec::new();
    let show_thinking = app.show_thinking;
    let spinner = app.spinner_char();
    let theme = app.theme; // Copy for borrow-free access during build
    for msg in &mut app.messages {
        if invalidate_all || msg.render_dirty {
            let (cache, offsets) = build_message_lines(msg, max_width, show_thinking, spinner, &app.image_cache, &theme);
            msg.render_cache = cache;
            msg.item_line_offsets = offsets;
            msg.render_dirty = false;
        }
        message_start_lines.push(all_lines.len());
        all_lines.extend(msg.render_cache.iter().cloned());
    }
    // Theme was copied, no borrow issues

    let total_lines = all_lines.len();
    let viewport_height = inner.height as usize;
    let max_scroll = total_lines.saturating_sub(viewport_height);
    app.max_scroll_from_bottom = max_scroll;

    // scroll_from_bottom: 0 = pinned to bottom (auto-scroll), >0 = scrolled up
    let scroll_from_bottom = app.scroll_from_bottom.min(max_scroll);
    app.scroll_from_bottom = scroll_from_bottom; // Clamp state to valid range
    let start = max_scroll.saturating_sub(scroll_from_bottom);
    app.update_message_navigation(message_start_lines.clone(), start);

    frame.render_widget(Clear, inner);

    let (top_padding, mut visible_lines): (usize, Vec<Line>) = if total_lines <= viewport_height {
        let padding = viewport_height.saturating_sub(total_lines);
        let mut padded: Vec<Line> = (0..padding).map(|_| Line::from("")).collect();
        padded.extend(all_lines);
        (padding, padded)
    } else {
        (0, all_lines
            .iter()
            .skip(start)
            .take(viewport_height)
            .cloned()
            .collect())
    };

    if visible_lines.len() < viewport_height {
        visible_lines.resize_with(viewport_height, || Line::from(""));
    }

    app.update_message_viewport(
        inner,
        visible_lines
            .iter()
            .map(line_to_plain_text)
            .collect(),
    );

    if let Some((start_sel, end_sel)) = app.selection_bounds() {
        for (row, line) in visible_lines.iter_mut().enumerate() {
            let start_col = if row == start_sel.row { start_sel.col } else { 0 };
            let end_col = if row == end_sel.row {
                end_sel.col.saturating_add(1)
            } else {
                usize::MAX
            };

            if row >= start_sel.row && row <= end_sel.row {
                *line = highlight_selected_range(line.clone(), start_col, end_col, &app.theme);
            }
        }
    }

    let active_message_rows = active_message_visible_rows(
        app,
        &message_start_lines,
        total_lines,
        viewport_height,
        start,
        top_padding,
        visible_lines.len(),
    );
    if let Some((active_start_row, active_end_row)) = active_message_rows {
        for row in active_start_row..=active_end_row {
            visible_lines[row] = indent_active_message_line(visible_lines[row].clone());
        }
    }

    let paragraph = Paragraph::new(Text::from(std::mem::take(&mut visible_lines)));

    frame.render_widget(paragraph, inner);

    if let Some((active_start_row, active_end_row)) = active_message_rows {
        let bar_style = Style::default().fg(app.theme.colors.active_bar);
        for row in active_start_row..=active_end_row {
            frame.render_widget(
                Paragraph::new(app.theme.active_bar_char).style(bar_style),
                Rect {
                    x: inner.x,
                    y: inner.y + row as u16,
                    width: 1,
                    height: 1,
                },
            );
        }
    }

    // ── Second pass: overlay image widgets at their calculated positions ──
    if !app.image_cache.is_empty() {
        // Calculate which images are visible based on scroll position.
        for (msg_idx, msg) in app.messages.iter().enumerate() {
            let msg_start = *message_start_lines.get(msg_idx).unwrap_or(&0);
            if msg_start + msg.render_cache.len() <= start {
                continue; // message is above viewport
            }
            if msg_start >= start + viewport_height {
                break; // message is below viewport
            }

            for (item_idx, item) in msg.items.iter().enumerate() {
                if let ContentItem::Image { source, .. } = item {
                    if let Some(proto) = app.image_cache.get(source) {
                        let offset = msg.item_line_offsets.get(item_idx).copied().unwrap_or(0);
                        let abs_line = msg_start + offset;
                        if abs_line + (proto.size().height as usize) <= start {
                            continue; // above viewport
                        }
                        if abs_line >= start + viewport_height {
                            continue; // below viewport
                        }

                        let screen_y = inner.y + (abs_line.saturating_sub(start)) as u16;
                        let height = proto.size().height;
                        if screen_y + height > inner.y + inner.height {
                            continue; // partially offscreen
                        }

                        let rect = Rect {
                            x: inner.x + 2, // small left margin
                            y: screen_y,
                            width: proto.size().width.min(inner.width.saturating_sub(4)),
                            height,
                        };
                        frame.render_widget(
                            ratatui_image::Image::new(proto),
                            rect,
                        );
                    }
                }
            }
        }
    }

    // Scroll indicators (small arrows in the margin)
    if start > 0 && inner.height > 0 {
        let indicator = Paragraph::new("▲")
            .style(Style::default().fg(c.muted));
        frame.render_widget(indicator, Rect {
            x: inner.x + inner.width.saturating_sub(1),
            y: inner.y + 1,
            width: 1,
            height: 1,
        });
    }
    if scroll_from_bottom > 0 && inner.height > 0 {
        let indicator = Paragraph::new("▼")
            .style(Style::default().fg(c.connecting));
        frame.render_widget(indicator, Rect {
            x: inner.x + inner.width.saturating_sub(1),
            y: inner.y + inner.height.saturating_sub(1),
            width: 1,
            height: 1,
        });
    }
}

/// Build Lines for a single message.
/// Returns (lines, item_line_offsets) where item_line_offsets maps ContentItem index → line offset.
fn build_message_lines(
    msg: &ChatMessage,
    max_width: u16,
    show_thinking: bool,
    spinner: &str,
    image_cache: &std::collections::HashMap<String, ratatui_image::protocol::Protocol>,
    theme: &Theme,
) -> (Vec<Line<'static>>, Vec<usize>) {
    let c = &theme.colors;
    let content_width = max_width.saturating_sub(2);
    let mut lines = Vec::new();
    let mut item_line_offsets = Vec::new();

    let user_bg = c.user_bg;
    let timestamp_str = msg.timestamp.format(" %H:%M").to_string();

    // Header line (role + timestamp)
    // Streaming assistant: show spinner
    if msg.is_streaming && msg.role == MessageRole::Assistant {
        lines.push(Line::from(vec![
            Span::styled("Assistant", Style::default().fg(c.assistant_header).add_modifier(Modifier::BOLD)),
            Span::styled(timestamp_str.clone(), Style::default().fg(c.muted)),
            Span::raw(" "),
            Span::styled(spinner.to_string(), Style::default().fg(c.connecting)),
        ]));
    } else if msg.role == MessageRole::User {
        match theme.message_block {
            MessageBlockStyle::FullBackground => {
                // Full-width background for user messages (current default)
                let used_width = unicode_width::UnicodeWidthStr::width("You")
                    + unicode_width::UnicodeWidthStr::width(timestamp_str.as_str())
                    + 1; // leading space
                let pad_len = max_width.saturating_sub(used_width as u16);
                lines.push(Line::from(vec![
                    Span::styled(" ", Style::default().bg(user_bg)),
                    Span::styled("You", Style::default().fg(c.user_header).add_modifier(Modifier::BOLD).bg(user_bg)),
                    Span::styled(timestamp_str.clone(), Style::default().fg(c.muted).bg(user_bg)),
                    Span::styled(format!("{:<width$}", "", width = pad_len as usize), Style::default().bg(user_bg)),
                ]));
            }
            MessageBlockStyle::AccentBar => {
                // Left accent bar + content with subtle bg
                lines.push(Line::from(vec![
                    Span::styled(format!("{} ", theme.active_bar_char), Style::default().fg(c.accent)),
                    Span::styled("You", Style::default().fg(c.user_header).add_modifier(Modifier::BOLD)),
                    Span::styled(timestamp_str.clone(), Style::default().fg(c.muted)),
                ]));
            }
        }
    } else {
        let (name, fg_color) = match msg.role {
            MessageRole::Assistant => ("Assistant", c.assistant_header),
            MessageRole::System => ("System", c.system_header),
            MessageRole::User => unreachable!(), // handled above
        };
        lines.push(Line::from(vec![
            Span::styled(name, Style::default().fg(fg_color).add_modifier(Modifier::BOLD)),
            Span::styled(timestamp_str.clone(), Style::default().fg(c.muted)),
        ]));
    }

    // Content based on role
    match msg.role {
        MessageRole::User => {
            let text: String = msg.items.iter().filter_map(|item| match item {
                ContentItem::Text(t) => Some(t.as_str()),
                _ => None,
            }).collect();
            match theme.message_block {
                MessageBlockStyle::FullBackground => {
                    for line in markdown_to_lines(
                        &text,
                        content_width,
                        Style::default().fg(c.text).bg(user_bg),
                        Style::default().fg(c.system_header).bg(user_bg).add_modifier(Modifier::BOLD),
                        theme,
                    ) {
                        let padded = pad_render_line(line, content_width);
                        let spans = padded
                            .spans
                            .into_iter()
                            .map(|span| {
                                let style = span.style.bg(user_bg);
                                Span::styled(span.content.into_owned(), style)
                            })
                            .collect::<Vec<_>>();
                        let mut full_spans = vec![Span::styled(" ", Style::default().bg(user_bg))];
                        full_spans.extend(spans);
                        let current_width: usize = full_spans
                            .iter()
                            .map(|span| span.content.chars().map(|ch| ch.width().unwrap_or(0)).sum::<usize>())
                            .sum();
                        if current_width < max_width as usize {
                            full_spans.push(Span::styled(
                                " ".repeat(max_width as usize - current_width),
                                Style::default().bg(user_bg),
                            ));
                        }
                        lines.push(Line::from(full_spans));
                    }
                }
                MessageBlockStyle::AccentBar => {
                    for line in markdown_to_lines(
                        &text,
                        content_width,
                        Style::default().fg(c.text),
                        Style::default().fg(c.system_header).add_modifier(Modifier::BOLD),
                        theme,
                    ) {
                        let padded = pad_render_line(line, content_width);
                        let prefix = vec![
                            Span::styled(
                                format!("{} ", theme.active_bar_char),
                                Style::default().fg(c.accent),
                            ),
                        ];
                        let mut spans: Vec<Span<'static>> = prefix;
                        spans.extend(padded.spans.into_iter().map(|s| {
                            Span::styled(s.content.into_owned(), s.style)
                        }));
                        lines.push(Line::from(spans));
                    }
                }
            }
        }
        MessageRole::System => {
            let text: String = msg.items.iter().filter_map(|item| match item {
                ContentItem::Text(t) => Some(t.as_str()),
                _ => None,
            }).collect();
            lines.extend(markdown_to_lines(
                &text,
                content_width,
                Style::default().fg(c.text),
                Style::default().fg(c.system_header).add_modifier(Modifier::BOLD),
                theme,
            ));
        }
        MessageRole::Assistant => {
            let mut idx = 0usize;

            while idx < msg.items.len() {
                item_line_offsets.push(lines.len());
                match &msg.items[idx] {
                    ContentItem::Text(text) => {
                        lines.extend(markdown_to_lines(
                            text,
                            content_width,
                            Style::default().fg(c.text),
                            Style::default().fg(c.accent).add_modifier(Modifier::BOLD),
                            theme,
                        ));
                        idx += 1;
                    }
                    ContentItem::Thinking { content, is_complete, .. } => {
                        if content.is_empty() {
                            idx += 1;
                            continue;
                        }
                        if show_thinking {
                            let label = if *is_complete { "Thought process" } else { "Thinking..." };
                            lines.push(Line::from(vec![
                                Span::styled("  ", Style::default().bg(c.thinking_bg)),
                                Span::styled(label, Style::default().fg(c.thinking).bg(c.thinking_bg).add_modifier(Modifier::BOLD)),
                            ]));
                            for line in wrap_text(content, content_width.saturating_sub(4)) {
                                lines.push(Line::from(Span::styled(
                                    format!("    {}", line),
                                    Style::default().fg(c.muted).bg(c.thinking_bg),
                                )));
                            }
                        } else if *is_complete {
                            // Thinking completed but hidden — compact notification
                            lines.push(Line::from(vec![
                                Span::styled("  ", Style::default().bg(c.thinking_bg)),
                                Span::styled("Thought process (hidden)", Style::default().fg(c.thinking).bg(c.thinking_bg)),
                            ]));
                        } else if msg.is_streaming {
                            // Active thinking, hidden — animated indicator
                            lines.push(Line::from(vec![
                                Span::styled("  ", Style::default().bg(c.thinking_bg)),
                                Span::styled(spinner.to_string(), Style::default().fg(c.connecting).bg(c.thinking_bg)),
                                Span::raw(" "),
                                Span::styled("Thinking…", Style::default().fg(c.thinking).bg(c.thinking_bg)),
                            ]));
                        }
                        idx += 1;
                    }
                    ContentItem::ToolCall { name, label, args, result, is_complete, is_error, .. } => {
                        let preview = tool_preview(name, label, args, content_width.saturating_sub(4) as usize);
                        let body_color = if *is_error { c.tool_error } else { c.tool_output };

                        // Spacing before tool block
                        lines.push(Line::from(""));

                        // Strip tool name from preview if it's already there (e.g. "read /path" → "/path")
                        let stripped = preview.strip_prefix(&format!("{} ", name)).unwrap_or(&preview);
                        lines.push(Line::from(vec![
                            Span::styled(
                                format!("  {}  ", name),
                                Style::default().fg(c.tool_name).bg(c.tool_bg).add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(
                                stripped.to_string(),
                                Style::default().fg(c.text).bg(c.tool_bg).add_modifier(Modifier::BOLD),
                            ),
                        ]));

                        // Output (live-updated inline)
                        if let Some(content) = result {
                            let wrapped = wrap_text(content, content_width.saturating_sub(8));
                            let max_lines = 10;
                            for line in wrapped.iter().take(max_lines) {
                                lines.push(Line::from(Span::styled(
                                    format!("      {}", line),
                                    Style::default().fg(body_color).bg(c.tool_bg),
                                )));
                            }
                            if wrapped.len() > max_lines {
                                lines.push(Line::from(Span::styled(
                                    "      ... (truncated)".to_string(),
                                    Style::default().fg(c.muted).bg(c.tool_bg),
                                )));
                            }
                        } else if msg.is_streaming && !*is_complete {
                            // Still running — show a subtle spinner hint
                            lines.push(Line::from(Span::styled(
                                "      …".to_string(),
                                Style::default().fg(c.muted).bg(c.tool_bg),
                            )));
                        }

                        idx += 1;
                    }
                    // Orphan ToolResult (history fallback when no paired ToolCall exists)
                    ContentItem::ToolResult { tool_name, content, is_error, .. } => {
                        let body_color = if *is_error { c.tool_error } else { c.tool_output };

                        lines.push(Line::from(""));
                        lines.push(Line::from(Span::styled(
                            format!("  {}", tool_name),
                            Style::default().fg(c.text).bg(c.tool_bg).add_modifier(Modifier::BOLD),
                        )));
                        let wrapped = wrap_text(content, content_width.saturating_sub(8));
                        let max_lines = 10;
                        for line in wrapped.iter().take(max_lines) {
                            lines.push(Line::from(Span::styled(
                                format!("      {}", line),
                                Style::default().fg(body_color).bg(c.tool_bg),
                            )));
                        }
                        if wrapped.len() > max_lines {
                            lines.push(Line::from(Span::styled(
                                "      ... (truncated)".to_string(),
                                Style::default().fg(c.muted).bg(c.tool_bg),
                            )));
                        }
                        idx += 1;
                    }
                    ContentItem::Image { source, alt } => {
                        if let Some(proto) = image_cache.get(source) {
                            let size = proto.size();
                            let rows = (size.height as usize).max(1);
                            // Emit placeholder rows — the image widget is rendered
                            // in a second pass at the correct screen position.
                            for _ in 0..rows {
                                lines.push(Line::from(""));
                            }
                        } else {
                            // Not yet encoded — show a text placeholder.
                            let text = alt.as_deref().unwrap_or("[image]");
                            lines.push(Line::from(vec![
                                Span::styled("  IMG ", Style::default().fg(c.image_text).add_modifier(Modifier::BOLD)),
                                Span::styled(format!("[Image: {}]", text), Style::default().fg(c.image_text)),
                            ]));
                            lines.push(Line::from(Span::styled(
                                format!("    {}", source.chars().take(content_width.saturating_sub(4) as usize).collect::<String>()),
                                Style::default().fg(c.muted),
                            )));
                        }
                        idx += 1;
                    }
                }
            }

            if msg.is_streaming && msg.items.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!("  {}", spinner),
                    Style::default().fg(c.connecting),
                )));
            }
        }
    }

    // Blank line after message for spacing
    match theme.message_block {
        MessageBlockStyle::FullBackground if msg.role == MessageRole::User => {
            lines.push(Line::from(Span::styled(
                format!("{:<width$}", "", width = max_width as usize),
                Style::default().bg(user_bg),
            )));
        }
        _ => {
            lines.push(Line::from(""));
        }
    }

    let result: Vec<Line<'static>> = lines
        .into_iter()
        .map(|line| pad_render_line(line, max_width))
        .collect();
    (result, item_line_offsets)
}

fn tool_preview(name: &str, label: &str, args: &str, max_chars: usize) -> String {
    let preview = if label != name && !label.is_empty() {
        label.to_string()
    } else if !args.is_empty() {
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(args) {
            if let Some(obj) = obj.as_object() {
                if name.eq_ignore_ascii_case("bash") {
                    obj.get("command")
                        .and_then(|v| v.as_str())
                        .map(|s| format!("$ {}", s))
                        .unwrap_or_default()
                } else if let Some(path) = obj.get("path").and_then(|v| v.as_str()) {
                    path.to_string()
                } else if let Some(first_val) = obj.values().next() {
                    first_val.as_str().map(|s| s.to_string()).unwrap_or_else(|| first_val.to_string())
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    if preview.chars().count() > max_chars && max_chars > 3 {
        let truncated: String = preview.chars().take(max_chars - 3).collect();
        format!("{}...", truncated)
    } else {
        preview
    }
}

// =============================================================================
// Input Area
// =============================================================================

fn render_input_area(frame: &mut Frame, app: &App, area: Rect) {
    let c = &app.theme.colors;
    let inner = area;

    let input_text = if app.input_text.is_empty() {
        if app.is_processing {
            "Press Esc to abort..."
        } else {
            "Type a message..."
        }
    } else {
        &app.input_text
    };

    let style = if app.input_text.is_empty() {
        Style::default().fg(c.input_placeholder)
    } else {
        Style::default().fg(c.input_fg)
    };

    let prefix = if app.is_processing {
        format!("{} ", app.spinner_char())
    } else {
        app.theme.input_prefix.to_string()
    };

    // Hint shown right-aligned on the input row (empty while processing — footer handles it)
    let (hint, hint_style): (&str, Style) = ("", Style::default());

    let hint_width = hint.width() as u16;
    let _prefix_width = prefix.width() as u16;

    // Text area: left portion of the input row (hint takes the right)
    let gap = if hint_width > 0 { 1 } else { 0 }; // 1-col gap between text and hint
    let text_width = inner.width.saturating_sub(hint_width + gap);
    let text_area = Rect {
        x: inner.x,
        y: inner.y + 1, // leave top line as separator
        width: text_width,
        height: inner.height.saturating_sub(1),
    };

    // Word-wrap for cursor positioning (matches ratatui's WordWrapper behavior)
    let line_width = text_width as usize;
    let visible_lines = text_area.height as usize;

    let wrapped = word_wrap_lines(&format!("{}{}", prefix, input_text), line_width);
    let total_lines = wrapped.len().max(1);
    let scroll = if total_lines > visible_lines {
        (total_lines - visible_lines) as u16
    } else {
        0
    };

    // Render with ratatui's built-in word wrapping
    let full_text = format!("{}{}", prefix, input_text);
    let input = Paragraph::new(full_text)
        .style(style)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));

    frame.render_widget(input, text_area);

    // Find cursor position (end of text) in the word-wrapped lines
    let cursor_row = wrapped.len().saturating_sub(1);
    let cursor_col = wrapped.last().map(|l| l.width()).unwrap_or(0);

    // Render hint on the right side of the input row
    let hint_area = Rect {
        x: inner.x + inner.width.saturating_sub(hint_width),
        y: inner.y + 1,
        width: hint_width,
        height: 1,
    };
    let hint_widget = Paragraph::new(hint).style(hint_style);
    frame.render_widget(hint_widget, hint_area);

    // Cursor position — account for wrapping and scroll offset
    if app.is_input_focused && !app.is_processing {
        let visible_row = cursor_row.saturating_sub(scroll as usize);
        if visible_row < text_area.height as usize {
            frame.set_cursor_position((
                inner.x + (cursor_col as u16).min(text_width.saturating_sub(1)),
                inner.y + 1 + visible_row as u16,
            ));
        }
    }
}

// =============================================================================
// Help Overlay
// =============================================================================

fn render_help_overlay(frame: &mut Frame, area: Rect, theme: &Theme) {
    let c = &theme.colors;
    let help_text = r#"Keyboard Shortcuts

Input Mode (default)
  Type chars    Enter text
  Enter         Send message
  Backspace     Delete char
  Up/Down       Scroll messages
  Esc           Enter nav mode

Navigation Mode
  i / Enter     Back to input
  ↑ / k         Scroll up
  ↓ / j         Scroll down
  PgUp/PgDown   Page up/down
  Ctrl+U/Ctrl+D Half-page up/down
  g / G         Go to top/bottom
  { / }         Prev/next message
  t             Toggle thinking
  y             Copy last message
  ?             Toggle help
  q             Quit

Global
  Esc          Abort generation
  Ctrl+C        Quit

Commands
  /status       Show gateway status
  /model        Switch model
  /session      Show session stats
  /new          Start new session
  /clear        Clear chat view
  /theme        Switch color theme
"#;

    let width = 50;
    let height = 26;
    let popup_area = centered_rect(width, height, area);

    frame.render_widget(Clear, popup_area);

    let border_style = match theme.borders {
        BorderTreatment::Subtle => Style::default().fg(c.muted),
        BorderTreatment::Standard => Style::default().fg(c.popup_border),
    };

    let block = Block::default()
        .title(" Help ")
        .borders(Borders::ALL)
        .border_style(border_style)
        .style(Style::default().bg(c.help_bg));

    let paragraph = Paragraph::new(help_text)
        .block(block)
        .style(Style::default().fg(c.text));

    frame.render_widget(paragraph, popup_area);
}

// =============================================================================
// Command Autocomplete Popup
// =============================================================================

fn render_command_popup(frame: &mut Frame, popup: &CommandPopup, input_area: Rect, theme: &Theme) {
    let c = &theme.colors;
    let item_count = popup.matches.len() as u16;
    let width = 40;
    let height = item_count.min(8) + 2; // +2 for border

    // Position popup just above the input area, aligned to its left edge
    let popup_area = Rect {
        x: input_area.x,
        y: input_area.y.saturating_sub(height),
        width: width.min(input_area.width),
        height,
    };

    frame.render_widget(Clear, popup_area);

    let border_style = match theme.borders {
        BorderTreatment::Subtle => Style::default().fg(c.muted),
        BorderTreatment::Standard => Style::default().fg(c.popup_border),
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .style(Style::default().bg(c.popup_bg));

    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    let mut lines = Vec::new();
    for (i, cmd) in popup.matches.iter().enumerate() {
        let is_selected = i == popup.selected;
        let style = if is_selected {
            Style::default().fg(c.selected_fg).bg(c.selected_bg).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(c.text)
        };
        let prefix = if is_selected { "> " } else { "  " };
        let line = format!("{}{}", prefix, cmd.usage);
        lines.push(Line::from(Span::styled(
            pad_line(&line, inner.width),
            style,
        )));
    }

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);
}

// =============================================================================
// Model Picker Popup
// =============================================================================

fn render_model_picker(frame: &mut Frame, picker: &ModelPicker, area: Rect, theme: &Theme) {
    let c = &theme.colors;
    let width = (area.width * 4 / 5).max(60).min(area.width - 4);
    let height = (area.height * 3 / 4).max(20).min(area.height - 4);

    let popup_area = Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    };

    frame.render_widget(Clear, popup_area);

    let border_style = match theme.borders {
        BorderTreatment::Subtle => Style::default().fg(c.muted),
        BorderTreatment::Standard => Style::default().fg(c.popup_border),
    };

    let block = Block::default()
        .title("Select Model")
        .borders(Borders::ALL)
        .border_style(border_style)
        .style(Style::default().bg(c.picker_bg));

    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(3)])
        .split(inner);

    // Query line
    let query_text = if picker.query.is_empty() {
        Span::styled(
            "Type to filter…",
            Style::default().fg(c.input_placeholder),
        )
    } else {
        Span::styled(
            &picker.query,
            Style::default().fg(c.input_fg).add_modifier(Modifier::BOLD),
        )
    };
    let query_line = Line::from(vec![
        Span::styled("> ", Style::default().fg(c.accent)),
        query_text,
    ]);
    let query_para = Paragraph::new(vec![query_line]);
    frame.render_widget(query_para, chunks[0]);

    // Model list
    let visible_count = chunks[1].height as usize;
    let total = picker.filtered_indices.len();

    if total == 0 {
        let empty = Paragraph::new("No models match your filter.").style(Style::default().fg(c.muted));
        frame.render_widget(empty, chunks[1]);
        return;
    }

    // Scroll window so selected item stays visible
    let selected = picker.selected;
    let scroll_offset = if selected >= visible_count {
        selected - visible_count + 1
    } else {
        0
    };

    let mut lines = Vec::new();
    for i in scroll_offset..total.min(scroll_offset + visible_count) {
        let model_idx = picker.filtered_indices[i];
        let model = &picker.all_models[model_idx];
        let is_selected = i == selected;
        let is_current = picker.current.as_ref().map_or(false, |c| {
            c.provider == model.provider && c.id == model.id
        });

        let prefix = if is_selected { "> " } else { "  " };
        let label = format!("{}{}/{}", prefix, model.provider, model.id);

        let style = if is_selected {
            Style::default().fg(c.selected_fg).bg(c.selected_bg).add_modifier(Modifier::BOLD)
        } else if is_current {
            Style::default().fg(c.connected)
        } else {
            Style::default().fg(c.text)
        };

        lines.push(Line::from(Span::styled(
            pad_line(&label, chunks[1].width),
            style,
        )));
    }

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, chunks[1]);
}

// =============================================================================
// Helpers
// =============================================================================

fn wrap_text(text: &str, width: u16) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    textwrap::wrap(text, width as usize)
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

fn markdown_to_lines(
    text: &str,
    width: u16,
    base_style: Style,
    heading_style: Style,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code_block = false;

    for raw_line in text.lines() {
        let trimmed = raw_line.trim_end();

        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        if in_code_block {
            let code_style = base_style.bg(theme.colors.code_bg).fg(theme.colors.code_fg);
            lines.extend(wrap_styled_spans(
                vec![Span::styled(trimmed.to_string(), code_style)],
                width as usize,
                "",
                "",
            ));
            continue;
        }

        let (prefix, content, style) = if let Some(stripped) = trimmed.strip_prefix("### ") {
            ("", stripped, heading_style)
        } else if let Some(stripped) = trimmed.strip_prefix("## ") {
            ("", stripped, heading_style)
        } else if let Some(stripped) = trimmed.strip_prefix("# ") {
            ("", stripped, heading_style)
        } else if let Some(stripped) = trimmed.strip_prefix("- ") {
            ("- ", stripped, base_style)
        } else if let Some(stripped) = trimmed.strip_prefix("* ") {
            ("- ", stripped, base_style)
        } else {
            ("", trimmed, base_style)
        };

        if content.is_empty() {
            lines.push(Line::from(""));
            continue;
        }

        let spans = parse_inline_markdown(content, style, theme);
        let continuation_prefix = if prefix.is_empty() { "" } else { "  " };
        lines.extend(wrap_styled_spans(
            spans,
            width as usize,
            prefix,
            continuation_prefix,
        ));
    }

    if text.ends_with('\n') {
        lines.push(Line::from(""));
    }

    lines
}

fn parse_inline_markdown(text: &str, base_style: Style, theme: &Theme) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans = Vec::new();
    let mut buffer = String::new();
    let mut i = 0usize;
    let mut bold = false;
    let mut italic = false;
    let mut code = false;

    let flush = |spans: &mut Vec<Span<'static>>, buffer: &mut String, style: Style| {
        if !buffer.is_empty() {
            spans.push(Span::styled(std::mem::take(buffer), style));
        }
    };

    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' && !code {
            flush(&mut spans, &mut buffer, inline_style(base_style, bold, italic, code, theme));
            bold = !bold;
            i += 2;
            continue;
        }
        if chars[i] == '*' && !code {
            flush(&mut spans, &mut buffer, inline_style(base_style, bold, italic, code, theme));
            italic = !italic;
            i += 1;
            continue;
        }
        if chars[i] == '`' {
            flush(&mut spans, &mut buffer, inline_style(base_style, bold, italic, code, theme));
            code = !code;
            i += 1;
            continue;
        }

        buffer.push(chars[i]);
        i += 1;
    }

    flush(&mut spans, &mut buffer, inline_style(base_style, bold, italic, code, theme));
    spans
}

fn inline_style(base_style: Style, bold: bool, italic: bool, code: bool, theme: &Theme) -> Style {
    let mut style = base_style;
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if italic {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if code {
        style = style.bg(theme.colors.code_bg).fg(theme.colors.accent);
    }
    style
}

fn wrap_styled_spans(
    spans: Vec<Span<'static>>,
    width: usize,
    first_prefix: &str,
    continuation_prefix: &str,
) -> Vec<Line<'static>> {
    if width == 0 {
        return vec![Line::from(spans)];
    }

    let mut lines = Vec::new();
    let mut current = Vec::new();
    let mut current_width = 0usize;
    let mut prefix = first_prefix.to_string();

    if !prefix.is_empty() {
        current_width += prefix.width();
        current.push(Span::raw(prefix.clone()));
    }

    for span in spans {
        let style = span.style;
        let text = span.content.to_string();
        let mut chunk = String::new();

        for ch in text.chars() {
            let ch_width = ch.width().unwrap_or(0);
            if current_width + ch_width > width && !chunk.is_empty() {
                current.push(Span::styled(std::mem::take(&mut chunk), style));
                lines.push(Line::from(std::mem::take(&mut current)));
                current_width = 0;
                prefix = continuation_prefix.to_string();
                if !prefix.is_empty() {
                    current_width += prefix.width();
                    current.push(Span::raw(prefix.clone()));
                }
            } else if current_width + ch_width > width && current.is_empty() {
                lines.push(Line::from(""));
            }

            chunk.push(ch);
            current_width += ch_width;
        }

        if !chunk.is_empty() {
            current.push(Span::styled(chunk, style));
        }
    }

    if !current.is_empty() {
        lines.push(Line::from(current));
    }

    lines
}

fn pad_render_line(mut line: Line<'static>, width: u16) -> Line<'static> {
    let current_width: usize = line
        .spans
        .iter()
        .map(|span| span.content.chars().map(|ch| ch.width().unwrap_or(0)).sum::<usize>())
        .sum();
    let target_width = width as usize;
    if current_width < target_width {
        line.spans.push(Span::raw(" ".repeat(target_width - current_width)));
    }
    line
}

fn line_to_plain_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>()
        .trim_end_matches(' ')
        .to_string()
}

fn highlight_selected_range(line: Line<'static>, start_col: usize, end_col: usize, theme: &Theme) -> Line<'static> {
    if start_col >= end_col {
        return line;
    }

    let highlight_bg = theme.colors.selected_bg;
    let highlight_fg = theme.colors.selected_fg;
    let highlight_style = Style::default().bg(highlight_bg).fg(highlight_fg);
    let mut spans = Vec::new();
    let mut current_col = 0usize;

    for span in line.spans {
        let base_style = span.style;
        let mut normal = String::new();
        let mut selected = String::new();
        let flush = |spans: &mut Vec<Span<'static>>, text: &mut String, style: Style| {
            if !text.is_empty() {
                spans.push(Span::styled(std::mem::take(text), style));
            }
        };

        for ch in span.content.chars() {
            let ch_width = ch.width().unwrap_or(0);
            let next_col = current_col + ch_width;
            let is_selected = next_col > start_col && current_col < end_col;

            if is_selected {
                flush(&mut spans, &mut normal, base_style);
                selected.push(ch);
            } else {
                flush(
                    &mut spans,
                    &mut selected,
                    merge_styles(base_style, highlight_style),
                );
                normal.push(ch);
            }

            current_col = next_col;
        }

        flush(&mut spans, &mut normal, base_style);
        flush(
            &mut spans,
            &mut selected,
            merge_styles(base_style, highlight_style),
        );
    }

    Line::from(spans)
}

fn indent_active_message_line(line: Line<'static>) -> Line<'static> {
    let mut spans = Vec::with_capacity(line.spans.len() + 1);
    spans.push(Span::raw(" "));
    spans.extend(line.spans);
    Line::from(spans)
}

fn active_message_visible_rows(
    app: &App,
    message_start_lines: &[usize],
    total_lines: usize,
    viewport_height: usize,
    start: usize,
    top_padding: usize,
    visible_line_count: usize,
) -> Option<(usize, usize)> {
    let current_idx = app.current_message_index?;
    let &message_start = message_start_lines.get(current_idx)?;
    let message_end = message_start_lines
        .get(current_idx + 1)
        .copied()
        .unwrap_or(total_lines)
        .saturating_sub(1);

    let (mut visible_start, mut visible_end) = if total_lines <= viewport_height {
        (
            top_padding + message_start,
            top_padding + message_end,
        )
    } else {
        (
            message_start.saturating_sub(start),
            message_end.saturating_sub(start),
        )
    };

    if total_lines > viewport_height {
        if message_end < start || message_start >= start + visible_line_count {
            return None;
        }
        visible_start = visible_start.min(visible_line_count.saturating_sub(1));
        visible_end = visible_end.min(visible_line_count.saturating_sub(1));
    } else {
        if visible_start >= visible_line_count {
            return None;
        }
        visible_end = visible_end.min(visible_line_count.saturating_sub(1));
    }

    Some((visible_start, visible_end))
}

fn merge_styles(base: Style, overlay: Style) -> Style {
    let mut style = base;
    if let Some(fg) = overlay.fg {
        style = style.fg(fg);
    }
    if let Some(bg) = overlay.bg {
        style = style.bg(bg);
    }
    style.add_modifier |= overlay.add_modifier;
    style.sub_modifier |= overlay.sub_modifier;
    style
}

/// Pad a line with trailing spaces to fill the given width.
/// Ensures background colors cover the full terminal width.
fn pad_line(text: &str, width: u16) -> String {
    let text_display_width = unicode_width::UnicodeWidthStr::width(text);
    let target = width as usize;
    if text_display_width >= target {
        text.to_string()
    } else {
        let pad = target - text_display_width;
        format!("{}{}", text, " ".repeat(pad))
    }
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let x = (area.width.saturating_sub(width)) / 2;
    let y = (area.height.saturating_sub(height)) / 2;
    Rect {
        x: area.x + x,
        y: area.y + y,
        width: width.min(area.width),
        height: height.min(area.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn paragraph_wrap_does_not_indent_continuation_lines() {
        let theme = Theme::default();
        let lines = markdown_to_lines(
            "If you actually want your Pixel 10 to survive a drop, grab a Ringke.",
            30,
            Style::default(),
            Style::default(),
            &theme,
        );

        assert!(lines.len() > 1);
        let second_line = lines[1]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(!second_line.starts_with("  "));
    }

    #[test]
    fn list_wrap_keeps_continuation_indent() {
        let theme = Theme::default();
        let lines = markdown_to_lines(
            "- If you actually want your Pixel 10 to survive a drop, grab a Ringke.",
            30,
            Style::default(),
            Style::default(),
            &theme,
        );

        assert!(lines.len() > 1);
        let second_line = lines[1]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(second_line.starts_with("  "));
    }

    #[test]
    fn highlight_selected_range_marks_only_requested_columns() {
        let theme = Theme::default();
        let line = Line::from(vec![
            Span::styled("abc", Style::default().fg(Color::White)),
            Span::styled("def", Style::default().fg(Color::Green)),
        ]);

        let highlighted = highlight_selected_range(line, 2, 5, &theme);
        let rendered = highlighted
            .spans
            .iter()
            .map(|span| (span.content.as_ref().to_string(), span.style.bg))
            .collect::<Vec<_>>();

        // Default theme: selected_bg = Cyan, selected_fg = Black
        assert_eq!(
            rendered,
            vec![
                ("ab".to_string(), None),
                ("c".to_string(), Some(Color::Cyan)),
                ("de".to_string(), Some(Color::Cyan)),
                ("f".to_string(), None),
            ]
        );
    }

    #[test]
    fn active_message_line_gets_indented() {
        let line = Line::from(vec![Span::styled("Assistant 12:00", Style::default())]);
        let indented = indent_active_message_line(line);
        let text = indented
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.starts_with(" Assistant 12:00"));
    }
}
