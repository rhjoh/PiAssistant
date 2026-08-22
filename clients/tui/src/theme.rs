use ratatui::style::Color;

// =============================================================================
// Design Choice Enums — Structural UI changes beyond color palette
// =============================================================================

/// How popup/panel borders are treated
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BorderTreatment {
    /// Standard Borders::ALL with accent color
    Standard,
    /// Borders::BOTTOM only with muted color
    Subtle,
}

// =============================================================================
// Color Palette
// =============================================================================

#[derive(Debug, Clone, Copy)]
pub struct ThemeColors {
    // Role headers
    pub user_header: Color,
    pub assistant_header: Color,
    pub system_header: Color,

    // Backgrounds
    pub code_bg: Color,
    pub popup_bg: Color,
    pub picker_bg: Color,
    pub help_bg: Color,

    // Text
    pub text: Color,
    pub muted: Color,
    pub accent: Color,

    // Semantic states
    pub connected: Color,
    pub disconnected: Color,
    pub connecting: Color,
    pub error_text: Color,
    pub thinking: Color,

    // Selection / highlight
    pub selected_fg: Color,
    pub selected_bg: Color,

    // Role chip text (on role-header-colored background)
    pub chip_fg: Color,

    // Code blocks
    pub code_fg: Color,

    // Tool calls
    pub tool_name: Color,
    pub tool_output: Color,
    pub tool_error: Color,

    // Image placeholder
    pub image_text: Color,

    // Popup / input
    pub popup_border: Color,
    pub input_fg: Color,
    pub input_placeholder: Color,
}

// =============================================================================
// Theme — complete design system
// =============================================================================

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub name: &'static str,
    pub colors: ThemeColors,
    pub borders: BorderTreatment,
}

impl Theme {
    // ── Built-in: Foundry (default dark design) ────────────────────────────

    pub fn default() -> Self {
        Self {
            name: "foundry",
            colors: ThemeColors {
                // Mirrors the Web UI foundry palette: coal, steel, forge amber.
                user_header: Color::Rgb(232, 168, 56),
                assistant_header: Color::Rgb(138, 138, 149),
                system_header: Color::Rgb(61, 143, 181),

                code_bg: Color::Rgb(20, 20, 24),
                popup_bg: Color::Rgb(8, 8, 10),
                picker_bg: Color::Rgb(8, 8, 10),
                help_bg: Color::Rgb(8, 8, 10),

                text: Color::Rgb(212, 212, 216),
                muted: Color::Rgb(107, 107, 117),
                accent: Color::Rgb(232, 168, 56),

                connected: Color::Rgb(45, 138, 78),
                disconnected: Color::Rgb(194, 59, 34),
                connecting: Color::Rgb(232, 168, 56),
                error_text: Color::Rgb(194, 59, 34),
                thinking: Color::Rgb(120, 113, 108),

                selected_fg: Color::Rgb(10, 10, 12),
                selected_bg: Color::Rgb(232, 168, 56),

                chip_fg: Color::Rgb(10, 10, 12),

                code_fg: Color::Rgb(212, 212, 216),

                tool_name: Color::Rgb(232, 168, 56),
                tool_output: Color::Rgb(138, 138, 149),
                tool_error: Color::Rgb(194, 59, 34),

                image_text: Color::Rgb(61, 143, 181),

                popup_border: Color::Rgb(51, 51, 61),
                input_fg: Color::Rgb(228, 228, 231),
                input_placeholder: Color::Rgb(70, 70, 79),
            },
            borders: BorderTreatment::Subtle,
        }
    }

    // ── Built-in: Classic (original dark terminal design) ──────────────────

    pub fn classic() -> Self {
        Self {
            name: "classic",
            colors: ThemeColors {
                user_header: Color::Blue,
                assistant_header: Color::Green,
                system_header: Color::Yellow,

                code_bg: Color::Rgb(24, 24, 30),
                popup_bg: Color::Rgb(30, 30, 40),
                picker_bg: Color::Rgb(25, 25, 35),
                help_bg: Color::Rgb(30, 30, 40),

                text: Color::White,
                muted: Color::DarkGray,
                accent: Color::Cyan,

                connected: Color::Green,
                disconnected: Color::Red,
                connecting: Color::Yellow,
                error_text: Color::Red,
                thinking: Color::Magenta,

                selected_fg: Color::Black,
                selected_bg: Color::Cyan,

                chip_fg: Color::Black,

                code_fg: Color::Green,

                tool_name: Color::Cyan,
                tool_output: Color::Gray,
                tool_error: Color::Rgb(210, 110, 110),

                image_text: Color::Blue,

                popup_border: Color::Cyan,
                input_fg: Color::White,
                input_placeholder: Color::DarkGray,
            },
            borders: BorderTreatment::Standard,
        }
    }

    // ── Built-in: Paper (light, Kanagawa Paper inspired) ───────────────────

    pub fn paper() -> Self {
        Self {
            name: "paper",
            colors: ThemeColors {
                // Kanagawa Paper palette
                // bg: #f4f0e0 (warm cream), fg: #1e1e2e (near black)
                user_header: Color::Rgb(46, 125, 233), // blue
                assistant_header: Color::Rgb(118, 148, 106), // green
                system_header: Color::Rgb(228, 104, 77), // coral

                code_bg: Color::Rgb(230, 224, 206), // darker paper
                popup_bg: Color::Rgb(240, 235, 218), // warm popup bg
                picker_bg: Color::Rgb(240, 235, 218),
                help_bg: Color::Rgb(240, 235, 218),

                text: Color::Rgb(30, 30, 46),      // near black
                muted: Color::Rgb(166, 160, 160),  // kanagawa comment
                accent: Color::Rgb(106, 149, 137), // kanagawa cyan

                connected: Color::Rgb(118, 148, 106),  // green
                disconnected: Color::Rgb(195, 64, 67), // kanagawa red
                connecting: Color::Rgb(220, 165, 97),  // kanagawa yellow
                error_text: Color::Rgb(195, 64, 67),   // kanagawa red
                thinking: Color::Rgb(149, 127, 184),   // kanagawa purple

                selected_fg: Color::Rgb(244, 240, 224), // paper
                selected_bg: Color::Rgb(106, 149, 137), // cyan

                chip_fg: Color::Rgb(30, 30, 46),

                code_fg: Color::Rgb(118, 148, 106), // green

                tool_name: Color::Rgb(106, 149, 137), // cyan
                tool_output: Color::Rgb(80, 80, 90),  // dark gray
                tool_error: Color::Rgb(195, 64, 67),  // red

                image_text: Color::Rgb(46, 125, 233), // blue

                popup_border: Color::Rgb(106, 149, 137), // cyan
                input_fg: Color::Rgb(30, 30, 46),
                input_placeholder: Color::Rgb(166, 160, 160),
            },
            borders: BorderTreatment::Subtle,
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /// Resolve a theme by name.
    pub fn by_name(name: &str) -> Option<Self> {
        match name {
            "default" | "foundry" => Some(Self::default()),
            "classic" => Some(Self::classic()),
            "paper" => Some(Self::paper()),
            _ => None,
        }
    }

    /// Return all available theme names, in display order.
    pub fn all_names() -> &'static [&'static str] {
        &["foundry", "classic", "paper"]
    }
}
