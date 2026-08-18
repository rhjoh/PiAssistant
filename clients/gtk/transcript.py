"""GTK transcript view and rendering controller.

This module owns the mutable state associated with the conversation
``Gtk.TextBuffer``: streamed segments and their marks, thinking blocks,
cursor/copy widgets, scrolling, markdown replacement, and user-message
accents.  The window/controller that owns the prompt and gateway only needs
to route protocol events to the public methods on :class:`TranscriptController`.

The imports intentionally support both invocation styles used by this client:
``./agent-gui.py`` puts ``clients/gtk`` on ``sys.path`` (local imports), while
the test suite imports the directory as ``clients.gtk`` (package fallback).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable, Mapping

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango

try:  # Direct executable invocation: `./agent-gui.py`.
    from config import (
        STREAM_CURSOR_CHAR,
        TRANSCRIPT_FONT,
    )
    from markdown_renderer import light_stream_filter
    from protocol import content_text, content_thinking, is_heartbeat
    from transcript_markdown import MarkdownBufferRenderer
    from transcript_tags import create_transcript_tags
    from transcript_tools import (
        display_tool_output,
        summarize_tool,
        summarize_tool_parts,
    )
    from user_accents import draw_user_accents as paint_user_accents
except ImportError:  # Package import from the repository test runner.
    from .config import (
        STREAM_CURSOR_CHAR,
        TRANSCRIPT_FONT,
    )
    from .markdown_renderer import light_stream_filter
    from .protocol import content_text, content_thinking, is_heartbeat
    from .transcript_markdown import MarkdownBufferRenderer
    from .transcript_tags import create_transcript_tags
    from .transcript_tools import (
        display_tool_output,
        summarize_tool,
        summarize_tool_parts,
    )
    from .user_accents import draw_user_accents as paint_user_accents


StatusCallback = Callable[[str], Any]
logger = logging.getLogger(__name__)

# Explicit headings keep both thinking states discoverable in the transcript.
# The shortcut is repeated on the collapsed row because the transient status
# message disappears quickly and is not useful when reviewing an older block.
THINKING_VISIBLE_HEADER = "▾ Thinking"
THINKING_HIDDEN_PLACEHOLDER = "▸ Thinking hidden — Ctrl+T to show"


class TranscriptView(Gtk.TextView):
    """TextView that paints the accent bars on user-message bands."""

    def __init__(self, controller: "TranscriptController", **kwargs):
        super().__init__(**kwargs)
        self._controller = controller

    def do_draw(self, cr):
        Gtk.TextView.do_draw(self, cr)
        self._controller.draw_user_accents(cr)


class TranscriptController:
    """Own the GTK transcript buffer and all rendering-related state.

    Args:
        parent: Optional window-like object used for the clipboard.  It is
            normally the containing ``Gtk.Window``; the view is used as a
            fallback when no parent is supplied.
        on_status: Optional callback for transient status text (copy and
            thinking visibility notifications).
        view: An existing :class:`TranscriptView` is accepted for advanced
            embedding, but normally the controller creates its own view.

    The controller exposes ``view`` and ``buffer`` for packing and keyboard
    selection.  Event-facing methods are intentionally small and protocol
    shaped: ``text_delta``, ``thinking_delta``, ``thinking_done``, ``done``,
    ``tool_start``, ``tool_output``, ``tool_end``, ``load_history``,
    ``proactive``, ``clear``, ``toggle_thinking``, and ``toggle_tools``.
    """

    def __init__(
        self,
        parent: Any = None,
        *,
        on_status: StatusCallback | None = None,
        view: TranscriptView | None = None,
        buffer: Gtk.TextBuffer | None = None,
        start_cursor_timer: bool = True,
    ):
        self.parent = parent
        self._on_status = on_status
        self.buffer = buffer or Gtk.TextBuffer()
        self._in_thinking = False
        self._segments: list[dict[str, Any]] = []
        self._cur_seg: dict[str, Any] | None = None
        self._show_thinking = True
        self._thinking_blocks: list[dict[str, Any]] = []
        self._hidden_thinking: list[dict[str, Any]] = []
        self._turn_serial = 0
        self._active_turn_key: str | None = None
        self._current_thinking_id: str | None = None
        self._current_hidden_thinking: dict[str, Any] | None = None
        self._show_tools = True
        self._tool_blocks: list[dict[str, Any]] = []
        self._tool_blocks_by_id: dict[str, dict[str, Any]] = {}
        self._cur_tool: dict[str, Any] | None = None
        self._pending_rows: dict[str, dict[str, Any]] = {}
        self._cursor_mark = None
        self._cursor_visible = True
        self._cursor_tag = None
        self._copy_buttons: list[Gtk.Widget] = []
        self._cursor_timer = None
        self._focus_window = parent if isinstance(parent, Gtk.Window) else None
        self._window_active_handler = None
        self._relayout_pin_adjustment = None
        self._relayout_pin_handler = None
        self._relayout_pin_release_source = None
        if view is None:
            self.view = TranscriptView(self, buffer=self.buffer)
        else:
            self.view = view
            # A supplied view must use the controller's buffer.  This keeps
            # marks and drawing state in one place even for custom embedding.
            self.buffer = view.get_buffer()
        # A right-gravity mark follows every append and structural buffer edit.
        # Create it only after resolving a caller-supplied view's buffer.
        self._bottom_mark = self.buffer.create_mark(
            None, self.buffer.get_end_iter(), False
        )
        self._configure_view()
        self._make_tags()
        self._markdown_renderer = MarkdownBufferRenderer(
            self.buffer, self.view, self._add_copy_button
        )
        self.view.connect("size-allocate", self._on_view_size_allocate)
        # GtkTextView renders through an internal pixel cache.  Repaint the
        # transcript when focus/backdrop state changes so cached lines cannot
        # retain a stale foreground until the cursor happens to touch them.
        self.view.connect("focus-in-event", self._on_focus_event)
        self.view.connect("focus-out-event", self._on_focus_event)
        if self._focus_window is not None:
            self._window_active_handler = self._focus_window.connect(
                "notify::is-active", self._on_window_active_changed
            )
        if start_cursor_timer:
            self._cursor_timer = GLib.timeout_add(500, self._cursor_tick)

    def _configure_view(self):
        self.view.set_editable(False)
        self.view.set_cursor_visible(False)
        self.view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.view.override_font(Pango.FontDescription.from_string(TRANSCRIPT_FONT))

    def _on_focus_event(self, _view, _event):
        self.queue_full_redraw()
        return False

    def _on_window_active_changed(self, _window, _param):
        self.queue_full_redraw()

    def queue_full_redraw(self):
        """Invalidate cached transcript tiles after a visual state change."""

        self.view.queue_draw()

    # ------------------------------------------------------------------
    # Lifecycle/status
    # ------------------------------------------------------------------

    def stop(self):
        """Stop the cursor timeout and destroy embedded copy buttons."""

        if self._window_active_handler is not None:
            self._focus_window.disconnect(self._window_active_handler)
            self._window_active_handler = None
        if self._cursor_timer is not None:
            GLib.source_remove(self._cursor_timer)
            self._cursor_timer = None
        self._cancel_relayout_bottom_pin()
        for button in self._copy_buttons:
            button.destroy()
        self._copy_buttons = []
        self._tool_blocks = []
        self._tool_blocks_by_id = {}
        self._cur_tool = None

    def _set_status(self, text: str):
        if self._on_status is not None:
            self._on_status(text)

    # ------------------------------------------------------------------
    # GTK tags and event-facing transcript API
    # ------------------------------------------------------------------

    def _make_tags(self):
        self._cursor_tag = create_transcript_tags(self.buffer)

    def append(self, text, tag=None, newline=True, force_scroll=False):
        """Append one tagged/plain line while respecting user's scroll pin."""

        stick = force_scroll or self._at_bottom()
        end = self.buffer.get_end_iter()
        content = text + ("\n" if newline else "")
        if tag:
            self.buffer.insert_with_tags_by_name(end, content, tag)
        else:
            self.buffer.insert(end, content)
        self._scroll_after_append(stick)

    def append_user(self, text, force_scroll=False, turn_id=None):
        """Append a user message as a vertically padded accented row."""

        self._append_user(text, force_scroll=force_scroll, turn_id=turn_id)

    def text_delta(self, content):
        """Render one assistant text delta, returning whether it was shown."""

        self._remove_stream_cursor()
        content = content or ""
        if is_heartbeat(content):
            return False
        self._close_thinking()
        if self._cur_seg is None:
            self._ensure_block_gap()
            mark = self.buffer.create_mark(None, self.buffer.get_end_iter(), True)
            self._cur_seg = {"start": mark, "end": None, "text": ""}
        self._cur_seg["text"] += content
        self._append(light_stream_filter(content), newline=False)
        self._append_stream_cursor()
        return True

    def thinking_delta(self, content, thinking_id=None, turn_id=None):
        """Render one thinking delta, returning whether it was shown."""

        content = content or ""
        if (
            self._in_thinking
            and thinking_id
            and self._current_thinking_id
            and thinking_id != self._current_thinking_id
        ):
            self._close_thinking()
        if not self._show_thinking:
            if not self._in_thinking:
                self._start_hidden_thinking(thinking_id, turn_id)
            self._current_hidden_thinking["text"] += content
            return False
        if not self._in_thinking:
            self._ensure_block_gap()
            start = self.buffer.create_mark(None, self.buffer.get_end_iter(), True)
            turn_key = turn_id or self._active_turn_key or self._next_turn_key()
            self._active_turn_key = turn_key
            self._thinking_blocks.append({
                "start": start,
                "end": None,
                "turn_key": turn_key,
                "thinking_id": thinking_id,
            })
            self._append(THINKING_VISIBLE_HEADER, "think-head")
            self._in_thinking = True
            self._current_thinking_id = thinking_id
        self._append(content, "thinking", newline=False)
        return True

    def thinking_done(self, thinking_id=None):
        if (
            thinking_id
            and self._current_thinking_id
            and thinking_id != self._current_thinking_id
        ):
            return
        self._close_thinking()

    def done(
        self,
        usage: Mapping[str, Any] | None = None,
        final_text: str | None = None,
        turn_id: str | None = None,
    ):
        """Finish a turn, repairing a missing final suffix before rendering.

        ``done.finalText`` is the gateway's authoritative prose snapshot.  Do
        not replace the whole live response with it: text segments may be
        interleaved with tool blocks.  When the live text is an exact prefix,
        however, appending the missing suffix is safe and recovers dropped
        trailing ``text_delta`` frames without reloading history.
        """

        streamed_text = "".join(
            segment.get("text", "") for segment in self._segments
        )
        if self._cur_seg is not None:
            streamed_text += self._cur_seg.get("text", "")

        same_turn = not (
            turn_id
            and self._active_turn_key
            and turn_id != self._active_turn_key
        )
        # A completed reply for the active turn must be visible. Prompt
        # submission already moves the conversation to its tail; preserve
        # that simple invariant through suffix repair and markdown relayout.
        stick = same_turn or self._at_bottom()
        if final_text and same_turn and final_text.startswith(streamed_text):
            missing_suffix = final_text[len(streamed_text):]
            if missing_suffix:
                logger.warning(
                    "Repairing incomplete GTK stream for turn %s: "
                    "received=%d final=%d",
                    turn_id or self._active_turn_key or "unknown",
                    len(streamed_text),
                    len(final_text),
                )
                self.text_delta(missing_suffix)
        elif final_text and same_turn and final_text != streamed_text:
            logger.warning(
                "GTK stream differs from done.finalText for turn %s; "
                "preserving live segment order (received=%d final=%d)",
                turn_id or self._active_turn_key or "unknown",
                len(streamed_text),
                len(final_text),
            )
        elif final_text and not same_turn:
            logger.warning(
                "Ignoring stale GTK done event for turn %s while turn %s is active",
                turn_id,
                self._active_turn_key,
            )

        self._remove_stream_cursor()
        self._close_thinking()
        self._close_segment()
        if self._segments:
            self._replace_segments_with_markdown(self._segments, stick=stick)
        self._segments = []

    # ------------------------------------------------------------------
    # Pending steering/follow-up rows (busy-time submissions)
    # ------------------------------------------------------------------

    def pending_update(self, steering: Iterable[Mapping[str, Any]], follow_up: Iterable[Mapping[str, Any]]):
        """Re-render the pending-queue rows from a gateway ``queue_update``.

        Entries carry ``id``, ``content``, and ``behavior`` ("steer" or
        "followUp").  Rows are kept as marked ranges so a consumed message
        can remove exactly its own indicator.
        """

        desired: dict[str, Mapping[str, Any]] = {}
        for entry in steering or []:
            pid = entry.get("id")
            if pid:
                desired[pid] = entry
        for entry in follow_up or []:
            pid = entry.get("id")
            if pid:
                desired[pid] = entry

        for pid in list(self._pending_rows):
            if pid not in desired:
                self._remove_pending_row(pid)

        for pid, entry in desired.items():
            if pid in self._pending_rows:
                continue
            behavior = entry.get("behavior") or "steer"
            prefix = "⏳ queued (follow-up)" if behavior == "followUp" else "⏳ queued (steer)"
            content = (entry.get("content") or "").replace("\n", " ").strip()
            if len(content) > 160:
                content = content[:160] + "…"
            stick = self._at_bottom()
            end = self.buffer.get_end_iter()
            start = self.buffer.create_mark(None, end, True)
            self.buffer.insert_with_tags_by_name(end, f"{prefix} — {content}\n", "system")
            end_mark = self.buffer.create_mark(None, self.buffer.get_end_iter(), True)
            self._pending_rows[pid] = {"start": start, "end": end_mark}
            self._scroll_after_append(stick)

    def pending_consume(self, pending_id: str | None):
        """Remove the pending indicator for a message Pi started consuming."""

        if pending_id and pending_id in self._pending_rows:
            self._remove_pending_row(pending_id)

    def _remove_pending_row(self, pid: str):
        row = self._pending_rows.pop(pid, None)
        if row is None:
            return
        stick = self._at_bottom()
        start = self.buffer.get_iter_at_mark(row["start"])
        end = self.buffer.get_iter_at_mark(row["end"])
        self.buffer.delete(start, end)
        self.buffer.delete_mark(row["start"])
        self.buffer.delete_mark(row["end"])
        self._scroll_after_relayout(stick)

    def tool_start(self, label_or_data):
        """Begin a collapsible tool-call block.

        ``label_or_data`` is the full ``tool_start`` payload (a mapping with
        ``toolCallId``/``toolName``/``args``/``label``); a plain label string
        is still accepted for compatibility with older callers.  Pi runs tool
        calls in parallel, so blocks are keyed by ``toolCallId`` and later
        outputs/ends are matched to their own block.
        """

        self._remove_stream_cursor()
        self._close_thinking()
        self._close_segment()
        call_id = None
        if isinstance(label_or_data, dict):
            call_id = label_or_data.get("toolCallId") or None
            parts = summarize_tool_parts(
                label_or_data.get("toolName") or "tool",
                label_or_data.get("args"),
                label_or_data.get("label"),
            )
        else:
            parts = summarize_tool_parts("tool", None, label_or_data)
        self._start_tool_block(parts, call_id=call_id)

    def tool_output(self, output):
        """Update a tool block's body with its latest output.

        ``output`` may be the full ``tool_output`` payload (matched to the
        block by ``toolCallId``) or a plain output string (attached to the
        active block).
        """

        block = None
        if isinstance(output, dict):
            block = self._lookup_tool_block(output)
            output = output.get("output") or ""
        else:
            block = self._cur_tool
        if block is None:
            # Orphan output (tool_start was missed): keep the legacy inline
            # rendering instead of dropping it silently.
            full_output = output or ""
            display = display_tool_output(full_output)
            if not display:
                return
            stick = self._at_bottom()
            at = self.buffer.get_end_iter()
            self.buffer.insert_with_tags_by_name(at, display, "tool-output")
            self._add_copy_button_line(full_output, at)
            self._scroll_after_append(stick)
            return
        block["body_text"] = output or ""
        if self._show_tools:
            self._render_tool_body(block)

    def tool_end(self, data=None):
        """Finish a tool block and apply its success/failure surface.

        ``data`` may be the full ``tool_end`` payload (matched to the block by
        ``toolCallId``) or omitted for the sequential active block.
        """

        block = self._lookup_tool_block(data) if data is not None else self._cur_tool
        if block is None:
            return
        block["done"] = True
        block["is_error"] = bool(
            data.get("isError", False) if isinstance(data, Mapping) else False
        )
        if block is self._cur_tool:
            self._cur_tool = None
        if self._show_tools:
            self._render_tool_body(block)
        else:
            self._apply_tool_status(block)

    def _lookup_tool_block(self, data: Mapping[str, Any]):
        """Resolve a tool event payload to its block by ``toolCallId``.

        Returns ``None`` when the id is unknown (the start event was missed)
        so callers fall back to legacy rendering instead of misattributing
        the payload to an unrelated block.
        """

        call_id = data.get("toolCallId")
        if call_id:
            return self._tool_blocks_by_id.get(call_id)
        return self._cur_tool

    def error(self, message):
        self._remove_stream_cursor()
        self._append("⚠ " + (message or "error"), "error")

    def load_history(self, messages: Iterable[Mapping[str, Any]]):
        """Render gateway history and schedule a post-layout bottom scroll."""

        for message in messages or []:
            content = content_text(message.get("content") or "")
            if is_heartbeat(content):
                continue
            role = message.get("role")
            if role == "user":
                self._append_user(content, force_scroll=True)
            elif role == "assistant":
                thinking = content_thinking(message.get("content") or "")
                if thinking:
                    self.thinking_delta(thinking, turn_id=self._active_turn_key)
                    self.thinking_done()
                if content:
                    self._ensure_block_gap()
                    self._render_markdown(content, force_scroll=True)
            elif role == "toolResult":
                parts = summarize_tool_parts(
                    message.get("toolName") or "tool",
                    message.get("args"),
                    message.get("label"),
                )
                self._start_history_tool_block(
                    parts,
                    content_text(message.get("content") or ""),
                    is_error=bool(message.get("isError", False)),
                    force_scroll=True,
                )

        if self.buffer.get_char_count() == 0:
            self._append("Fresh session — ask me anything.", "system", force_scroll=True)
            self._append("Try /status, /model, /session, /new", "system", force_scroll=True)

        GLib.idle_add(self._scroll_to_bottom)
        # Window activation commonly precedes the asynchronous history
        # response. Repaint after hydration as well, otherwise GTK's empty
        # pre-focus pixel cache can survive until a transcript click.
        GLib.idle_add(self.queue_full_redraw)

    def proactive(self, message):
        if not is_heartbeat(message):
            self._append("💬 " + message, "system")

    def handle_message(self, message_type: str, data: Mapping[str, Any] | None = None):
        """Route a gateway event that belongs to the transcript.

        Connection/model/state messages remain the window's responsibility;
        this method handles only transcript-producing events.  Unknown event
        types are ignored so the controller can be used directly as a router
        while the gateway protocol grows.
        """

        data = data or {}
        if message_type == "user_message":
            self.pending_consume(data.get("id"))
            if self._cur_seg is not None:
                # Defensive: the gateway closes the previous response segment
                # first (response_segment_done), but if that message was ever
                # lost, close here so the user row is never inside the range
                # later replaced by markdown finalization.
                self._close_segment()
            self.append_user(
                data.get("content") or "",
                force_scroll=True,
                turn_id=data.get("turnId"),
            )
        elif message_type == "text_delta":
            return self.text_delta(data.get("content") or "")
        elif message_type == "thinking_delta":
            return self.thinking_delta(
                data.get("content") or "",
                thinking_id=data.get("thinkingId"),
                turn_id=data.get("turnId"),
            )
        elif message_type == "thinking_done":
            self.thinking_done(data.get("thinkingId"))
        elif message_type == "done":
            self.done(
                data.get("usage"),
                final_text=data.get("finalText"),
                turn_id=data.get("turnId"),
            )
        elif message_type == "response_segment_done":
            # One logical response finished, but the run continues (a queued
            # steering/follow-up message follows). Finalize the transcript
            # segment exactly like `done` without ending the busy state.
            self.done(
                data.get("usage"),
                final_text=data.get("finalText"),
                turn_id=data.get("turnId"),
            )
        elif message_type == "queue_update":
            self.pending_update(
                data.get("steering") or [],
                data.get("followUp") or [],
            )
        elif message_type == "prompt_queued":
            # Acknowledgement for the submitting client; the queue_update
            # broadcast that follows carries the renderable queue state.
            pass
        elif message_type == "abort_complete":
            self._append("Prompt aborted", "abort-status", force_scroll=True)
        elif message_type == "tool_start":
            self.tool_start(data)
        elif message_type == "tool_output":
            self.tool_output(data)
        elif message_type == "tool_end":
            self.tool_end(data)
        elif message_type == "error":
            self.error(data.get("message") or "error")
        elif message_type == "history":
            self.load_history(data.get("messages") or [])
        elif message_type == "proactive":
            self.proactive(data.get("message") or "")

    # Verbose aliases are convenient for callers that prefer event names over
    # the short protocol verbs above.
    append_text_delta = text_delta
    append_thinking_delta = thinking_delta
    finish_thinking = thinking_done
    finish_turn = done
    append_tool_start = tool_start
    append_tool_output = tool_output
    append_tool_end = tool_end

    def clear(self):
        """Clear the local transcript and reset all controller state."""

        self._remove_stream_cursor()
        for button in self._copy_buttons:
            button.destroy()
        self._copy_buttons = []
        self.buffer.set_text("")
        self._in_thinking = False
        self._segments = []
        self._cur_seg = None
        self._thinking_blocks = []
        self._hidden_thinking = []
        self._turn_serial = 0
        self._active_turn_key = None
        self._current_thinking_id = None
        self._current_hidden_thinking = None
        self._show_tools = True
        self._tool_blocks = []
        self._tool_blocks_by_id = {}
        self._cur_tool = None
        self._pending_rows = {}

    def toggle_thinking(self):
        """Hide/show thinking blocks, tracking them across the toggle.

        Hidden blocks are replaced in place by a muted placeholder line so
        the transcript keeps an obvious, minimal trace of what was collapsed.

        Deletion safety: GTK drags any mark sitting on a deleted range's end
        boundary to the deletion start (thinking blocks are adjacent, so
        every block's marks share boundary positions with its neighbours).
        This routine therefore deletes back-to-front, tracks each placeholder
        with an interior anchor (never on a boundary), and re-anchors any
        tracked marks that were sitting on a deleted end boundary.
        """

        stick = self._at_bottom()
        self._close_thinking()
        self._show_thinking = not self._show_thinking
        if not self._show_thinking:
            hidden = []
            for block in self._thinking_blocks:
                start = self.buffer.get_iter_at_mark(block["start"])
                end = self.buffer.get_iter_at_mark(block["end"])
                hidden.append({
                    "start": start.get_offset(),
                    "end": end.get_offset(),
                    "text": self.buffer.get_text(start, end, True),
                    "turn_key": block.get("turn_key"),
                    "thinking_id": block.get("thinking_id"),
                })
            # Replace each block from the end so captured offsets remain valid
            # and no surviving mark sits on a deletion's end boundary.
            for item in sorted(hidden, key=lambda h: h["start"], reverse=True):
                start_off = item["start"]
                end_off = item["end"]
                at_risk = [
                    m for m in self._tracked_marks()
                    if self.buffer.get_iter_at_mark(m).get_offset() == end_off
                ]
                self.buffer.delete(
                    self.buffer.get_iter_at_offset(start_off),
                    self.buffer.get_iter_at_offset(end_off),
                )
                replacement = THINKING_HIDDEN_PLACEHOLDER + "\n"
                self.buffer.insert_with_tags_by_name(
                    self.buffer.get_iter_at_offset(start_off),
                    replacement,
                    "think-hidden",
                )
                # The insertion point is immediately after the thin spacer
                # paragraph. GTK inherits that tag across inserted text even
                # when insert_with_tags_by_name() supplies think-hidden; its
                # one-point font is what made collapsed/restored thinking
                # appear as hairlines in the real transcript.
                self.buffer.remove_tag_by_name(
                    "block-gap",
                    self.buffer.get_iter_at_offset(start_off),
                    self.buffer.get_iter_at_offset(start_off + len(replacement)),
                )
                anchor = self.buffer.create_mark(
                    None, self.buffer.get_iter_at_offset(start_off + 1), True
                )
                # Marks that sat on the deleted range's end boundary were
                # dragged to the deletion start; put them back just past the
                # placeholder.
                for mark in at_risk:
                    self.buffer.move_mark(
                        mark,
                        self.buffer.get_iter_at_offset(
                            start_off + len(replacement)
                        ),
                    )
                self._hidden_thinking.append({
                    "anchor": anchor,
                    "text": item["text"],
                    "replacement_len": len(replacement),
                    "turn_key": item["turn_key"],
                    "thinking_id": item["thinking_id"],
                })
            for block in self._thinking_blocks:
                self.buffer.delete_mark(block["start"])
                self.buffer.delete_mark(block["end"])
            self._thinking_blocks = []
            self._set_status("▸ Thinking hidden — Ctrl+T to show")
        else:
            # Restore in buffer order (anchors are read before any mutation).
            for item in sorted(
                self._hidden_thinking,
                key=lambda h: self.buffer.get_iter_at_mark(h["anchor"]).get_offset(),
            ):
                anchor = item["anchor"]
                start_off = self.buffer.get_iter_at_mark(anchor).get_offset() - 1
                end_off = start_off + item["replacement_len"]
                at_risk = [
                    m for m in self._tracked_marks()
                    if self.buffer.get_iter_at_mark(m).get_offset() == end_off
                ]
                self.buffer.delete(
                    self.buffer.get_iter_at_offset(start_off),
                    self.buffer.get_iter_at_offset(end_off),
                )
                at = self.buffer.get_iter_at_offset(start_off)
                # Right-gravity probe rides along to just past the inserted
                # text, giving us the restored block's end position.
                probe = self.buffer.create_mark(None, at, False)
                self._insert_thinking_block(at, item["text"])
                new_end = self.buffer.get_iter_at_mark(probe).get_offset()
                self.buffer.remove_tag_by_name(
                    "block-gap",
                    self.buffer.get_iter_at_offset(start_off),
                    self.buffer.get_iter_at_offset(new_end),
                )
                # Re-anchor any marks that followed this block to just past
                # the restored text.
                for mark in at_risk:
                    self.buffer.move_mark(
                        mark, self.buffer.get_iter_at_offset(new_end)
                    )
                # Re-register the restored block with fresh marks so a later
                # toggle can hide it again.
                self._thinking_blocks.append({
                    "start": self.buffer.create_mark(
                        None, self.buffer.get_iter_at_offset(start_off), True
                    ),
                    "end": self.buffer.create_mark(
                        None, self.buffer.get_iter_at_offset(new_end), True
                    ),
                    "turn_key": item["turn_key"],
                    "thinking_id": item["thinking_id"],
                })
                self.buffer.delete_mark(anchor)
                self.buffer.delete_mark(probe)
            self._hidden_thinking = []
            self._set_status("▾ Thinking shown — Ctrl+T to hide")
        self._scroll_after_relayout(stick)

    def toggle_tools(self):
        """Collapse/expand all tool-call blocks (Ctrl+O).

        Collapsed blocks keep only their summary header (``▸ ⚙ bash  ls -la``);
        expanding restores the stored output bodies and copy buttons.
        """

        stick = self._at_bottom()
        self._show_tools = not self._show_tools
        for block in list(self._tool_blocks):
            self._update_tool_header_arrow(block)
            if self._show_tools:
                self._render_tool_body(block, stick=stick)
            else:
                self._hide_tool_body(block)
        if self._show_tools:
            self._set_status("▾ tool calls shown — Ctrl+O to collapse")
        else:
            self._set_status("▸ tool calls collapsed — Ctrl+O to expand")
        # Keep the viewport pinned to the bottom when it was pinned before
        # the toggle (expanding pushes content down, collapsing removes it).
        self._scroll_after_relayout(stick)

    def _insert_tool_header(self, end, parts):
        """Insert a themed tool header at ``end`` and advance the iterator.

        The header reads ``▾ ⚙ bash  ls -la`` — dim glyphs, amber bold tool
        name, cooler grey argument summary — so the tool identity pops while
        the payload stays readable.  Inserting in runs with one advancing
        iterator keeps the pieces in order.
        """

        header_start = end.get_offset()
        arrow = "▾" if self._show_tools else "▸"
        name, rest = parts
        self.buffer.insert_with_tags_by_name(end, f"{arrow} ⚙ ", "tool")
        self.buffer.insert_with_tags_by_name(end, name, "tool-name")
        if rest:
            self.buffer.insert_with_tags_by_name(end, "  " + rest, "tool-args")
        self.buffer.insert_with_tags_by_name(end, "\n", "tool")
        self.buffer.apply_tag_by_name(
            "tool-header",
            self.buffer.get_iter_at_offset(header_start),
            self.buffer.get_iter_at_offset(end.get_offset()),
        )

    def _start_tool_block(self, parts, call_id=None):
        """Insert a new tool-call header and open a body region for it.

        ``parts`` is the ``(tool_name, argument_summary)`` pair from
        :func:`summarize_tool_parts`.  Every block is registered in
        ``_tool_blocks`` immediately (so collapsing covers in-flight parallel
        calls) and, when the gateway supplied a ``toolCallId``, in
        ``_tool_blocks_by_id`` so subsequent outputs/ends land under their
        own header.
        """

        stick = self._at_bottom()
        self._ensure_block_gap()
        end = self.buffer.get_end_iter()
        start = self.buffer.create_mark(None, end, True)  # left gravity
        self._insert_tool_header(end, parts)
        # Anchor the start mark just AFTER the arrow character.  A mark placed
        # exactly at the header start would coincide with the preceding
        # segment's end mark and get dragged to the segment start when that
        # range is later deleted (GTK moves end-boundary marks to the
        # deletion start).  One char into the header it stays put.
        at = self.buffer.get_iter_at_mark(start)
        at.forward_char()
        self.buffer.move_mark(start, at)
        body_start = self.buffer.create_mark(
            None, self.buffer.get_end_iter(), True
        )
        # LEFT gravity pins the end mark at the block boundary when later
        # content is appended at the buffer end; _render_tool_body() moves it
        # to the true body end on every render.
        end_mark = self.buffer.create_mark(
            None, self.buffer.get_end_iter(), True
        )
        self._cur_tool = {
            "start": start,
            "body_start": body_start,
            "end": end_mark,
            "body_text": "",
            "buttons": [],
            "done": False,
            "is_error": False,
        }
        self._tool_blocks.append(self._cur_tool)
        if call_id:
            self._tool_blocks_by_id[call_id] = self._cur_tool
        self._scroll_after_append(stick)
        return self._cur_tool

    def _start_history_tool_block(
        self, parts, body, *, is_error=False, force_scroll=False
    ):
        """Render a completed tool result from history as a collapsible block."""

        stick = force_scroll or self._at_bottom()
        self._ensure_block_gap()
        end = self.buffer.get_end_iter()
        start = self.buffer.create_mark(None, end, True)
        self._insert_tool_header(end, parts)
        at = self.buffer.get_iter_at_mark(start)
        at.forward_char()
        self.buffer.move_mark(start, at)
        body_start = self.buffer.create_mark(
            None, self.buffer.get_end_iter(), True
        )
        end_mark = self.buffer.create_mark(
            None, self.buffer.get_end_iter(), True
        )
        block = {
            "start": start,
            "body_start": body_start,
            "end": end_mark,
            "body_text": body or "",
            "buttons": [],
            "done": True,
            "is_error": is_error,
        }
        self._tool_blocks.append(block)
        if self._show_tools:
            self._render_tool_body(block, stick=stick)
        else:
            self._apply_tool_status(block)
        self._scroll_after_append(stick)

    def _render_tool_body(self, block, stick=None):
        """Replace a block's body region with its stored output."""

        if stick is None:
            stick = self._at_bottom()
        display = display_tool_output(block["body_text"])
        done = block["done"]
        bs = self.buffer.get_iter_at_mark(block["body_start"])
        end = self.buffer.get_iter_at_mark(block["end"])
        if bs.compare(end) < 0:
            self.buffer.delete(bs, end)
        for button in block["buttons"]:
            self._destroy_button(button)
        block["buttons"] = []
        if not display and not done:
            return
        # Insert through a single advancing iterator so successive pieces
        # keep their order (the body_start mark itself never moves), then
        # move the end mark to the true body end.
        at = self.buffer.get_iter_at_mark(block["body_start"])
        if display:
            self.buffer.insert_with_tags_by_name(at, display, "tool-output")
            button, at = self._add_copy_button_line(block["body_text"], at)
            block["buttons"].append(button)
        self.buffer.move_mark(block["end"], at)
        if done:
            self._apply_tool_status(block)
        self._scroll_after_append(stick)

    def _apply_tool_status(self, block):
        """Tint a completed tool block without adding another text row."""

        start = self.buffer.get_iter_at_mark(block["start"])
        if start.backward_char():
            end = self.buffer.get_iter_at_mark(block["end"])
            tag = "tool-error" if block.get("is_error") else "tool-success"
            self.buffer.apply_tag_by_name(tag, start, end)

    def _hide_tool_body(self, block):
        """Remove a block's body region, keeping its summary header."""

        bs = self.buffer.get_iter_at_mark(block["body_start"])
        end = self.buffer.get_iter_at_mark(block["end"])
        if bs.compare(end) < 0:
            self.buffer.delete(bs, end)
        for button in block["buttons"]:
            self._destroy_button(button)
        block["buttons"] = []
        # Body deletion and arrow replacement both split GTK tag ranges. Do
        # not rely on the old success/error range surviving those edits:
        # explicitly tint the remaining header in its collapsed state.
        if block.get("done"):
            self._apply_tool_status(block)

    def _update_tool_header_arrow(self, block):
        """Swap the ▸/▾ arrow that precedes a block's start mark."""

        start = self.buffer.get_iter_at_mark(block["start"])
        arrow_pos = start.copy()
        if not arrow_pos.backward_char():
            return
        self.buffer.delete(arrow_pos, start)
        arrow = "▾" if self._show_tools else "▸"
        # Reapply the paragraph tag as well as the glyph tag. Without it the
        # replacement arrow sits outside the inset tool surface, and applying
        # a success/error tint produces a small coloured protrusion.
        self.buffer.insert_with_tags_by_name(
            arrow_pos, arrow, "tool", "tool-header"
        )
        # The delete above dragged the start mark onto the arrow position;
        # re-anchor it just after the new arrow.
        self.buffer.move_mark(block["start"], arrow_pos)

    def _destroy_button(self, button):
        if button in self._copy_buttons:
            self._copy_buttons.remove(button)
        button.destroy()

    # ------------------------------------------------------------------
    # Buffer helpers (kept together because mark gravity is behavior-critical)
    # ------------------------------------------------------------------

    def _at_bottom(self):
        adjustment = self.view.get_vadjustment()
        return (
            adjustment.get_upper()
            - adjustment.get_page_size()
            - adjustment.get_value()
        ) < 4

    def _tracked_marks(self):
        """Every live mark the controller owns, for re-anchoring after deletes.

        Deleting a range drags marks sitting on its end boundary to the
        deletion start; these are the marks that could ever sit on such a
        boundary, so they are checked and re-anchored by toggle_thinking().
        """

        marks = [self._bottom_mark]
        if self._cursor_mark is not None:
            marks.append(self._cursor_mark)
        if self._cur_seg is not None:
            marks.append(self._cur_seg["start"])
            if self._cur_seg["end"] is not None:
                marks.append(self._cur_seg["end"])
        for seg in self._segments:
            marks.append(seg["start"])
            if seg["end"] is not None:
                marks.append(seg["end"])
        if self._cur_tool is not None:
            marks.extend((
                self._cur_tool["start"],
                self._cur_tool["body_start"],
                self._cur_tool["end"],
            ))
        for blk in self._tool_blocks:
            marks.extend((blk["start"], blk["body_start"], blk["end"]))
        for blk in self._thinking_blocks:
            # Freshly restored blocks' start marks sit exactly on the next
            # placeholder's end boundary, so they can be dragged too.
            marks.extend((blk["start"], blk["end"]))
        for row in self._pending_rows.values():
            marks.extend((row["start"], row["end"]))
        return marks

    def _scroll_after_append(self, stick):
        self._scroll_after_relayout(stick)

    def _scroll_after_relayout(self, stick):
        """Keep a bottom-pinned viewport pinned across deferred GTK layout.

        Inserting text before the visible end invalidates GtkTextView's layout,
        but the vertical adjustment still has its old ``upper`` value until a
        later layout pass.  Temporarily constrain every adjustment change to
        its bottom value so each new range is pinned before GTK paints it.  The
        low-priority idle only disconnects that constraint; it does not scroll.
        """

        if not stick:
            self._cancel_relayout_bottom_pin()
            return
        self._cancel_relayout_bottom_pin()
        adjustment = self.view.get_vadjustment()
        self._relayout_pin_adjustment = adjustment
        self._relayout_pin_handler = adjustment.connect(
            "changed",
            self._on_relayout_adjustment_changed,
        )
        self._relayout_pin_release_source = GLib.idle_add(
            self._release_relayout_bottom_pin,
            priority=GLib.PRIORITY_LOW,
        )

    def _on_relayout_adjustment_changed(self, adjustment):
        if adjustment is self._relayout_pin_adjustment:
            adjustment.set_value(
                adjustment.get_upper() - adjustment.get_page_size()
            )

    def _disconnect_relayout_bottom_pin(self):
        if (
            self._relayout_pin_adjustment is not None
            and self._relayout_pin_handler is not None
        ):
            self._relayout_pin_adjustment.disconnect(self._relayout_pin_handler)
        self._relayout_pin_adjustment = None
        self._relayout_pin_handler = None

    def _release_relayout_bottom_pin(self):
        self._relayout_pin_release_source = None
        # One final correction after GTK's deferred layout. Some multi-block
        # edits coalesce their adjustment notifications before the new upper
        # bound is final, so relying only on the changed signal can leave the
        # viewport at the old bottom.
        adjustment = self._relayout_pin_adjustment
        if adjustment is not None:
            adjustment.set_value(
                adjustment.get_upper() - adjustment.get_page_size()
            )
        self._disconnect_relayout_bottom_pin()
        return False

    def _cancel_relayout_bottom_pin(self):
        if self._relayout_pin_release_source is not None:
            GLib.source_remove(self._relayout_pin_release_source)
            self._relayout_pin_release_source = None
        self._disconnect_relayout_bottom_pin()

    def _append(self, text, tag=None, newline=True, force_scroll=False):
        self.append(text, tag=tag, newline=newline, force_scroll=force_scroll)

    def _next_turn_key(self):
        self._turn_serial += 1
        return f"gtk-turn-{self._turn_serial}"

    def _append_user(self, text, force_scroll=False, turn_id=None):
        stick = force_scroll or self._at_bottom()
        self._active_turn_key = turn_id or self._next_turn_key()
        self._ensure_block_gap()
        end = self.buffer.get_end_iter()
        # Consecutive user-tagged ranges otherwise coalesce into one GTK tag
        # span, making a consumed steering prompt look like part of the root
        # prompt's visual block. An untagged spacer keeps the rows distinct.
        previous = end.copy()
        user_tag = self.buffer.get_tag_table().lookup("user")
        if (
            user_tag is not None
            and previous.backward_char()
            and previous.has_tag(user_tag)
        ):
            self.buffer.insert(end, "\n")
        self.buffer.insert_with_tags_by_name(end, text + "\n", "user")
        self._scroll_after_append(stick)

    def _ensure_block_gap(self):
        """Insert one thin base-colour row before the next transcript surface."""

        if self.buffer.get_char_count() == 0:
            return
        end = self.buffer.get_end_iter()
        previous = end.copy()
        gap_tag = self.buffer.get_tag_table().lookup("block-gap")
        if previous.backward_char() and previous.has_tag(gap_tag):
            return
        self.buffer.insert_with_tags_by_name(end, "\n", "block-gap")

    def draw_user_accents(self, cr):
        """Paint the full-height accent bar for user rows."""

        paint_user_accents(self.view, self.buffer, cr)

    def _draw_user_accents(self, cr):
        """Compatibility name for callers that used the old window helper."""

        self.draw_user_accents(cr)

    def render_markdown(self, text, at=None, force_scroll=False):
        """Render markdown at an optional buffer iterator."""

        self._render_markdown(text, at=at, force_scroll=force_scroll)

    def _render_markdown(self, text, at=None, force_scroll=False):
        stick = force_scroll or self._at_bottom()
        self._markdown_renderer.render(text, at=at)
        if at is None:
            self._scroll_after_append(stick)

    def _scroll_end(self):
        # Let GtkTextView resolve ordinary end-appends during its layout.  A
        # structural edit that inserts content above the end also needs the
        # post-layout adjustment correction in _scroll_after_relayout().
        self.view.scroll_to_mark(self._bottom_mark, 0.0, True, 0.0, 1.0)

    def scroll_to_bottom(self):
        return self._scroll_to_bottom()

    def _scroll_to_bottom(self):
        adj = self.view.get_vadjustment()
        adj.set_value(adj.get_upper() - adj.get_page_size())
        return False

    def _sync_code_head_tab(self):
        self._markdown_renderer.sync_code_head_tab()

    def _on_view_size_allocate(self, _widget, alloc):
        self._markdown_renderer.on_view_size_allocate(alloc)

    # ------------------------------------------------------------------
    # Cursor/copy widgets and mark-sensitive segment replacement
    # ------------------------------------------------------------------

    def _cursor_tick(self):
        if self._cursor_mark is not None and self._cursor_tag is not None:
            self._cursor_visible = not self._cursor_visible
            self._cursor_tag.set_property("invisible", not self._cursor_visible)
        return GLib.SOURCE_CONTINUE

    def _append_stream_cursor(self):
        if self._cursor_mark is not None:
            return
        stick = self._at_bottom()
        end = self.buffer.get_end_iter()
        self.buffer.insert_with_tags_by_name(end, STREAM_CURSOR_CHAR, "stream-cursor")
        self._cursor_mark = self.buffer.create_mark(None, end, True)
        self._scroll_after_append(stick)

    def _remove_stream_cursor(self):
        if self._cursor_mark is None:
            return
        mark_iter = self.buffer.get_iter_at_mark(self._cursor_mark)
        cursor_start = mark_iter.copy()
        if cursor_start.backward_char():
            cursor_text = self.buffer.get_text(cursor_start, mark_iter, True)
            if cursor_text == STREAM_CURSOR_CHAR:
                self.buffer.delete(cursor_start, mark_iter)
        self.buffer.delete_mark(self._cursor_mark)
        self._cursor_mark = None
        self._cursor_visible = True
        if self._cursor_tag is not None:
            self._cursor_tag.set_property("invisible", False)

    def _make_copy_button(self, text):
        button = Gtk.Button.new_from_icon_name("edit-copy-symbolic", Gtk.IconSize.MENU)
        button.set_relief(Gtk.ReliefStyle.NONE)
        button.set_name("copy-button")
        button.set_can_focus(False)
        button.set_tooltip_text("Copy")
        button.connect("realize", self._set_pointer_cursor)
        button.connect("clicked", lambda _button, value=text: self._copy_text(value))
        return button

    @staticmethod
    def _set_pointer_cursor(widget):
        window = widget.get_window()
        if window is not None:
            window.set_cursor(Gdk.Cursor.new_for_display(
                window.get_display(), Gdk.CursorType.LEFT_PTR
            ))

    def _copy_text(self, text):
        owner = self.parent or self.view
        clipboard = owner.get_clipboard(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        self._set_status("⧉ copied")

    def _add_copy_button(self, text, at=None):
        position = at if at is not None else self.buffer.get_end_iter()
        anchor = self.buffer.create_child_anchor(position)
        button = self._make_copy_button(text)
        button.show()
        self.view.add_child_at_anchor(button, anchor)
        self._copy_buttons.append(button)
        return button

    def _add_copy_button_line(self, text, at):
        """Place a copy control on its own right-aligned row after content."""

        self.buffer.insert(at, "\n")
        anchor_offset = at.get_offset()
        button = self._add_copy_button(text, at=at)
        row_start = self.buffer.get_iter_at_offset(anchor_offset)
        row_end = self.buffer.get_iter_at_offset(anchor_offset + 1)
        self.buffer.apply_tag_by_name("tool-output", row_start, row_end)
        self.buffer.apply_tag_by_name("copy-row", row_start, row_end)
        self.buffer.insert(row_end, "\n")
        return button, self.buffer.get_iter_at_offset(anchor_offset + 2)

    def _start_hidden_thinking(self, thinking_id=None, turn_id=None):
        """Retain a newly streamed thinking fragment while display is hidden."""

        stick = self._at_bottom()
        self._ensure_block_gap()
        turn_key = turn_id or self._active_turn_key or self._next_turn_key()
        self._active_turn_key = turn_key
        replacement = THINKING_HIDDEN_PLACEHOLDER + "\n"
        start_off = self.buffer.get_char_count()
        self.buffer.insert_with_tags_by_name(
            self.buffer.get_end_iter(), replacement, "think-hidden"
        )
        self.buffer.remove_tag_by_name(
            "block-gap",
            self.buffer.get_iter_at_offset(start_off),
            self.buffer.get_iter_at_offset(start_off + len(replacement)),
        )
        item = {
            "anchor": self.buffer.create_mark(
                None, self.buffer.get_iter_at_offset(start_off + 1), True
            ),
            "text": THINKING_VISIBLE_HEADER + "\n",
            "replacement_len": len(replacement),
            "turn_key": turn_key,
            "thinking_id": thinking_id,
        }
        self._hidden_thinking.append(item)
        self._current_hidden_thinking = item
        self._current_thinking_id = thinking_id
        self._in_thinking = True
        self._scroll_after_append(stick)

    def _close_thinking(self):
        if self._in_thinking:
            if self._current_hidden_thinking is not None:
                self._current_hidden_thinking["text"] += "\n"
                self._current_hidden_thinking = None
                self._current_thinking_id = None
                self._in_thinking = False
                return
            self._append("", newline=True)
            # Preserve left-gravity behavior from the original implementation:
            # the end mark remains at the block boundary as later text arrives.
            self._thinking_blocks[-1]["end"] = self.buffer.create_mark(
                None, self.buffer.get_end_iter(), True
            )
            self._in_thinking = False
            self._current_thinking_id = None

    def _insert_thinking_block(self, at, text):
        head, sep, body = text.partition("\n")
        self.buffer.insert_with_tags_by_name(at, head + "\n", "think-head")
        if sep and body:
            body = body.rstrip("\n")
            if body:
                self.buffer.insert_with_tags_by_name(at, body, "thinking")
        self.buffer.insert(at, "\n")

    def _close_segment(self):
        """Close a stream segment with a LEFT-gravity end mark."""

        if self._cur_seg is not None:
            if not self._cur_seg["text"].endswith("\n"):
                self._append("", newline=True)
            self._cur_seg["end"] = self.buffer.create_mark(
                None, self.buffer.get_end_iter(), True
            )
            self._segments.append(self._cur_seg)
            self._cur_seg = None

    def _replace_segments_with_markdown(self, segments, stick=False):
        for segment in reversed(segments):
            start = self.buffer.get_iter_at_mark(segment["start"])
            end = self.buffer.get_iter_at_mark(segment["end"])
            self.buffer.delete(start, end)
        for segment in segments:
            start = self.buffer.get_iter_at_mark(segment["start"])
            self._render_markdown(segment["text"], at=start)
            self.buffer.delete_mark(segment["start"])
            self.buffer.delete_mark(segment["end"])
        self._scroll_after_relayout(stick)


# Short alias for callers that prefer a view-oriented name.
Transcript = TranscriptController
