use anyhow::Result;

use crate::app::{App, ContentItem, MessageRole};

/// Copy the last assistant message text to the system clipboard
pub fn copy_last_message(app: &App) -> Result<()> {
    let text = find_last_copyable_text(app)?;
    copy_to_clipboard(&text)
}

/// Copy arbitrary text to the system clipboard.
pub fn copy_text(text: &str) -> Result<()> {
    copy_to_clipboard(text)
}

fn find_last_copyable_text(app: &App) -> Result<String> {
    // Find the most recent assistant message with text content
    for msg in app.messages.iter().rev() {
        if msg.role != MessageRole::Assistant {
            continue;
        }

        let mut parts = Vec::new();
        for item in &msg.items {
            match item {
                ContentItem::Text(text) => parts.push(text.clone()),
                ContentItem::ToolCall {
                    label,
                    result,
                    is_error,
                    ..
                } => {
                    if let Some(content) = result {
                        let lang = if *is_error { "" } else { "" };
                        parts.push(format!("{}\n```{}\n{}\n```", label, lang, content));
                    } else {
                        parts.push(format!("*Running: {}*", label));
                    }
                }
                // Legacy orphan ToolResult (history fallback)
                ContentItem::ToolResult { content, .. } => {
                    parts.push(format!("```\n{}\n```", content));
                }
                _ => {}
            }
        }

        if !parts.is_empty() {
            return Ok(parts.join("\n\n"));
        }
    }

    // Fallback: copy the last user message
    for msg in app.messages.iter().rev() {
        if msg.role == MessageRole::User {
            for item in &msg.items {
                if let ContentItem::Text(text) = item {
                    return Ok(text.clone());
                }
            }
        }
    }

    anyhow::bail!("No text to copy")
}

fn copy_to_clipboard(text: &str) -> Result<()> {
    // Try arboard first (cross-platform)
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        clipboard.set_text(text)?;
        return Ok(());
    }

    // Platform-specific fallbacks
    #[cfg(target_os = "macos")]
    {
        return copy_via_pbcopy(text);
    }

    #[cfg(target_os = "linux")]
    {
        return copy_via_xclip(text);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        anyhow::bail!("No clipboard mechanism available")
    }
}

#[cfg(target_os = "macos")]
fn copy_via_pbcopy(text: &str) -> Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }

    let _ = child.wait()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_via_xclip(text: &str) -> Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("xclip")
        .args(["-selection", "clipboard"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }

    let _ = child.wait()?;
    Ok(())
}
