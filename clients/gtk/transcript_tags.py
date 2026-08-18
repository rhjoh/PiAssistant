"""Text tags used by the GTK transcript.

Keeping the tag palette here makes the transcript controller responsible for
rendering state and event flow, while this module owns the GTK styling
contract.  ``create_transcript_tags`` intentionally creates tags in the same
order as the old inline implementation: Gtk uses creation order for tag
priority when multiple tags apply to the same range.

The imports support both invocation styles used by the GTK client.  The
standalone ``agent-gui.py`` launcher places ``clients/gtk`` on ``sys.path``;
the test suite imports it as ``clients.gtk``.
"""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk, Pango

try:  # Direct executable invocation: ``./agent-gui.py``.
    import config
except ImportError:  # Package import from the repository test runner.
    from . import config


def _rgba(color: str) -> Gdk.RGBA:
    """Parse one configured colour into a GTK RGBA value."""

    value = Gdk.RGBA()
    value.parse(color)
    return value


def build_tag_specs() -> dict[str, dict[str, object]]:
    """Return the transcript tag definitions in creation/priority order.

    A fresh mapping and fresh colour objects are returned on every call so a
    caller can safely pass the definitions to a different text buffer.
    """

    # Block surfaces: each transcript surface (user rows, thinking blocks,
    # tool results) gets a shaded paragraph background, with accent
    # foregrounds (blue band, purple thinking header, orange tool name)
    # layered on top.
    thinking_rgba = _rgba(config.THINKING_COLOR)
    thinking_head_rgba = _rgba(config.THINKING_HEAD_COLOR)
    thinking_block_rgba = _rgba(config.THINKING_BLOCK_BG_COLOR)
    user_block_rgba = _rgba(config.USER_BLOCK_BG_COLOR)
    tool_name_rgba = _rgba(config.TOOL_NAME_COLOR)
    tool_arg_rgba = _rgba(config.TOOL_ARG_COLOR)
    tool_meta_rgba = _rgba(config.TOOL_META_COLOR)
    tool_block_rgba = _rgba(config.TOOL_BLOCK_BG_COLOR)
    tool_success_rgba = _rgba(config.TOOL_SUCCESS_BG_COLOR)
    tool_error_rgba = _rgba(config.TOOL_ERROR_BG_COLOR)
    background_rgba = _rgba(config.BG_COLOR)

    return {
        # A real, uncoloured spacer paragraph between transcript surfaces.
        # TextTag pixel padding is painted as part of a paragraph's
        # background, so it cannot create a visible gap.
        "block-gap": dict(
            paragraph_background_rgba=background_rgba,
            size_points=1,
            pixels_above_lines=2,
            pixels_below_lines=2,
        ),
        "user": dict(
            paragraph_background_rgba=user_block_rgba,
            left_margin=config.USER_TEXT_MARGIN,
            right_margin=16,
            pixels_above_lines=config.USER_BAND_PADDING_TOP,
            pixels_below_lines=config.USER_BAND_PADDING_BOTTOM,
        ),
        "thinking": dict(
            foreground_rgba=thinking_rgba,
            style=Pango.Style.ITALIC,
            paragraph_background_rgba=thinking_block_rgba,
            left_margin=16,
            right_margin=16,
        ),
        "think-head": dict(
            foreground_rgba=thinking_head_rgba,
            scale=0.85,
            weight=Pango.Weight.BOLD,
            paragraph_background_rgba=thinking_block_rgba,
            left_margin=16,
            right_margin=16,
            pixels_above_lines=4,
        ),
        "think-hidden": dict(
            foreground_rgba=thinking_rgba,
            scale=0.85,
            style=Pango.Style.ITALIC,
            paragraph_background_rgba=thinking_block_rgba,
            left_margin=16,
            right_margin=16,
            pixels_above_lines=4,
            pixels_below_lines=4,
        ),
        "tool": dict(foreground_rgba=tool_meta_rgba),
        "tool-name": dict(
            foreground_rgba=tool_name_rgba,
            weight=Pango.Weight.BOLD,
        ),
        "tool-args": dict(foreground_rgba=tool_arg_rgba),
        "tool-header": dict(
            paragraph_background_rgba=tool_block_rgba,
            left_margin=18,
            right_margin=18,
            pixels_above_lines=6,
            pixels_below_lines=2,
        ),
        "tool-output": dict(
            family="monospace",
            paragraph_background_rgba=tool_block_rgba,
            left_margin=18,
            right_margin=18,
            pixels_above_lines=2,
            pixels_below_lines=2,
        ),
        "tool-success": dict(
            paragraph_background_rgba=tool_success_rgba,
        ),
        "tool-error": dict(
            paragraph_background_rgba=tool_error_rgba,
        ),
        "copy-row": dict(
            justification=Gtk.Justification.RIGHT,
            left_margin=18,
            right_margin=18,
            pixels_below_lines=6,
        ),
        "error": dict(),
        "system": dict(),
        "abort-status": dict(
            foreground_rgba=tool_meta_rgba,
            scale=0.85,
        ),
        "md-h1": dict(
            weight=Pango.Weight.BOLD,
            scale=1.4,
            pixels_above_lines=8,
            pixels_below_lines=4,
        ),
        "md-h2": dict(
            weight=Pango.Weight.BOLD,
            scale=1.22,
            pixels_above_lines=6,
            pixels_below_lines=3,
        ),
        "md-h3": dict(weight=Pango.Weight.BOLD, scale=1.08, pixels_above_lines=5),
        "md-h4": dict(weight=Pango.Weight.BOLD, scale=1.0, pixels_above_lines=5),
        "md-strong": dict(weight=Pango.Weight.BOLD),
        "md-em": dict(style=Pango.Style.ITALIC),
        "md-code": dict(),
        "md-pre": dict(
            left_margin=config.CODE_MARGIN,
            right_margin=config.CODE_MARGIN,
        ),
        "md-pre-head": dict(
            left_margin=config.CODE_MARGIN,
            right_margin=config.CODE_MARGIN,
            pixels_above_lines=config.CODE_HEAD_PAD,
        ),
        "md-pre-lang": dict(
            scale=0.85,
            weight=Pango.Weight.BOLD,
        ),
        "syn-keyword": dict(),
        "syn-func": dict(),
        "syn-builtin": dict(),
        "syn-string": dict(),
        "syn-number": dict(),
        "syn-comment": dict(style=Pango.Style.ITALIC),
        "syn-operator": dict(),
        "syn-tag": dict(),
        "syn-attr": dict(),
        "md-quote": dict(
            style=Pango.Style.ITALIC,
            left_margin=14,
            pixels_above_lines=2,
            pixels_below_lines=2,
        ),
        "md-li": dict(left_margin=18),
        "md-table": dict(),
        "md-link": dict(
            underline=Pango.Underline.SINGLE,
        ),
        "md-hr": dict(),
        "stream-cursor": dict(weight=Pango.Weight.BOLD),
    }


def create_transcript_tags(buffer: Gtk.TextBuffer) -> Gtk.TextTag:
    """Install all transcript tags on ``buffer`` and return the cursor tag."""

    cursor_tag = None
    for name, props in build_tag_specs().items():
        tag = buffer.create_tag(name, **props)
        if name == "stream-cursor":
            cursor_tag = tag
    # The final tag is part of the public contract: TranscriptController uses
    # the object directly when appending/removing its streaming cursor.
    assert cursor_tag is not None
    return cursor_tag
