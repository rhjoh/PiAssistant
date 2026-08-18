"""Cairo painting for GTK transcript user-message accent bars."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

try:  # Direct executable invocation: ``./agent-gui.py``.
    from config import (
        USER_BAND_INSET,
        USER_BAND_PADDING_BOTTOM,
        USER_BAND_PADDING_TOP,
        USER_BAND_RGB,
        USER_BAR_WIDTH,
    )
except ImportError:  # Package import from the repository test runner.
    from .config import (
        USER_BAND_INSET,
        USER_BAND_PADDING_BOTTOM,
        USER_BAND_PADDING_TOP,
        USER_BAND_RGB,
        USER_BAR_WIDTH,
    )


def draw_user_accents(view, buffer, cr):
    """Paint a full-height accent bar beside every ``user`` tag range."""

    tag = buffer.get_tag_table().lookup("user")
    if tag is None:
        return
    tx, ty = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, 0, 0)
    start = buffer.get_start_iter()
    while True:
        if start.has_tag(tag):
            begin = start.copy()
        else:
            if not start.forward_to_tag_toggle(tag):
                return
            if not start.has_tag(tag):
                continue
            begin = start.copy()
        end = begin.copy()
        if not end.forward_to_tag_toggle(tag):
            end = buffer.get_end_iter()
        _paint_user_band(view, cr, begin, end, tx, ty)
        start = end


def _paint_user_band(view, cr, begin, end, tx, ty):
    first = begin.copy()
    loc1 = view.get_iter_location(first)
    last = end.copy()
    if last.backward_char():
        # Keep the iterator on the final character. Moving it back to the
        # logical line start makes wrapped and explicit multiline messages
        # report the first visual line's y coordinate, shortening the bar.
        loc2 = view.get_iter_location(last)
        bottom = loc2.y + loc2.height
    else:
        bottom = loc1.y + loc1.height
    top = ty + loc1.y - USER_BAND_PADDING_TOP
    bottom = ty + bottom + USER_BAND_PADDING_BOTTOM
    x = tx + USER_BAND_INSET
    cr.set_source_rgb(*USER_BAND_RGB)
    cr.rectangle(x, top, USER_BAR_WIDTH, bottom - top)
    cr.fill()


__all__ = ["draw_user_accents"]
