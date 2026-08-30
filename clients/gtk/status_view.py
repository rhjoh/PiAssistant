"""Connection status presentation for the GTK client.

The main window used to own the connection label state and its small pulse
animation.  This module keeps that behavior in one object while deliberately
depending only on a label-like object (``set_markup``) and GLib.  Keeping the
label duck-typed makes the state transitions testable without constructing a
GTK window.
"""

import math

import gi

gi.require_version("GLib", "2.0")
from gi.repository import GLib

try:  # Direct executable invocation: `./agent-gui.py`.
    from config import STATUS_ERR_COLOR, STATUS_OK_COLOR
except ImportError:  # Package import from the repository test runner.
    from .config import STATUS_ERR_COLOR, STATUS_OK_COLOR


def format_token_count(tokens):
    """Format a token count compactly for the status line."""

    tokens = int(tokens)
    if tokens < 1000:
        return f"{tokens:,}"
    return f"{(tokens + 500) // 1000:,}k"


class ConnectionStatus:
    """Render connection/model state into a GTK label.

    ``label`` is normally a :class:`Gtk.Label`.  ``glib`` is injectable for
    tests; the default is the real GLib module.  The pulse source is started
    by default to match the original window behavior (80 ms cadence).

    The public methods intentionally correspond to the old ``AgentGui``
    helpers: ``set_status`` replaces ``_set_status``, ``set_conn_status``
    replaces ``_set_conn_status``, and ``set_processing`` replaces
    ``_set_processing``.  ``set_model_name`` is separate because connection
    and state protocol messages update the model before re-rendering status.
    """

    PULSE_INTERVAL_MS = 80
    PULSE_STEP = 0.28

    def __init__(self, label, *, glib=GLib, pulse_interval_ms=PULSE_INTERVAL_MS):
        self.label = label
        self._glib = glib
        self._connected = False
        self._model_name = None
        self._thinking_level = None
        self._token_total = None
        self._context_window: int | None = None
        self._working = None
        self._processing = False
        self._pulse_phase = 0.0
        self._pulse_source = self._glib.timeout_add(
            pulse_interval_ms, self.pulse_tick)

    @property
    def connected(self):
        """Whether the last connection status reported a live connection."""

        return self._connected

    @property
    def model_name(self):
        """The last model display name supplied by the gateway."""

        return self._model_name

    @property
    def processing(self):
        """Whether the connection dot should pulse."""

        return self._processing

    def set_status(self, text):
        """Show a subdued, escaped status message."""

        escaped = self._glib.markup_escape_text(text)
        self.label.set_markup(f'<span alpha="55%">{escaped}</span>')

    def set_conn_status(self, dot, rest, connected):
        """Set a static connection status and reset processing state.
        This is used for the initial connection request and disconnect/error
        states.  Steady connected status is subsequently rendered by
        :meth:`set_processing` / :meth:`render`.

        The dot glyph is coloured by state: green while connected, red for
        disconnect/error states.
        """

        self._connected = bool(connected)
        self._processing = False
        dot_color = STATUS_OK_COLOR if self._connected else STATUS_ERR_COLOR
        dot_escaped = self._glib.markup_escape_text(dot)
        rest_escaped = self._glib.markup_escape_text(rest)
        self.label.set_markup(
            f'<span color="{dot_color}">{dot_escaped}</span> '
            f'<span alpha="55%">{rest_escaped}</span>')

    def set_model_name(self, model_name):
        """Update the model text used by the connected status line."""

        self._model_name = model_name

    def set_thinking_level(self, level):
        """Update the Pi reasoning level shown in the connected status line."""

        if not isinstance(level, str) or not level.strip():
            return
        self._thinking_level = level.strip()
        self.render()

    def set_usage(self, usage):
        """Update the context token count shown in the status line."""

        usage = usage or {}
        if isinstance(usage, dict):
            total = usage.get("contextTokens")
            if total is None:
                total = usage.get("total")
        else:
            total = usage
        if isinstance(total, (int, float)) and total >= 0:
            self._token_total = int(total)
            self.render()

    def set_context_window(self, limit):
        """Set the current model's context limit, if it is valid."""

        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            return
        self._context_window = limit
        self.render()

    def set_working(self, text):
        """Set the live activity line (compaction, retry, waiting for input)."""

        if text is None or (isinstance(text, str) and not text.strip()):
            self._working = None
        elif isinstance(text, str):
            self._working = text.strip()
        else:
            return
        self.render()

    def set_processing(self, processing):
        """Flip the busy flag and re-render the connected status line."""

        self._processing = bool(processing)
        self.render()

    def render(self):
        """Render the pulsing connected status, if currently connected."""

        if not self._connected:
            return

        if self._processing:
            # Smooth sine pulse between approximately 30% and 100% opacity.
            alpha = 0.30 + 0.70 * (0.5 + 0.5 * math.sin(self._pulse_phase))
            pct = int(round(alpha * 100))
        else:
            pct = 100

        if self._model_name:
            escaped_model = self._glib.markup_escape_text(self._model_name)
            rest = f"connected — {escaped_model}"
        else:
            rest = "connected"
        if self._thinking_level:
            escaped_level = self._glib.markup_escape_text(self._thinking_level)
            rest += f" · thinking: {escaped_level}"
        if self._working:
            escaped_working = self._glib.markup_escape_text(self._working)
            rest += f" · {escaped_working}"
        if self._token_total is not None:
            if self._context_window is not None:
                rest += (
                    f" · {format_token_count(self._token_total)}"
                    f"/{format_token_count(self._context_window)} tok")
            else:
                rest += f" · {format_token_count(self._token_total)} tok"
        self.label.set_markup(
            f'<span color="{STATUS_OK_COLOR}" alpha="{pct}%">●</span> '
            f'<span alpha="55%">{rest}</span>')

    def pulse_tick(self):
        """Advance the dot animation and retain the GLib timeout source."""

        if self._connected and self._processing:
            self._pulse_phase += self.PULSE_STEP
            self.render()
        return self._glib.SOURCE_CONTINUE

    def stop(self):
        """Remove the timeout source, if it is still registered.

        The original timeout naturally disappeared when ``Gtk.main`` quit;
        making shutdown explicit lets the window safely destroy this helper
        while the process is still alive and makes repeated cleanup harmless.
        """

        source = self._pulse_source
        if source is not None:
            self._glib.source_remove(source)
            self._pulse_source = None


# Descriptive compatibility alias for callers that prefer the old terminology.
StatusView = ConnectionStatus
