"""Headless tests for GTK transcript tool presentation helpers."""

import unittest

from clients.gtk.transcript_tools import (
    TOOL_OUTPUT_DISPLAY_MAX_CHARS,
    TOOL_SUMMARY_MAX_CHARS,
    compact_tool_value,
    display_tool_output,
    summarize_tool,
    summarize_tool_parts,
)


class ToolPresentationTests(unittest.TestCase):
    def test_compact_tool_value_folds_whitespace_and_bounds_result(self):
        self.assertEqual(compact_tool_value("  ls\n  -la  "), "ls -la")

        value = "node -e '\n" + ("const value = 1;\n" * 20) + "'"
        compact = compact_tool_value(value)
        self.assertLessEqual(len(compact), TOOL_SUMMARY_MAX_CHARS)
        self.assertNotIn("\n", compact)
        self.assertTrue(compact.endswith("…"))

    def test_summarize_tool_prefers_concrete_arguments(self):
        self.assertEqual(
            summarize_tool("bash", {"command": "ls -la"}, "bash"),
            "$ ls -la",
        )
        self.assertEqual(
            summarize_tool("read", {"path": "/tmp/x"}, "read"),
            "read /tmp/x",
        )
        self.assertEqual(
            summarize_tool("web_search", {"query": "gtk"}, None),
            "web_search gtk",
        )
        self.assertEqual(
            summarize_tool("todo", {"action": "add", "text": "ship it"}),
            "todo add ship it",
        )

    def test_summarize_tool_falls_back_to_informative_label(self):
        self.assertEqual(
            summarize_tool("read", None, "read /tmp/x"), "read /tmp/x"
        )
        self.assertEqual(summarize_tool("read", None, None), "read")

    def test_summarize_tool_parts_keeps_name_separate(self):
        self.assertEqual(
            summarize_tool_parts("bash", {"command": "ls -la"}, "bash"),
            ("bash", "ls -la"),
        )
        self.assertEqual(
            summarize_tool_parts("bash", None, "$ echo hi"),
            ("bash", "echo hi"),
        )
        self.assertEqual(
            summarize_tool_parts("read", {"path": "/tmp/x"}, "read"),
            ("read", "/tmp/x"),
        )
        self.assertEqual(summarize_tool_parts(None, None, None), ("tool", ""))

    def test_display_tool_output_preserves_lines_but_bounds_preview(self):
        self.assertEqual(display_tool_output("  first\nsecond  "), "first\nsecond")
        output = "x" * (TOOL_OUTPUT_DISPLAY_MAX_CHARS + 40)
        preview = display_tool_output(output)
        self.assertEqual(len(preview), TOOL_OUTPUT_DISPLAY_MAX_CHARS + 1)
        self.assertTrue(preview.endswith("…"))

if __name__ == "__main__":
    unittest.main()
