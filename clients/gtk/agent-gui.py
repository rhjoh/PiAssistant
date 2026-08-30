#!/usr/bin/env python3
"""Agent GUI — GTK3 front-end for the Pi assistant gateway.

Launched by the Apple Magic Keyboard lock key. keyd remaps the native
XF86ScreenSaver (lock) key to Ctrl+Alt+K; labwc rc.xml binds C-A-k to
an If/ForEach run-or-raise rule. toggle.sh is its launch fallback.

Lock-key behavior: focused -> minimize; otherwise (open but unfocused, or
minimized, on any workspace) -> brought onto the current workspace and
focused. Ctrl+T inside the app toggles thinking blocks; Ctrl+O collapses
or expands tool-call blocks (which keep their amber tool-name summary
line while collapsed).

Minimizing uses iconify and restoring is handled by labwc without unmapping
the Wayland surface. The compositor therefore keeps the exact position and
size while moving the window onto the current workspace. Normal size and
maximize state are also saved for full process restarts.

Wayland notes (copied from key-test-window.py):
  - GLib.set_prgname() sets a deterministic app_id so the labwc windowRule
    (identifier="agent-gui", AutoPlace policy=center) matches reliably.
  - The compositor owns placement; client-side move()/position hints are ignored.

Talks to the gateway over the standard WebSocket API (ws://127.0.0.1:3456/):
  client -> gateway: prompt (with streamingBehavior when busy), get_history,
                     get_state, extension_ui_response, abort, command
  gateway -> client: connection, user_message, text_delta, thinking_delta,
                     thinking_done, tool_start, tool_output, tool_end, done,
                     response_segment_done, queue_update, prompt_accepted,
                     prompt_queued, abort_complete, error, notify,
                     extension_error, extension_ui_request,
                     extension_ui_resolved, state, proactive, history

While the assistant is processing, Enter steers the active run and Alt+Enter
queues a follow-up; Esc-Esc aborts (first Esc arms the confirmation, a
second Esc within the window sends the abort). Busy-time submissions render
as compact pending rows (from queue_update) until Pi consumes them, at which
point the gateway broadcasts them as normal user messages.

Assistant turns are rendered as markdown (via the `markdown` lib + a small
HTML->TextBuffer renderer) once the turn completes; thinking blocks are shown
as purple-accented, shaded italic blocks (dim grey text so reasoning reads as
secondary to the whitish prose). Heartbeat traffic is filtered the same way
the web UI filters it ([Heartbeat]/[[NO_ACTION]] markers).
"""

import logging
from logging.handlers import RotatingFileHandler
import os
import uuid

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import GLib, Gdk, Gtk, Pango

from abort_confirm import AbortConfirm
from commands import COMMANDS, matching_commands, parse_command
from config import (
    APP_ID,
    BG_COLOR,
    GATEWAY_URI,
    GTK_LOG_PATH,
    INPUT_BG_COLOR,
    SELECTION_BG_COLOR,
    STATUS_ERR_COLOR,
    TEXT_COLOR,
    THINKING_HEAD_COLOR,
    transcript_font_css,
    apply_transcript_font,
)
from protocol import is_pending_duplicate, model_name, prompt_payload, session_id
from extension_ui import (
    dialog_options,
    dialog_title,
    extension_ui_response,
    is_dialog_method,
    response_for_option,
    working_text,
)
from model_picker import matching_models
from instance_lock import InstanceLock
from status_view import ConnectionStatus
from gateway_client import GatewayClient
from transcript import TranscriptController
from window_state import WindowState, WindowStateStore


logger = logging.getLogger(__name__)
KNOWN_THINKING_LEVELS = (
    "off", "minimal", "low", "medium", "high", "xhigh", "max")


def _configure_logging():
    """Write bounded client lifecycle/protocol diagnostics to a stable file."""

    path = os.path.expanduser(GTK_LOG_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handler = RotatingFileHandler(
        path, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter(
        "%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    ))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    logger.info("GTK client logging started path=%s", path)


def _install_style():
    """Apply the client palette: dark surfaces with whitish text.

    GTK themes style the inner ``textview text`` node separately from the
    widget.  The selectors below pin colour, background, and the transcript
    font on that node so Inter and ligature substitutions cannot leak in.
    Opacity is not set on text views: it forces an offscreen flatten that
    stipples glyphs into a dotted gutter.  Thinking blocks are dimmed via
    TextTags (see TranscriptController).
    """
    font = transcript_font_css()
    css = f"""
        label,
        label:backdrop,
        button,
        button:backdrop,
        list,
        list:backdrop,
        list row,
        list row:backdrop {{
            color: {TEXT_COLOR};
            opacity: 1;
        }}
        textview,
        textview:backdrop,
        textview text,
        textview text:backdrop,
        entry,
        entry:backdrop,
        entry text,
        entry text:backdrop {{
            color: {TEXT_COLOR};
        }}
        window,
        window:backdrop {{
            background-color: {BG_COLOR};
        }}
        textview,
        textview:backdrop,
        textview text,
        textview text:backdrop,
        entry,
        entry:backdrop,
        entry text,
        entry text:backdrop,
        #prompt-placeholder,
        #prompt-placeholder:backdrop {{
            {font}
        }}
        textview,
        textview:backdrop,
        textview text,
        textview text:backdrop,
        entry,
        entry:backdrop,
        entry text,
        entry text:backdrop {{
            background-color: {BG_COLOR};
            background: {BG_COLOR};
            caret-color: {TEXT_COLOR};
        }}
        list,
        list:backdrop,
        list row,
        list row:backdrop {{
            background: transparent;
        }}
        list row:selected,
        list row:selected:focus {{
            color: {TEXT_COLOR};
            background: {SELECTION_BG_COLOR};
        }}
        textview selection,
        textview selection:backdrop,
        entry selection,
        entry selection:backdrop {{
            color: {TEXT_COLOR};
            background-color: {SELECTION_BG_COLOR};
        }}
        /* The prompt input is a TextView named "prompt-entry".  The ID
        selectors out-rank the generic textview rules above, giving the
        composer a slightly lighter surface so it reads as a distinct
        input field against the transcript background. */
        #prompt-entry,
        #prompt-entry:backdrop,
        #prompt-entry text,
        #prompt-entry text:backdrop {{
            background-color: {INPUT_BG_COLOR};
            background: {INPUT_BG_COLOR};
        }}
        #working-banner {{
            color: {THINKING_HEAD_COLOR};
            padding: 4px 2px;
        }}
        #extension-ui {{
            background-color: {INPUT_BG_COLOR};
            padding: 8px;
        }}
        #extension-ui-title {{
            color: {TEXT_COLOR};
            font-weight: bold;
        }}
        #extension-ui-cancel {{
            color: {STATUS_ERR_COLOR};
        }}
        #copy-button {{
            min-height: 0;
            min-width: 0;
            padding: 0 4px;
            border: none;
            background: transparent;
        }}
        .monospace {{
            {font}
        }}
    """
    provider = Gtk.CssProvider()
    try:
        provider.load_from_data(css.encode())
    except GLib.Error as exc:
        logger.error("GTK CSS failed to load: %s", exc)
        return
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER)

GLib.set_prgname(APP_ID)


# ---------------------------------------------------------------------------
# The window
# ---------------------------------------------------------------------------

class AgentGui(Gtk.Window):
    def __init__(self):
        super().__init__(title="Agent")
        self.window_state_store = WindowStateStore()
        saved_window_state = self.window_state_store.load()
        self._normal_size = (
            saved_window_state.width,
            saved_window_state.height,
        )
        self._window_maximized = saved_window_state.maximized
        self.set_default_size(*self._normal_size)
        self.set_border_width(10)

        _install_style()
        # Gateway processing state drives input behavior (Enter steers while
        # the assistant is busy) and the placeholder hint.
        self._processing = False
        self._pending_submission = None
        self._available_models = []
        self._current_model = None
        self._model_dialog = None
        self._model_matches = []
        self._model_selected = 0
        self._model_loading = False
        self._available_thinking_levels = []
        self._current_thinking_level = None
        self._thinking_dialog = None
        self._thinking_selected = 0
        self._thinking_loading = False
        # Esc-Esc abort confirmation. on_disarm fires only on timeout expiry
        # (never on explicit disarm), restoring the connected status line.
        self._abort_confirm = AbortConfirm(
            glib=GLib, on_disarm=self._clear_abort_hint)
        self._session_id = None
        self._extension_ui_request = None
        self._extension_option_index = 0
        self._extension_ui_list = None
        self._extension_ui_input = None
        self._build_ui()
        self.connection_status = ConnectionStatus(self.status)
        self.connect("configure-event", self._on_window_configure)
        self.connect("window-state-event", self._on_window_state)
        self.connect("notify::is-active", self._on_window_active_changed)
        self.connect("destroy", self._on_destroy)

        # The PID file makes toggle.sh a single-instance launch fallback. Live
        # toggling is owned by labwc so the Wayland surface is never remapped.
        pidfile = os.path.join(
            os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "agent-gui.pid")
        self.instance_lock = InstanceLock(pidfile)
        self.instance_lock.acquire()

        # In-app hotkey: Ctrl+T toggles the thinking blocks (show/hide).
        # Local to this app only — no compositor/global shortcut.
        self.connect("key-press-event", self._on_key_press)

        self.gateway = GatewayClient(
            GATEWAY_URI,
            dispatch=lambda callback: GLib.idle_add(callback),
            on_connected=self._on_ws_connected,
            on_disconnected=self._on_ws_disconnected,
            on_message=self._on_message,
            on_error=self._on_ws_error,
            reconnect=True,
        )
        self.gateway.start()

        if saved_window_state.maximized:
            self.maximize()

    # ── UI ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.add(vbox)

        sw = Gtk.ScrolledWindow()
        # Text wraps (WORD_CHAR), so no horizontal overflow — never show the
        # horizontal scrollbar; keep vertical automatic.
        sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sw.set_vexpand(True)
        vbox.pack_start(sw, True, True, 0)

        self.transcript = TranscriptController(
            self,
            on_status=lambda text: self.connection_status.set_status(text),
        )
        self.buffer = self.transcript.buffer
        self.view = self.transcript.view
        apply_transcript_font(self.view)
        self.view.connect("realize", self._on_transcript_font_realize)
        self.view.connect("style-updated", lambda w: apply_transcript_font(w))
        sw.add(self.view)

        row = Gtk.Box(spacing=6)

        self.entry = Gtk.TextView()
        self.entry.set_name("prompt-entry")
        self.entry.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.entry.set_accepts_tab(False)
        apply_transcript_font(self.entry)
        self.entry.connect("realize", lambda *_: apply_transcript_font(self.entry))
        self.entry.connect("style-updated", lambda w: apply_transcript_font(w))
        self.entry.set_left_margin(8)
        self.entry.set_right_margin(8)
        self.entry.set_top_margin(6)
        self.entry.set_bottom_margin(6)
        self.entry.set_tooltip_text(
            "Enter sends (steers while processing); Shift+Enter adds a new "
            "line; Alt+Enter queues a follow-up; Esc-Esc aborts")
        self.entry_buffer = self.entry.get_buffer()

        entry_scroll = Gtk.ScrolledWindow()
        entry_scroll.set_name("prompt-entry-scroller")
        entry_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        entry_scroll.set_propagate_natural_height(True)
        entry_scroll.set_min_content_height(42)
        entry_scroll.set_max_content_height(112)
        entry_scroll.add(self.entry)

        self._prompt_placeholder = Gtk.Label(
            label=self._placeholder_text(),
            xalign=0,
        )
        self._prompt_placeholder.set_name("prompt-placeholder")
        self._prompt_placeholder.set_ellipsize(Pango.EllipsizeMode.END)
        self._prompt_placeholder.set_halign(Gtk.Align.START)
        self._prompt_placeholder.set_valign(Gtk.Align.START)
        self._prompt_placeholder.set_margin_start(9)
        self._prompt_placeholder.set_margin_top(7)
        apply_transcript_font(self._prompt_placeholder)

        prompt_overlay = Gtk.Overlay()
        prompt_overlay.add(entry_scroll)
        prompt_overlay.add_overlay(self._prompt_placeholder)
        prompt_overlay.set_overlay_pass_through(
            self._prompt_placeholder, True)
        row.pack_start(prompt_overlay, True, True, 0)

        # Suggestions live in the normal layout, immediately above the input
        # row.  This is more predictable than GtkEntryCompletion's popup (which
        # opens below the entry and replaces the entry with the whole display
        # string when selected).
        self._cmd_matches = []
        self._cmd_selected = 0
        self._cmd_list = Gtk.ListBox()
        self._cmd_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self._cmd_list.set_activate_on_single_click(True)
        self._cmd_list.set_can_focus(False)
        self._cmd_list.connect("row-activated", self._on_cmd_row_activated)
        self._cmd_list.set_no_show_all(True)

        self._working_banner = Gtk.Label(xalign=0)
        self._working_banner.set_name("working-banner")
        self._working_banner.get_style_context().add_class("monospace")
        self._working_banner.set_line_wrap(True)
        self._working_banner.set_halign(Gtk.Align.START)
        self._working_banner.set_no_show_all(True)

        # Extension prompts can contain an entire shell command.  Keep the
        # panel bounded so a long permission request cannot push its option
        # rows below the window, and make the whole request vertically
        # scrollable so the user can still inspect every line before choosing.
        self._extension_ui_scroll = Gtk.ScrolledWindow()
        self._extension_ui_scroll.set_name("extension-ui")
        self._extension_ui_scroll.set_policy(
            Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self._extension_ui_scroll.set_overlay_scrolling(False)
        self._extension_ui_scroll.set_propagate_natural_height(True)
        self._extension_ui_scroll.set_min_content_height(96)
        self._extension_ui_scroll.set_max_content_height(240)
        self._extension_ui_scroll.set_no_show_all(True)

        self._extension_ui = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self._extension_ui_scroll.add(self._extension_ui)

        vbox.pack_start(self._working_banner, False, False, 0)
        vbox.pack_start(self._extension_ui_scroll, False, False, 0)
        vbox.pack_start(self._cmd_list, False, False, 0)
        vbox.pack_start(row, False, False, 0)
        self.entry_buffer.connect("changed", self._on_prompt_changed)
        self.entry.connect("key-press-event", self._on_entry_key_press)
        self._update_prompt_placeholder()

        send = Gtk.Button(label="Send")
        send.connect("clicked", lambda _b: self._send())
        row.pack_start(send, False, False, 0)

        close = Gtk.Button(label="Close")
        close.connect("clicked", lambda _b: self.destroy())
        row.pack_start(close, False, False, 0)

        self.status = Gtk.Label(label="connecting…", xalign=0)
        self.status.get_style_context().add_class("monospace")
        vbox.pack_start(self.status, False, False, 0)

    def _on_transcript_font_realize(self, view):
        apply_transcript_font(view)
        desc = view.get_pango_context().get_font_description()
        logger.info(
            "transcript font %s",
            desc.to_string() if desc is not None else "unset",
        )

    def _on_destroy(self, _w):
        self.window_state_store.save(WindowState(
            width=self._normal_size[0],
            height=self._normal_size[1],
            maximized=self._window_maximized,
        ))
        self.gateway.close()
        self.transcript.stop()
        self._abort_confirm.stop()
        self.connection_status.stop()
        self.instance_lock.release()
        Gtk.main_quit()

    def _on_window_configure(self, _window, event):
        """Remember the normal size without replacing it while maximized."""
        gdk_window = self.get_window()
        state = gdk_window.get_state() if gdk_window is not None else 0
        non_normal = Gdk.WindowState.MAXIMIZED | Gdk.WindowState.FULLSCREEN
        if not self._window_maximized and not state & non_normal:
            self._normal_size = (event.width, event.height)
        return False

    def _on_window_state(self, _window, event):
        self._window_maximized = bool(
            event.new_window_state & Gdk.WindowState.MAXIMIZED
        )
        return False

    def _on_window_active_changed(self, _window, _param):
        """Put keyboard-raised windows straight into prompt-entry mode."""

        if self.is_active():
            # Run after GTK/compositor focus propagation settles. This also
            # covers Alt-Tab and labwc run-or-raise activation, not just the
            # initial launch path at the bottom of this file.
            GLib.idle_add(self._focus_prompt_after_activation)

    def _focus_prompt_after_activation(self):
        if not self.is_active():
            return False
        self.entry.grab_focus()
        self.transcript.queue_full_redraw()
        return False

    def _on_key_press(self, _w, event):
        """Handle transcript shortcuts and Ctrl+T thinking toggle."""
        control = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        view_focused = self.view.has_focus()

        if (event.keyval == Gdk.KEY_t and control and not shift):
            self.transcript.toggle_thinking()
            return True  # consume the keypress
        if (event.keyval in (Gdk.KEY_o, Gdk.KEY_O) and control and not shift):
            self.transcript.toggle_tools()
            return True  # consume the keypress
        if event.keyval == Gdk.KEY_a and control and not shift and view_focused:
            self.buffer.select_range(
                self.buffer.get_start_iter(), self.buffer.get_end_iter())
            return True
        if (event.keyval in (Gdk.KEY_c, Gdk.KEY_C)
                and control and shift and view_focused):
            self.view.emit("copy-clipboard")
            return True
        if event.keyval == Gdk.KEY_Escape:
            # Mirrors the entry handler so Esc-Esc aborts from anywhere in
            # the window, including when the transcript view has focus.
            if self._cmd_matches:
                self._hide_command_suggestions()
                return True
            if self._extension_ui_request:
                self._cancel_extension_ui()
                return True
            if self._processing:
                return self._handle_abort_escape()
            return True
        return False

    # ── prompt entry ─────────────────────────────────────────────────────

    def _prompt_text(self):
        return self.entry_buffer.get_text(
            self.entry_buffer.get_start_iter(),
            self.entry_buffer.get_end_iter(),
            True,
        )

    def _set_prompt_text(self, text):
        self.entry_buffer.set_text(text)
        self.entry_buffer.place_cursor(self.entry_buffer.get_end_iter())

    def _placeholder_text(self):
        if self._processing:
            return ("Steering active… (Enter: steer, Alt+Enter: follow-up, "
                    "Esc: abort, Ctrl+T: thinking)")
        return ("Ask the agent… (Enter: send, Shift+Enter: new line, "
                "Ctrl+T: thinking, Ctrl+O: tools)")

    def _update_prompt_placeholder(self):
        self._prompt_placeholder.set_label(self._placeholder_text())
        self._prompt_placeholder.set_visible(
            self.entry_buffer.get_char_count() == 0)

    def _set_processing(self, processing):
        if self._processing == processing:
            return
        self._processing = processing
        logger.info("processing=%s", processing)
        if not processing:
            # A run that finished (or was aborted elsewhere) must not leave
            # an armed Esc-Esc confirmation behind.
            self._abort_confirm.disarm()
        self.connection_status.set_processing(processing)
        self._update_prompt_placeholder()

    def _handle_abort_escape(self):
        """Escape while processing: first press arms, second press aborts.

        Consumes the keypress either way; the abort is the same ``abort``
        command the gateway's /stop uses (grace period -> force-clear ->
        Pi restart).
        """

        if self._abort_confirm.on_escape():
            self.gateway.send({"type": "abort"})
            self.connection_status.set_status("aborting…")
        else:
            self.connection_status.set_status("Press Esc again to abort…")
        return True

    def _clear_abort_hint(self):
        """Restore the status line when the confirmation window expires."""

        self.connection_status.render()

    # ── slash-command suggestions ─────────────────────────────────────────

    def _on_prompt_changed(self, _buffer):
        self._update_prompt_placeholder()
        matches = matching_commands(self._prompt_text())
        if not matches:
            self._hide_command_suggestions()
            return
        self._cmd_matches = matches
        self._cmd_selected = 0
        self._render_command_suggestions()

    def _render_command_suggestions(self):
        """Render the current matches above the input while keeping entry focus."""
        for child in self._cmd_list.get_children():
            self._cmd_list.remove(child)

        for index, command in enumerate(self._cmd_matches):
            row = Gtk.ListBoxRow()
            row.set_can_focus(False)
            content = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            content.set_border_width(5)

            name = Gtk.Label(label="/" + command["name"], xalign=0)
            name.set_width_chars(12)
            name.set_selectable(False)
            name.get_style_context().add_class("monospace")

            description = Gtk.Label(label=command["description"], xalign=0)
            description.set_ellipsize(Pango.EllipsizeMode.END)
            description.set_hexpand(True)
            description.set_selectable(False)

            usage = Gtk.Label(label=command["usage"], xalign=1)

            content.pack_start(name, False, False, 0)
            content.pack_start(description, True, True, 0)
            content.pack_end(usage, False, False, 0)
            row.add(content)
            self._cmd_list.add(row)

        # The ListBox is created with set_no_show_all(True) so the window's
        # initial show_all() keeps it hidden.  That flag also stops show_all()
        # from recursing into the rows we just added, leaving the popup visible
        # but empty.  Show each row explicitly instead.
        for row in self._cmd_list.get_children():
            row.show_all()
        self._cmd_list.set_visible(True)
        self._select_command_suggestion()

    def _select_command_suggestion(self):
        if not self._cmd_matches:
            return
        self._cmd_selected %= len(self._cmd_matches)
        row = self._cmd_list.get_row_at_index(self._cmd_selected)
        if row is not None:
            self._cmd_list.select_row(row)

    def _hide_command_suggestions(self):
        self._cmd_matches = []
        self._cmd_selected = 0
        self._cmd_list.unselect_all()
        self._cmd_list.set_visible(False)

    def _on_cmd_row_activated(self, _listbox, row):
        index = row.get_index()
        if 0 <= index < len(self._cmd_matches):
            self._accept_command(self._cmd_matches[index])

    def _accept_command(self, command):
        """Insert only the command token, never its explanatory usage text."""
        suffix = " " if command["takes_args"] else ""
        self._set_prompt_text("/" + command["name"] + suffix)
        self._hide_command_suggestions()
        self.entry.grab_focus()

    # ── model picker ──────────────────────────────────────────────────────

    def _open_model_picker(self, initial_query=""):
        """Open a modal, searchable model list and refresh its catalogue."""
        if self._model_dialog is not None:
            self._model_dialog.present()
            self._model_search.grab_focus()
            return

        dialog = Gtk.Dialog(
            title="Select model",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dialog.set_default_size(760, 560)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Switch", Gtk.ResponseType.APPLY)
        dialog.set_default_response(Gtk.ResponseType.APPLY)
        dialog.connect("response", self._on_model_dialog_response)
        dialog.connect("destroy", self._on_model_dialog_destroyed)

        content = dialog.get_content_area()
        content.set_spacing(8)
        content.set_border_width(12)

        search = Gtk.SearchEntry()
        search.set_placeholder_text("Fuzzy search by provider, model ID, or name…")
        search.connect("changed", self._on_model_search_changed)
        search.connect("key-press-event", self._on_model_search_key_press)
        content.pack_start(search, False, False, 0)

        summary = Gtk.Label(xalign=0)
        content.pack_start(summary, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        scroll.set_min_content_height(360)

        model_list = Gtk.ListBox()
        model_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        model_list.set_activate_on_single_click(False)
        model_list.connect("row-selected", self._on_model_row_selected)
        model_list.connect("row-activated", self._on_model_row_activated)
        scroll.add(model_list)
        content.pack_start(scroll, True, True, 0)

        self._model_dialog = dialog
        self._model_search = search
        self._model_summary = summary
        self._model_scroll = scroll
        self._model_list = model_list
        self._model_matches = []
        self._model_selected = 0
        self._model_loading = True

        self._render_model_matches(preselect_current=not initial_query)
        dialog.show_all()
        if initial_query:
            search.set_text(initial_query)
            search.set_position(-1)
        search.grab_focus()
        dialog.present()

        if not self.gateway.send({"type": "get_models"}):
            self._model_loading = False
            self._render_model_matches()
            self.transcript.error("not connected to gateway")

    def _on_model_dialog_destroyed(self, _dialog):
        self._model_dialog = None
        self._model_matches = []
        self._model_selected = 0

    def _on_model_dialog_response(self, dialog, response_id):
        if response_id == Gtk.ResponseType.APPLY:
            model = self._selected_model()
            if model is None:
                return
            dialog.destroy()
            if not self.gateway.send({
                    "type": "switch_model",
                    "provider": model["provider"],
                    "modelId": model["id"],
            }):
                self.transcript.error("not connected to gateway")
                return
            self.connection_status.set_status(
                f"switching to {model['provider']}/{model['id']}…")
            return
        dialog.destroy()

    def _on_model_search_changed(self, search):
        self._model_selected = 0
        self._render_model_matches(query=search.get_text())

    def _on_model_search_key_press(self, _search, event):
        key = event.keyval
        if key in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            if self._selected_model() is not None:
                self._model_dialog.response(Gtk.ResponseType.APPLY)
            return True
        if key == Gdk.KEY_Escape:
            self._model_dialog.response(Gtk.ResponseType.CANCEL)
            return True
        if key == Gdk.KEY_Down:
            return self._move_model_selection(1)
        if key == Gdk.KEY_Up:
            return self._move_model_selection(-1)
        if key == Gdk.KEY_Page_Down:
            return self._move_model_selection(10)
        if key == Gdk.KEY_Page_Up:
            return self._move_model_selection(-10)
        if key == Gdk.KEY_Home:
            return self._set_model_selection(0)
        if key == Gdk.KEY_End:
            return self._set_model_selection(len(self._model_matches) - 1)
        return False

    def _on_model_row_selected(self, _listbox, row):
        if row is not None and getattr(row, "_model_data", None) is not None:
            self._model_selected = row.get_index()

    def _on_model_row_activated(self, _listbox, row):
        if getattr(row, "_model_data", None) is not None:
            self._model_list.select_row(row)
            self._model_dialog.response(Gtk.ResponseType.APPLY)

    def _move_model_selection(self, delta):
        if not self._model_matches:
            return True
        target = max(0, min(
            self._model_selected + delta,
            len(self._model_matches) - 1,
        ))
        return self._set_model_selection(target)

    def _set_model_selection(self, index):
        if not self._model_matches:
            return True
        self._model_selected = max(0, min(index, len(self._model_matches) - 1))
        row = self._model_list.get_row_at_index(self._model_selected)
        if row is not None:
            self._model_list.select_row(row)
            GLib.idle_add(self._scroll_model_row_into_view, row)
        return True

    def _scroll_model_row_into_view(self, row):
        if self._model_dialog is None or row.get_parent() is None:
            return False
        adjustment = self._model_scroll.get_vadjustment()
        allocation = row.get_allocation()
        top = allocation.y
        bottom = top + allocation.height
        visible_top = adjustment.get_value()
        visible_bottom = visible_top + adjustment.get_page_size()
        if top < visible_top:
            adjustment.set_value(top)
        elif bottom > visible_bottom:
            adjustment.set_value(bottom - adjustment.get_page_size())
        return False

    def _selected_model(self):
        if not self._model_matches:
            return None
        if not 0 <= self._model_selected < len(self._model_matches):
            return None
        return self._model_matches[self._model_selected]

    def _render_model_matches(self, query=None, preselect_current=False):
        if self._model_dialog is None:
            return
        if query is None:
            query = self._model_search.get_text()
        self._model_matches = matching_models(query, self._available_models)

        for child in self._model_list.get_children():
            self._model_list.remove(child)

        if not self._model_matches:
            message = "Loading models…" if self._model_loading else "No matching models"
            row = Gtk.ListBoxRow()
            row.set_selectable(False)
            row.set_activatable(False)
            row._model_data = None
            label = Gtk.Label(label=message, xalign=0)
            label.set_margin_top(14)
            label.set_margin_bottom(14)
            label.set_margin_start(10)
            row.add(label)
            self._model_list.add(row)
            self._model_dialog.set_response_sensitive(
                Gtk.ResponseType.APPLY, False)
        else:
            for model in self._model_matches:
                row = Gtk.ListBoxRow()
                row._model_data = model
                box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
                box.set_border_width(8)

                identity = Gtk.Label(
                    label=f"{model['provider']}/{model['id']}", xalign=0)
                identity.set_hexpand(True)
                identity.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
                identity.get_style_context().add_class("monospace")

                name = Gtk.Label(label=model.get("name") or "", xalign=1)
                name.set_ellipsize(Pango.EllipsizeMode.END)
                name.set_max_width_chars(28)

                current = Gtk.Label(
                    label="current" if self._is_current_model(model) else "",
                    xalign=1,
                )
                current.set_width_chars(8)

                box.pack_start(identity, True, True, 0)
                box.pack_start(name, False, False, 0)
                box.pack_end(current, False, False, 0)
                row.add(box)
                self._model_list.add(row)
            self._model_dialog.set_response_sensitive(
                Gtk.ResponseType.APPLY, True)

        total = len(self._available_models)
        shown = len(self._model_matches)
        self._model_summary.set_label(
            f"{shown} of {total} models · ↑/↓ navigate · Enter switch · Esc cancel"
        )
        self._model_list.show_all()

        selected = 0
        if preselect_current and not query:
            for index, model in enumerate(self._model_matches):
                if self._is_current_model(model):
                    selected = index
                    break
        self._set_model_selection(selected)

    def _is_current_model(self, model):
        current = self._current_model or {}
        return (current.get("provider") == model.get("provider")
                and current.get("id") == model.get("id"))

    # ── thinking-level picker ──────────────────────────────────────────────

    def _open_thinking_picker(self):
        """Choose from Pi's authoritative levels for the current model."""
        if self._thinking_dialog is not None:
            self._thinking_dialog.present()
            return

        dialog = Gtk.Dialog(
            title="Select thinking level",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dialog.set_default_size(460, 380)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Select", Gtk.ResponseType.APPLY)
        dialog.set_default_response(Gtk.ResponseType.APPLY)
        dialog.connect("response", self._on_thinking_dialog_response)
        dialog.connect("destroy", self._on_thinking_dialog_destroyed)
        dialog.connect("key-press-event", self._on_thinking_dialog_key_press)

        content = dialog.get_content_area()
        content.set_spacing(8)
        content.set_border_width(12)
        model = self._current_model or {}
        model_label = (f"{model.get('provider')}/{model.get('id')}"
                       if model.get("provider") and model.get("id")
                       else "Current model")
        heading = Gtk.Label(label=model_label, xalign=0)
        heading.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        heading.get_style_context().add_class("monospace")
        content.pack_start(heading, False, False, 0)

        hint = Gtk.Label(
            label="Choose the reasoning effort used for the next model call.",
            xalign=0,
        )
        content.pack_start(hint, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        level_list = Gtk.ListBox()
        level_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        level_list.set_activate_on_single_click(False)
        level_list.connect("row-selected", self._on_thinking_row_selected)
        level_list.connect("row-activated", self._on_thinking_row_activated)
        scroll.add(level_list)
        content.pack_start(scroll, True, True, 0)

        self._thinking_dialog = dialog
        self._thinking_list = level_list
        self._thinking_selected = 0
        self._thinking_loading = True
        self._render_thinking_levels()
        dialog.show_all()
        dialog.present()

        if not self.gateway.send({"type": "get_thinking_levels"}):
            self._thinking_loading = False
            self._render_thinking_levels()
            self.transcript.error("not connected to gateway")

    def _on_thinking_dialog_destroyed(self, _dialog):
        self._thinking_dialog = None
        self._thinking_selected = 0

    def _on_thinking_dialog_response(self, dialog, response_id):
        if response_id == Gtk.ResponseType.APPLY:
            level = self._selected_thinking_level()
            if level is None:
                return
            dialog.destroy()
            if not self.gateway.send({
                    "type": "set_thinking_level",
                    "level": level,
            }):
                self.transcript.error("not connected to gateway")
                return
            self.connection_status.set_status(
                f"switching thinking level to {level}…")
            return
        dialog.destroy()

    def _on_thinking_dialog_key_press(self, _dialog, event):
        if event.keyval == Gdk.KEY_Escape:
            self._thinking_dialog.response(Gtk.ResponseType.CANCEL)
            return True
        if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            if self._selected_thinking_level() is not None:
                self._thinking_dialog.response(Gtk.ResponseType.APPLY)
            return True
        if event.keyval == Gdk.KEY_Down:
            return self._move_thinking_selection(1)
        if event.keyval == Gdk.KEY_Up:
            return self._move_thinking_selection(-1)
        return False

    def _on_thinking_row_selected(self, _listbox, row):
        if row is not None and getattr(row, "_thinking_level", None) is not None:
            self._thinking_selected = row.get_index()

    def _on_thinking_row_activated(self, _listbox, row):
        if getattr(row, "_thinking_level", None) is not None:
            self._thinking_list.select_row(row)
            self._thinking_dialog.response(Gtk.ResponseType.APPLY)

    def _move_thinking_selection(self, delta):
        levels = self._available_thinking_levels
        if not levels:
            return True
        target = max(0, min(
            self._thinking_selected + delta,
            len(levels) - 1,
        ))
        self._set_thinking_selection(target)
        return True

    def _set_thinking_selection(self, index):
        levels = self._available_thinking_levels
        if not levels or self._thinking_dialog is None:
            return
        self._thinking_selected = max(0, min(index, len(levels) - 1))
        row = self._thinking_list.get_row_at_index(self._thinking_selected)
        if row is not None:
            self._thinking_list.select_row(row)
            row.grab_focus()

    def _selected_thinking_level(self):
        levels = self._available_thinking_levels
        if not levels or not 0 <= self._thinking_selected < len(levels):
            return None
        return levels[self._thinking_selected]

    def _render_thinking_levels(self):
        if self._thinking_dialog is None:
            return
        for child in self._thinking_list.get_children():
            self._thinking_list.remove(child)

        levels = self._available_thinking_levels
        if not levels:
            row = Gtk.ListBoxRow()
            row.set_selectable(False)
            row.set_activatable(False)
            row._thinking_level = None
            message = ("Loading thinking levels…" if self._thinking_loading
                       else "No thinking levels available")
            label = Gtk.Label(label=message, xalign=0)
            label.set_margin_top(12)
            label.set_margin_bottom(12)
            label.set_margin_start(8)
            row.add(label)
            self._thinking_list.add(row)
            self._thinking_dialog.set_response_sensitive(
                Gtk.ResponseType.APPLY, False)
        else:
            for level in levels:
                row = Gtk.ListBoxRow()
                row._thinking_level = level
                box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
                box.set_border_width(9)
                name = Gtk.Label(label=level, xalign=0)
                name.set_hexpand(True)
                name.get_style_context().add_class("monospace")
                current = Gtk.Label(
                    label="current" if level == self._current_thinking_level else "",
                    xalign=1,
                )
                current.set_width_chars(8)
                box.pack_start(name, True, True, 0)
                box.pack_end(current, False, False, 0)
                row.add(box)
                self._thinking_list.add(row)
            self._thinking_dialog.set_response_sensitive(
                Gtk.ResponseType.APPLY, True)

        self._thinking_list.show_all()
        selected = 0
        if self._current_thinking_level in levels:
            selected = levels.index(self._current_thinking_level)
        self._set_thinking_selection(selected)

    def _on_entry_key_press(self, _entry, event):
        # Handy dictation (and similar tools) sends Ctrl+Shift+V to paste
        # plain text. Bind it explicitly for consistent behavior.
        if event.keyval in (Gdk.KEY_v, Gdk.KEY_V):
            ctrl = (event.state & Gdk.ModifierType.CONTROL_MASK) != 0
            shift = (event.state & Gdk.ModifierType.SHIFT_MASK) != 0
            if ctrl and shift:
                self.entry_buffer.paste_clipboard(
                    self.entry.get_clipboard(Gdk.SELECTION_CLIPBOARD),
                    None,
                    True,
                )
                return True

        if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            if self._extension_ui_request:
                method = self._extension_ui_request.get("method")
                if method in ("select", "confirm"):
                    options = dialog_options(self._extension_ui_request)
                    if options:
                        index = min(self._extension_option_index, len(options) - 1)
                        self._choose_extension_option(options[index])
                    return True
                self._submit_extension_input()
                return True
            shift = (event.state & Gdk.ModifierType.SHIFT_MASK) != 0
            alt = (event.state & Gdk.ModifierType.MOD1_MASK) != 0
            if shift:
                self.entry.emit("insert-at-cursor", "\n")
                return True
            if alt:
                # Alt+Enter queues a follow-up (runs after the active work).
                self._send(behavior="followUp")
                return True

            # A complete command should execute with the usual single Enter.
            # Enter on a partial command accepts the completion first.
            if self._cmd_matches:
                typed = self._prompt_text().strip().lower()
                selected = self._cmd_matches[self._cmd_selected]
                if typed != "/" + selected["name"]:
                    self._accept_command(selected)
                    return True
            self._send()
            return True

        if self._extension_ui_request and self._extension_ui_request.get("method") in ("select", "confirm"):
            options = dialog_options(self._extension_ui_request)
            if options and event.keyval == Gdk.KEY_Down:
                self._extension_option_index = (
                    self._extension_option_index + 1) % len(options)
                self._select_extension_option()
                return True
            if options and event.keyval == Gdk.KEY_Up:
                self._extension_option_index = (
                    self._extension_option_index - 1) % len(options)
                self._select_extension_option()
                return True

        if not self._cmd_matches:
            return False

        if event.keyval == Gdk.KEY_Down:
            self._cmd_selected = (self._cmd_selected + 1) % len(self._cmd_matches)
            self._select_command_suggestion()
            return True
        if event.keyval == Gdk.KEY_Up:
            self._cmd_selected = (self._cmd_selected - 1) % len(self._cmd_matches)
            self._select_command_suggestion()
            return True
        if event.keyval == Gdk.KEY_Tab:
            self._accept_command(self._cmd_matches[self._cmd_selected])
            return True
        if event.keyval == Gdk.KEY_Escape:
            # A visible completion popup is dismissed first; Escape then acts
            # on the session (Esc-Esc aborts while processing).
            if self._cmd_matches:
                self._hide_command_suggestions()
                return True
            if self._extension_ui_request:
                self._cancel_extension_ui()
                return True
            if self._processing:
                return self._handle_abort_escape()
            return True
        return False


    # ── WebSocket transport ───────────────────────────────

    def _on_ws_connected(self):
        self.connection_status.set_conn_status(
            "●", "connected — requesting history…", True)
        self.gateway.send({"type": "get_state"})

    def _on_ws_disconnected(self, reason):
        self._hide_extension_ui()
        self._set_processing(False)
        self._set_working_banner(None)
        self.connection_status.set_working(None)
        suffix = f" — reconnecting… ({reason})" if reason else " — reconnecting…"
        self.connection_status.set_conn_status("✗", "disconnected" + suffix, False)

    def _apply_gateway_state(self, data):
        incoming_session = session_id(data)
        if incoming_session and incoming_session != self._session_id:
            if self._session_id is not None:
                self.transcript.clear()
                self._hide_extension_ui()
            self._session_id = incoming_session

        model = data.get("model") or {}
        if model.get("provider") and model.get("id"):
            self._current_model = model
        if model.get("name"):
            self.connection_status.set_model_name(model.get("name"))
        elif model.get("provider") and model.get("id"):
            self.connection_status.set_model_name(
                f"{model.get('provider')}/{model.get('id')}")
        if data.get("thinkingLevel"):
            self._current_thinking_level = data.get("thinkingLevel")
            self.connection_status.set_thinking_level(
                data.get("thinkingLevel"))
        if isinstance(data.get("availableThinkingLevels"), list):
            self._available_thinking_levels = [
                level for level in data.get("availableThinkingLevels")
                if level in KNOWN_THINKING_LEVELS
            ]
        if data.get("contextWindow") is not None:
            self.connection_status.set_context_window(
                data.get("contextWindow"))
        if "isProcessing" in data:
            self._set_processing(bool(data.get("isProcessing")))
        if data.get("contextTokens") is not None:
            self.connection_status.set_usage(
                {"contextTokens": data.get("contextTokens")})

        activity = working_text(data)
        self.connection_status.set_working(activity)
        self._set_working_banner(activity)

        if "pendingExtensionUi" in data:
            pending = data.get("pendingExtensionUi")
            if pending and is_dialog_method(pending.get("method")):
                self._show_extension_ui(pending)
            else:
                self._hide_extension_ui()

    def _set_working_banner(self, text):
        if text:
            self._working_banner.set_text(text)
            self._working_banner.show()
        else:
            self._working_banner.hide()
            self._working_banner.set_text("")

    def _clear_extension_ui_widgets(self):
        for child in list(self._extension_ui.get_children()):
            self._extension_ui.remove(child)

    def _hide_extension_ui(self):
        self._extension_ui_request = None
        self._extension_option_index = 0
        self._extension_ui_list = None
        self._extension_ui_input = None
        self._clear_extension_ui_widgets()
        self._extension_ui_scroll.hide()

    def _show_extension_ui(self, request):
        if not request or not request.get("id"):
            return
        if (
            self._extension_ui_request
            and self._extension_ui_request.get("id") == request.get("id")
        ):
            return
        # Gateway ``working`` repeats the dialog title, which for permission
        # gates is often the full command.  The scrollable panel below already
        # shows that text; keep the surrounding layout compact and the status
        # line useful instead of rendering the command twice.
        self.connection_status.set_working("Waiting for your answer")
        self._set_working_banner(None)
        self._extension_ui_request = dict(request)
        self._extension_option_index = 0
        self._clear_extension_ui_widgets()

        title = Gtk.Label(label=dialog_title(request), xalign=0)
        title.set_name("extension-ui-title")
        title.set_line_wrap(True)
        title.set_halign(Gtk.Align.START)
        self._extension_ui.pack_start(title, False, False, 0)

        method = request.get("method")
        if method in ("select", "confirm"):
            options = dialog_options(request)
            option_list = Gtk.ListBox()
            option_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
            option_list.set_activate_on_single_click(True)
            option_list.set_can_focus(False)
            option_list.connect(
                "row-activated",
                lambda _list, row, opts=options: self._choose_extension_option(
                    opts[row.get_index()] if 0 <= row.get_index() < len(opts) else None
                ),
            )
            for option in options:
                label = Gtk.Label(label=option, xalign=0)
                label.set_line_wrap(True)
                row = Gtk.ListBoxRow()
                row.add(label)
                option_list.add(row)
            self._extension_ui_list = option_list
            self._extension_ui.pack_start(option_list, False, False, 0)
        else:
            entry = Gtk.TextView() if method == "editor" else Gtk.Entry()
            if method == "editor":
                entry.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
                prefill = request.get("prefill") or ""
                entry.get_buffer().set_text(prefill)
                entry.set_size_request(-1, 72)
            else:
                entry.set_placeholder_text(request.get("placeholder") or "")
                entry.connect("activate", lambda _w: self._submit_extension_input())
            self._extension_ui_input = entry
            self._extension_ui.pack_start(entry, False, False, 0)
            submit = Gtk.Button(label="Submit")
            submit.connect("clicked", lambda _b: self._submit_extension_input())
            self._extension_ui.pack_start(submit, False, False, 0)

        cancel = Gtk.Button(label="Cancel")
        cancel.set_name("extension-ui-cancel")
        cancel.connect("clicked", lambda _b: self._cancel_extension_ui())
        self._extension_ui.pack_start(cancel, False, False, 0)
        self._extension_ui.show_all()
        # no-show-all keeps the empty scroller hidden during the window's
        # initial show_all(); reveal it explicitly once it has a request.
        self._extension_ui_scroll.show()
        # A new request should always start at its title, even if the previous
        # prompt was dismissed while scrolled to its action rows.
        self._extension_ui_scroll.get_vadjustment().set_value(0)
        self._select_extension_option()

    def _select_extension_option(self):
        option_list = getattr(self, "_extension_ui_list", None)
        if option_list is None:
            return
        rows = option_list.get_children()
        if not rows:
            return
        index = min(max(self._extension_option_index, 0), len(rows) - 1)
        option_list.select_row(rows[index])

    def _choose_extension_option(self, option):
        request = self._extension_ui_request
        if not request or option is None:
            return
        payload = response_for_option(request, option)
        if payload:
            self.gateway.send(payload)
        self._hide_extension_ui()

    def _submit_extension_input(self):
        request = self._extension_ui_request
        if not request:
            return
        entry = getattr(self, "_extension_ui_input", None)
        value = ""
        if isinstance(entry, Gtk.Entry):
            value = entry.get_text()
        elif isinstance(entry, Gtk.TextView):
            buf = entry.get_buffer()
            value = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), True)
        self.gateway.send(extension_ui_response(request.get("id"), value=value))
        self._hide_extension_ui()

    def _cancel_extension_ui(self):
        request = self._extension_ui_request
        if request and request.get("id"):
            self.gateway.send(extension_ui_response(request["id"], cancelled=True))
        self._hide_extension_ui()

    def _handle_extension_ui_request(self, data):
        method = data.get("method")
        if method == "set_editor_text":
            self._set_prompt_text(data.get("text") or "")
            return
        if method == "setTitle":
            self.set_title(data.get("title") or "Agent")
            return
        if is_dialog_method(method):
            self._show_extension_ui(data)

    def _send(self, behavior=None):
        text = self._prompt_text().strip()
        if not text:
            return
        pending = self._pending_submission
        if is_pending_duplicate(pending, text):
            logger.warning(
                "suppressing duplicate prompt while awaiting acknowledgement id=%s",
                pending["id"],
            )
            return
        if text.startswith("/"):
            self._send_command(text)
            return
        turn_id = str(uuid.uuid4())
        msg = prompt_payload(text, turn_id, processing=self._processing, behavior=behavior)
        if self._processing:
            # Busy-time submission: queue with the active run. The text stays
            # in the composer until the gateway acknowledges it (prompt_queued)
            # so a rejected submission is never lost; the transcript row
            # appears only when Pi consumes it (user_message broadcast).
            self._pending_submission = {"id": turn_id, "text": text}
        else:
            self._set_prompt_text("")
            self.transcript.append_user(text, force_scroll=True, turn_id=turn_id)
        if not self.gateway.send(msg):
            self.transcript.error("not connected to gateway")
            return
        self._set_processing(True)

    def _on_prompt_queued(self, data):
        """Clear the composer once our busy-time submission was accepted."""
        pending = self._pending_submission
        if not pending or data.get("id") != pending["id"]:
            return
        current = self._prompt_text().strip()
        if current == pending["text"]:
            self._set_prompt_text("")
        self._pending_submission = None

    def _on_prompt_accepted(self, data):
        """Reconcile a root acceptance when our local busy state was stale."""
        pending = self._pending_submission
        if not pending or data.get("id") != pending["id"]:
            return
        self.transcript.append_user(
            pending["text"], force_scroll=True, turn_id=pending["id"])
        current = self._prompt_text().strip()
        if current == pending["text"]:
            self._set_prompt_text("")
        self._pending_submission = None

    def _send_command(self, text):
        """Slash command: /cmd [args].

        Parse arguments into the same token shape used by the gateway command
        registry.  In particular, /task add needs separate cron/name/prompt
        tokens; sending the whole remainder as one argument makes that command
        impossible to use from a text box.  ``shlex`` also gives users natural
        quoting for task names and prompts.
        """
        self._set_prompt_text("")
        try:
            parsed = parse_command(text)
        except ValueError as exc:
            self.transcript.error(f"invalid command syntax: {exc}")
            return
        if parsed is None:
            return

        command, args = parsed
        if command == "clear":
            self.transcript.clear()
            return
        if command == "new":
            self.transcript.clear()
            self._hide_extension_ui()
            self._session_id = None
            self.transcript.append_user(text, force_scroll=True)
            msg = {"type": "command", "command": command, "args": args}
            if not self.gateway.send(msg):
                self.transcript.error("not connected to gateway")
            return
        if (command == "model" and (not args or args == ["list"])):
            self._open_model_picker()
            return
        if command == "models":
            self._open_model_picker(" ".join(args))
            return
        if command == "think":
            if args:
                self.transcript.error("usage: /think")
                return
            self._open_thinking_picker()
            return

        self.transcript.append_user(text, force_scroll=True)
        msg = {"type": "command", "command": command, "args": args}
        if not self.gateway.send(msg):
            self.transcript.error("not connected to gateway")

    # ── gateway message handling (runs on the GTK main loop) ──────────────

    def _on_message(self, msg):
        t = msg.get("type")
        data = msg.get("data") or {}
        details = []
        if data.get("turnId"):
            details.append(f"turn={data.get('turnId')}")
        if t in ("text_delta", "thinking_delta"):
            details.append(f"chars={len(data.get('content') or '')}")
        elif t == "tool_output":
            details.append(f"chars={len(data.get('output') or '')}")
        elif t in ("done", "response_segment_done"):
            details.append(f"finalChars={len(data.get('finalText') or '')}")
        elif t == "history":
            details.append(f"messages={len(data.get('messages') or [])}")
        elif t == "queue_update":
            details.append(f"steering={len(data.get('steering') or [])}")
            details.append(f"followUp={len(data.get('followUp') or [])}")
        elif t == "state":
            details.append(f"processing={bool(data.get('isProcessing'))}")
        suffix = " " + " ".join(details) if details else ""
        logger.info("recv type=%s%s", t, suffix)

        if t == "connection":
            self.connection_status.set_conn_status("●", "connected", True)
            self._apply_gateway_state(data)

        elif t == "state":
            self._apply_gateway_state(data)

        elif t == "usage":
            self.connection_status.set_usage(data)

        elif t == "models":
            models = data.get("models") or []
            self._available_models = [
                model for model in models
                if (isinstance(model, dict)
                    and model.get("provider")
                    and model.get("id"))
            ]
            if data.get("current"):
                self._current_model = data.get("current")
            self._model_loading = False
            self._render_model_matches(preselect_current=True)

        elif t == "thinking_levels":
            levels = data.get("levels") or []
            self._available_thinking_levels = [
                level for level in levels if level in KNOWN_THINKING_LEVELS
            ]
            if data.get("current") in KNOWN_THINKING_LEVELS:
                self._current_thinking_level = data.get("current")
            if data.get("model"):
                self._current_model = data.get("model")
            self._thinking_loading = False
            self._render_thinking_levels()

        elif t == "thinking_level_changed":
            if data.get("success"):
                if data.get("level") in KNOWN_THINKING_LEVELS:
                    self._current_thinking_level = data.get("level")
                    self.connection_status.set_thinking_level(
                        data.get("level"))
                if isinstance(data.get("availableLevels"), list):
                    self._available_thinking_levels = [
                        level for level in data.get("availableLevels")
                        if level in KNOWN_THINKING_LEVELS
                    ]
                if data.get("model"):
                    self._current_model = data.get("model")
            else:
                self.connection_status.render()
                self.transcript.error(
                    data.get("error") or "failed to set thinking level")

        elif t == "model_switched":
            if data.get("success"):
                if data.get("model"):
                    self._current_model = data.get("model")
                    self.connection_status.set_model_name(
                        model_name(data.get("model")))
                self.gateway.send({"type": "get_state"})
            else:
                self.connection_status.render()
                self.transcript.error(
                    data.get("error") or "failed to switch model")

        elif t == "prompt_accepted":
            self._on_prompt_accepted(data)

        elif t == "prompt_queued":
            self._on_prompt_queued(data)
            self.transcript.handle_message(t, data)

        elif t == "abort_complete":
            self._pending_submission = None
            self._set_processing(False)
            self._hide_extension_ui()
            self.connection_status.set_working(None)
            self._set_working_banner(None)
            self.connection_status.set_status("Prompt aborted")
            self.transcript.handle_message(t, data)

        elif t == "extension_ui_request":
            self._handle_extension_ui_request(data)

        elif t == "extension_ui_resolved":
            if (
                self._extension_ui_request
                and data.get("id") == self._extension_ui_request.get("id")
            ):
                self._hide_extension_ui()

        elif t in ("error", "notify", "extension_error"):
            if t == "error":
                self._set_processing(False)
                self._hide_extension_ui()
            self.transcript.handle_message(t, data)

        else:
            if t == "done":
                # The full session-level run finished; `response_segment_done`
                # finalizes a segment WITHOUT ending the busy state.
                self._set_processing(False)
                if data.get("usage"):
                    self.connection_status.set_usage(data.get("usage"))
            self.transcript.handle_message(t, data)

    def _on_ws_error(self, err):
        self._set_processing(False)
        self.connection_status.set_conn_status(
            "✗", "disconnected — " + err, False)
        self.transcript.error(f"gateway error: {err}")


if __name__ == "__main__":
    _configure_logging()
    win = AgentGui()
    win.show_all()
    win.present()
    # Focus the prompt entry once the window is mapped (labwc auto-focuses
    # new windows), so the user can type immediately after spawning.
    GLib.timeout_add(300, win.entry.grab_focus)
    Gtk.main()
