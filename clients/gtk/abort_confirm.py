"""Esc-Esc confirmation state for aborting a running prompt or tool call.

Aborting mid-run is destructive (the gateway escalates to a Pi restart when
the run does not settle), so a single stray Escape should not kill work.
``AbortConfirm`` turns the first Escape into an arming press that shows a
hint, and only a second Escape inside the confirmation window sends the
abort.  The armed state also clears itself if the run finishes first.

The class is deliberately GTK-widget-free: ``glib`` is injectable so the
state machine can be unit-tested with a fake (same pattern as
``status_view.ConnectionStatus``).
"""

from __future__ import annotations

import gi

gi.require_version("GLib", "2.0")
from gi.repository import GLib


class AbortConfirm:
    """Two-press confirmation for abort, with a timeout disarm.

    ``on_disarm`` is invoked only when the confirmation window expires on its
    own (so the caller can clear its "press Esc again" hint).  Explicit
    :meth:`disarm` calls do not fire it — the caller is already handling the
    transition.
    """

    CONFIRM_TIMEOUT_MS = 3000

    def __init__(
        self,
        *,
        glib=GLib,
        timeout_ms: int = CONFIRM_TIMEOUT_MS,
        on_disarm=None,
    ) -> None:
        self._glib = glib
        self._timeout_ms = timeout_ms
        self._on_disarm = on_disarm
        self._armed = False
        self._source = None

    @property
    def armed(self) -> bool:
        """Whether the first Escape was pressed and the window is open."""

        return self._armed

    def on_escape(self) -> bool:
        """Process one Escape press.

        Returns ``True`` when the abort should be sent (a confirmed second
        press).  The first press arms the confirmation and schedules the
        disarm timeout; confirming resets the state before returning.
        """

        if self._armed:
            self.disarm()
            return True
        self._armed = True
        self._source = self._glib.timeout_add(self._timeout_ms, self._on_timeout)
        return False

    def disarm(self) -> None:
        """Cancel the armed state and any pending timeout."""

        self._armed = False
        if self._source is not None:
            self._glib.source_remove(self._source)
            self._source = None

    def stop(self) -> None:
        """Idempotent cleanup for window destroy (removes the timer)."""

        self.disarm()

    def _on_timeout(self):
        self._armed = False
        self._source = None
        if self._on_disarm is not None:
            self._on_disarm()
        return False  # GLib.SOURCE_REMOVE
