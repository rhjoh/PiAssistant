import unittest

from gi.repository import GLib

from clients.gtk.config import STATUS_ERR_COLOR, STATUS_OK_COLOR
from clients.gtk.status_view import ConnectionStatus


class _FakeLabel:
    def __init__(self):
        self.markup = None

    def set_markup(self, markup):
        self.markup = markup


class _FakeGLib:
    SOURCE_CONTINUE = True

    def __init__(self):
        self.sources = {}
        self.next_source = 1

    def timeout_add(self, interval, callback):
        source = self.next_source
        self.next_source += 1
        self.sources[source] = (interval, callback)
        return source

    def source_remove(self, source):
        self.sources.pop(source, None)

    @staticmethod
    def markup_escape_text(text):
        return GLib.markup_escape_text(text)


class ConnectionStatusTests(unittest.TestCase):
    def setUp(self):
        self.label = _FakeLabel()
        self.glib = _FakeGLib()
        self.status = ConnectionStatus(self.label, glib=self.glib)

    def tearDown(self):
        self.status.stop()

    def test_set_status_escapes_markup_and_dims_text(self):
        self.status.set_status("gateway <offline> & waiting")

        self.assertEqual(
            self.label.markup,
            '<span alpha="55%">gateway &lt;offline&gt; &amp; waiting</span>',
        )

    def test_connection_status_resets_processing_and_escapes_rest(self):
        self.status.set_conn_status("●", "connected <requesting>", True)

        self.assertTrue(self.status.connected)
        self.assertFalse(self.status.processing)
        self.assertEqual(
            self.label.markup,
            f'<span color="{STATUS_OK_COLOR}">●</span> '
            '<span alpha="55%">connected &lt;requesting&gt;</span>',
        )

    def test_working_activity_is_rendered_in_connected_status(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model")
        self.status.set_working("Compacting context…")

        self.assertIn("provider/model · Compacting context…", self.label.markup)

    def test_working_clears_when_empty(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model")
        self.status.set_working("Retrying…")
        self.status.set_working(None)

        self.assertNotIn("Retrying", self.label.markup)

    def test_disconnected_status_dot_is_red(self):
        self.status.set_conn_status("✗", "disconnected — boom", False)

        self.assertFalse(self.status.connected)
        self.assertIn(
            f'<span color="{STATUS_ERR_COLOR}">✗</span>', self.label.markup)

    def test_processing_pulse_renders_model_and_advances_phase(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model <test>")
        self.status.set_processing(True)
        before = self.status._pulse_phase

        self.assertIn('alpha="65%"', self.label.markup)
        self.assertIn("provider/model &lt;test&gt;", self.label.markup)
        self.assertTrue(self.status.pulse_tick())
        self.assertGreater(self.status._pulse_phase, before)
        self.assertIn('alpha="75%"', self.label.markup)

    def test_usage_is_rendered_in_connected_status(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model")
        self.status.set_usage({"total": 151489})

        self.assertIn("provider/model · 151k tok", self.label.markup)

    def test_context_usage_is_rendered_with_context_window(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model")
        self.status.set_context_window(1000000)
        self.status.set_usage({"contextTokens": 139888, "total": 999999})

        self.assertIn("provider/model · 140k/1,000k tok", self.label.markup)
        self.assertNotIn("999,999", self.label.markup)

    def test_thinking_level_is_rendered_and_escaped(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_model_name("provider/model")
        self.status.set_thinking_level("high<fast>")

        self.assertIn(
            "provider/model · thinking: high&lt;fast&gt;",
            self.label.markup,
        )

    def test_invalid_thinking_level_does_not_replace_known_value(self):
        self.status.set_conn_status("●", "connected", True)
        self.status.set_thinking_level("off")
        before = self.label.markup

        self.status.set_thinking_level(None)

        self.assertEqual(self.label.markup, before)

    def test_disconnected_pulse_does_not_replace_static_status(self):
        self.status.set_conn_status("✗", "disconnected", False)
        before = self.label.markup

        self.status.set_processing(True)
        self.status.pulse_tick()

        self.assertEqual(self.label.markup, before)

    def test_stop_removes_timeout_and_is_idempotent(self):
        source = self.status._pulse_source
        self.assertIn(source, self.glib.sources)

        self.status.stop()
        self.status.stop()

        self.assertNotIn(source, self.glib.sources)
        self.assertIsNone(self.status._pulse_source)


if __name__ == "__main__":
    unittest.main()
