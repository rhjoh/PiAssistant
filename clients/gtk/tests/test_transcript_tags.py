"""Focused checks for GTK transcript tag construction."""

import unittest

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

from clients.gtk.transcript_tags import (
    build_tag_specs,
    create_transcript_tags,
)


TAG_ORDER = (
    "block-gap",
    "user",
    "thinking",
    "think-head",
    "think-hidden",
    "tool",
    "tool-name",
    "tool-args",
    "tool-header",
    "tool-output",
    "tool-success",
    "tool-error",
    "copy-row",
    "error",
    "system",
    "abort-status",
    "md-h1",
    "md-h2",
    "md-h3",
    "md-h4",
    "md-strong",
    "md-em",
    "md-code",
    "md-pre",
    "md-pre-head",
    "md-pre-lang",
    "syn-keyword",
    "syn-func",
    "syn-builtin",
    "syn-string",
    "syn-number",
    "syn-comment",
    "syn-operator",
    "syn-tag",
    "syn-attr",
    "md-quote",
    "md-li",
    "md-table",
    "md-link",
    "md-hr",
    "stream-cursor",
)


class TranscriptTagsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Gtk.init([])

    def test_specs_preserve_creation_order(self):
        self.assertEqual(tuple(build_tag_specs()), TAG_ORDER)

    def test_installation_preserves_priorities_and_returns_cursor_tag(self):
        buffer = Gtk.TextBuffer()
        cursor = create_transcript_tags(buffer)
        table = buffer.get_tag_table()

        for priority, name in enumerate(TAG_ORDER):
            tag = table.lookup(name)
            self.assertIsNotNone(tag)
            self.assertEqual(tag.get_priority(), priority)

        self.assertIs(cursor, table.lookup("stream-cursor"))


if __name__ == "__main__":
    unittest.main()
