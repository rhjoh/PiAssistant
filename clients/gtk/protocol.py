"""Pure helpers for normalizing gateway protocol payloads."""


def is_pending_duplicate(pending, text):
    """Whether ``text`` is already awaiting a gateway acknowledgement."""

    return bool(pending and pending.get("text") == text)


def prompt_payload(text, turn_id, processing=False, behavior=None):
    """Build a gateway ``prompt`` message for the GTK submission rules.

    While processing, the message carries ``streamingBehavior`` (defaulting to
    ``"steer"``, ``"followUp"`` for Alt+Enter); while idle it is a plain
    prompt.
    """

    msg = {"type": "prompt", "message": text, "id": turn_id}
    if processing:
        msg["streamingBehavior"] = behavior or "steer"
    return msg


def content_text(content):
    """Reduce history content parts to the text shown by this client."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    parts.append(part.get("text", ""))
                elif part.get("type") == "image":
                    parts.append("[image]")
            else:
                parts.append(str(part))
        return "".join(parts)
    return str(content)


def content_thinking(content):
    """Extract persisted reasoning parts from an assistant history message."""
    if not isinstance(content, list):
        return ""
    return "".join(
        part.get("thinking", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "thinking"
    )


def is_heartbeat(text):
    normalized = text.strip().strip("`")
    return (normalized.startswith("[Heartbeat]")
            or "[[NO_ACTION]]" in normalized)


def model_name(model):
    """Return the gateway model's display name, if it is identifiable."""
    model = model or {}
    if model.get("name"):
        return model["name"]
    if model.get("provider") or model.get("id"):
        return f"{model.get('provider', '?')}/{model.get('id', '?')}"
    return None
