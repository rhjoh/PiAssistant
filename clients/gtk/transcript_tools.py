"""GTK-independent tool-call presentation and state helpers.

The transcript controller owns the GTK marks and child widgets used to lay
out a tool block.  The decisions that turn a gateway tool payload into a
short header, however, do not need a text buffer (or GTK at all).  Keeping
those decisions here gives the controller a small, deterministic seam for
tests and leaves the view layer responsible only for mutation and layout.

The GTK marks and child widgets that define a live block intentionally remain
in the controller, where their deletion order and mark gravity can be managed
as one state machine.
"""

from __future__ import annotations

from typing import Any


TOOL_SUMMARY_MAX_CHARS = 120
TOOL_OUTPUT_DISPLAY_MAX_CHARS = 300


def compact_tool_value(value: Any, limit: int = TOOL_SUMMARY_MAX_CHARS) -> str:
    """Collapse a tool argument into a bounded, single-line label.

    The transcript uses a compact label in a header, so whitespace (including
    newlines from shell snippets) is folded before the value is bounded.  The
    ellipsis is included in the limit whenever truncation is needed.
    """

    compact = " ".join(str(value).split())
    if len(compact) <= limit:
        return compact
    return compact[: max(1, limit - 1)].rstrip() + "…"


def summarize_tool(tool_name: Any, args: Any, label: Any = None) -> str:
    """Return a short human-readable summary for one tool call.

    Concrete arguments are preferred (command, path, URL, query, and so on),
    then a gateway label is used when it adds information, and finally the
    plain tool name is returned.  The precedence intentionally mirrors the
    original GTK transcript behavior.
    """

    if isinstance(args, dict):
        if tool_name == "bash":
            command = args.get("command")
            if isinstance(command, str) and command.strip():
                return "$ " + compact_tool_value(command)
        for key in ("path", "filePath", "filename"):
            value = args.get(key)
            if isinstance(value, str) and value.strip():
                return f"{tool_name} {compact_tool_value(value)}"
        for key in ("pattern", "glob", "url", "query"):
            value = args.get(key)
            if isinstance(value, str) and value.strip():
                return f"{tool_name} {compact_tool_value(value)}"
        if tool_name == "todo":
            action = args.get("action")
            if isinstance(action, str) and action:
                text = args.get("text")
                if isinstance(text, str) and text.strip():
                    return f"todo {action} {text.strip()[:60]}"
                return f"todo {action}"
        message = args.get("message")
        if isinstance(message, str) and message.strip():
            return f"{tool_name} " + message.strip().replace("\n", " ")[:80]
    if isinstance(label, str) and label and label not in ("tool", tool_name):
        return compact_tool_value(label)
    return tool_name


def summarize_tool_parts(
    tool_name: Any, args: Any, label: Any = None
) -> tuple[str, str]:
    """Return ``(tool_name, argument_summary)`` for a themed header.

    This uses the same precedence as :func:`summarize_tool`, while keeping
    the name separate so the GTK layer can apply independent name/argument
    tags.  Gateway labels for bash sometimes include ``"$ "``; that prefix
    is removed because the name already identifies the shell tool.
    """

    name = str(tool_name or "tool")
    if isinstance(args, dict):
        if name == "bash":
            command = args.get("command")
            if isinstance(command, str) and command.strip():
                return name, compact_tool_value(command)
        for key in ("path", "filePath", "filename"):
            value = args.get(key)
            if isinstance(value, str) and value.strip():
                return name, compact_tool_value(value)
        for key in ("pattern", "glob", "url", "query"):
            value = args.get(key)
            if isinstance(value, str) and value.strip():
                return name, compact_tool_value(value)
        if name == "todo":
            action = args.get("action")
            if isinstance(action, str) and action:
                text = args.get("text")
                if isinstance(text, str) and text.strip():
                    return name, compact_tool_value(f"{action} {text.strip()}")
                return name, action
        message = args.get("message")
        if isinstance(message, str) and message.strip():
            return name, compact_tool_value(message)
    if isinstance(label, str) and label and label not in ("tool", name):
        rest = compact_tool_value(label)
        if rest.startswith("$ "):
            rest = rest[2:]
        return name, rest
    return name, ""


def display_tool_output(
    output: Any, limit: int = TOOL_OUTPUT_DISPLAY_MAX_CHARS
) -> str:
    """Return the bounded body text shown inside a tool block.

    Tool output is intentionally not whitespace-collapsed: line breaks are
    meaningful for command output.  Empty surrounding whitespace is removed,
    matching the transcript body renderer, and the visible preview is capped
    independently from the full text retained for copy-to-clipboard.
    """

    display = str(output or "").strip()
    if len(display) > limit:
        return display[:limit] + "…"
    return display


__all__ = [
    "TOOL_OUTPUT_DISPLAY_MAX_CHARS",
    "TOOL_SUMMARY_MAX_CHARS",
    "compact_tool_value",
    "display_tool_output",
    "summarize_tool",
    "summarize_tool_parts",
]
