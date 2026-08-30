"""GTK-independent markdown and streaming rendering helpers.

The GTK client turns markdown into HTML with the :mod:`markdown` package and
then feeds that HTML to :class:`MdRenderer`.  This module contains the second,
display-independent half of that pipeline: parsing HTML into a small line
model, formatting tables, optional Pygments tokenisation, and the light filter
used while text is still streaming.  It deliberately imports no GTK modules
so these behaviours can be tested in a headless environment.
"""

import html.parser
import re


class MdRenderer(html.parser.HTMLParser):
    """Parse markdown-lib HTML into transcript lines.

    Each line is one of::

        ("p", runs)
        ("h", level, runs)
        ("li", runs, prefix)
        ("quote", runs)
        ("pre", text, language)
        ("table", rows)
        ("hr",)

    ``runs`` is a list of ``(text, inline_tag|None)`` pairs and ``rows`` is a
    list of cell-string lists.  The tuple representation is intentionally the
    same as the original GTK client so the UI layer can adopt this module
    without changing transcript output.
    """

    INLINE = {"strong", "em", "code", "a"}
    HEADING = re.compile(r"h([1-6])")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines = []
        self._stack = []       # {"kind": "p"|"h"|"li", "level": n, "runs": []}
        self._inline = []      # open inline tags
        self._lists = []       # {"kind": "ul"|"ol", "counter": n}
        self._quote_depth = 0
        self._pre_text = None
        self._pre_lang = None
        self._table = None     # {"rows": [], "cur_row": None, "cur_cell": None}

    def _eff_tag(self):
        for tag in ("code", "strong", "em", "a"):
            if tag in self._inline:
                return tag
        return None

    def _current_list_item(self):
        """Return the nearest open list item, if any."""

        for entry in reversed(self._stack):
            if entry.get("kind") == "li":
                return entry
        return None

    def _next_list_prefix(self):
        """Allocate the prefix for a list item when the item starts.

        Prefixes used to be allocated when ``</li>`` was seen.  That worked
        for tight list items, but loose items contain nested ``<p>`` blocks;
        their text was emitted before the delayed prefix.  Allocating it at
        ``<li>`` start keeps the prefix attached to the item's content.
        """

        if not self._lists:
            return "• "
        current = self._lists[-1]
        if current["kind"] == "ol":
            current["counter"] += 1
            return f"{current['counter']}. "
        return "• "

    @staticmethod
    def _normalize_list_runs(runs):
        """Remove structural indentation from list-item continuation text."""

        normalized = []
        at_line_start = True
        for text, inline in runs:
            if not text:
                continue
            output = []
            index = 0
            while index < len(text):
                if at_line_start:
                    while index < len(text) and text[index] in " \t":
                        index += 1
                    if index == len(text):
                        at_line_start = True
                        break
                    at_line_start = False
                newline = text.find("\n", index)
                if newline < 0:
                    output.append(text[index:])
                    index = len(text)
                else:
                    output.append(text[index:newline + 1])
                    index = newline + 1
                    at_line_start = True
            value = "".join(output)
            if value:
                normalized.append((value, inline))
            if text.endswith("\n"):
                at_line_start = True
        return normalized

    @classmethod
    def _append_list_paragraph(cls, item, runs):
        """Append one nested list paragraph to its parent ``<li>``.

        The line model has one entry per list item, so paragraph boundaries
        become a single compact newline inside that item.  This also means
        the renderer can place the list prefix exactly once, before the first
        paragraph.
        """

        runs = cls._normalize_list_runs(runs)
        if not runs:
            return
        if item["runs"]:
            item["runs"].append(("\n", None))
        item["runs"].extend(runs)

    def _append_data(self, data, *, explicit_break=False):
        """Append text while dropping HTML-only whitespace around blocks."""

        top = self._stack[-1] if self._stack else None
        if top and top.get("runs") is not None:
            # markdown.markdown emits indentation/newline-only data between
            # block tags inside loose list items.  It is not user content and
            # must not become several empty GTK lines.  Preserve ordinary
            # spaces (for example between two inline tags), and preserve
            # explicit ``<br>`` breaks.
            if (
                not explicit_break
                and top.get("kind") == "li"
                and "\n" in data
                and not data.strip()
            ):
                return
            top["runs"].append((data, self._eff_tag()))

    def handle_starttag(self, tag, attrs):
        if self._pre_text is not None:
            # Inside a <pre>: capture the fenced-block language from
            # <code class="language-…"> and ignore everything else.
            if tag == "code":
                for key, val in attrs:
                    if key == "class" and val.startswith("language-"):
                        self._pre_lang = val[len("language-"):]
            return
        if tag == "pre":
            self._pre_text = ""
            self._pre_lang = None
            return
        if self._table is not None:
            if tag == "tr":
                self._table["cur_row"] = []
            elif tag in ("th", "td"):
                self._table["cur_cell"] = ""
            return
        if tag == "table":
            self._table = {"rows": [], "cur_row": None, "cur_cell": None}
        elif tag == "p" or self.HEADING.fullmatch(tag or ""):
            match = self.HEADING.fullmatch(tag)
            self._stack.append({
                "kind": "h" if match else "p",
                "level": int(match.group(1)) if match else 0,
                "runs": [],
                "list_item": self._current_list_item(),
            })
        elif tag == "li":
            self._stack.append({
                "kind": "li",
                "runs": [],
                "prefix": self._next_list_prefix(),
            })
        elif tag == "blockquote":
            self._quote_depth += 1
        elif tag == "ul":
            self._lists.append({"kind": "ul", "counter": 0})
        elif tag == "ol":
            start = 1
            for key, value in attrs:
                if key == "start":
                    try:
                        start = int(value)
                    except (TypeError, ValueError):
                        pass
                    break
            self._lists.append({"kind": "ol", "counter": start - 1})
        elif tag == "hr":
            self.lines.append(("hr",))
        elif tag == "br":
            self._append_data("\n", explicit_break=True)
        elif tag in self.INLINE:
            self._inline.append(tag)

    def handle_endtag(self, tag):
        if tag == "pre":
            if self._pre_text is not None:
                self.lines.append(
                    ("pre", self._pre_text.rstrip("\n"), self._pre_lang))
            self._pre_text = None
            self._pre_lang = None
            return
        if self._table is not None:
            if tag in ("th", "td"):
                self._table["cur_row"].append(self._table["cur_cell"].strip())
                self._table["cur_cell"] = None
            elif tag == "tr":
                if self._table["cur_row"] is not None:
                    self._table["rows"].append(self._table["cur_row"])
                self._table["cur_row"] = None
            elif tag == "table":
                rows, self._table = self._table["rows"], None
                if rows:
                    self.lines.append(("table", rows))
            return
        if tag in ("ul", "ol"):
            if self._lists:
                self._lists.pop()
            return
        if tag == "blockquote":
            self._quote_depth = max(0, self._quote_depth - 1)
            return
        if tag in self.INLINE:
            if tag in self._inline:
                self._inline.pop()
            return
        if not self._stack:
            return
        top = self._stack[-1]
        if tag == "p" or self.HEADING.fullmatch(tag or ""):
            if top.get("runs"):
                if top.get("list_item") is not None:
                    self._append_list_paragraph(top["list_item"], top["runs"])
                elif top["kind"] == "h":
                    self.lines.append(("h", top["level"], top["runs"]))
                elif self._quote_depth:
                    self.lines.append(("quote", top["runs"]))
                else:
                    self.lines.append(("p", top["runs"]))
            self._stack.pop()
        elif tag == "li":
            if top.get("runs"):
                self.lines.append((
                    "li",
                    self._normalize_list_runs(top["runs"]),
                    top.get("prefix", "• "),
                ))
            self._stack.pop()

    def handle_data(self, data):
        if self._pre_text is not None:
            self._pre_text += data
            return
        if self._table is not None:
            if self._table["cur_cell"] is not None:
                self._table["cur_cell"] += data
            return
        self._append_data(data)


def table_grid(rows):
    """Render table rows as an aligned monospace grid."""
    if not rows:
        return []
    ncols = max(len(row) for row in rows)
    cells = [[(row[col].strip() if col < len(row) else "")
              for col in range(ncols)] for row in rows]
    widths = [max(len(cells[row][col]) for row in range(len(cells)))
              for col in range(ncols)]

    def line(row):
        return "│ " + " │ ".join(
            cell.ljust(widths[col]) for col, cell in enumerate(row)
        ) + " │"

    output = [line(cells[0])]
    output.append("├" + "┼".join("─" * (width + 2) for width in widths) + "┤")
    output.extend(line(row) for row in cells[1:])
    return output


def pygments_token_tag(ttype):
    """Map a Pygments token type to a syntax-tag name, or ``None``.

    Pygments is optional for the GTK client.  Importing this helper therefore
    remains safe when the package is absent, matching the original fallback to
    unhighlighted code.
    """
    try:
        from pygments.token import Token
    except ImportError:
        return None
    if ttype in Token.Keyword:
        return "syn-keyword"
    if (ttype in Token.Name.Function or ttype in Token.Name.Class
            or ttype in Token.Name.Decorator):
        return "syn-func"
    if ttype in Token.Name.Builtin:
        return "syn-builtin"
    if ttype in Token.String:
        return "syn-string"
    if ttype in Token.Number:
        return "syn-number"
    if ttype in Token.Comment:
        return "syn-comment"
    if ttype in Token.Operator:
        return "syn-operator"
    if ttype in Token.Name.Tag:
        return "syn-tag"
    if ttype in Token.Name.Attribute:
        return "syn-attr"
    return None


def highlight_code(code, language):
    """Tokenize a code block with Pygments.

    Returns ``(text, token_type)`` pairs, or ``None`` when Pygments is absent,
    the language is unknown, or lexing fails.  The returned token text
    reconstructs the input without the synthetic trailing newline Pygments
    adds to its stream.
    """
    if not language:
        return None
    try:
        from pygments import lex
        from pygments.lexers import get_lexer_by_name
        from pygments.util import ClassNotFound
    except ImportError:
        return None
    try:
        lexer = get_lexer_by_name(language)
    except ClassNotFound:
        return None
    try:
        tokens = [(value, ttype) for ttype, value in lex(code, lexer) if value]
    except Exception:
        return None
    # Pygments appends a trailing newline to the token stream; strip it so the
    # tokens reconstruct the input exactly.  The GTK renderer adds its own
    # paragraph terminator and card padding.
    if tokens and tokens[-1][0].endswith("\n"):
        text, ttype = tokens[-1]
        stripped = text.rstrip("\n")
        if stripped:
            tokens[-1] = (stripped, ttype)
        else:
            tokens.pop()
    return tokens


def light_stream_filter(text):
    """Strip common markdown markers while streamed text is visible."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    lines = []
    for line in text.split("\n"):
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^\s*>\s?", "", line)
        lines.append(line)
    return "\n".join(lines)


# Temporary compatibility aliases for callers migrating from agent-gui.py.
# The public names above are intentionally concise; aliases preserve the old
# private helper spelling for a low-friction import transition.
_table_grid = table_grid
_pygments_token_tag = pygments_token_tag
_highlight_code = highlight_code
_light_stream_filter = light_stream_filter


__all__ = [
    "MdRenderer",
    "table_grid",
    "pygments_token_tag",
    "highlight_code",
    "light_stream_filter",
]
