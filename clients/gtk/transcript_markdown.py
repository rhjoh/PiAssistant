"""GTK TextBuffer rendering for parsed assistant Markdown."""

from __future__ import annotations

from typing import Callable

import gi
import markdown

gi.require_version("Gtk", "3.0")
from gi.repository import Pango

try:  # Direct executable invocation: ``./agent-gui.py``.
    from config import CODE_MARGIN, TRANSCRIPT_FONT
    from markdown_renderer import (
        MdRenderer,
        highlight_code,
        pygments_token_tag,
        table_grid,
    )
except ImportError:  # Package import from the repository test runner.
    from .config import CODE_MARGIN, TRANSCRIPT_FONT
    from .markdown_renderer import (
        MdRenderer,
        highlight_code,
        pygments_token_tag,
        table_grid,
    )


INLINE_TAG_MAP = {
    "strong": "md-strong",
    "em": "md-em",
    "code": "md-code",
    "a": "md-link",
}


class MarkdownBufferRenderer:
    """Insert Markdown into a GTK buffer without owning transcript state."""

    def __init__(self, buffer, view, add_copy_button: Callable):
        self.buffer = buffer
        self.view = view
        self.add_copy_button = add_copy_button
        self._code_tab_width = None
        self._list_tag_names = {}

    def _list_tag_name(self, prefix):
        """Return a hanging-indent tag sized to this list prefix."""

        try:
            layout = self.view.create_pango_layout(prefix)
            layout.set_font_description(
                Pango.FontDescription.from_string(TRANSCRIPT_FONT)
            )
            width = layout.get_pixel_size()[0]
        except Exception:
            # Rendering should remain usable even if a custom/embedded view
            # cannot create a layout yet.  The transcript font is monospace,
            # so this is a conservative fallback until the view is realized.
            width = len(prefix) * 8
        width = max(1, int(width))
        tag_name = self._list_tag_names.get(width)
        if tag_name is not None:
            return tag_name

        tag_name = f"md-li-hanging-{width}"
        if self.buffer.get_tag_table().lookup(tag_name) is None:
            self.buffer.create_tag(tag_name, left_margin=width)
        self._list_tag_names[width] = tag_name
        return tag_name

    def emit_runs(self, runs, extra=(), at=None):
        end = at if at is not None else self.buffer.get_end_iter()
        base = tuple(tag for tag in extra if tag)
        for text, inline in runs:
            tags = base
            if inline:
                tags += (INLINE_TAG_MAP.get(inline, inline),)
            if tags:
                self.buffer.insert_with_tags_by_name(end, text, *tags)
            else:
                self.buffer.insert(end, text)
        self.buffer.insert(end, "\n")

    def render(self, text, at=None):
        """Render ``text`` at the end or at the supplied advancing iterator."""

        try:
            html = markdown.markdown(
                text,
                extensions=["tables", "fenced_code", "sane_lists"],
            )
            parser = MdRenderer()
            parser.feed(html)
        except Exception:
            end = at if at is not None else self.buffer.get_end_iter()
            self.buffer.insert(end, text + "\n")
            return

        cur = at if at is not None else self.buffer.get_end_iter()
        for line in parser.lines:
            kind = line[0]
            try:
                if kind == "p":
                    self.emit_runs(line[1], at=cur)
                elif kind == "h":
                    self.emit_runs(line[2], extra=(f"md-h{line[1]}",), at=cur)
                elif kind == "li":
                    self.buffer.insert(cur, line[2])
                    self.emit_runs(
                        line[1],
                        extra=("md-li", self._list_tag_name(line[2])),
                        at=cur,
                    )
                elif kind == "quote":
                    self.emit_runs(line[1], extra=("md-quote",), at=cur)
                elif kind == "pre":
                    self._render_code(cur, line)
                elif kind == "table":
                    for line_text in table_grid(line[1]):
                        self.buffer.insert_with_tags_by_name(
                            cur, line_text + "\n", "md-table"
                        )
                elif kind == "hr":
                    self.buffer.insert_with_tags_by_name(cur, "─" * 60 + "\n", "md-hr")
            except Exception:
                # One malformed rendered line must not suppress the remainder
                # of an otherwise usable assistant response.
                pass

    def _render_code(self, cur, line):
        code = line[1]
        language = line[2] if len(line) > 2 else None
        self.sync_code_head_tab()
        slug = (language or "").strip()
        if slug:
            self.buffer.insert_with_tags_by_name(
                cur, slug.upper() + "\t", "md-pre-head", "md-pre-lang"
            )
        else:
            self.buffer.insert_with_tags_by_name(cur, "\t", "md-pre-head")
        self.add_copy_button(code, at=cur)
        self.buffer.insert_with_tags_by_name(cur, "\n", "md-pre-head")
        tokens = highlight_code(code, language)
        if tokens:
            for token_text, token_type in tokens:
                tag = pygments_token_tag(token_type)
                tags = ("md-pre", tag) if tag else ("md-pre",)
                self.buffer.insert_with_tags_by_name(cur, token_text, *tags)
        else:
            self.buffer.insert_with_tags_by_name(cur, code, "md-pre")
        self.buffer.insert_with_tags_by_name(cur, "\n\n", "md-pre")

    def sync_code_head_tab(self):
        tag = self.buffer.get_tag_table().lookup("md-pre-head")
        if tag is None:
            return
        width = self.view.get_allocation().width
        if width <= 0:
            return
        tabs = Pango.TabArray.new(1, True)
        tabs.set_tab(0, Pango.TabAlign.RIGHT, max(0, width - 2 * CODE_MARGIN))
        tag.set_property("tabs", tabs)

    def on_view_size_allocate(self, alloc):
        if alloc.width != self._code_tab_width:
            self._code_tab_width = alloc.width
            self.sync_code_head_tab()


__all__ = ["MarkdownBufferRenderer"]
