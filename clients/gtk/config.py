"""Static configuration and visual constants for the GTK client."""

GATEWAY_URI = "ws://127.0.0.1:3456/"
APP_ID = "agent-gui"
STREAM_CURSOR_CHAR = "▊"
GTK_LOG_PATH = "~/personal_assistant/logs/gtk.log"

DEFAULT_WINDOW_WIDTH = 780
DEFAULT_WINDOW_HEIGHT = 540

TRANSCRIPT_FONT = "JetBrainsMono Nerd Font 13"

USER_BAND_INSET = 16
USER_BAR_WIDTH = 6
USER_TEXT_MARGIN = 26
USER_BAND_PADDING_TOP = 12
USER_BAND_PADDING_BOTTOM = 12
CODE_MARGIN = 14
CODE_HEAD_PAD = 6

# Base palette. Dark surfaces, whitish primary text, dim grey reserved for
# thinking blocks, and state colours for the connection dot in the status bar.
BG_COLOR = "#1e1e22"
INPUT_BG_COLOR = "#2a2a2f"
TEXT_COLOR = "#c4c4c4"
THINKING_COLOR = "#969696"

# User messages: blue accent bar and a blue-tinted shaded block.
USER_BAND_COLOR = "#58a6ff"
USER_BLOCK_BG_COLOR = "#242a38"

# Thinking blocks: purple accent (header glyph) over a faint purple wash.
THINKING_HEAD_COLOR = "#bc8cff"
THINKING_BLOCK_BG_COLOR = "#252130"

STATUS_OK_COLOR = "#3fb950"
STATUS_ERR_COLOR = "#f85149"
SELECTION_BG_COLOR = "#3a4150"

# Tool-call theming: bright orange tool name, cooler grey arguments, dim
# glyphs, and neutral/success/error surfaces for the collapsible result block.
TOOL_NAME_COLOR = "#ffa657"
TOOL_ARG_COLOR = "#a6adc8"
TOOL_META_COLOR = "#969696"
TOOL_BLOCK_BG_COLOR = "#26262b"
TOOL_SUCCESS_BG_COLOR = "#243029"
TOOL_ERROR_BG_COLOR = "#332629"


def _hex_rgb(hex_color):
    """Convert ``#rrggbb`` to the 0..1 float triple Cairo expects."""

    value = hex_color.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


USER_BAND_RGB = _hex_rgb(USER_BAND_COLOR)
