"""Tests for the GTK-independent markdown helpers."""

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "markdown_renderer.py"
SPEC = importlib.util.spec_from_file_location("gtk_markdown_renderer", MODULE_PATH)
markdown_renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(markdown_renderer)


class MdRendererTests(unittest.TestCase):
    def parse(self, html):
        parser = markdown_renderer.MdRenderer()
        parser.feed(html)
        parser.close()
        return parser.lines

    def test_paragraph_and_inline_runs(self):
        self.assertEqual(
            self.parse(
                '<p>Hello <strong>bold</strong> <em>soft</em> '
                '<code>x</code> <a href="url">link</a></p>'
            ),
            [("p", [
                ("Hello ", None),
                ("bold", "strong"),
                (" ", None),
                ("soft", "em"),
                (" ", None),
                ("x", "code"),
                (" ", None),
                ("link", "a"),
            ])],
        )

    def test_headings_lists_quotes_and_breaks(self):
        self.assertEqual(
            self.parse(
                '<h2>Heading</h2><ul><li>one</li><li>two<br>line</li></ul>'
                '<ol><li>first</li><li>second</li></ol>'
                '<blockquote><p>quoted</p></blockquote><hr>'
            ),
            [
                ("h", 2, [("Heading", None)]),
                ("li", [("one", None)], "• "),
                ("li", [("two", None), ("\n", None), ("line", None)], "• "),
                ("li", [("first", None)], "1. "),
                ("li", [("second", None)], "2. "),
                ("quote", [("quoted", None)]),
                ("hr",),
            ],
        )

    def test_fenced_code_captures_language_and_strips_newline(self):
        self.assertEqual(
            self.parse('<pre><code class="language-python">print(1)\n</code></pre>'),
            [("pre", "print(1)", "python")],
        )
        self.assertEqual(
            self.parse('<pre><code>plain\n</code></pre>'),
            [("pre", "plain", None)],
        )

    def test_tables_strip_cells_and_preserve_rows(self):
        self.assertEqual(
            self.parse(
                '<table><tr><th> A </th><th>B</th></tr>'
                '<tr><td>x</td><td> y </td></tr></table>'
            ),
            [("table", [["A", "B"], ["x", "y"]])],
        )


class FormattingTests(unittest.TestCase):
    def test_table_grid_empty_and_ragged_rows(self):
        self.assertEqual(markdown_renderer.table_grid([]), [])
        self.assertEqual(
            markdown_renderer.table_grid([[" A ", "B"], ["x"], ["long", "yy"]]),
            [
                "│ A    │ B  │",
                "├──────┼────┤",
                "│ x    │    │",
                "│ long │ yy │",
            ],
        )

    def test_stream_filter_removes_common_markers(self):
        self.assertEqual(
            markdown_renderer.light_stream_filter(
                "**bold** `code` [link](https://example.test)\n# title\n> quote"
            ),
            "bold code link\ntitle\nquote",
        )
        # A lone marker is intentionally preserved while a stream is partial.
        self.assertEqual(markdown_renderer.light_stream_filter("**partial"), "**partial")

    def test_highlight_code_fallback_and_reconstruction(self):
        self.assertIsNone(markdown_renderer.highlight_code("x", None))
        try:
            import pygments  # noqa: F401
        except ImportError:
            # Pygments is optional in the GTK client.  The no-language branch
            # above still verifies the dependency-free fallback.
            return
        self.assertIsNone(markdown_renderer.highlight_code("x", "not-a-real-language"))
        tokens = markdown_renderer.highlight_code("print(1)", "python")
        self.assertIsNotNone(tokens)
        self.assertEqual("".join(text for text, _token in tokens), "print(1)")

    def test_pygments_token_mapping(self):
        try:
            from pygments.token import Token
        except ImportError:
            self.skipTest("Pygments is optional")
        self.assertEqual(
            markdown_renderer.pygments_token_tag(Token.Keyword), "syn-keyword"
        )
        self.assertEqual(
            markdown_renderer.pygments_token_tag(Token.String), "syn-string"
        )
        self.assertIsNone(markdown_renderer.pygments_token_tag(Token.Text))


if __name__ == "__main__":
    unittest.main()
