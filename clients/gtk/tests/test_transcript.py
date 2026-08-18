"""Headless behavior checks for the GTK transcript controller."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk, Pango

from clients.gtk.config import (
    BG_COLOR,
    THINKING_BLOCK_BG_COLOR,
    THINKING_COLOR,
    THINKING_HEAD_COLOR,
    TOOL_ARG_COLOR,
    TOOL_BLOCK_BG_COLOR,
    TOOL_ERROR_BG_COLOR,
    TOOL_META_COLOR,
    TOOL_NAME_COLOR,
    TOOL_SUCCESS_BG_COLOR,
    USER_BLOCK_BG_COLOR,
)
from clients.gtk.transcript import (
    TranscriptController,
    summarize_tool,
    summarize_tool_parts,
)


def _text(buffer):
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)


class TranscriptControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Gtk.init([])

    def make_controller(self, statuses=None):
        return TranscriptController(
            on_status=(statuses.append if statuses is not None else None),
            start_cursor_timer=False,
        )

    @staticmethod
    def drain_gtk_events():
        """Let queued text layout, adjustment, and idle work settle."""

        for _ in range(10):
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)

    @staticmethod
    def bottom_gap(controller):
        adjustment = controller.view.get_vadjustment()
        return (
            adjustment.get_upper()
            - adjustment.get_page_size()
            - adjustment.get_value()
        )

    def test_user_append_and_heartbeat_filter(self):
        controller = self.make_controller()
        try:
            controller.append_user("hello", force_scroll=True)
            self.assertEqual(_text(controller.buffer), "hello\n")
            self.assertFalse(controller.text_delta("[Heartbeat] [[NO_ACTION]]"))
            self.assertEqual(_text(controller.buffer), "hello\n")
        finally:
            controller.stop()

    def test_history_thinking_that_mentions_no_action_does_not_poison_stream(self):
        controller = self.make_controller()
        try:
            controller.load_history([
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "Docs discuss the literal [[NO_ACTION]] marker.",
                        },
                        {"type": "text", "text": "Historical answer"},
                    ],
                },
            ])
            controller.append_user("New prompt", turn_id="turn-live")

            self.assertTrue(controller.text_delta("Visible live reply"))
            controller.done(
                final_text="Visible live reply", turn_id="turn-live"
            )
            self.assertIn("Visible live reply", _text(controller.buffer))
        finally:
            controller.stop()

    def test_heartbeat_fragment_does_not_poison_later_prose(self):
        controller = self.make_controller()
        try:
            self.assertFalse(controller.text_delta("[[NO_ACTION]]"))
            self.assertTrue(controller.text_delta("ordinary response"))
            self.assertIn("ordinary response", _text(controller.buffer))
        finally:
            controller.stop()

    def test_tool_result_tag_forms_shaded_block(self):
        controller = self.make_controller()
        try:
            tags = controller.buffer.get_tag_table()
            tool_output = tags.lookup("tool-output")
            expected = Gdk.RGBA()
            expected.parse(TOOL_BLOCK_BG_COLOR)
            self.assertEqual(
                tool_output.get_property("paragraph-background-rgba").to_string(),
                expected.to_string(),
            )
            self.assertEqual(tool_output.get_property("pixels-above-lines"), 2)
            self.assertEqual(tool_output.get_property("pixels-below-lines"), 2)
            self.assertEqual(tool_output.get_property("left-margin"), 18)
            self.assertEqual(tool_output.get_property("right-margin"), 18)
            copy_row = tags.lookup("copy-row")
            self.assertEqual(copy_row.get_property("left-margin"), 18)
            self.assertEqual(copy_row.get_property("right-margin"), 18)
            self.assertEqual(copy_row.get_property("pixels-below-lines"), 6)
            for name, color in (
                ("tool-success", TOOL_SUCCESS_BG_COLOR),
                ("tool-error", TOOL_ERROR_BG_COLOR),
            ):
                expected.parse(color)
                self.assertEqual(
                    tags.lookup(name)
                    .get_property("paragraph-background-rgba")
                    .to_string(),
                    expected.to_string(),
                )
        finally:
            controller.stop()

    def test_coloured_surfaces_have_thin_uncoloured_gaps(self):
        controller = self.make_controller()
        try:
            controller.append_user("question", turn_id="turn-1")
            controller.thinking_delta("before tool", "thinking-1", "turn-1")
            controller.thinking_done("thinking-1")
            controller.tool_start({"toolName": "bash", "args": {"command": "true"}})
            controller.tool_output("ok")
            controller.tool_end()
            controller.thinking_delta("after tool", "thinking-2", "turn-1")
            controller.thinking_done("thinking-2")
            controller.text_delta("answer")

            gap = controller.buffer.get_tag_table().lookup("block-gap")
            gap_offsets = []
            cursor = controller.buffer.get_start_iter()
            while not cursor.is_end():
                if cursor.get_char() == "\n" and cursor.has_tag(gap):
                    gap_offsets.append(cursor.get_offset())
                cursor.forward_char()
            # user → thinking → tool → thinking → prose
            self.assertEqual(len(gap_offsets), 4)
            expected = Gdk.RGBA()
            expected.parse(BG_COLOR)
            self.assertEqual(
                gap.get_property("paragraph-background-rgba").to_string(),
                expected.to_string(),
            )
            self.assertEqual(gap.get_property("size-points"), 1)
            self.assertEqual(gap.get_property("pixels-above-lines"), 2)
            self.assertEqual(gap.get_property("pixels-below-lines"), 2)
        finally:
            controller.stop()

    def test_thinking_tags_are_dim_grey_and_other_tags_inherit(self):
        controller = self.make_controller()
        try:
            tags = controller.buffer.get_tag_table()

            def rgba_of(color):
                rgba = Gdk.RGBA()
                rgba.parse(color)
                return rgba.to_string()

            expected = Gdk.RGBA()
            expected.parse(THINKING_COLOR)
            for name in ("thinking", "think-hidden"):
                with self.subTest(tag=name):
                    tag = tags.lookup(name)
                    self.assertTrue(tag.get_property("foreground-set"))
                    self.assertEqual(
                        tag.get_property("foreground-rgba").to_string(),
                        expected.to_string(),
                    )
            # The thinking header carries the purple cerebral accent and the
            # body sits on a purple-washed surface.
            head = tags.lookup("think-head")
            self.assertEqual(
                head.get_property("foreground-rgba").to_string(),
                rgba_of(THINKING_HEAD_COLOR),
            )
            for name, bg in (
                ("thinking", THINKING_BLOCK_BG_COLOR),
                ("think-head", THINKING_BLOCK_BG_COLOR),
                ("think-hidden", THINKING_BLOCK_BG_COLOR),
                ("user", USER_BLOCK_BG_COLOR),
            ):
                with self.subTest(tag=name, prop="background"):
                    self.assertEqual(
                        tags.lookup(name)
                        .get_property("paragraph-background-rgba")
                        .to_string(),
                        rgba_of(bg),
                    )
            names = (
                "user", "tool-output", "error", "system", "md-code",
                "md-pre-lang", "syn-keyword", "syn-comment", "md-quote",
                "md-table", "md-link", "md-hr", "stream-cursor",
            )
            for name in names:
                with self.subTest(tag=name):
                    self.assertFalse(
                        tags.lookup(name).get_property("foreground-set")
                    )
        finally:
            controller.stop()

    def test_tool_header_tags_are_themed(self):
        controller = self.make_controller()
        try:
            tags = controller.buffer.get_tag_table()

            def rgba_of(color):
                rgba = Gdk.RGBA()
                rgba.parse(color)
                return rgba.to_string()

            tool = tags.lookup("tool")
            self.assertTrue(tool.get_property("foreground-set"))
            self.assertEqual(
                tool.get_property("foreground-rgba").to_string(),
                rgba_of(TOOL_META_COLOR),
            )
            tool_name = tags.lookup("tool-name")
            self.assertEqual(
                tool_name.get_property("foreground-rgba").to_string(),
                rgba_of(TOOL_NAME_COLOR),
            )
            self.assertEqual(
                tool_name.get_property("weight"), Pango.Weight.BOLD
            )
            tool_args = tags.lookup("tool-args")
            self.assertEqual(
                tool_args.get_property("foreground-rgba").to_string(),
                rgba_of(TOOL_ARG_COLOR),
            )
            tool_header = tags.lookup("tool-header")
            self.assertEqual(
                tool_header.get_property("paragraph-background-rgba").to_string(),
                rgba_of(TOOL_BLOCK_BG_COLOR),
            )
            self.assertEqual(tool_header.get_property("left-margin"), 18)
            self.assertEqual(tool_header.get_property("right-margin"), 18)
            self.assertEqual(tool_header.get_property("pixels-above-lines"), 6)
            self.assertEqual(tool_header.get_property("pixels-below-lines"), 2)
        finally:
            controller.stop()

    def test_bottom_scroll_uses_native_textview_mark_alignment(self):
        calls = []
        mark = object()
        view = SimpleNamespace(
            scroll_to_mark=lambda *args: calls.append(args),
        )
        fake_controller = SimpleNamespace(view=view, _bottom_mark=mark)

        TranscriptController._scroll_end(fake_controller)

        self.assertEqual(calls, [(mark, 0.0, True, 0.0, 1.0)])

    def test_relayout_pin_updates_on_range_change_before_idle_release(self):
        controller = self.make_controller()
        real_view = controller.view
        adjustment = Gtk.Adjustment.new(0, 0, 1000, 10, 100, 200)
        controller.view = SimpleNamespace(
            get_vadjustment=lambda: adjustment,
            scroll_to_mark=lambda *_args: None,
        )
        try:
            with patch(
                "clients.gtk.transcript.GLib.idle_add",
                return_value=77,
            ) as idle_add:
                controller._scroll_after_relayout(True)

                adjustment.set_upper(1200)

                self.assertEqual(adjustment.get_value(), 1000)
                release = idle_add.call_args.args[0]
                self.assertIs(
                    release.__func__,
                    TranscriptController._release_relayout_bottom_pin,
                )
                self.assertFalse(release())
                self.assertIsNone(controller._relayout_pin_adjustment)
        finally:
            controller.view = real_view
            controller.stop()

    def test_expanding_tools_stays_pinned_after_gtk_relayout(self):
        window = Gtk.Window()
        window.set_default_size(600, 420)
        scroller = Gtk.ScrolledWindow()
        window.add(scroller)
        controller = self.make_controller()
        scroller.add(controller.view)
        window.show_all()
        try:
            for index in range(35):
                controller.append(f"prefix line {index}")
            for index in range(8):
                controller.tool_start({
                    "toolName": "bash",
                    "args": {"command": f"command {index}"},
                })
                controller.tool_output("output line\n" * 8)
                controller.tool_end()
            controller.append("final line")
            self.drain_gtk_events()
            controller.scroll_to_bottom()
            self.drain_gtk_events()

            controller.toggle_tools()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)

            controller.toggle_tools()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
        finally:
            window.destroy()
            controller.stop()
            self.drain_gtk_events()

    def test_expanding_thinking_stays_pinned_after_gtk_relayout(self):
        window = Gtk.Window()
        window.set_default_size(600, 420)
        scroller = Gtk.ScrolledWindow()
        window.add(scroller)
        controller = self.make_controller()
        scroller.add(controller.view)
        window.show_all()
        try:
            for index in range(20):
                turn_id = f"turn-{index}"
                thinking_id = f"thinking-{index}"
                controller.append_user(f"question {index}", turn_id=turn_id)
                controller.thinking_delta(
                    "reasoning words " * 30,
                    thinking_id,
                    turn_id,
                )
                controller.thinking_done(thinking_id)
                controller.text_delta("answer")
                controller.done()
            controller.append("final line")
            self.drain_gtk_events()
            controller.scroll_to_bottom()
            self.drain_gtk_events()

            controller.toggle_thinking()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)

            controller.toggle_thinking()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
        finally:
            window.destroy()
            controller.stop()
            self.drain_gtk_events()

    def test_streaming_text_and_thinking_follow_the_bottom_pin(self):
        window = Gtk.Window()
        window.set_default_size(600, 420)
        scroller = Gtk.ScrolledWindow()
        window.add(scroller)
        controller = self.make_controller()
        scroller.add(controller.view)
        window.show_all()
        try:
            for index in range(40):
                controller.append(f"seed line {index}")
            self.drain_gtk_events()
            controller.scroll_to_bottom()
            self.drain_gtk_events()

            controller.text_delta("streamed words " * 120)
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
            controller.text_delta("more streamed words " * 120)
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
            controller.done()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)

            controller.append_user("next question", turn_id="turn-next")
            controller.thinking_delta(
                "reasoning words " * 120,
                "thinking-next",
                "turn-next",
            )
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
            controller.thinking_delta(
                "more reasoning " * 120,
                "thinking-next",
                "turn-next",
            )
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
        finally:
            window.destroy()
            controller.stop()
            self.drain_gtk_events()

    def test_streaming_preserves_scroll_but_completion_reveals_reply(self):
        window = Gtk.Window()
        window.set_default_size(600, 420)
        scroller = Gtk.ScrolledWindow()
        window.add(scroller)
        controller = self.make_controller()
        scroller.add(controller.view)
        window.show_all()
        try:
            for index in range(60):
                controller.append(f"seed line {index}")
            self.drain_gtk_events()
            controller.scroll_to_bottom()
            self.drain_gtk_events()

            adjustment = controller.view.get_vadjustment()
            adjustment.set_value(adjustment.get_value() - 180)
            controller.text_delta("detached stream " * 120)
            self.drain_gtk_events()
            self.assertGreater(self.bottom_gap(controller), 4)
            controller.done()
            self.drain_gtk_events()
            self.assertLess(self.bottom_gap(controller), 4)
        finally:
            window.destroy()
            controller.stop()
            self.drain_gtk_events()

    def test_copy_button_sets_arrow_pointer(self):
        display = object()
        cursors = []
        window = SimpleNamespace(
            get_display=lambda: display,
            set_cursor=cursors.append,
        )
        widget = SimpleNamespace(get_window=lambda: window)
        cursor = object()
        with patch(
            "clients.gtk.transcript.Gdk.Cursor.new_for_display",
            return_value=cursor,
        ) as make_cursor:
            TranscriptController._set_pointer_cursor(widget)

        make_cursor.assert_called_once_with(display, Gdk.CursorType.LEFT_PTR)
        self.assertEqual(cursors, [cursor])

    def test_streamed_text_replaced_with_markdown_on_done(self):
        controller = self.make_controller()
        try:
            self.assertTrue(controller.text_delta("**bold**"))
            # The cursor is visible during streaming; done removes it and
            # replaces the raw segment with the rendered text.
            controller.done()
            self.assertNotIn("▊", _text(controller.buffer))
            self.assertIn("bold", _text(controller.buffer))
            self.assertIsNone(controller._cur_seg)
            self.assertEqual(controller._segments, [])
            controller.done({"total": 151489})
            self.assertNotIn("151,489 tok", _text(controller.buffer))
        finally:
            controller.stop()

    def test_markdown_list_items_are_rendered(self):
        controller = self.make_controller()
        try:
            controller.render_markdown("Before\n\n- first\n- **second**\n\nAfter")

            text = _text(controller.buffer)
            self.assertIn("Before\n", text)
            self.assertIn("• first\n", text)
            self.assertIn("• second\n", text)
            self.assertIn("After\n", text)
        finally:
            controller.stop()

    def test_done_repairs_missing_final_text_suffix_without_reloading_history(self):
        controller = self.make_controller()
        try:
            controller.append_user("question", turn_id="turn-1")
            controller.text_delta("first paragraph\n\n")
            controller.tool_start({"toolName": "bash", "args": {"command": "true"}})
            controller.tool_output("ok")
            controller.tool_end()

            controller.handle_message(
                "done",
                {
                    "turnId": "turn-1",
                    "finalText": "first paragraph\n\nmissing final paragraph",
                },
            )

            text = _text(controller.buffer)
            self.assertIn("first paragraph", text)
            self.assertIn("missing final paragraph", text)
            self.assertIn("ok", text)
        finally:
            controller.stop()

    def test_done_does_not_apply_final_text_from_a_different_turn(self):
        controller = self.make_controller()
        try:
            controller.append_user("question", turn_id="turn-current")
            controller.text_delta("current response")
            controller.handle_message(
                "done",
                {
                    "turnId": "turn-stale",
                    "finalText": "current response stale suffix",
                },
            )

            text = _text(controller.buffer)
            self.assertIn("current response", text)
            self.assertNotIn("stale suffix", text)
        finally:
            controller.stop()

    def test_thinking_toggle_round_trips_and_reports_status(self):
        statuses = []
        controller = self.make_controller(statuses)
        try:
            controller.append_user("question?")
            controller.thinking_delta("private reasoning A")
            controller.thinking_done()
            controller.thinking_delta("private reasoning B")
            controller.thinking_done()
            controller.text_delta("public answer")
            controller.done()
            shown = _text(controller.buffer)
            self.assertIn("▾ Thinking", shown)
            # Each lifecycle fragment keeps a visible marker so reasoning
            # that resumes after a tool call is not silently omitted.
            for expected_hidden in (True, False, True, False):
                controller.toggle_thinking()
                text = _text(controller.buffer)
                if expected_hidden:
                    self.assertNotIn("private reasoning A", text)
                    self.assertNotIn("private reasoning B", text)
                    self.assertEqual(
                        text.count("▸ Thinking hidden — Ctrl+T to show"), 2
                    )
                    self.assertEqual(
                        statuses[-1], "▸ Thinking hidden — Ctrl+T to show"
                    )
                    gap = controller.buffer.get_tag_table().lookup("block-gap")
                    placeholder = text.index("▸ Thinking hidden")
                    self.assertFalse(
                        controller.buffer.get_iter_at_offset(placeholder).has_tag(gap)
                    )
                else:
                    self.assertIn("private reasoning A", text)
                    self.assertIn("private reasoning B", text)
                    self.assertNotIn("Thinking hidden", text)
                    thinking = controller.buffer.get_tag_table().lookup("thinking")
                    gap = controller.buffer.get_tag_table().lookup("block-gap")
                    for needle in ("private reasoning A", "private reasoning B"):
                        restored = controller.buffer.get_iter_at_offset(
                            text.index(needle)
                        )
                        self.assertTrue(restored.has_tag(thinking))
                        self.assertFalse(restored.has_tag(gap))
                    self.assertEqual(
                        statuses[-1], "▾ Thinking shown — Ctrl+T to hide"
                    )
                self.assertIn("question?", text)
                self.assertIn("public answer", text)
        finally:
            controller.stop()

    def test_thinking_toggle_keeps_placeholder_for_each_fragment(self):
        controller = self.make_controller()
        try:
            controller.append_user("first", turn_id="turn-1")
            controller.thinking_delta("before tool", "thinking-1", "turn-1")
            controller.thinking_done("thinking-1")
            controller.tool_start({"toolName": "bash", "args": {"command": "ping"}})
            controller.tool_output("reply")
            controller.tool_end()
            controller.thinking_delta("after tool", "thinking-2", "turn-1")
            controller.thinking_done("thinking-2")
            controller.append_user("second", turn_id="turn-2")
            controller.thinking_delta("other turn", "thinking-1", "turn-2")
            controller.thinking_done("thinking-1")

            controller.toggle_thinking()
            hidden = _text(controller.buffer)
            self.assertEqual(
                hidden.count("▸ Thinking hidden — Ctrl+T to show"), 3
            )
            self.assertIn("reply", hidden)

            controller.toggle_thinking()
            text = _text(controller.buffer)
            self.assertIn("before tool", text)
            self.assertIn("after tool", text)
            self.assertIn("other turn", text)
            self.assertIn("reply", text)
        finally:
            controller.stop()

    def test_thinking_streamed_while_hidden_can_be_restored(self):
        controller = self.make_controller()
        try:
            controller.append_user("question", turn_id="turn-1")
            controller.toggle_thinking()
            controller.thinking_delta("retained reasoning", "thinking-1", "turn-1")
            controller.thinking_done("thinking-1")
            hidden = _text(controller.buffer)
            self.assertNotIn("retained reasoning", hidden)
            self.assertEqual(
                hidden.count("▸ Thinking hidden — Ctrl+T to show"), 1
            )

            controller.toggle_thinking()
            shown = _text(controller.buffer)
            self.assertIn("retained reasoning", shown)
            self.assertNotIn("Thinking hidden", shown)
        finally:
            controller.stop()

    def test_history_empty_hint_and_protocol_router(self):
        controller = self.make_controller()
        try:
            controller.handle_message("history", {"messages": []})
            self.assertIn("Fresh session", _text(controller.buffer))
            controller.clear()
            controller.handle_message("user_message", {"content": "from gateway"})
            self.assertEqual(_text(controller.buffer), "from gateway\n")
        finally:
            controller.stop()

    def test_history_restores_assistant_thinking(self):
        controller = self.make_controller()
        try:
            controller.load_history([
                {"role": "user", "content": "question"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "stored reasoning"},
                        {"type": "text", "text": "answer"},
                    ],
                },
            ])
            text = _text(controller.buffer)
            self.assertIn("stored reasoning", text)
            self.assertIn("answer", text)
        finally:
            controller.stop()

    # -- tool-call blocks -------------------------------------------------

    def test_summarize_tool_parts_helper(self):
        self.assertEqual(
            summarize_tool_parts("bash", {"command": "ls -la"}, "bash"),
            ("bash", "ls -la"),
        )
        self.assertEqual(
            summarize_tool_parts("read", {"path": "/tmp/x"}, "read"),
            ("read", "/tmp/x"),
        )
        # Labels keep their tool name and lose the shell prefix the name now
        # conveys.
        self.assertEqual(
            summarize_tool_parts("bash", None, "$ echo hi"),
            ("bash", "echo hi"),
        )
        self.assertEqual(
            summarize_tool_parts("read", None, None), ("read", "")
        )

    def test_tool_header_applies_separate_tags_to_name_and_args(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {"toolName": "bash", "args": {"command": "ls -la"}},
            )
            buffer = controller.buffer
            tags = buffer.get_tag_table()
            name_tag = tags.lookup("tool-name")
            args_tag = tags.lookup("tool-args")
            header = buffer.get_text(
                buffer.get_start_iter(), buffer.get_end_iter(), True
            )
            name_at = header.index("bash")
            args_at = header.index("ls -la")
            self.assertTrue(
                buffer.get_iter_at_offset(name_at).has_tag(name_tag)
            )
            self.assertTrue(
                buffer.get_iter_at_offset(args_at).has_tag(args_tag)
            )
            self.assertFalse(
                buffer.get_iter_at_offset(name_at).has_tag(args_tag)
            )
        finally:
            controller.stop()

    def test_summarize_tool_helper(self):
        self.assertEqual(
            summarize_tool("bash", {"command": "ls -la"}, "bash"), "$ ls -la"
        )
        self.assertEqual(
            summarize_tool("read", {"path": "/tmp/x"}, "read"), "read /tmp/x"
        )
        self.assertEqual(
            summarize_tool("read", None, "read /tmp/x"), "read /tmp/x"
        )
        self.assertEqual(summarize_tool("read", None, None), "read")
        self.assertEqual(
            summarize_tool("web_search", {"query": "gtk"}, None),
            "web_search gtk",
        )
        self.assertEqual(
            summarize_tool("todo", {"action": "add", "text": "ship it"}, None),
            "todo add ship it",
        )
        multiline = "node -e '\n" + ("const value = 1;\n" * 20) + "'"
        summary = summarize_tool("bash", {"command": multiline}, "bash")
        self.assertNotIn("\n", summary)
        self.assertLessEqual(len(summary), 122)  # "$ " plus bounded command
        self.assertTrue(summary.endswith("…"))
        label_summary = summarize_tool("bash", None, multiline)
        self.assertNotIn("\n", label_summary)
        self.assertLessEqual(len(label_summary), 120)
        self.assertTrue(label_summary.endswith("…"))

    def test_done_repairs_text_and_keeps_submitted_turn_visible(self):
        controller = self.make_controller()
        try:
            controller.append_user("Say that again", force_scroll=True, turn_id="turn-1")
            # Reproduce a stale post-layout adjustment just before done.
            with patch.object(controller, "_at_bottom", return_value=False):
                with patch.object(controller, "_scroll_after_relayout") as pin:
                    controller.done(final_text="complete reply", turn_id="turn-1")
                    self.assertTrue(any(call.args[0] for call in pin.call_args_list))
            self.assertIn("complete reply", _text(controller.buffer))
        finally:
            controller.stop()

    def test_completed_live_turn_is_visible_without_reconnect(self):
        window = Gtk.Window()
        window.set_default_size(600, 420)
        scroller = Gtk.ScrolledWindow()
        window.add(scroller)
        controller = self.make_controller()
        scroller.add(controller.view)
        window.show_all()
        try:
            for index in range(60):
                controller.append(f"history line {index}")
            controller.append_user(
                "One more time", force_scroll=True, turn_id="turn-live"
            )
            controller.thinking_delta(
                "reasoning", "thinking-live", "turn-live"
            )
            for delta in ("Here ", "is ", "the reply."):
                controller.text_delta(delta)
            # Pi currently emits thinking_done after prose deltas.
            controller.thinking_done("thinking-live")
            controller.done(
                final_text="Here is the reply.", turn_id="turn-live"
            )
            self.drain_gtk_events()

            self.assertIn("Here is the reply.", _text(controller.buffer))
            self.assertLess(self.bottom_gap(controller), 4)
        finally:
            window.destroy()
            controller.stop()
            self.drain_gtk_events()

    def test_done_keeps_following_tail_across_tool_relayout(self):
        controller = self.make_controller()
        try:
            controller.tool_start({
                "toolName": "bash",
                "args": {"command": "printf output"},
            })
            # Model the transient stale adjustment observed while GTK is
            # laying out a newly inserted tool block.
            with patch.object(controller, "_at_bottom", return_value=False):
                controller.tool_output("output\n" * 50)
                with patch.object(controller, "_scroll_after_relayout") as pin:
                    controller.done(final_text="finished", turn_id=None)
                    self.assertTrue(any(call.args[0] for call in pin.call_args_list))
        finally:
            controller.stop()

    def test_tool_call_renders_summary_and_body(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {
                    "toolName": "bash",
                    "args": {"command": "ls -la"},
                    "label": "$ ls -la",
                },
            )
            controller.handle_message("tool_output", {"output": "total 48\nfile1\n"})
            controller.handle_message("tool_end", {"toolName": "bash"})
            text = _text(controller.buffer)
            self.assertIn("⚙ bash", text)
            self.assertIn("ls -la", text)
            self.assertNotIn("$ ls", text)
            self.assertIn("total 48", text)
            self.assertNotIn("✓", text)
            success = controller.buffer.get_tag_table().lookup("tool-success")
            self.assertTrue(
                controller.buffer.get_iter_at_offset(text.index("bash")).has_tag(success)
            )
        finally:
            controller.stop()

    def test_tool_output_replaces_previous_body(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {"toolName": "bash", "args": {"command": "echo hi"}},
            )
            controller.handle_message("tool_output", {"output": "partial"})
            controller.handle_message("tool_output", {"output": "partial more"})
            controller.handle_message("tool_end", {"toolName": "bash"})
            text = _text(controller.buffer)
            self.assertEqual(text.count("partial"), 1)
            self.assertIn("partial more", text)
        finally:
            controller.stop()

    def test_parallel_tool_calls_keep_outputs_under_their_own_headers(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {
                    "toolCallId": "call-a",
                    "toolName": "bash",
                    "args": {"command": "cmd a"},
                },
            )
            controller.handle_message(
                "tool_start",
                {
                    "toolCallId": "call-b",
                    "toolName": "read",
                    "args": {"path": "/tmp/b"},
                },
            )
            # Interleaved output/end, exactly as Pi emits for parallel calls.
            controller.handle_message(
                "tool_output", {"toolCallId": "call-a", "output": "OUTPUT_A"}
            )
            controller.handle_message(
                "tool_output", {"toolCallId": "call-b", "output": "OUTPUT_B"}
            )
            controller.handle_message("tool_end", {"toolCallId": "call-a"})
            controller.handle_message(
                "tool_output", {"toolCallId": "call-b", "output": "OUTPUT_B2"}
            )
            controller.handle_message("tool_end", {"toolCallId": "call-b"})
            text = _text(controller.buffer)

            header_a = text.index("cmd a")
            header_b = text.index("/tmp/b")
            self.assertLess(header_a, header_b)
            # A's output sits between its header and B's header.
            self.assertLess(header_a, text.index("OUTPUT_A"))
            self.assertLess(text.index("OUTPUT_A"), header_b)
            # B's outputs sit after B's header, and the update replaces the
            # first version rather than duplicating it.
            self.assertLess(header_b, text.index("OUTPUT_B2"))
            self.assertEqual(text.count("OUTPUT_B2"), 1)
            self.assertEqual(
                text.replace("OUTPUT_B2", "").count("OUTPUT_B"), 0
            )
            self.assertNotIn("✓", text)
            success = controller.buffer.get_tag_table().lookup("tool-success")
            self.assertTrue(
                controller.buffer.get_iter_at_offset(text.index("OUTPUT_A")).has_tag(success)
            )
            self.assertTrue(
                controller.buffer.get_iter_at_offset(text.index("OUTPUT_B2")).has_tag(success)
            )
        finally:
            controller.stop()

    def test_tool_output_without_call_id_still_uses_active_block(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {"toolCallId": "call-a", "toolName": "bash"},
            )
            controller.handle_message("tool_output", {"output": "legacy out"})
            controller.handle_message("tool_end", {})
            text = _text(controller.buffer)
            self.assertIn("legacy out", text)
            self.assertNotIn("✓", text)
        finally:
            controller.stop()

    def test_tool_collapse_and_expand(self):
        statuses = []
        controller = self.make_controller(statuses)
        try:
            controller.handle_message(
                "tool_start",
                {"toolName": "read", "args": {"path": "/tmp/x"}},
            )
            controller.handle_message("tool_output", {"output": "content here"})
            controller.handle_message("tool_end", {"toolName": "read"})
            self.assertIn("content here", _text(controller.buffer))

            controller.toggle_tools()
            collapsed = _text(controller.buffer)
            self.assertIn("read  /tmp/x", collapsed)
            self.assertNotIn("content here", collapsed)
            self.assertIn("▸", collapsed)
            success = controller.buffer.get_tag_table().lookup("tool-success")
            header = controller.buffer.get_tag_table().lookup("tool-header")
            for needle in ("▸", "read", "/tmp/x"):
                header_iter = controller.buffer.get_iter_at_offset(
                    collapsed.index(needle)
                )
                self.assertTrue(
                    header_iter.has_tag(success),
                    f"collapsed tool header lost success tint at {needle!r}",
                )
                self.assertTrue(
                    header_iter.has_tag(header),
                    f"collapsed tool header lost inset surface at {needle!r}",
                )
            self.assertEqual(
                statuses[-1], "▸ tool calls collapsed — Ctrl+O to expand"
            )

            controller.toggle_tools()
            expanded = _text(controller.buffer)
            self.assertIn("content here", expanded)
            self.assertNotIn("✓", expanded)
            self.assertIn("▾", expanded)
            self.assertTrue(
                controller.buffer.get_iter_at_offset(
                    expanded.index("content here")
                ).has_tag(success)
            )
            self.assertEqual(
                statuses[-1], "▾ tool calls shown — Ctrl+O to collapse"
            )
        finally:
            controller.stop()

    def test_collapsed_failed_tool_keeps_error_tint(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "tool_start",
                {
                    "toolCallId": "failed-call",
                    "toolName": "bash",
                    "args": {"command": "false"},
                },
            )
            controller.handle_message(
                "tool_output",
                {"toolCallId": "failed-call", "output": "exit 1"},
            )
            controller.handle_message(
                "tool_end",
                {"toolCallId": "failed-call", "isError": True},
            )

            controller.toggle_tools()
            collapsed = _text(controller.buffer)
            error = controller.buffer.get_tag_table().lookup("tool-error")
            self.assertNotIn("exit 1", collapsed)
            for needle in ("▸", "bash", "false"):
                self.assertTrue(
                    controller.buffer.get_iter_at_offset(
                        collapsed.index(needle)
                    ).has_tag(error),
                    f"collapsed tool header lost error tint at {needle!r}",
                )
        finally:
            controller.stop()

    def test_history_tool_result_uses_label(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "history",
                {
                    "messages": [
                        {
                            "role": "toolResult",
                            "toolName": "bash",
                            "label": "$ echo hi",
                            "toolCallId": "c1",
                            "isError": True,
                            "content": [{"type": "text", "text": "hi\n"}],
                        }
                    ]
                },
            )
            text = _text(controller.buffer)
            self.assertIn("⚙ bash", text)
            self.assertIn("echo hi", text)
            self.assertNotIn("$ echo", text)
            self.assertIn("hi\n", text)
            error = controller.buffer.get_tag_table().lookup("tool-error")
            self.assertTrue(
                controller.buffer.get_iter_at_offset(text.index("bash")).has_tag(error)
            )
        finally:
            controller.stop()

    # -- steering / follow-up queue lifecycle -----------------------------

    def test_abort_complete_renders_muted_minimal_notice(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "abort_complete",
                {"message": "Prompt aborted. Ready for a new message."},
            )
            text = _text(controller.buffer)
            self.assertIn("Prompt aborted", text)
            self.assertNotIn("Ready for a new message", text)
            abort_tag = controller.buffer.get_tag_table().lookup("abort-status")
            self.assertTrue(
                controller.buffer.get_iter_at_offset(
                    text.index("Prompt aborted")
                ).has_tag(abort_tag)
            )
        finally:
            controller.stop()

    def test_queue_update_renders_pending_rows(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "queue_update",
                {
                    "steering": [
                        {"id": "s1", "content": "do this instead", "behavior": "steer"},
                    ],
                    "followUp": [
                        {"id": "f1", "content": "then summarize", "behavior": "followUp"},
                    ],
                },
            )
            text = _text(controller.buffer)
            self.assertIn("⏳ queued (steer) — do this instead", text)
            self.assertIn("⏳ queued (follow-up) — then summarize", text)
        finally:
            controller.stop()

    def test_consumed_user_message_replaces_pending_indicator(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "queue_update",
                {
                    "steering": [
                        {"id": "s1", "content": "redirect now", "behavior": "steer"},
                    ],
                    "followUp": [],
                },
            )
            controller.handle_message(
                "user_message",
                {
                    "content": "redirect now",
                    "source": "client-b",
                    "id": "s1",
                    "turnId": "turn-s1",
                },
            )
            text = _text(controller.buffer)
            self.assertNotIn("⏳ queued", text)
            self.assertIn("redirect now\n", text)
        finally:
            controller.stop()

    def test_pending_rows_removed_when_queue_empties(self):
        controller = self.make_controller()
        try:
            controller.handle_message(
                "queue_update",
                {
                    "steering": [{"id": "s1", "content": "x", "behavior": "steer"}],
                    "followUp": [],
                },
            )
            controller.handle_message("queue_update", {"steering": [], "followUp": []})
            self.assertNotIn("⏳ queued", _text(controller.buffer))
        finally:
            controller.stop()

    def test_response_segment_done_finalizes_markdown_without_new_row(self):
        controller = self.make_controller()
        try:
            controller.handle_message("text_delta", {"content": "**bold** answer"})
            controller.handle_message("response_segment_done", {"finalText": "**bold** answer"})
            text = _text(controller.buffer)
            # Streamed raw text was replaced by rendered markdown text.
            self.assertNotIn("**bold**", text)
            self.assertIn("bold answer", text)
            # A new segment starts cleanly for the next logical turn.
            controller.handle_message("text_delta", {"content": "second turn"})
            controller.handle_message("done", {})
            text = _text(controller.buffer)
            self.assertIn("bold answer", text)
            self.assertIn("second turn", text)
        finally:
            controller.stop()

    def test_user_row_inserted_during_streaming_is_not_consumed_by_markdown(self):
        controller = self.make_controller()
        try:
            controller.handle_message("text_delta", {"content": "assistant words"})
            # Even without a preceding response_segment_done (defensive path),
            # the user row must survive finalization.
            controller.handle_message(
                "user_message",
                {"content": "mid-stream user row", "source": "c", "id": "u1"},
            )
            controller.handle_message("done", {})
            text = _text(controller.buffer)
            self.assertIn("assistant words", text)
            self.assertIn("mid-stream user row", text)
        finally:
            controller.stop()

    def test_consecutive_user_messages_have_an_untagged_separator(self):
        controller = self.make_controller()
        try:
            controller.append_user("original", turn_id="turn-1")
            controller.append_user("steering", turn_id="turn-2")

            self.assertEqual(_text(controller.buffer), "original\n\nsteering\n")
            user_tag = controller.buffer.get_tag_table().lookup("user")
            separator = controller.buffer.get_iter_at_offset(len("original\n"))
            self.assertFalse(separator.has_tag(user_tag))
        finally:
            controller.stop()



if __name__ == "__main__":
    unittest.main()
