"""Pure helpers for Pi extension UI dialogs (question, permission-gate, etc.)."""

import re

DIALOG_METHODS = frozenset({"select", "confirm", "input", "editor"})
CONFIRM_OPTIONS = ("Yes", "No")

# Pi extensions run in a terminal-aware environment and may pass strings
# styled with ANSI CSI/OSC sequences to ``ui.setStatus``.  Standard gateway
# clients render plain text, so those terminal controls must not reach GTK
# labels (Pango displays ESC as a visible control-character box).
_ANSI_ESCAPE_RE = re.compile(
    r"(?:\x1b\][^\x07]*(?:\x07|\x1b\\))"
    r"|(?:\x1b\[[0-?]*[ -/]*[@-~])"
    r"|(?:\x9b[0-?]*[ -/]*[@-~])"
)


def strip_terminal_formatting(text):
    """Return display text without ANSI styling or stray ESC/BEL controls."""

    plain = _ANSI_ESCAPE_RE.sub("", str(text))
    return plain.replace("\x1b", "").replace("\x07", "")


def is_dialog_method(method):
    return method in DIALOG_METHODS


def working_text(data):
    """Human-readable activity line from a gateway ``state`` payload."""

    data = data or {}
    working = data.get("working")
    if isinstance(working, dict):
        # ``isCompacting`` is the authoritative lifecycle flag.  A queued or
        # stale state snapshot can briefly retain the previous working object
        # after compaction has ended; never show that activity as live unless
        # compaction is explicitly active.
        if working.get("kind") == "compaction" and data.get("isCompacting") is not True:
            working = None
        else:
            message = working.get("message")
            if isinstance(message, str):
                message = strip_terminal_formatting(message).strip()
                return message or None
    if isinstance(working, str):
        working = strip_terminal_formatting(working).strip()
        if working:
            return working
    widgets = data.get("widgets")
    if isinstance(widgets, list):
        lines = [
            plain
            for line in widgets
            if (plain := strip_terminal_formatting(line).strip())
        ]
        if lines:
            return "\n".join(lines)
    return None


def dialog_title(request):
    request = request or {}
    for key in ("title", "message"):
        value = request.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    method = request.get("method") or "prompt"
    return f"Pi needs input ({method})"


def dialog_options(request):
    request = request or {}
    method = request.get("method")
    if method == "confirm":
        return list(CONFIRM_OPTIONS)
    options = request.get("options") or []
    return [str(option) for option in options if str(option)]


def extension_ui_response(request_id, *, value=None, confirmed=None, cancelled=False):
    """Build a gateway ``extension_ui_response`` payload."""

    message = {"type": "extension_ui_response", "id": request_id}
    if cancelled:
        message["cancelled"] = True
        return message
    if confirmed is not None:
        message["confirmed"] = bool(confirmed)
        return message
    message["value"] = "" if value is None else str(value)
    return message


def response_for_option(request, option):
    """Map a chosen option label to the protocol response for ``request``."""

    request = request or {}
    request_id = request.get("id")
    if not request_id:
        return None
    if request.get("method") == "confirm":
        return extension_ui_response(request_id, confirmed=option == "Yes")
    return extension_ui_response(request_id, value=option)
