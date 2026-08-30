import unittest

from clients.gtk.extension_ui import (
    CONFIRM_OPTIONS,
    dialog_options,
    dialog_title,
    extension_ui_response,
    is_dialog_method,
    response_for_option,
    strip_terminal_formatting,
    working_text,
)
from clients.gtk.protocol import session_id


class ExtensionUiTests(unittest.TestCase):
    def test_dialog_methods_and_confirm_options(self):
        self.assertTrue(is_dialog_method("select"))
        self.assertTrue(is_dialog_method("confirm"))
        self.assertFalse(is_dialog_method("notify"))
        self.assertEqual(dialog_options({"method": "confirm"}), list(CONFIRM_OPTIONS))
        self.assertEqual(
            dialog_options({"method": "select", "options": ["A", "B"]}),
            ["A", "B"],
        )

    def test_dialog_title_prefers_title_then_message(self):
        self.assertEqual(dialog_title({"title": "Allow?"}), "Allow?")
        self.assertEqual(
            dialog_title({"method": "input", "message": "Name?"}),
            "Name?",
        )

    def test_response_payloads(self):
        self.assertEqual(
            extension_ui_response("ui-1", cancelled=True),
            {"type": "extension_ui_response", "id": "ui-1", "cancelled": True},
        )
        self.assertEqual(
            response_for_option({"id": "ui-2", "method": "confirm"}, "Yes"),
            {"type": "extension_ui_response", "id": "ui-2", "confirmed": True},
        )
        self.assertEqual(
            response_for_option({"id": "ui-3", "method": "select"}, "B"),
            {"type": "extension_ui_response", "id": "ui-3", "value": "B"},
        )

    def test_working_text_and_session_id(self):
        self.assertEqual(
            working_text({
                "isCompacting": True,
                "working": {"kind": "compaction", "message": "Compacting context…"},
            }),
            "Compacting context…",
        )
        self.assertEqual(working_text({"widgets": ["line 1", "line 2"]}), "line 1\nline 2")
        self.assertIsNone(working_text({}))
        self.assertEqual(session_id({"sessionId": "abc"}), "abc")
        self.assertIsNone(session_id({"sessionId": ""}))

    def test_stopped_compaction_is_not_rendered_as_working(self):
        self.assertIsNone(
            working_text({
                "isCompacting": False,
                "working": {
                    "kind": "compaction",
                    "message": "Compacting context…",
                },
            })
        )
        self.assertEqual(
            working_text({
                "isCompacting": True,
                "working": {
                    "kind": "compaction",
                    "message": "Compacting context…",
                },
            }),
            "Compacting context…",
        )

    def test_working_text_strips_terminal_formatting(self):
        styled = (
            "\x1b[38;2;138;190;183m"
            "🔌 MCP: 4 servers enabled"
            "\x1b[39m"
        )
        self.assertEqual(
            working_text({"working": {"kind": "status", "message": styled}}),
            "🔌 MCP: 4 servers enabled",
        )
        self.assertEqual(
            strip_terminal_formatting("\x1b]0;title\x07Ready"),
            "Ready",
        )


if __name__ == "__main__":
    unittest.main()
