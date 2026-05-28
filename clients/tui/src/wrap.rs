use unicode_width::UnicodeWidthChar;

/// Word-wraps text into lines matching ratatui's WordWrapper behavior with `trim: false`.
///
/// The algorithm matches ratatui-0.29's WordWrapper state machine for `Wrap { trim: false }`:
///
/// 1. Words (non-whitespace runs) and whitespace runs are tracked separately.
/// 2. On transition from non-whitespace → whitespace (`word_found`), the pending word
///    (and any pending whitespace) is flushed to the current line.
/// 3. On transition that would overflow the line, the line is wrapped:
///    - The current line is emitted.
///    - Pending whitespace that fits in the remaining width is dropped (moved to
///      become leading padding of the wrapped line in ratatui's rendering).
/// 4. A single word longer than max_line_width IS broken across lines.
/// 5. Trailing whitespace before a wrap is partially preserved: up to `remaining_width`
///    characters move to the next line as leading whitespace.
pub fn word_wrap_lines(text: &str, line_width: usize) -> Vec<String> {
    if line_width == 0 {
        return vec![text.to_string()];
    }

    let mut lines: Vec<String> = vec![String::new()];
    let mut line_width_accum = 0usize;
    let mut word = String::new();
    let mut word_width = 0usize;
    let mut whitespace = String::new();
    let mut whitespace_width = 0usize;
    let mut prev_was_ws = false;

    for c in text.chars() {
        let cw = c.width().unwrap_or(0);
        let is_ws = c == ' ';

        // Skip any symbol wider than max_line_width
        if cw as u16 > line_width as u16 {
            continue;
        }

        // Detect word-found transition (non-ws → ws)
        let word_found = !prev_was_ws && is_ws;
        // On an empty line, if word+ws+symbol would exceed width: flush before adding symbol
        let untrimmed_overflow =
            line_width_accum == 0 && word_width + whitespace_width + cw > line_width;

        // Flush pending whitespace + word to current line when triggered
        if word_found || untrimmed_overflow {
            if line_width_accum > 0 || !whitespace.is_empty() {
                push_line_mut(&mut lines).push_str(&whitespace);
                line_width_accum += whitespace_width;
            }
            if !word.is_empty() {
                push_line_mut(&mut lines).push_str(&word);
                line_width_accum += word_width;
            }

            whitespace.clear();
            whitespace_width = 0;
            word.clear();
            word_width = 0;
        }

        // Check if current line is full or would overflow with pending content
        let line_full = line_width_accum >= line_width;
        let pending_overflow = line_width_accum > 0
            && cw > 0
            && line_width_accum + whitespace_width + word_width >= line_width;

        if line_full || pending_overflow {
            // Emit the current line and start a new one
            lines.push(String::new());
            let flushed_width = line_width_accum;
            line_width_accum = 0;

            // Leading whitespace from the wrapped line: up to `remaining_width`
            // chars are dropped from pending whitespace (they become leading
            // spaces of the new line in ratatui's rendering).
            let mut remaining = line_width.saturating_sub(flushed_width);
            while let Some(ws_char) = whitespace.chars().next() {
                let ws_width = ws_char.width().unwrap_or(0);
                if ws_width > remaining {
                    break;
                }
                remaining -= ws_width;
                whitespace_width -= ws_width;
                whitespace.remove(0);
            }

            // Don't count this whitespace char toward the next word if we just wrapped
            if is_ws && whitespace.is_empty() {
                prev_was_ws = true;
                continue;
            }
        }

        // Accumulate into pending buffers
        if is_ws {
            whitespace.push(c);
            whitespace_width += cw;
        } else {
            word.push(c);
            word_width += cw;
        }

        prev_was_ws = is_ws;
    }

    // Flush remaining content
    if line_width_accum > 0 || !whitespace.is_empty() {
        if !whitespace.is_empty() {
            push_line_mut(&mut lines).push_str(&whitespace);
        }
    }
    if !word.is_empty() {
        push_line_mut(&mut lines).push_str(&word);
    }

    lines
}

fn push_line_mut(lines: &mut Vec<String>) -> &mut String {
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines.last_mut().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn test_short_line_no_wrap() {
        let r = word_wrap_lines("hello world", 60);
        assert_eq!(r, vec!["hello world"]);
    }

    #[test]
    fn test_wrap_at_word_boundary() {
        let r = word_wrap_lines("hello world this is a test", 15);
        assert!(r.len() >= 2);
        for line in &r {
            assert!(line.width() <= 15, "'{}' exceeds width 15", line);
        }
    }

    #[test]
    fn test_long_word_is_broken() {
        let r = word_wrap_lines("superlongword", 10);
        assert_eq!(r[0], "superlongw");
        assert_eq!(r[1], "ord");
    }

    #[test]
    fn test_whitespace_before_wrap_dropped_as_leading_padding() {
        // "hello   world" @ 8: "hello" (5) + "   " (3) would exactly fill width 8.
        // pending_overflow triggers at the 3rd space (5+3 >= 8).
        // flushed_width=5, remaining=3 → all 3 spaces removed from pending_whitespace.
        // The space char is skipped. "world" goes to next line.
        // The trailing 3 spaces appear in the buffer but NOT in the wrapped line content.
        let r = word_wrap_lines("hello   world", 8);
        assert_eq!(r[0], "hello");
        assert_eq!(r[1], "world");
    }

    #[test]
    fn test_whitespace_consumed_as_padding() {
        // "hello    world" @ 8: "hello" (5) + "    " (4) = 9 > 8.
        // 3rd space (wsw=3): pending_overflow: 5+3+0=8 >= 8 → triggers.
        // remaining=8-5=3 → all 3 spaces consumed. 4th space is_ws and ws empty → skipped.
        // No space remains. "world" goes to next line.
        let r = word_wrap_lines("hello    world", 8);
        assert_eq!(r[0], "hello");
        assert_eq!(r[1], "world");
        for line in &r {
            assert!(line.width() <= 8, "'{}' exceeds width 8", line);
        }
    }

    #[test]
    fn test_prefix_fills_line_exactly() {
        // "> 12345678" @ 10 fills exactly
        let r = word_wrap_lines("> 12345678", 10);
        assert_eq!(r, vec!["> 12345678"]);
    }

    #[test]
    fn test_empty() {
        let r = word_wrap_lines("", 20);
        assert_eq!(r, vec![""]);
    }

    #[test]
    fn test_exact_line_width_no_wrap() {
        let r = word_wrap_lines("1234567890", 10);
        assert_eq!(r, vec!["1234567890"]);
    }

    #[test]
    fn test_ratatui_compatibility() {
        let text = "This is a long line of text that should wrap      and contains a superultramegagigalong word.";
        let r = word_wrap_lines(text, 15);
        // Just check widths are valid
        for line in &r {
            assert!(line.width() <= 15, "'{}' exceeds width 15", line);
        }
        // Verify the long word is broken
        assert!(r.iter().any(|l| l.contains("superultra")));
    }
}
